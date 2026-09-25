#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Color, Position, Square, handPieceTypes, pieceTypeToSFEN } from '../../node_modules/tsshogi/dist/esm/index.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(SCRIPT_DIR, '../bench/fixtures.json');

// Each trajectory is a fixed seeded sequence of legal USI moves from startpos.
// The seed, requested ply, and deterministic move ordering below reproduce the
// committed move lists; the resulting JSON stores every move explicitly.
const TARGETS = [
  { id: 'quiet-no-mate', seed: 1, ply: 20, sourceNote: 'Synthetic deterministic legal playout from startpos; quiet, not in check, with no mate-in-one found by exhaustive legal move enumeration.' },
  { id: 'sente-middlegame', seed: 1, ply: 40, sourceNote: 'Synthetic deterministic legal playout from startpos; sente to move in the middlegame.' },
  { id: 'gote-middlegame', seed: 1, ply: 41, sourceNote: 'Synthetic deterministic legal playout from startpos; gote to move in the middlegame.' },
  { id: 'middlegame-60', seed: 1, ply: 60, sourceNote: 'Synthetic deterministic legal playout from startpos; middlegame snapshot.' },
  { id: 'middlegame-80', seed: 1, ply: 80, sourceNote: 'Synthetic deterministic legal playout from startpos; middlegame snapshot with captures and drops.' },
  { id: 'hand-piece-rich', seed: 1, ply: 106, sourceNote: 'Synthetic deterministic legal playout from startpos; both sides have captured pieces in hand.' },
  { id: 'middlegame-120', seed: 1, ply: 120, sourceNote: 'Synthetic deterministic legal playout from startpos; late middlegame snapshot.' },
  { id: 'middlegame-150', seed: 1, ply: 150, sourceNote: 'Synthetic deterministic legal playout from startpos; late middlegame snapshot.' },
  { id: 'mate-in-one', seed: 1, ply: 172, sourceNote: 'Synthetic deterministic legal playout from startpos; tsshogi confirms a legal mating move in one.' },
  { id: 'single-legal-move', seed: 1, ply: 186, sourceNote: 'Synthetic deterministic legal playout from startpos; exactly one legal evasion remains.' },
  { id: 'sparse-endgame', seed: 28, ply: 184, sourceNote: 'Synthetic deterministic legal playout from startpos; sparse endgame with captures and hand pieces.' },
];

function squareUsi(square) {
  return `${9 - square.x}${'abcdefghi'[square.y]}`;
}

function legalMoves(position) {
  const moves = [];
  for (const from of position.board.listNonEmptySquares()) {
    const piece = position.board.at(from);
    if (!piece || piece.color !== position.color) continue;
    for (const to of Square.all) {
      const base = `${squareUsi(from)}${squareUsi(to)}`;
      for (const suffix of ['', '+']) {
        const move = position.createMoveByUSI(base + suffix);
        if (move && position.isValidMove(move)) moves.push(move);
      }
    }
  }

  const hand = position.hand(position.color);
  for (const type of handPieceTypes) {
    if (hand.count(type) === 0) continue;
    let symbol = pieceTypeToSFEN(type);
    if (position.color === Color.WHITE) symbol = symbol.toLowerCase();
    for (const to of Square.all) {
      const move = position.createMoveByUSI(`${symbol}*${squareUsi(to)}`);
      if (move && position.isValidMove(move)) moves.push(move);
    }
  }
  return moves;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function replay(moves) {
  const position = new Position();
  for (const usi of moves) {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move) || !position.doMove(move)) {
      throw new Error(`Illegal fixed USI move ${usi} after ${moves.slice(0, moves.indexOf(usi)).join(' ')}`);
    }
  }
  return position;
}

function handPieceCount(position) {
  return [...position.hand(Color.BLACK).counts, ...position.hand(Color.WHITE).counts]
    .reduce((count, piece) => count + piece.count, 0);
}

