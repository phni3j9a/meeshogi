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
import { getStatistics, legalMoves, parseKif } from '../../src/domain';
import { LocalRepository, type Database } from '../../src/storage/repository';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import { AnalysisBudgetIncompleteError } from '../../src/analysis/errors';

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
function shortGame(id = 'short-game'): GameRecord {
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
function budgetIncomplete(sfen: string, conditions: { nodes: number; multiPV: number }) {
  return new AnalysisBudgetIncompleteError(sfen, conditions, {
    requestedNodes: conditions.nodes,
    nodes: conditions.nodes,
    completedDepth: 0,
    fallback: true,
    budgetReached: true,
  });
}
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
    ): Promise<PositionAnalysis> => ({
      sfen,
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: conditions.nodes,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: false,
      },
      conditions,
      candidates: [{ usi: '7g7f', pv: ['7g7f'], depth: 1, scoreCp: 10, mate: null }],
      mateProof: null,
      completedAt: '2026-09-12',
    }),
  );
  let nextId = 0;
  const cancel = vi.fn<() => void | Promise<void>>();
  const store = makeAppStore({
    openRepository: async () => repository as unknown as LocalRepository,
    analyze,
    cancel,
    createId: () => String(++nextId),
  });
  return { store, repository, analyze, cancel, persisted: () => persisted };
}
describe('棋譜の更新と解析の隔離', () => {
  it('駒セットの変更は進行中の解析を止めず、同じ条件の結果を保存する', async () => {
    const { store, repository, analyze, cancel } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const pending = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    const firstResult = await analyze.getMockImplementation()!(game.positions[0], {
      nodes: DEFAULT_SETTINGS.analysisNodes,
      multiPV: DEFAULT_SETTINGS.multiPV,
    });
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const run = store.getState().startAnalysis(game.id);
    await entered.promise;
    cancel.mockClear();
    const runningJob = store.getState().analysisJob;
    await store.getState().updateSettings({ pieceSet: 'shiraki' });
    expect(store.getState().settings.pieceSet).toBe('shiraki');
    expect(store.getState().analysisJob).toBe(runningJob);
    expect(cancel).not.toHaveBeenCalled();
    expect(repository.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ pieceSet: 'shiraki' }),
      [],
    );
    pending.resolve(firstResult);
    await run;
    const analyzed = store.getState().games[0];
    expect(analyzed.rawKif).toBe(game.rawKif);
    // The stored row gains run timing fields on top of the analyze() result.
    expect(analyzed.analysis[0]).toMatchObject(firstResult);
    expect(Object.keys(analyzed.analysis)).toHaveLength(game.positions.length);
    expect(store.getState().settings.pieceSet).toBe('shiraki');
  });
  it('駒セットの保存失敗では元の選択を保ち、次の変更を保存できる', async () => {
    const { store, repository } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const savedSettings = store.getState().settings;
    repository.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.getState().updateSettings({ pieceSet: 'sakura' })).rejects.toThrow(
      'disk full',
    );
    expect(store.getState().settings).toBe(savedSettings);
    expect(store.getState().games).toEqual([game]);
    await store.getState().updateSettings({ pieceSet: 'seiji' });
    expect(store.getState().settings.pieceSet).toBe('seiji');
    expect(repository.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ pieceSet: 'seiji' }),
      [],
    );
  });
  it('旧DBを読み込み、停止・再開後のcurrent解析をSQLiteへ保存して再起動後も復元する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeshogi-store-db-'));
    const terminalSfen = '4k4/3RG4/9/9/9/9/9/9/8K w - 1';
    const conditions = { nodes: 10000, multiPV: 2 };
    const currentResult: PositionAnalysis = {
      sfen: terminalSfen,
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: 10000,
        nodes: 0,
        completedDepth: 0,
        fallback: false,
        budgetReached: false,
      },
      conditions,
      candidates: [],
      terminal: 'checkmate',
      mateProof: null,
      completedAt: '2026-09-22T00:00:00.000Z',
    };
    try {
      const parsed = fixture();
      const oldAnalysis = {
        sfen: terminalSfen,
        engineId: 'sekirei-v0.3.36@old',
        modelId: 'old-model',
        conditions,
        candidates: [],
        terminal: 'checkmate',
        mateProof: null,
        completedAt: '2026-09-12T00:00:00.000Z',
      } as unknown as PositionAnalysis;
      const oldGame: GameRecord = {
        ...parsed,
        id: 'old-db-game',
        createdAt: '2026-09-22T00:00:00.000Z',
        favorite: false,
        mySide: null,
        attribution: 'none',
        moves: [],
        positions: [terminalSfen],
        lastViewedPly: 0,
        analysis: { 0: oldAnalysis },
      };
      const path = join(dir, 'data.db');
      const first = database(path);
      await first.repository.initialize();
      await first.repository.insert(oldGame);
      first.db.close();

      const reopened = database(path);
      await reopened.repository.initialize();
      const entered = deferred<void>();
      const pending = deferred<PositionAnalysis>();
      const analyze = vi
        .fn<
          (
            sfen: string,
            conditions: { nodes: number; multiPV: number },
          ) => Promise<PositionAnalysis>
        >()
        .mockImplementationOnce(async () => {
          entered.resolve();
          return pending.promise;
        });
      const cancel = vi.fn<() => void | Promise<void>>();
      const store = makeAppStore({
        openRepository: async () => reopened.repository,
        analyze,
        cancel,
        createId: () => 'unused',
      });
      await store.getState().initialize();
      expect(store.getState().games[0].analysis[0]).toEqual(oldAnalysis);

      const interruptedRun = store.getState().startAnalysis(oldGame.id);
      await entered.promise;
      store.getState().stopAnalysis();
      pending.resolve(currentResult);
      await interruptedRun;
      expect((await reopened.repository.load()).games[0].analysis[0]).toEqual(oldAnalysis);

      analyze.mockResolvedValue(currentResult);
      await store.getState().startAnalysis(oldGame.id);
      expect((await reopened.repository.load()).games[0].analysis[0]).toMatchObject(currentResult);
      reopened.db.close();

      const afterRestart = database(path);
      await afterRestart.repository.initialize();
      expect((await afterRestart.repository.load()).games[0].analysis[0]).toMatchObject(
        currentResult,
      );
      afterRestart.db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it('再起動後も旧identityの解析を保持するが、完了件数と再解析の再利用対象にはしない', async () => {
    const parsed = fixture();
    const old = {
      sfen: parsed.positions[0],
      engineId: 'sekirei-v0.3.36@old',
      modelId: 'old-model',
      conditions: { nodes: 10000, multiPV: 2 },
      candidates: [],
      mateProof: null,
      completedAt: '2026-09-12',
    } as unknown as PositionAnalysis;
    const oldGame: GameRecord = {
      ...parsed,
      id: 'reloaded-old',
      createdAt: '2026-09-12',
      favorite: false,
      lastViewedPly: 0,
      mySide: null,
      attribution: 'none',
      analysis: { 0: old },
    };
    const { store, analyze, cancel } = setup([oldGame]);
    await store.getState().initialize();
    expect(store.getState().games[0].analysis[0]).toEqual(old);

    const entered = deferred<void>();
    const pending = deferred<PositionAnalysis>();
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const run = store.getState().startAnalysis(oldGame.id);
    await entered.promise;
    expect(store.getState().analysisJob).toMatchObject({
      completed: 0,
      total: parsed.positions.length,
    });
    store.getState().stopAnalysis();
    expect(cancel).toHaveBeenCalled();
    pending.resolve({
      sfen: parsed.positions[0],
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: 10000,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: false,
      },
      conditions: { nodes: 10000, multiPV: 2 },
      candidates: [],
      mateProof: null,
      completedAt: 'now',
    });
    await run;
    expect(store.getState().games[0].analysis[0]).toEqual(old);
  });

  it('解析条件の保存後は古い処理を止め、新しい条件で再開する', async () => {
    const { store, analyze, cancel } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const pending = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const run = store.getState().startAnalysis(game.id);
    await entered.promise;
    await store.getState().updateSettings({ analysisNodes: 1000, multiPV: 1 });
    expect(cancel).toHaveBeenCalled();
    expect(store.getState().analysisJob).toBeNull();
    pending.resolve({
      sfen: game.positions[0],
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: 10000,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: false,
      },
      conditions: { nodes: 10000, multiPV: 2 },
      candidates: [],
      mateProof: null,
      completedAt: 'now',
    });
    await run;
    expect(store.getState().games[0].analysis).toEqual({});
    await store.getState().startAnalysis(game.id);
    expect(Object.values(store.getState().games[0].analysis)).toHaveLength(game.positions.length);
    expect(
      Object.values(store.getState().games[0].analysis).every(
        (result) => result.conditions.nodes === 1000 && result.conditions.multiPV === 1,
      ),
    ).toBe(true);
  });
  it('同時取り込みでも重複を作らない', async () => {
    const { store, repository } = setup();
    await store.getState().initialize();
    const results = await Promise.allSettled([
      store.getState().saveImport(fixture(), { service: 'shogiwars' }),
      store.getState().saveImport(fixture(), { service: 'shogiwars' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(repository.insert).toHaveBeenCalledTimes(1);
    expect(store.getState().games).toHaveLength(1);
  });
  it.each(['2026/9/8 19:36:45', '2026-09-08 19:36:45'])(
    '日時が%s表記でも保存済みの同一局として扱い、原本を保つ',
    async (date) => {
      const { store, persisted } = setup();
      await store.getState().initialize();
      const original = fixture();
      const game = await store.getState().saveImport(original, { service: 'shogiwars' });
      const variant = parseKif(original.rawKif.replace(original.startedAt, date));
      expect(variant.identity).not.toBe(original.identity);
      await expect(
        store.getState().saveImport(variant, { service: 'shogiwars' }),
      ).rejects.toMatchObject({ existingId: game.id });
      expect(persisted()).toHaveLength(1);
      expect(persisted()[0].rawKif).toBe(original.rawKif);
      expect(persisted()[0].identity).toBe(original.identity);
    },
  );
  it('同じ日時・対局者で内容が違う棋譜は表記揺れがあっても確認を求める', async () => {
    const { store } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const alternative = parseKif(
      '開始日時：2026/9/8 19:36:45\n先手：KeroPona\n後手：asitaka_y\n手数----指手---------消費時間--\n1 ２六歩(27)\n2 投了\n',
    );
    await expect(
      store.getState().saveImport(alternative, { service: 'shogiwars' }),
    ).rejects.toMatchObject({ existingId: game.id, collision: true });
    expect(store.getState().games).toHaveLength(1);
    await store.getState().saveImport(alternative, { service: 'shogiwars', allowCollision: true });
    expect(store.getState().games).toHaveLength(2);
  });
  it('先後の戦型を連続保存しても両者の修正が残り、片側だけ自動に戻せる', async () => {
    const { store, repository, persisted } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const pending = deferred<void>();
    const entered = deferred<void>();
    const save = repository.save.getMockImplementation()!;
    repository.save.mockImplementationOnce(async (value) => {
      entered.resolve();
      await pending.promise;
      await save(value);
    });
    const black = store.getState().updateOpening(game.id, 'black', 'static');
    await entered.promise;
    const white = store.getState().updateOpening(game.id, 'white', 'fourth-file');
    pending.resolve();
    await Promise.all([black, white]);
    expect(persisted()[0].openings).toMatchObject({
      black: { manual: 'static' },
      white: { manual: 'fourth-file' },
    });
    await store.getState().updateOpening(game.id, 'black', null);
    expect(persisted()[0].openings).toMatchObject({
      black: { manual: null },
      white: { manual: 'fourth-file' },
    });
  });
  it('書き込み失敗時は保存できたように見せず次回再試行できる', async () => {
    const { store, repository } = setup();
    await store.getState().initialize();
    repository.insert.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.getState().saveImport(fixture(), { service: 'shogiwars' })).rejects.toThrow(
      'disk full',
    );
    expect(store.getState().games).toHaveLength(0);
    await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    expect(store.getState().games).toHaveLength(1);
  });
  it('停止後に届く結果を本譜に保存しない', async () => {
    const { store, analyze } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const pending = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const run = store.getState().startAnalysis(game.id);
    await entered.promise;
    store.getState().stopAnalysis();
    pending.resolve({
      sfen: game.positions[0],
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: 10000,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: false,
      },
      conditions: { nodes: 10000, multiPV: 2 },
      candidates: [],
      mateProof: null,
      completedAt: 'now',
    });
    await run;
    expect(store.getState().games[0].analysis).toEqual({});
    expect(store.getState().analysisJob?.status).toBe('paused');
  });
  it('分岐の追加解析は本譜の保存結果を書き換えない', async () => {
    const { store } = setup();
    await store.getState().initialize();
    await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const result = await store.getState().analyzePosition(fixture().positions[1]);
    expect(result.sfen).toBe(fixture().positions[1]);
    expect(store.getState().games[0].analysis).toEqual({});
  });
  it('旧キャンセルが完了するまで新しい局面解析を開始しない', async () => {
    const { store, analyze, cancel } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const initial = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return initial.promise;
    });
    const run = store.getState().startAnalysis(game.id);
    await entered.promise;
    const cancellation = deferred<void>();
    cancel.mockImplementationOnce(() => cancellation.promise);
    const focused = store.getState().analyzePosition(game.positions[1]);
    initial.resolve({
      sfen: game.positions[0],
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: 10000,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: false,
      },
      conditions: { nodes: 10000, multiPV: 2 },
      candidates: [],
      mateProof: null,
      completedAt: 'now',
    });
    await run;
    await new Promise((resolve) => setImmediate(resolve));
    expect(analyze).toHaveBeenCalledTimes(1);
    cancellation.resolve();
    expect((await focused).sfen).toBe(game.positions[1]);
    store.getState().stopAnalysis();
    expect(store.getState().games[0].analysis).toEqual({});
  });
  it('名前変更で手動帰属を保持し自動帰属のみ更新する', async () => {
    const { store, repository } = setup();
    await store.getState().initialize();
    const game = await store
      .getState()
      .saveImport(fixture(), { service: 'shogiwars', mySide: 'black' });
    await store
      .getState()
      .updateSettings({ playerNames: { shogiwars: ['asitaka_y'], kiou: [], unknown: [] } });
    expect(store.getState().games[0].mySide).toBe('black');
    expect(store.getState().games[0].attribution).toBe('manual');
    expect(repository.saveSettings.mock.calls[0]?.[1]).toEqual([]);
    await store.getState().updateGame(game.id, { favorite: true });
    expect(store.getState().games[0].favorite).toBe(true);
  });
  it('取込時と保存後に結果を修正し原本の結果へ戻せる', async () => {
    const { store, persisted } = setup();
    await store.getState().initialize();
    const parsed = fixture();
    const game = await store
      .getState()
      .saveImport(parsed, { service: 'shogiwars', mySide: 'white', manualResult: 'black-win' });
    expect(getStatistics(store.getState().games).losses).toBe(1);
    await store.getState().updateGame(game.id, { manualResult: 'draw' });
    expect(getStatistics(store.getState().games).draws).toBe(1);
    expect(persisted()[0]).toMatchObject({
      rawKif: parsed.rawKif,
      result: parsed.result,
      manualResult: 'draw',
    });
    await store.getState().updateGame(game.id, { manualResult: null });
    expect(getStatistics(store.getState().games).wins).toBe(1);
  });
  it('連続した局面解析の置換後も中断した全局解析へ戻る', async () => {
    const { store, analyze } = setup();
    await store.getState().initialize();
    const game = await store.getState().saveImport(fixture(), { service: 'shogiwars' });
    const pending = Array.from({ length: 4 }, () => deferred<PositionAnalysis>());
    const entered = Array.from({ length: 4 }, () => deferred<void>());
    let call = 0;
    analyze.mockImplementation(async () => {
      const index = call++;
      entered[index].resolve();
      return pending[index].promise;
    });
    const result = (sfen: string): PositionAnalysis => ({
      sfen,
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: 50000,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: false,
      },
      conditions: { nodes: 50000, multiPV: 2 },
      candidates: [],
      mateProof: null,
      completedAt: 'now',
    });
    const all = store.getState().startAnalysis(game.id);
    await entered[0].promise;
    const firstFocus = store.getState().analyzePosition(game.positions[1]);
    const firstCancelled = expect(firstFocus).rejects.toThrow('中止');
    pending[0].resolve(result(game.positions[0]));
    await all;
    await entered[1].promise;
    const secondFocus = store.getState().analyzePosition(game.positions[2]);
    pending[1].resolve(result(game.positions[1]));
    await firstCancelled;
    await entered[2].promise;
    pending[2].resolve(result(game.positions[2]));
    await secondFocus;
    await entered[3].promise;
    expect(store.getState().analysisJob).toMatchObject({ gameId: game.id, status: 'running' });
    store.getState().stopAnalysis();
    pending[3].resolve(result(game.positions[0]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getState().games[0].analysis).toEqual({});
  });
});

