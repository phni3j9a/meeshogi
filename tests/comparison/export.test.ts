import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildComparisonExport } from '../../src/comparison/export';
import { validateComparisonExport } from '../../src/comparison/validate';
import { aggregateAll } from '../../src/comparison/aggregate';
import { renderReport } from '../../src/comparison/report';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import { legalMoves } from '../../src/domain';
import type {
  AnalysisConditions,
  GameRecord,
  GameMove,
  PositionAnalysis,
  SekireiRunRecord,
} from '../../src/domain/model';
import type { CloudAttempt, CloudProfileId } from '../../src/cloud/contract';
import type { PersistedCloudResult } from '../../src/storage/cloud-repository';
import {
  ENDPOINT,
  TERMINAL_MATE,
  makeIncompleteResult,
  makeSuccessResult,
  makeTerminalResult,
  positionsFor,
} from '../cloud/helpers';
import { makeAppStore } from '../../src/store/create-app-store';
import { DEFAULT_SETTINGS, type Settings } from '../../src/domain/model';
import type { LocalRepository } from '../../src/storage/repository';

const sha256Hex = async (text: string) => createHash('sha256').update(text).digest('hex');

const GENERATOR = {
  platform: 'android' as const,
  osVersion: '36',
  deviceModel: 'emu64a',
  appVersion: '0.1.0',
  buildId: 'testbuild',
};
const EXPORTED_AT = '2026-10-01T00:00:00.000Z';
const CONDITIONS: AnalysisConditions = { nodes: 10000, multiPV: 2 };

const MOVESET = ['7g7f', '3c3d', '8g8f'];

function makeGame(
  overrides: Partial<GameRecord> & { positions: string[] },
): GameRecord {
  const { positions, ...rest } = overrides;
  const moveUsis = overrides.moves
    ? overrides.moves.map((m) => m.usi)
    : MOVESET.slice(0, positions.length - 1);
  return {
    rawKif: 'test',
    identity: 'identity-test',
    blackName: 'Black',
    whiteName: 'White',
    blackRank: null,
    whiteRank: null,
    startedAt: '2026-09-30',
    endedAt: null,
    timeControl: '',
    headers: {},
    service: 'unknown',
    result: 'unknown',
    termination: '',
    moves: moveUsis.map(
      (usi): GameMove => ({ usi, label: usi, elapsedMs: 0, totalElapsedMs: 0 }),
    ),
    openings: {
      black: { automatic: 'unknown', manual: null },
      white: { automatic: 'unknown', manual: null },
      ruleVersion: '1',
    },
    positions,
    id: 'g1',
    createdAt: '2026-09-30T00:00:00.000Z',
    favorite: false,
    lastViewedPly: 0,
    mySide: null,
    attribution: 'none',
    analysis: {},
    ...rest,
  };
}

function sekireiRow(
  sfen: string,
  conditions: AnalysisConditions,
  extra: Partial<PositionAnalysis> = {},
): PositionAnalysis {
  const count = Math.min(conditions.multiPV, legalMoves(sfen).length);
  return {
    sfen,
    ...CURRENT_ANALYSIS_IDENTITY,
    status: 'complete',
    meta: {
      requestedNodes: conditions.nodes,
      nodes: conditions.nodes - 1,
      completedDepth: 8,
      fallback: false,
      budgetReached: false,
    },
    conditions,
    candidates: legalMoves(sfen)
      .slice(0, count)
      .map((usi, index) => ({ usi, pv: [usi], scoreCp: 30 + index * 5, mate: null, depth: 8 })),
    mateProof: null,
    completedAt: '2026-09-30T00:00:00.000Z',
    ...extra,
  };
}

function makeRun(overrides: Partial<SekireiRunRecord> = {}): SekireiRunRecord {
  return {
    runId: 'sek-run-1',
    conditions: CONDITIONS,
    wholeGameWallMs: 12_345,
    cacheReuseCount: 0,
    interrupted: false,
    resumed: false,
    completion: 'completed',
    ...overrides,
  };
}

