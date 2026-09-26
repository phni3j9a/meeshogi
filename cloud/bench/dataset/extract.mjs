#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  handPieceTypes,
  importCSA,
  isPromotable,
  Move,
  Position,
  RecordMetadataKey,
  Square,
} from 'tsshogi';

export const ARCHIVE_SHA256 = '48ece58b091dbb4df41e6fb55b73600767f77f4c9ee9ff8360474d5b75bb2631';
export const ARCHIVE_URL = 'https://www.computer-shogi.org/kifu/wcsc36_kifu.zip';
export const INDEX_URL = 'https://www.computer-shogi.org/kifu/kifu.html';
export const TOURNAMENT = '第36回世界コンピュータ将棋選手権';
export const SELECTION_SEED = 'meeshogi-issue-20-wcsc36-v1';
export const PHASES = ['opening', 'middlegame', 'endgame'];

const PHASE_LIMITS = {
  opening: { min: 16, max: 40 },
  middlegame: { min: 41, max: 90 },
  endgame: { min: 91, max: Infinity },
};
const STAGE_ORDER = ['primary', 'secondary', 'final'];
const ROUND_TARGETS = { primary: 7, secondary: 7, final: 6 };
const NORMAL_RESULTS = new Set(['resign', 'mate']);
const RESULT_MARKERS = new Set([
  'interrupt', 'resign', 'maxMoves', 'impass', 'draw', 'repetitionDraw', 'mate', 'noMate',
  'timeout', 'foulWin', 'foulLose', 'enteringOfKing', 'winByDefault', 'loseByDefault', 'try',
]);
const THIS_DIR = dirname(fileURLToPath(import.meta.url));

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sfenKey(sfen) {
  const fields = sfen.trim().split(/\s+/u);
  if (fields.length !== 4) throw new Error(`Expected four SFEN fields: ${sfen}`);
  return fields.slice(0, 3).join(' ');
}

function seededHash(text) {
  return sha256(Buffer.from(`${SELECTION_SEED}\0${text}`, 'utf8'));
}

function stageForEvent(event) {
  if (event.includes('一次予選')) return 'primary';
  if (event.includes('二次予選')) return 'secondary';
  if (event.includes('決勝')) return 'final';
  return null;
}

function metadata(record, key) {
  return record.metadata.getStandardMetadata(key) ?? '';
}

export function hasAnyLegalMove(position) {
  const color = position.color;
  for (const from of Square.all) {
    const piece = position.board.at(from);
    if (!piece || piece.color !== color) continue;
    for (const to of Square.all) {
      const move = position.createMove(from, to);
      if (!move) continue;
      if (position.isValidMove(move)) return true;
      if (isPromotable(move.pieceType) && position.isValidMove(move.withPromote())) return true;
    }
  }
  const hand = position.hand(color);
  for (const type of handPieceTypes) {
    if (hand.count(type) < 1) continue;
    for (const to of Square.all) {
      const move = position.createMove(type, to);
      if (move && position.isValidMove(move)) return true;
    }
  }
  return false;
}

function replayGame(file, bytes) {
  const decoded = new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  const record = importCSA(decoded);
  if (record instanceof Error) throw new Error(`CSA parse failed: ${record.message}`);

  const position = Position.newBySFEN(record.initialPosition.sfen);
  if (!position) throw new Error('CSA initial position is not valid SFEN');
  const positions = [];
  let ply = 0;
  let result = null;

  for (const node of record.moves) {
    if (node.move instanceof Move) {
      if (result) throw new Error(`move found after terminal marker ${result} at ply ${ply}`);
      const sfen = position.getSFEN(ply + 1);
      if (!Position.isValidSFEN(sfen)) throw new Error(`invalid generated SFEN before ply ${ply}`);
      const move = node.move;
      if (!position.isValidMove(move)) throw new Error(`illegal move at ply ${ply}: ${move.usi}`);
      positions.push({ ply, sfen, position: position.clone() });
      if (!position.doMove(move)) throw new Error(`failed to replay legal move at ply ${ply}: ${move.usi}`);
      ply += 1;
    } else {
      if (node.move.type === 'start' && ply === 0 && !result) continue;
      if (result) throw new Error(`multiple terminal markers (${result}, ${node.move.type})`);
      if (!RESULT_MARKERS.has(node.move.type) && node.move.type !== 'any') {
        throw new Error(`unknown CSA terminal marker: ${node.move.type}`);
      }
      result = node.move.type;
    }
  }

  const event = metadata(record, RecordMetadataKey.TITLE);
  const startTime = metadata(record, RecordMetadataKey.START_DATETIME);
  const black = metadata(record, RecordMetadataKey.BLACK_NAME);
  const white = metadata(record, RecordMetadataKey.WHITE_NAME);
  if (!event || !startTime || !black || !white) {
    throw new Error('missing $EVENT, $START_TIME, N+ or N- source metadata');
  }
  if (!event.includes('第36回世界コンピュータ将棋選手権')) {
    throw new Error(`unexpected event: ${event}`);
  }
  return {
    file,
    sha256: sha256(bytes),
    event,
    stage: stageForEvent(event),
    black,
    white,
    startTime,
    plies: ply,
    result,
    positions,
  };
}