describe('探索量不足の局面単位スキップ', () => {
  const conditions = { nodes: 10000, multiPV: 2 };
  const resultFor = (sfen: string, requested = conditions): PositionAnalysis => {
    const candidates = legalMoves(sfen)
      .slice(0, requested.multiPV)
      .map((usi, index) => ({
        usi,
        pv: [usi],
        depth: 1,
        scoreCp: index,
        mate: null,
      }));
    return {
      sfen,
      ...CURRENT_ANALYSIS_IDENTITY,
      status: 'complete',
      meta: {
        requestedNodes: requested.nodes,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: false,
      },
      conditions: requested,
      candidates,
      mateProof: null,
      completedAt: 'now',
    };
  };

  it('success→shortfall→success reaches the last position without saving the fallback', async () => {
    const game = shortGame('skip-middle');
    const { store, analyze, persisted } = setup([game]);
    await store.getState().initialize();
    const calls: string[] = [];
    analyze.mockImplementation(async (sfen, requested) => {
      calls.push(sfen);
      if (calls.length === 2) throw budgetIncomplete(sfen, requested);
      return resultFor(sfen, requested);
    });

    await store.getState().startAnalysis(game.id);

    expect(calls).toEqual(game.positions);
    expect(Object.keys(persisted()[0].analysis).map(Number)).toEqual([0, 2]);
    expect(store.getState().analysisJob).toMatchObject({
      gameId: game.id,
      status: 'partial',
      completed: 2,
      total: 3,
      budgetShortfallPlies: [1],
    });
  });

  it('retries only the missing position on an explicit resume and clears partial state after success', async () => {
    const game = shortGame('resume-missing');
    const { store, analyze } = setup([game]);
    await store.getState().initialize();
    // Seed the same partial run through the native-boundary error type.
    analyze.mockReset();
    const firstCalls: string[] = [];
    analyze.mockImplementation(async (sfen, requested) => {
      firstCalls.push(sfen);
      if (firstCalls.length === 2) throw budgetIncomplete(sfen, requested);
      return resultFor(sfen, requested);
    });
    await store.getState().startAnalysis(game.id);

    analyze.mockReset();
    const resumedCalls: string[] = [];
    analyze.mockImplementation(async (sfen, requested) => {
      resumedCalls.push(sfen);
      return resultFor(sfen, requested);
    });
    await store.getState().startAnalysis(game.id);

    expect(resumedCalls).toEqual([game.positions[1]]);
    expect(store.getState().analysisJob).toBeNull();
    expect(Object.keys(store.getState().games[0].analysis).map(Number)).toEqual([0, 1, 2]);
  });

  it('finishes in a finite pass when every position is below budget', async () => {
    const game = shortGame('skip-all');
    const { store, analyze, persisted } = setup([game]);
    await store.getState().initialize();
    analyze.mockImplementation(async (sfen, requested) => {
      throw budgetIncomplete(sfen, requested);
    });

    await store.getState().startAnalysis(game.id);

    expect(analyze).toHaveBeenCalledTimes(game.positions.length);
    expect(persisted()[0].analysis).toEqual({});
    expect(store.getState().analysisJob).toMatchObject({
      status: 'partial',
      completed: 0,
      total: 3,
      budgetShortfallPlies: [0, 1, 2],
    });
  });

  it('keeps ordinary analysis and save errors fatal', async () => {
    const game = shortGame('ordinary-errors');
    const ordinary = setup([game]);
    await ordinary.store.getState().initialize();
    ordinary.analyze.mockImplementationOnce(async () => {
      throw new Error('native failure');
    });
    await ordinary.store.getState().startAnalysis(game.id);
    expect(ordinary.analyze).toHaveBeenCalledTimes(1);
    expect(ordinary.store.getState().analysisJob).toMatchObject({
      status: 'error',
      completed: 0,
    });

    const saveFailure = setup([shortGame('save-failure')]);
    await saveFailure.store.getState().initialize();
    saveFailure.analyze.mockImplementation(async (sfen, requested) => resultFor(sfen, requested));
    saveFailure.repository.save.mockRejectedValueOnce(new Error('disk full'));
    await saveFailure.store.getState().startAnalysis('save-failure');
    expect(saveFailure.analyze).toHaveBeenCalledTimes(1);
    expect(saveFailure.store.getState().analysisJob).toMatchObject({
      status: 'error',
      completed: 0,
    });
  });

  it('does not record a late budget response after stop', async () => {
    const game = shortGame('stop-race');
    const { store, analyze, persisted } = setup([game]);
    await store.getState().initialize();
    const pending = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    analyze.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const run = store.getState().startAnalysis(game.id);
    await entered.promise;
    store.getState().stopAnalysis();
    pending.reject(budgetIncomplete(game.positions[0], conditions));
    await run;

    expect(persisted()[0].analysis).toEqual({});
    expect(store.getState().analysisJob).toMatchObject({ status: 'paused' });
    expect(store.getState().analysisJob).not.toMatchObject({ budgetShortfallPlies: [0] });
  });

  it('does not record a late budget response after settings change or deletion', async () => {
    const settingsGame = shortGame('settings-race');
    const settingsSetup = setup([settingsGame]);
    await settingsSetup.store.getState().initialize();
    const settingsPending = deferred<PositionAnalysis>();
    const settingsEntered = deferred<void>();
    settingsSetup.analyze.mockImplementationOnce(async () => {
      settingsEntered.resolve();
      return settingsPending.promise;
    });
    const settingsRun = settingsSetup.store.getState().startAnalysis(settingsGame.id);
    await settingsEntered.promise;
    await settingsSetup.store.getState().updateSettings({ analysisNodes: 50000 });
    settingsPending.reject(budgetIncomplete(settingsGame.positions[0], conditions));
    await settingsRun;
    expect(settingsSetup.store.getState().analysisJob).toBeNull();
    expect(settingsSetup.persisted()[0].analysis).toEqual({});

    const deleteGame = shortGame('delete-race');
    const deleteSetup = setup([deleteGame]);
    await deleteSetup.store.getState().initialize();
    const deletePending = deferred<PositionAnalysis>();
    const deleteEntered = deferred<void>();
    deleteSetup.analyze.mockImplementationOnce(async () => {
      deleteEntered.resolve();
      return deletePending.promise;
    });
    const deleteRun = deleteSetup.store.getState().startAnalysis(deleteGame.id);
    await deleteEntered.promise;
    const deleting = deleteSetup.store.getState().deleteGame(deleteGame.id);
    deletePending.reject(budgetIncomplete(deleteGame.positions[0], conditions));
    await Promise.all([deleting, deleteRun]);
    expect(deleteSetup.store.getState().games).toEqual([]);
    expect(deleteSetup.store.getState().analysisJob).toBeNull();
  });

  it('does not let a replaced job receive a budget response from the previous job', async () => {
    const firstGame = shortGame('first-job');
    const secondGame = shortGame('second-job');
    const { store, analyze } = setup([firstGame, secondGame]);
    await store.getState().initialize();
    const pending = deferred<PositionAnalysis>();
    const entered = deferred<void>();
    let firstCall = true;
    analyze.mockImplementation(async (sfen, requested) => {
      if (firstCall) {
        firstCall = false;
        entered.resolve();
        return pending.promise;
      }
      return resultFor(sfen, requested);
    });
    const firstRun = store.getState().startAnalysis(firstGame.id);
    await entered.promise;
    const secondRun = store.getState().startAnalysis(secondGame.id);
    pending.resolve(resultFor(firstGame.positions[0], conditions));
    await Promise.all([firstRun, secondRun]);

    expect(store.getState().games.find((game) => game.id === firstGame.id)?.analysis).toEqual({});
    expect(
      Object.keys(store.getState().games.find((game) => game.id === secondGame.id)!.analysis),
    ).toHaveLength(secondGame.positions.length);
    expect(store.getState().analysisJob).toBeNull();
  });

  it('does not persist partial-job details, while successful positions survive SQLite reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeshogi-partial-db-'));
    try {
      const path = join(dir, 'data.db');
      const first = database(path);
      await first.repository.initialize();
      const game = shortGame('sqlite-partial');
      await first.repository.insert(game);
      const store = makeAppStore({
        openRepository: async () => first.repository,
        analyze: vi.fn(async (sfen, requested) => {
          if (sfen === game.positions[1]) throw budgetIncomplete(sfen, requested);
          return resultFor(sfen, requested);
        }),
        cancel: vi.fn<() => void | Promise<void>>(),
        createId: () => 'unused',
      });
      await store.getState().initialize();
      await store.getState().startAnalysis(game.id);
      const loaded = await first.repository.load();
      expect(Object.keys(loaded.games[0].analysis).map(Number)).toEqual([0, 2]);
      expect(store.getState().analysisJob).toMatchObject({ status: 'partial' });
      first.db.close();

      const second = database(path);
      await second.repository.initialize();
      const restarted = await second.repository.load();
      expect(Object.keys(restarted.games[0].analysis).map(Number)).toEqual([0, 2]);
      expect(restarted.games[0].analysis[1]).toBeUndefined();
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