function makeAttempt(
  game: GameRecord,
  profileId: CloudProfileId,
  overrides: Partial<CloudAttempt> = {},
): CloudAttempt {
  return {
    attemptId: `att-${profileId}`,
    gameId: game.id,
    gameIdentity: game.identity,
    profileId,
    endpoint: ENDPOINT,
    installId: 'inst_test',
    ownerId: 'own_test',
    idempotencyKey: `mk.key-${profileId}`,
    initialSfen: game.positions[0],
    moves: game.moves.map((m) => m.usi),
    totalPlies: game.positions.length,
    jobId: `job_${profileId}`,
    status: 'completed',
    receiveAfterPly: game.positions.length - 1,
    serverNextPly: game.positions.length,
    resultCounts: null,
    receivedCount: game.positions.length,
    validCount: game.positions.length,
    failureCode: null,
    failureMessage: null,
    lastError: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:05:00.000Z',
    finishedAt: '2026-09-30T00:05:00.000Z',
    ...overrides,
  };
}

function cloudRow(
  game: GameRecord,
  ply: number,
  profileId: CloudProfileId,
  result: unknown = makeSuccessResult(game.positions[ply], profileId),
): PersistedCloudResult {
  return { ply, sfen: game.positions[ply], status: 'success', engineLaunch: 1, result };
}

async function build(game: GameRecord, attempts: CloudAttempt[] = [], results = {}) {
  return buildComparisonExport(
    { game, attempts, results, generator: GENERATOR, exportedAt: EXPORTED_AT },
    sha256Hex,
  );
}

function serialized(doc: unknown): string {
  return JSON.stringify(doc);
}