function findMateInOne(position) {
  for (const move of legalMoves(position)) {
    const after = position.clone();
    if (after.doMove(move) && after.checked && legalMoves(after).length === 0) return move.usi;
  }
  return null;
}

function walkToTargets(seed, targets) {
  const random = seededRandom(seed);
  const snapshots = new Map();
  const targetByPly = new Map(targets.map((target) => [target.ply, target]));
  const position = new Position();
  const moves = [];
  const maximumPly = Math.max(...targets.map((target) => target.ply));

  for (let ply = 0; ply <= maximumPly; ply += 1) {
    const target = targetByPly.get(ply);
    if (target) snapshots.set(target.id, { sfen: position.sfen, moves: [...moves], position: position.clone() });
    if (ply === maximumPly) break;

    const candidates = legalMoves(position);
    if (candidates.length === 0) throw new Error(`Seed ${seed} ended before requested ply ${maximumPly}`);
    const selected = candidates[Math.floor(random() * candidates.length)];
    if (!position.doMove(selected)) throw new Error(`Seed ${seed} failed to apply ${selected.usi}`);
    moves.push(selected.usi);
  }
  return snapshots;
}

function buildFixtures() {
  const fixtures = [
    {
      id: 'initial-position',
      sfen: new Position().sfen,
      sourceNote: 'Synthetic public initial shogi position (startpos).',
      moves: [],
    },
  ];

  for (const seed of [...new Set(TARGETS.map((target) => target.seed))]) {
    const seedTargets = TARGETS.filter((target) => target.seed === seed);
    const snapshots = walkToTargets(seed, seedTargets);
    for (const target of seedTargets) {
      const snapshot = snapshots.get(target.id);
      const replayed = replay(snapshot.moves);
      if (replayed.sfen !== snapshot.sfen) throw new Error(`Non-reproducible SFEN for ${target.id}`);

      if (target.id === 'quiet-no-mate') {
        if (snapshot.position.checked || findMateInOne(snapshot.position) !== null) {
          throw new Error('quiet-no-mate fixture is checked or has a mate-in-one');
        }
      } else if (target.id === 'hand-piece-rich' && handPieceCount(snapshot.position) < 8) {
        throw new Error('hand-piece-rich fixture has fewer than eight pieces in hand');
      } else if (target.id === 'mate-in-one') {
        const matingMove = findMateInOne(snapshot.position);
        if (!matingMove) throw new Error('mate-in-one fixture has no verified mating move');
      } else if (target.id === 'single-legal-move' && legalMoves(snapshot.position).length !== 1) {
        throw new Error('single-legal-move fixture does not have exactly one legal move');
      } else if (
        target.id === 'sente-middlegame' && snapshot.position.color !== Color.BLACK ||
        target.id === 'gote-middlegame' && snapshot.position.color !== Color.WHITE
      ) {
        throw new Error(`${target.id} fixture has the wrong side to move`);
      } else if (target.id === 'sparse-endgame' && snapshot.position.board.listNonEmptySquares().length > 30) {
        throw new Error('sparse-endgame fixture has more than 30 board pieces');
      }

      fixtures.push({ id: target.id, sfen: snapshot.sfen, sourceNote: target.sourceNote, moves: snapshot.moves });
    }
  }

  const ids = new Set();
  const sfens = new Set();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id) || sfens.has(fixture.sfen)) throw new Error(`Duplicate fixture id or SFEN: ${fixture.id}`);
    ids.add(fixture.id);
    sfens.add(fixture.sfen);
  }
  if (fixtures.length < 12) throw new Error(`Expected at least 12 fixtures, got ${fixtures.length}`);
  return fixtures;
}

async function main() {
  const args = process.argv.slice(2);
  let outputPath = DEFAULT_OUTPUT;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node cloud/scripts/gen-fixtures.mjs [--out <path>]');
    outputPath = resolve(args[1]);
  }
  const fixtures = buildFixtures();
  const contents = `${JSON.stringify(fixtures, null, 2)}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents, { encoding: 'utf8' });
  console.log(`Wrote ${fixtures.length} legal fixtures to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
