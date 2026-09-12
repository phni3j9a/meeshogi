import { createStore } from 'zustand/vanilla';
import {
  DEFAULT_SETTINGS,
  type GameRecord,
  type ParsedGame,
  type PositionAnalysis,
  type Service,
  type Settings,
  type Side,
  type AnalysisConditions,
} from '../domain/model';
import { inferAttribution } from '../domain';
import type { LocalRepository } from '../storage/repository';

type AnalysisJob = {
  gameId: string;
  status: 'running' | 'paused' | 'error';
  completed: number;
  total: number;
  error?: string;
};
type ImportOptions = {
  service: Service;
  mySide?: Side | null;
  allowCollision?: boolean;
  autoAnalyze?: boolean;
};
type GamePatch = Partial<
  Pick<
    GameRecord,
    | 'favorite'
    | 'lastViewedPly'
    | 'lastOpenedAt'
    | 'mySide'
    | 'attribution'
    | 'service'
    | 'openings'
  >
>;
export interface AppState {
  ready: boolean;
  error: string | null;
  games: GameRecord[];
  settings: Settings;
  analysisJob: AnalysisJob | null;
  initialize(): Promise<void>;
  saveImport(parsed: ParsedGame, options: ImportOptions): Promise<GameRecord>;
  updateGame(id: string, patch: GamePatch): Promise<void>;
  deleteGame(id: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setLastViewed(id: string, ply: number): Promise<void>;
  startAnalysis(id: string): Promise<void>;
  stopAnalysis(): void;
  analyzePosition(sfen: string): Promise<PositionAnalysis>;
  clearError(): void;
}
interface Dependencies {
  openRepository(): Promise<LocalRepository>;
  analyze(sfen: string, conditions: AnalysisConditions): Promise<PositionAnalysis>;
  cancel(): void | Promise<void>;
  engineId: string;
  modelId: string;
  createId(): string;
}
export function makeAppStore(deps: Dependencies) {
  let repository: LocalRepository | undefined;
  let initialization: Promise<void> | undefined;
  let writes = Promise.resolve();
  let engineTail: Promise<unknown> = Promise.resolve();
  let cancellationBarrier: Promise<void> = Promise.resolve();
  let generation = 0;
  let focusGeneration = 0;
  const write = <T>(operation: () => Promise<T>) => {
    const pending = writes.then(operation);
    writes = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const engine = <T>(operation: () => Promise<T>) => {
    const pending = engineTail.then(async () => {
      // Android cancellation crosses an asynchronous native boundary. Drain
      // every cancellation already issued before letting a new search begin.
      let barrier: Promise<void>;
      do {
        barrier = cancellationBarrier;
        await barrier;
      } while (barrier !== cancellationBarrier);
      return operation();
    });
    engineTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  const repo = () => {
    if (!repository) throw new Error('保存データを読み込み中です。');
    return repository;
  };
  const store = createStore<AppState>((set, get) => {
    const report = (error: unknown) => {
      set({
        error:
          error instanceof Error ? error.message : '処理に失敗しました。もう一度お試しください。',
      });
    };
    const replaceGame = (game: GameRecord) =>
      set((state) => ({ games: state.games.map((g) => (g.id === game.id ? game : g)) }));
    const cancel = () => {
      try {
        const pending = Promise.resolve(deps.cancel()).catch(report);
        cancellationBarrier = Promise.all([cancellationBarrier, pending]).then(() => undefined);
      } catch (error) {
        report(error);
      }
    };
    return {
      ready: false,
      error: null,
      games: [],
      settings: { ...DEFAULT_SETTINGS, playerNames: { shogiwars: [], kiou: [], unknown: [] } },
      analysisJob: null,
      clearError: () => set({ error: null }),
      initialize: () => {
        if (!initialization)
          initialization = (async () => {
            try {
              repository = await deps.openRepository();
              const data = await repository.load();
              set({ ...data, ready: true, error: null });
            } catch (error) {
              report(error);
              initialization = undefined;
              throw error;
            }
          })();
        return initialization;
      },
      saveImport: (parsed, options) =>
        write(async () => {
          const duplicate = get().games.find((g) => g.identity === parsed.identity);
          if (duplicate)
            throw Object.assign(new Error('この棋譜は保存済みです。既存の棋譜を開けます。'), {
              existingId: duplicate.id,
            });
          const collision = get().games.find(
            (g) =>
              g.startedAt === parsed.startedAt &&
              g.blackName === parsed.blackName &&
              g.whiteName === parsed.whiteName,
          );
          if (collision && !options.allowCollision)
            throw Object.assign(
              new Error(
                '同じ日時・対局者の棋譜がありますが内容が異なります。別の対局として保存するか確認してください。',
              ),
              { existingId: collision.id, collision: true },
            );
          const selected = { ...parsed, service: options.service };
          const attribution =
            options.mySide !== undefined
              ? { mySide: options.mySide, attribution: 'manual' as const }
              : inferAttribution(selected, get().settings);
          const game: GameRecord = {
            ...selected,
            ...attribution,
            id: deps.createId(),
            createdAt: new Date().toISOString(),
            favorite: false,
            lastViewedPly: 0,
            analysis: {},
          };
          await repo().insert(game);
          set((state) => ({ games: [game, ...state.games], error: null }));
          if (options.autoAnalyze ?? get().settings.autoAnalyze) void get().startAnalysis(game.id);
          return game;
        }),
      updateGame: (id, patch) =>
        write(async () => {
          const previous = get().games.find((g) => g.id === id);
          if (!previous) throw new Error('棋譜が見つかりません。');
          const game = { ...previous, ...patch };
          if (
            patch.service !== undefined &&
            patch.mySide === undefined &&
            game.attribution !== 'manual'
          ) {
            Object.assign(game, inferAttribution(game, get().settings));
          }
          if (patch.lastViewedPly !== undefined)
            game.lastViewedPly = Math.max(
              0,
              Math.min(previous.moves.length, Math.trunc(patch.lastViewedPly)),
            );
          if (patch.mySide !== undefined) game.attribution = 'manual';
          await repo().save(game);
          replaceGame(game);
        }),
      deleteGame: (id) =>
        write(async () => {
          if (get().analysisJob?.gameId === id) {
            get().stopAnalysis();
            set({ analysisJob: null });
          }
          await repo().delete(id);
          set((state) => ({ games: state.games.filter((g) => g.id !== id) }));
        }),
      updateSettings: (patch) =>
        write(async () => {
          const settings = { ...get().settings, ...patch };
          settings.playerNames = Object.fromEntries(
            Object.entries(settings.playerNames).map(([service, names]) => [
              service,
              [...new Set(names.map((name) => name.trim()).filter(Boolean))],
            ]),
          ) as Settings['playerNames'];
          const reattributed = patch.playerNames
            ? get()
                .games.filter((g) => g.attribution !== 'manual')
                .map((g) => ({ ...g, ...inferAttribution(g, settings) }))
            : [];
          await repo().saveSettings(settings, reattributed);
          const updated = new Map(reattributed.map((g) => [g.id, g]));
          set((state) => ({ settings, games: state.games.map((g) => updated.get(g.id) ?? g) }));
        }),
      setLastViewed: (id, ply) =>
        get().updateGame(id, { lastViewedPly: ply, lastOpenedAt: new Date().toISOString() }),
      stopAnalysis: () => {
        generation++;
        focusGeneration++;
        cancel();
        const job = get().analysisJob;
        if (job?.status === 'running') set({ analysisJob: { ...job, status: 'paused' } });
      },
      startAnalysis: async (id) => {
        get().stopAnalysis();
        const run = ++generation;
        const game = get().games.find((g) => g.id === id);
        if (!game) return;
        const conditions = { nodes: get().settings.analysisNodes, multiPV: get().settings.multiPV };
        const reusable = (a: PositionAnalysis | undefined, sfen: string) =>
          a?.sfen === sfen &&
          a.engineId === deps.engineId &&
          a.modelId === deps.modelId &&
          a.conditions.nodes === conditions.nodes &&
          a.conditions.multiPV === conditions.multiPV;
        let completed = game.positions.filter((sfen, ply) =>
          reusable(game.analysis[ply], sfen),
        ).length;
        set({
          analysisJob: { gameId: id, status: 'running', completed, total: game.positions.length },
        });
        try {
          for (const [ply, sfen] of game.positions.entries()) {
            if (run !== generation) return;
            const current = get().games.find((g) => g.id === id);
            if (!current) return;
            if (reusable(current.analysis[ply], sfen)) continue;
            const result = await engine(async () => {
              if (run !== generation) throw new Error('解析を停止しました。');
              return deps.analyze(sfen, conditions);
            });
            if (run !== generation) return;
            if (
              result.sfen !== sfen ||
              result.engineId !== deps.engineId ||
              result.modelId !== deps.modelId
            )
              throw new Error('解析結果の局面またはモデルが一致しません。');
            await write(async () => {
              if (run !== generation) return;
              const latest = get().games.find((g) => g.id === id);
              if (!latest) return;
              const next = { ...latest, analysis: { ...latest.analysis, [ply]: result } };
              await repo().save(next);
              replaceGame(next);
            });
            if (run !== generation) return;
            completed++;
            set({
              analysisJob: {
                gameId: id,
                status: 'running',
                completed,
                total: game.positions.length,
              },
            });
          }
          if (run === generation) set({ analysisJob: null });
        } catch (error) {
          if (run === generation)
            set({
              analysisJob: {
                gameId: id,
                status: 'error',
                completed,
                total: game.positions.length,
                error: error instanceof Error ? error.message : '解析に失敗しました。',
              },
            });
        }
      },
      analyzePosition: async (sfen) => {
        const resumeId =
          get().analysisJob?.status === 'running' ? get().analysisJob?.gameId : undefined;
        get().stopAnalysis();
        const focus = ++focusGeneration;
        const conditions = {
          nodes: Math.min(1000000, get().settings.analysisNodes * 5),
          multiPV: get().settings.multiPV,
        };
        try {
          const result = await engine(async () => {
            if (focus !== focusGeneration) throw new Error('局面の解析を中止しました。');
            return deps.analyze(sfen, conditions);
          });
          if (focus !== focusGeneration) throw new Error('局面の解析を中止しました。');
          if (result.sfen !== sfen) throw new Error('解析結果の局面が一致しません。');
          return result;
        } finally {
          if (resumeId && focus === focusGeneration) void get().startAnalysis(resumeId);
        }
      },
    };
  });
  return store;
}
