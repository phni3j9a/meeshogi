import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handPieceTypes, isPromotable, Position, Square } from 'tsshogi';

const directory = dirname(fileURLToPath(import.meta.url));
const positionsPath = resolve(directory, 'positions.json');
const gamePath = resolve(directory, 'game.json');
const dataset = JSON.parse(readFileSync(positionsPath, 'utf8'));
const game = JSON.parse(readFileSync(gamePath, 'utf8'));
const phases = ['opening', 'middlegame', 'endgame'];

function hash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sfenKey(sfen) {
  return sfen.trim().split(/\s+/u).slice(0, 3).join(' ');
}

function hasAnyLegalMove(position) {
  for (const from of Square.all) {
    const piece = position.board.at(from);
    if (!piece || piece.color !== position.color) continue;
    for (const to of Square.all) {
      const move = position.createMove(from, to);
      if (!move) continue;
      if (position.isValidMove(move)) return true;
      if (isPromotable(move.pieceType) && position.isValidMove(move.withPromote())) return true;
    }
  }
  const hand = position.hand(position.color);
  for (const type of handPieceTypes) {
    if (hand.count(type) < 1) continue;
    for (const to of Square.all) {
      const move = position.createMove(type, to);
      if (move && position.isValidMove(move)) return true;
    }
  }
  return false;
}

function assertReplayable(row) {
  assert.equal(Position.isValidSFEN(row.sfen), true, `invalid SFEN: ${row.sfen}`);
  const position = Position.newBySFEN(row.sfen);
  assert.ok(position, `SFEN did not regenerate: ${row.sfen}`);
  const moveNumber = Number(row.sfen.split(/\s+/u)[3]);
  assert.equal(position.getSFEN(moveNumber), row.sfen, `SFEN did not round-trip: ${row.sfen}`);
  assert.equal(hasAnyLegalMove(position), true, `SFEN has no legal move: ${row.id ?? row.ply}`);
}

test('fixed public dataset has 20 opening, middlegame, and endgame positions', () => {
  assert.equal(dataset.schemaVersion, 1);
  assert.equal(dataset.source.archiveSha256, '48ece58b091dbb4df41e6fb55b73600767f77f4c9ee9ff8360474d5b75bb2631');
  assert.equal(dataset.positions.length, 60);
  for (const phase of phases) {
    assert.equal(dataset.positions.filter((row) => row.phase === phase).length, 20);
  }
  assert.equal(new Set(dataset.positions.map((row) => row.sfenKey)).size, 60);
});

test('every benchmark and full-game SFEN validates, regenerates, and has a legal move', () => {
  for (const row of dataset.positions) {
    assertReplayable(row);
    assert.equal(row.sfenKey, sfenKey(row.sfen));
  }
  for (const row of game.positions) assertReplayable(row);
});

test('SFEN, CSA source, and manifest hashes recompute', () => {
  const fileHashes = new Map(dataset.source.files.map(({ file, sha256 }) => [file, sha256]));
  assert.equal(fileHashes.size, 21);
  for (const digest of fileHashes.values()) assert.match(digest, /^[0-9a-f]{64}$/u);
  for (const row of dataset.positions) {
    assert.equal(row.sha256, hash(row.sfen));
    assert.ok(fileHashes.has(row.source.file), `missing CSA hash for ${row.source.file}`);
    assert.ok(row.source.event && row.source.black && row.source.white && row.source.startTime);
  }
  assert.equal(dataset.manifestSha256, hash(canonicalJson(dataset.positions)));
  assert.equal(game.manifestSha256, hash(canonicalJson(game.positions)));
  assert.equal(game.source.fileSha256, fileHashes.get(game.source.file));
  for (const row of game.positions) assert.equal(row.sha256, hash(row.sfen));
});

test('full-game input is complete, has 80-160 plies, and is separate from the 60-position sample', () => {
  assert.ok(game.plies >= 80 && game.plies <= 160);
  assert.equal(game.positions.length, game.plies);
  assert.equal(game.positions[0].ply, 0);
  assert.equal(game.positions.at(-1).ply, game.plies - 1);
  const benchmarkFiles = new Set(dataset.positions.map((row) => row.source.file));
  assert.equal(benchmarkFiles.has(game.source.file), false);
});

test('phase plies follow the fixed rules', () => {
  for (const row of dataset.positions) {
    const ply = row.source.ply;
    if (row.phase === 'opening') assert.ok(ply >= 16 && ply <= 40);
    if (row.phase === 'middlegame') assert.ok(ply >= 41 && ply <= 90);
    if (row.phase === 'endgame') assert.ok(ply >= 91);
  }
});

test('extractor is byte-for-byte deterministic for the supplied archive', {
  skip: !(process.env.WCSC36_CSA_DIR && process.env.WCSC36_ARCHIVE),
}, () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'meeshogi-wcsc36-test-'));
  try {
    const extractorPath = resolve(directory, 'extract.mjs');
    const outputs = ['first', 'second'].map((name) => {
      const out = resolve(temporary, name);
      execFileSync(process.execPath, [
        extractorPath,
        '--archive-file', process.env.WCSC36_ARCHIVE,
        '--source-dir', process.env.WCSC36_CSA_DIR,
        '--out-dir', out,
      ], { stdio: 'pipe' });
      return [readFileSync(resolve(out, 'positions.json')), readFileSync(resolve(out, 'game.json'))];
    });
    assert.deepEqual(outputs[0][0], outputs[1][0], 'positions.json differs between extraction runs');
    assert.deepEqual(outputs[0][1], outputs[1][1], 'game.json differs between extraction runs');
    assert.deepEqual(outputs[0][0], readFileSync(positionsPath), 'checked-in positions.json differs from regeneration');
    assert.deepEqual(outputs[0][1], readFileSync(gamePath), 'checked-in game.json differs from regeneration');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
