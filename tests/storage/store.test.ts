import { describe, it, expect, vi } from 'vitest';
import { makeAppStore } from '../../src/store/create-app-store';
import {
  DEFAULT_SETTINGS,
  type GameRecord,
  type PositionAnalysis,
  type Settings,
} from '../../src/domain/model';
import { getStatistics, parseKif } from '../../src/domain';
import { readFileSync } from 'node:fs';
import type { LocalRepository } from '../../src/storage/repository';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const fixture = () => parseKif(readFileSync('fixtures/kif/shogiwars.kif', 'utf8'));
function setup() {
  let persisted: GameRecord[] = [];
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
      engineId: 'engine',
      modelId: 'model',
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
    engineId: 'engine',
    modelId: 'model',
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
    expect(analyzed.analysis[0]).toEqual(firstResult);
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
      engineId: 'engine',
      modelId: 'model',
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
      engineId: 'engine',
      modelId: 'model',
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
      engineId: 'engine',
      modelId: 'model',
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
      engineId: 'engine',
      modelId: 'model',
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