describe('比較export writer', () => {
  it('3方式の結果を写し取りvalidatorが受理する', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET);
    const analysis: Record<number, PositionAnalysis> = {};
    positions.forEach((sfen, ply) => {
      analysis[ply] = sekireiRow(sfen, CONDITIONS, { callElapsedMs: 100 + ply, runId: 'sek-run-1' });
    });
    const game = makeGame({
      positions,
      analysis,
      analysisRun: makeRun({ wholeGameWallMs: 450 }),
    });
    const freeAttempt = makeAttempt(game, 'free');
    const precisionAttempt = makeAttempt(game, 'precision');
    const doc = await build(game, [freeAttempt, precisionAttempt], {
      'att-free': positions.map((_, ply) => cloudRow(game, ply, 'free')),
      'att-precision': positions.map((_, ply) => cloudRow(game, ply, 'precision')),
    });

    expect(doc.schema).toBe('meeshogi-comparison-export');
    expect(doc.schemaVersion).toBe(1);
    expect(doc.exportedAt).toBe(EXPORTED_AT);
    expect(doc.game.moves).toEqual(MOVESET);
    expect(doc.game.moveListHash).toBe(
      createHash('sha256').update(`${positions[0]}\n${MOVESET.join(' ')}`).digest('hex'),
    );
    expect(doc.methods.sekirei).toMatchObject({
      method: 'sekirei',
      attemptId: 'sek-run-1',
      conditions: CONDITIONS,
      timing: { wholeGameWallMs: 450, cacheReuseCount: 0, completion: 'completed' },
    });
    expect(doc.methods['cloud-free']).toMatchObject({
      method: 'cloud-free',
      attemptId: 'att-free',
      jobId: 'job_free',
      profileId: 'free',
      timing: { completion: 'completed' },
    });
    expect(doc.methods['cloud-precision']).toMatchObject({
      profileId: 'precision',
      conditions: { requested: { moveTimeMs: 5000, multiPV: 3 } },
    });

    const first = doc.plies[0].results;
    expect(first.sekirei).toMatchObject({
      status: 'complete',
      timing: { kind: 'app-call', elapsedMs: 100 },
      fromCache: false,
    });
    expect(first['cloud-free']).toMatchObject({
      status: 'complete',
      timing: { kind: 'server-search', elapsedMs: 950 },
    });
    const validation = validateComparisonExport(doc);
    expect(validation.ok).toBe(true);
  });

  it('指し手なしのterminal局面をterminal行として写し勝者を導く', async () => {
    const game = makeGame({
      positions: [TERMINAL_MATE],
      analysis: {
        0: {
          ...sekireiRow(TERMINAL_MATE, CONDITIONS),
          candidates: [],
          terminal: 'checkmate' as const,
          meta: {
            requestedNodes: CONDITIONS.nodes,
            nodes: 0,
            completedDepth: 0,
            fallback: false,
            budgetReached: false,
          },
          runId: 'sek-run-1',
        },
      },
      analysisRun: makeRun(),
    });
    const attempt = makeAttempt(game, 'free');
    const doc = await build(game, [attempt], {
      'att-free': [
        {
          ply: 0,
          sfen: TERMINAL_MATE,
          status: 'terminal',
          engineLaunch: 1,
          result: makeTerminalResult(TERMINAL_MATE, 'checkmate', 'free'),
        },
      ],
    });
    // w側手番で詰み → 先手の勝ち
    expect(doc.plies[0].results.sekirei).toMatchObject({
      status: 'terminal',
      terminal: { kind: 'checkmate', winner: 'black' },
    });
    expect(doc.plies[0].results['cloud-free']).toMatchObject({
      status: 'terminal',
      terminal: { kind: 'checkmate', winner: 'black' },
    });
    expect(validateComparisonExport(doc).ok).toBe(true);
  });

  it('未存在の行はmissing、cloudのincompleteをそのまま写す', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET);
    const game = makeGame({
      positions,
      analysis: { 0: sekireiRow(positions[0], CONDITIONS, { runId: 'sek-run-1' }) },
      analysisRun: makeRun({ cacheReuseCount: 0 }),
    });
    const attempt = makeAttempt(game, 'free');
    const doc = await build(game, [attempt], {
      'att-free': [
        cloudRow(game, 0, 'free', makeIncompleteResult(positions[0], 'free')),
        // ply 2 only: ply 1 is missing
        cloudRow(game, 2, 'free'),
      ],
    });
    expect(doc.plies[0].results['cloud-free']).toMatchObject({
      status: 'incomplete',
      timing: { kind: 'server-search', elapsedMs: 900 },
    });
    expect(doc.plies[1].results.sekirei).toEqual({ status: 'missing' });
    expect(doc.plies[1].results['cloud-free']).toEqual({ status: 'missing' });
    expect(doc.methods['cloud-precision']).toBeUndefined();
    expect(validateComparisonExport(doc).ok).toBe(true);
  });

  it('mateスコアの符号と勝者を保持し候補順を維持する', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', []);
    const legal = legalMoves(positions[0]);
    const game = makeGame({ positions });
    const attempt = makeAttempt(game, 'free');
    const result = makeSuccessResult(positions[0], 'free', {
      scores: [
        { kind: 'mate', value: -5, winningSide: 'gote' },
        { kind: 'mate', value: 3, winningSide: 'sente' },
      ],
    });
    const doc = await build(game, [attempt], { 'att-free': [cloudRow(game, 0, 'free', result)] });
    const row = doc.plies[0].results['cloud-free'];
    expect(row?.status).toBe('complete');
    if (!row || row.status !== 'complete') return;
    const candidates = row.candidates ?? [];
    expect(candidates.map((c) => c.move)).toEqual(legal.slice(0, 2));
    expect(candidates[0]?.score).toEqual({ kind: 'mate', value: -5, winner: 'white' });
    expect(candidates[1]?.score).toEqual({ kind: 'mate', value: 3, winner: 'black' });
    expect(row.evaluation).toEqual({ kind: 'mate', value: -5, winner: 'white' });
    expect(validateComparisonExport(doc).ok).toBe(true);
  });

  it('cache再利用の行はfromCacheで区別し呼出し時間を付けない', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET.slice(0, 1));
    const game = makeGame({
      positions,
      analysis: {
        // ply 0 was produced by an older run and reused by this one.
        0: sekireiRow(positions[0], CONDITIONS, { runId: 'sek-run-old' }),
        1: sekireiRow(positions[1], CONDITIONS, { callElapsedMs: 55, runId: 'sek-run-1' }),
      },
      analysisRun: makeRun({ cacheReuseCount: 1, resumed: true }),
    });
    const doc = await build(game);
    const reused = doc.plies[0].results.sekirei;
    expect(reused).toMatchObject({ status: 'complete', fromCache: true });
    expect(reused?.status === 'complete' && 'timing' in reused).toBe(false);
    expect(doc.plies[1].results.sekirei).toMatchObject({
      status: 'complete',
      fromCache: false,
      timing: { kind: 'app-call', elapsedMs: 55 },
    });
    expect(doc.methods.sekirei).toMatchObject({
      timing: { cacheReuseCount: 1, resumed: true, completion: 'completed' },
    });
    expect(validateComparisonExport(doc).ok).toBe(true);
  });

  it('run記録のない旧データはtimingをnull/unknownで残す', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET.slice(0, 1));
    const game = makeGame({
      positions,
      // Legacy rows: no runId, no callElapsedMs, no analysisRun on the game.
      analysis: {
        0: sekireiRow(positions[0], CONDITIONS),
        1: sekireiRow(positions[1], CONDITIONS),
      },
    });
    const doc = await build(game);
    expect(doc.methods.sekirei).toMatchObject({
      attemptId: 'sekirei-stored-g1',
      timing: {
        wholeGameWallMs: null,
        cacheReuseCount: null,
        interrupted: null,
        resumed: null,
        completion: 'unknown',
      },
    });
    const row = doc.plies[0].results.sekirei;
    expect(row?.status).toBe('complete');
    if (!row || row.status !== 'complete') return;
    expect('timing' in row).toBe(false);
    expect('fromCache' in row).toBe(false);
    expect(validateComparisonExport(doc).ok).toBe(true);
  });

  it('同一profileの複数attemptは最新createdAtを選ぶ', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET.slice(0, 1));
    const game = makeGame({ positions });
    const older = makeAttempt(game, 'free', {
      attemptId: 'att-old',
      jobId: 'job_old',
      createdAt: '2026-09-29T00:00:00.000Z',
      status: 'failed',
      finishedAt: '2026-09-29T00:10:00.000Z',
    });
    const newer = makeAttempt(game, 'free');
    const otherGame = makeAttempt(game, 'free', {
      attemptId: 'att-stale',
      gameIdentity: 'different-identity',
      createdAt: '2026-10-02T00:00:00.000Z',
    });
    const doc = await build(game, [older, newer, otherGame], {
      'att-free': positions.map((_, ply) => cloudRow(game, ply, 'free')),
    });
    expect(doc.methods['cloud-free']).toMatchObject({ attemptId: 'att-free', jobId: 'job_free' });
    expect(validateComparisonExport(doc).ok).toBe(true);
  });

  it('credential・endpoint・ownerIdをexportに含めない', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET.slice(0, 1));
    const game = makeGame({ positions });
    const attempt = makeAttempt(game, 'free');
    const doc = await build(game, [attempt], {
      'att-free': positions.map((_, ply) => cloudRow(game, ply, 'free')),
    });
    const text = serialized(doc);
    for (const secret of ['mcd1', 'Bearer', 'analysis.test.example', 'own_test', 'inst_test']) {
      expect(text).not.toContain(secret);
    }
    // No endpoint/identity credential field names leak either.
    expect(text).not.toContain('endpoint');
    expect(text).not.toContain('credential');
    expect(text).not.toContain('installId');
    expect(text).not.toContain('ownerId');
    expect(text).not.toContain('idempotencyKey');
  });

  it('writer出力をvalidator・aggregator・reportへ通す', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET);
    const analysis: Record<number, PositionAnalysis> = {};
    positions.forEach((sfen, ply) => {
      analysis[ply] = sekireiRow(sfen, CONDITIONS, { callElapsedMs: 40 + ply, runId: 'sek-run-1' });
    });
    const game = makeGame({
      positions,
      analysis,
      analysisRun: makeRun({ wholeGameWallMs: 300 }),
    });
    const free = makeAttempt(game, 'free');
    const precision = makeAttempt(game, 'precision');
    const doc = await build(game, [free, precision], {
      'att-free': positions.map((_, ply) => cloudRow(game, ply, 'free')),
      'att-precision': positions.map((_, ply) => cloudRow(game, ply, 'precision')),
    });
    const validation = validateComparisonExport(doc);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const summary = aggregateAll([{ source: 'export.json', data: validation.value }]);
    expect(summary.exports).toHaveLength(1);
    const exportSummary = summary.exports[0];
    expect(exportSummary.methods.sekirei.statusCounts.complete).toBe(positions.length);
    expect(exportSummary.methods['cloud-free'].statusCounts.complete).toBe(positions.length);
    // Cloud Precision is present as reference → pairwise comparisons exist.
    expect(exportSummary.comparisons.length).toBeGreaterThan(0);
    expect(exportSummary.timing.find((t) => t.method === 'sekirei')).toBeTruthy();
    const markdown = renderReport(summary);
    expect(markdown).toContain('Sekirei');
    expect(markdown).toContain('Cloud Precision');
    expect(markdown.length).toBeGreaterThan(200);
  });
});