function bySeedHash(left, right, discriminator) {
  const leftHash = seededHash(`${discriminator}\0${left}`);
  const rightHash = seededHash(`${discriminator}\0${right}`);
  return lexical(leftHash, rightHash) || lexical(left, right);
}

function eligibleBenchmarkGame(game) {
  return game.stage !== null && NORMAL_RESULTS.has(game.result) && game.plies >= 99;
}

function selectGames(games) {
  const eligible = games.filter(eligibleBenchmarkGame);
  const rounds = new Map();
  for (const game of eligible) {
    if (!rounds.has(game.event)) rounds.set(game.event, []);
    rounds.get(game.event).push(game);
  }

  const selected = [];
  for (const stage of STAGE_ORDER) {
    const stageRounds = [...rounds.entries()]
      .filter(([event]) => stageForEvent(event) === stage)
      .map(([event, roundGames]) => ({ event, games: roundGames }))
      .sort((a, b) => bySeedHash(a.event, b.event, `round\0${stage}`));
    const target = ROUND_TARGETS[stage];
    if (stageRounds.length < target) {
      throw new Error(`Need ${target} eligible ${stage} rounds, found ${stageRounds.length}`);
    }
    const chosenRounds = stageRounds.slice(0, target).sort((a, b) => lexical(a.event, b.event));
    for (const round of chosenRounds) {
      const chosen = round.games.slice().sort((a, b) => bySeedHash(a.file, b.file, 'game'))[0];
      selected.push(chosen);
    }
  }
  if (selected.length !== 20 || new Set(selected.map((game) => game.file)).size !== 20) {
    throw new Error(`Expected 20 distinct source games, got ${selected.length}`);
  }
  return selected;
}

function phaseCandidates(game, phase) {
  const limits = PHASE_LIMITS[phase];
  const max = phase === 'endgame' ? game.plies - 8 : limits.max;
  return game.positions
    .filter(({ ply }) => ply >= limits.min && ply <= max)
    .filter(({ position }) => hasAnyLegalMove(position))
    .sort((a, b) => bySeedHash(`${game.file}\0${a.ply}`, `${game.file}\0${b.ply}`, `position\0${phase}`));
}

function pickBenchPositions(games) {
  const selectedGames = selectGames(games);
  const usedKeys = new Set();
  const result = [];
  for (const phase of PHASES) {
    for (const game of selectedGames) {
      const candidate = phaseCandidates(game, phase).find(({ sfen }) => !usedKeys.has(sfenKey(sfen)));
      if (!candidate) throw new Error(`No unique legal ${phase} position remains for ${game.file}`);
      const key = sfenKey(candidate.sfen);
      usedKeys.add(key);
      result.push({
        id: `${phase}-${String(result.filter((row) => row.phase === phase).length + 1).padStart(2, '0')}`,
        phase,
        sfen: candidate.sfen,
        sfenKey: key,
        sha256: sha256(Buffer.from(candidate.sfen, 'utf8')),
        source: {
          file: game.file,
          event: game.event,
          black: game.black,
          white: game.white,
          startTime: game.startTime,
          ply: candidate.ply,
        },
      });
    }
  }
  return { positions: result, selectedGames };
}

function pickFullGame(games, excludedFiles) {
  const candidate = games
    .filter((game) => !excludedFiles.has(game.file))
    .filter((game) => game.plies >= 80 && game.plies <= 160 && NORMAL_RESULTS.has(game.result))
    .sort((a, b) => bySeedHash(a.file, b.file, 'full-game'))[0];
  if (!candidate) throw new Error('No separate normal-result game between 80 and 160 plies was found');
  return candidate;
}

function sourceManifest(archiveSha, usedGames) {
  const files = [...new Map(usedGames.map((game) => [game.file, game.sha256])).entries()]
    .map(([file, digest]) => ({ file, sha256: digest }))
    .sort((a, b) => lexical(a.file, b.file));
  return {
    archiveFile: 'wcsc36_kifu.zip',
    archiveSha256: archiveSha,
    archiveUrl: ARCHIVE_URL,
    indexUrl: INDEX_URL,
    event: TOURNAMENT,
    attribution: 'WCSC36 CSA archive; per-game program names, start times, event names, and CSA filenames are included with the derived positions.',
    files,
  };
}

