import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAppStore } from '../../src/store/create-app-store';
import {
  DEFAULT_SETTINGS,
  type GameRecord,
  type PositionAnalysis,
  type Settings,
} from '../../src/domain/model';
import { legalMoves, parseKif } from '../../src/domain';
import { LocalRepository, type Database } from '../../src/storage/repository';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import { AnalysisBudgetIncompleteError } from '../../src/analysis/errors';

/**
 * Sekirei run-timing persistence: the whole-game record and per-call timing
 * are JS-measured and stored with the game. Legacy data without them must
 * still load and must not have timing inferred from other fields.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const fixture = () => parseKif(readFileSync('fixtures/kif/shogiwars.kif', 'utf8'));

function shortGame(id = 'timed-game'): GameRecord {
  const parsed = fixture();
  return {
    ...parsed,
    id,
    moves: parsed.moves.slice(0, 2),
    positions: parsed.positions.slice(0, 3),
    createdAt: '2026-09-22T00:00:00.000Z',
    favorite: false,
    lastViewedPly: 0,
    mySide: null,
    attribution: 'none',
    analysis: {},
  };
}

function sekireiResult(
  sfen: string,
  conditions: { nodes: number; multiPV: number },
): PositionAnalysis {
  const count = Math.min(conditions.multiPV, legalMoves(sfen).length);
  return {
    sfen,
    ...CURRENT_ANALYSIS_IDENTITY,
    status: 'complete',
    meta: {
      requestedNodes: conditions.nodes,
      nodes: conditions.nodes,
      completedDepth: 1,
      fallback: false,
      budgetReached: true,
    },
    conditions,
    candidates: legalMoves(sfen)
      .slice(0, count)
      .map((usi) => ({ usi, pv: [usi], depth: 1, scoreCp: 10, mate: null })),
    mateProof: null,
    completedAt: '2026-09-30T00:00:00.000Z',
  };
}

function setup(initialGames: GameRecord[] = []) {
  let persisted: GameRecord[] = [...initialGames];
  const repository = {
    load: async () => ({ games: persisted, settings: { ...DEFAULT_SETTINGS, autoAnalyze: false } }),
    insert: vi.fn(async (game: GameRecord) => {
      persisted = [...persisted, game];
    }),
    save: vi.fn(async (game: GameRecord) => {
      persisted = persisted.map((g) => (g.id === game.id ? game : g));
    }),
    saveSettings: vi.fn(async (_settings: Settings, _games: GameRecord[]) => {}),
    delete: vi.fn(async (id: string) => {
      persisted = persisted.filter((g) => g.id !== id);
    }),
  };
  const analyze = vi.fn(
    async (
      sfen: string,
      conditions: { nodes: number; multiPV: number },
    ): Promise<PositionAnalysis> => sekireiResult(sfen, conditions),
  );
  let nextId = 0;
  const store = makeAppStore({
    openRepository: async () => repository as unknown as LocalRepository,
    analyze,
    cancel: vi.fn<() => void | Promise<void>>(),
    createId: () => `id-${++nextId}`,
  });
  return { store, analyze, persisted: () => persisted };
}

describe('Sekirei解析タイミングの永続化', () => {
  it('新規完走したrunはcompleted記録と呼出し時間を持つ', async () => {
    const { store } = setup([shortGame()]);
    await store.getState().initialize();
    await store.getState().startAnalysis('timed-game');

    const game = store.getState().games[0];
    const run = game.analysisRun;
    expect(run).toBeDefined();
    expect(run).toMatchObject({
      conditions: { nodes: DEFAULT_SETTINGS.analysisNodes, multiPV: DEFAULT_SETTINGS.multiPV },
      cacheReuseCount: 0,
      interrupted: false,
      completion: 'completed',
    });
    expect('resumed' in run!).toBe(false);
    expect(run!.wholeGameWallMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(run!.wholeGameWallMs)).toBe(true);
    for (const ply of [0, 1, 2]) {
      const row = game.analysis[ply];
      expect(row.runId).toBe(run!.runId);
      expect(typeof row.callElapsedMs).toBe('number');
      expect(row.callElapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('中断したrunはinterruptedとして記録される', async () => {
    const { store, analyze } = setup([shortGame()]);
    await store.getState().initialize();
    const pending = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    analyze.mockImplementationOnce(async (sfen, conditions) =>
      sekireiResult(sfen, conditions),
    );
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const run = store.getState().startAnalysis('timed-game');
    await entered.promise;
    store.getState().stopAnalysis();
    pending.resolve(sekireiResult('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', { nodes: 1, multiPV: 1 }));
    await run;

    const game = store.getState().games[0];
    expect(game.analysisRun).toMatchObject({
      interrupted: true,
      completion: 'interrupted',
    });
    // The ply saved before the interruption keeps the interrupted run's id.
    expect(game.analysis[0].runId).toBe(game.analysisRun!.runId);
  });

  it('中断後に続けたrunはcache再利用を数えるだけで由来は追跡しない', async () => {
    const { store, analyze } = setup([shortGame()]);
    await store.getState().initialize();
    // Interrupt mid-run so ply 0 is persisted by run 1.
    const pending = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    analyze.mockImplementationOnce(async (sfen, conditions) => sekireiResult(sfen, conditions));
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const first = store.getState().startAnalysis('timed-game');
    await entered.promise;
    store.getState().stopAnalysis();
    pending.resolve(
      sekireiResult(shortGame().positions[1], {
        nodes: DEFAULT_SETTINGS.analysisNodes,
        multiPV: DEFAULT_SETTINGS.multiPV,
      }),
    );
    await first;
    const firstRun = store.getState().games[0].analysisRun!;
    expect(firstRun.completion).toBe('interrupted');
    expect(store.getState().games[0].analysis[0]).toBeDefined();

    // Run 2 reuses the ply-0 result instead of searching again.
    analyze.mockClear();
    analyze.mockImplementation(async (sfen, conditions) => sekireiResult(sfen, conditions));
    await store.getState().startAnalysis('timed-game');

    const game = store.getState().games[0];
    const run = game.analysisRun!;
    expect(run.completion).toBe('completed');
    expect(run.interrupted).toBe(false);
    // The reused row came from an interrupted run, but the record only keeps
    // this run's measured facts — the reuse origin is not tracked.
    expect('resumed' in run).toBe(false);
    expect(run.cacheReuseCount).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(2);
    // The reused row keeps its original runId — only fresh rows carry run 2's.
    expect(game.analysis[0].runId).toBe(firstRun.runId);
    expect(game.analysis[1].runId).toBe(run.runId);
    expect(game.analysis[2].runId).toBe(run.runId);
  });

  it('budget不足で一部局面が残ったrunはpartialとして記録される', async () => {
    const { store, analyze } = setup([shortGame()]);
    await store.getState().initialize();
    analyze.mockImplementationOnce(async (sfen, conditions) =>
      sekireiResult(sfen, conditions),
    );
    analyze.mockImplementationOnce(async (_sfen, conditions) => {
      throw new AnalysisBudgetIncompleteError(_sfen, conditions, {
        requestedNodes: conditions.nodes,
        nodes: conditions.nodes,
        completedDepth: 0,
        fallback: true,
        budgetReached: true,
      });
    });
    analyze.mockImplementationOnce(async (sfen, conditions) =>
      sekireiResult(sfen, conditions),
    );
    await store.getState().startAnalysis('timed-game');

    const game = store.getState().games[0];
    expect(game.analysisRun).toMatchObject({
      interrupted: false,
      completion: 'partial',
      cacheReuseCount: 0,
    });
    expect(game.analysis[1]).toBeUndefined();
    expect(game.analysis[0]).toBeDefined();
    expect(game.analysis[2]).toBeDefined();
  });
});

describe('タイミングのSQLite往復と後方互換', () => {
  function database(path: string) {
    const db = new DatabaseSync(path);
    const adapter: Database = {
      execAsync: async (sql) => db.exec(sql),
      runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
      getAllAsync: async <T>(sql: string, ...args: (string | number | null)[]) =>
        db.prepare(sql).all(...args) as T[],
    };
    return { db, repository: new LocalRepository(adapter) };
  }

  it('run記録と呼出し時間が永続化・復元される', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeshogi-timing-'));
    try {
      const game = {
        ...shortGame('persist-run'),
        analysis: {
          0: {
            ...sekireiResult(shortGame().positions[0], { nodes: 10000, multiPV: 2 }),
            callElapsedMs: 42,
            runId: 'sek-run-persisted',
          },
        },
        analysisRun: {
          runId: 'sek-run-persisted',
          conditions: { nodes: 10000, multiPV: 2 },
          wholeGameWallMs: 500,
          cacheReuseCount: 1,
          interrupted: false,
          completion: 'completed' as const,
          // Records written before the timing-classification change carry a
          // `resumed` flag: tolerated on read, never promoted to a fact.
          resumed: true,
        } as unknown as GameRecord['analysisRun'],
      };
      const path = join(dir, 'data.db');
      const first = database(path);
      await first.repository.initialize();
      await first.repository.insert(game);
      first.db.close();

      const second = database(path);
      await second.repository.initialize();
      const loaded = (await second.repository.load()).games[0];
      expect(loaded.analysisRun).toMatchObject({
        runId: 'sek-run-persisted',
        cacheReuseCount: 1,
        completion: 'completed',
      });
      expect(loaded.analysis[0].callElapsedMs).toBe(42);
      expect(loaded.analysis[0].runId).toBe('sek-run-persisted');
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('timing情報のない旧データは推測せずそのまま読める', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeshogi-timing-legacy-'));
    try {
      const legacy = {
        ...shortGame('legacy-game'),
        analysis: {
          0: {
            sfen: shortGame().positions[0],
            ...CURRENT_ANALYSIS_IDENTITY,
            status: 'complete' as const,
            meta: {
              requestedNodes: 10000,
              nodes: 5000,
              completedDepth: 4,
              fallback: false,
              budgetReached: false,
            },
            conditions: { nodes: 10000, multiPV: 2 },
            candidates: legalMoves(shortGame().positions[0])
              .slice(0, 2)
              .map((usi) => ({ usi, pv: [usi], depth: 4, scoreCp: 20, mate: null })),
            mateProof: null,
            // completedAt exists but must never be treated as timing.
            completedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };
      const path = join(dir, 'data.db');
      const first = database(path);
      await first.repository.initialize();
      await first.repository.insert(legacy);
      first.db.close();

      const second = database(path);
      await second.repository.initialize();
      const loaded = (await second.repository.load()).games[0];
      expect(loaded.analysisRun).toBeUndefined();
      expect(loaded.analysis[0].callElapsedMs).toBeUndefined();
      expect(loaded.analysis[0].runId).toBeUndefined();
      expect(loaded.analysis[0].completedAt).toBe('2026-01-01T00:00:00.000Z');
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