describe('exportComparison（store経路）', () => {
  function storeWith(game: GameRecord, cloud: { attempts: CloudAttempt[]; results: Record<string, PersistedCloudResult[]> }) {
    const repository = {
      load: async () => ({
        games: [game],
        settings: { ...DEFAULT_SETTINGS, autoAnalyze: false },
      }),
      insert: async () => {},
      save: async () => {},
      saveSettings: async (_settings: Settings, _games: GameRecord[]) => {},
      delete: async () => {},
      cloud: {
        attempts: async () => cloud.attempts,
        results: async (attemptId: string) => cloud.results[attemptId] ?? [],
      },
    };
    const store = makeAppStore({
      openRepository: async () => repository as unknown as LocalRepository,
      analyze: async () => {
        throw new Error('unused');
      },
      cancel: () => {},
      createId: () => 'test-id',
      comparison: { sha256Hex, generator: () => GENERATOR },
    });
    return store;
  }

  it('store経路でも有効なexportを返す', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET.slice(0, 1));
    const game = makeGame({
      positions,
      analysis: { 0: sekireiRow(positions[0], CONDITIONS, { runId: 'sek-run-1', callElapsedMs: 10 }) },
      analysisRun: makeRun(),
    });
    const attempt = makeAttempt(game, 'free');
    const store = storeWith(game, {
      attempts: [attempt],
      results: { 'att-free': positions.map((_, ply) => cloudRow(game, ply, 'free')) },
    });
    await store.getState().initialize();
    const doc = await store.getState().exportComparison(game.id);
    expect(validateComparisonExport(doc).ok).toBe(true);
  });

  it('schema検証に落ちた場合はexportを拒否する', async () => {
    const positions = positionsFor('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', MOVESET.slice(0, 1));
    // A corrupt stored move makes the produced document fail validation; the
    // store must refuse rather than hand back an unusable export.
    const game = makeGame({ positions });
    game.moves[0] = { ...game.moves[0], usi: 'not-a-move' };
    const store = storeWith(game, { attempts: [], results: {} });
    await store.getState().initialize();
    await expect(store.getState().exportComparison(game.id)).rejects.toThrow('検証に失敗');
  });
});