function makeRules() {
  return {
    fixedBeforeAnalysis: true,
    replay: 'Decode CSA as Shift_JIS; import with tsshogi 2.3.4; replay every ordinary move from the declared initial position and reject a game on parse failure, an illegal move, a failed doMove, missing attribution metadata, or a move after a result marker.',
    phases: {
      opening: { minPlayedPlies: 16, maxPlayedPlies: 40 },
      middlegame: { minPlayedPlies: 41, maxPlayedPlies: 90 },
      endgame: { minPlayedPlies: 91, maxPlayedPlies: 'gamePlies - 8' },
    },
    terminalFilter: 'Each selected row is a pre-move position with at least one legal move. Endgame rows leave at least 8 recorded plies before the result marker.',
    endgameEligibility: { resultMarkers: ['resign', 'mate'], minimumGamePlies: 99 },
    sampling: {
      positionsPerPhase: 20,
      distinctGames: 20,
      oneGamePerRound: true,
      roundsByStage: ROUND_TARGETS,
      seed: SELECTION_SEED,
      selectionOrder: 'SHA-256-ranked event rounds, game files, and eligible plies; ties use UTF-16 lexical order. One legal, unique position is taken from each selected game in each phase.',
    },
    deduplication: 'sfenKey is the first three space-separated SFEN fields (board, side to move, hands); the move-number field is ignored. Keys are unique across all 60 positions.',
    fullGame: 'Select the first SHA-256-ranked, non-benchmark game with a normal result and 80-160 ordinary plies; include the SFEN before every ordinary move. Its positions are not added to the 60-row dataset.',
    hashes: 'SHA-256 of UTF-8 SFEN bytes; manifestSha256 is SHA-256 of UTF-8 canonical JSON for the positions array (recursively lexicographically sorted object keys, compact JSON, array order retained).',
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function extract({ archiveFile, sourceDir, outDir = THIS_DIR }) {
  const archivePath = resolve(archiveFile);
  const inputDir = resolve(sourceDir);
  const outputDir = resolve(outDir);
  const archiveSha = sha256(readFileSync(archivePath));
  if (archiveSha !== ARCHIVE_SHA256) {
    throw new Error(`Unexpected archive SHA-256 ${archiveSha}; expected ${ARCHIVE_SHA256}`);
  }
  const files = readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.csa'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`No .csa files found in ${inputDir}`);

  const games = [];
  const rejected = [];
  for (const file of files) {
    const bytes = readFileSync(resolve(inputDir, file));
    try {
      games.push(replayGame(file, bytes));
    } catch (error) {
      rejected.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const { positions, selectedGames } = pickBenchPositions(games);
  const selectedFileSet = new Set(selectedGames.map((game) => game.file));
  const fullGame = pickFullGame(games, selectedFileSet);
  const source = sourceManifest(archiveSha, [...selectedGames, fullGame]);
  const dataset = {
    schemaVersion: 1,
    source,
    rules: makeRules(),
    positions,
    manifestSha256: sha256(Buffer.from(canonicalJson(positions), 'utf8')),
  };
  const fullGamePositions = fullGame.positions.map(({ ply, sfen }) => ({
    ply,
    sfen,
    sha256: sha256(Buffer.from(sfen, 'utf8')),
  }));
  const gameData = {
    schemaVersion: 1,
    source: {
      ...source,
      file: fullGame.file,
      fileSha256: fullGame.sha256,
      event: fullGame.event,
      black: fullGame.black,
      white: fullGame.white,
      startTime: fullGame.startTime,
      result: fullGame.result,
    },
    id: basename(fullGame.file, '.csa'),
    plies: fullGame.plies,
    positions: fullGamePositions,
    manifestSha256: sha256(Buffer.from(canonicalJson(fullGamePositions), 'utf8')),
  };

  mkdirSync(outputDir, { recursive: true });
  writeJson(resolve(outputDir, 'positions.json'), dataset);
  writeJson(resolve(outputDir, 'game.json'), gameData);

  const phaseSummary = Object.fromEntries(PHASES.map((phase) => {
    const rows = positions.filter((row) => row.phase === phase);
    const plies = rows.map((row) => row.source.ply);
    return [phase, {
      count: rows.length,
      plyRange: [Math.min(...plies), Math.max(...plies)],
      sourceGames: new Set(rows.map((row) => row.source.file)).size,
    }];
  }));
  return {
    archiveSha256: archiveSha,
    csaFileCount: files.length,
    legalGameCount: games.length,
    rejectedGames: rejected,
    selectedGames: selectedGames.map(({ file, event, plies, result }) => ({ file, event, plies, result })),
    phaseSummary,
    fullGame: { file: fullGame.file, plies: fullGame.plies, result: fullGame.result },
    outputDir,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--archive-file', '--source-dir', '--out-dir'].includes(flag) || !value) {
      throw new Error('Usage: node extract.mjs --archive-file <zip> --source-dir <extracted-csa-dir> [--out-dir <dir>]');
    }
    args[flag.slice(2).replaceAll('-', '')] = value;
    index += 1;
  }
  if (!args.archivefile || !args.sourcedir) {
    throw new Error('Usage: node extract.mjs --archive-file <zip> --source-dir <extracted-csa-dir> [--out-dir <dir>]');
  }
  return { archiveFile: args.archivefile, sourceDir: args.sourcedir, outDir: args.outdir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = extract(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.rejectedGames.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
