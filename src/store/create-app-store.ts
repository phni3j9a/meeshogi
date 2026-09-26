import { createStore } from 'zustand/vanilla';
import {
  DEFAULT_SETTINGS,
  cloudProfileOf,
  type GameRecord,
  type ParsedGame,
  type PositionAnalysis,
  type Service,
  type Settings,
  type Side,
  type AnalysisConditions,
  type GameResult,
  type Opening,
} from '../domain/model';
import { inferAttribution, sameGameOccasion, sameRecordedGame } from '../domain';
import type { LocalRepository } from '../storage/repository';
import { attemptBlocksDelete, type CloudAttempt } from '../cloud/contract';
import {
  toCloudPositionResult,
  validateCloudResult,
  type CloudPositionResult,
} from '../cloud/results';
import { makeCloudController, type CloudDeps } from './cloud-controller';
import { isCompatibleAnalysis } from '../analysis/cache';
import { AnalysisBudgetIncompleteError } from '../analysis/errors';
import type { AnalysisJob } from './analysis-job';
type ImportOptions = {
  service: Service;
  mySide?: Side | null;
  allowCollision?: boolean;
  autoAnalyze?: boolean;
  manualResult?: GameResult | null;
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
    | 'manualResult'
  >
>;
export interface AppState {
  ready: boolean;
  error: string | null;
  games: GameRecord[];
  settings: Settings;
  analysisJob: AnalysisJob | null;
  cloudAttempts: CloudAttempt[];
  /** Validated display rows keyed by attemptId; incomplete plies are absent. */
  cloudResults: Record<string, CloudPositionResult[]>;
  cloudLoadError: string | null;
  initialize(): Promise<void>;
  saveImport(parsed: ParsedGame, options: ImportOptions): Promise<GameRecord>;
  updateGame(id: string, patch: GamePatch): Promise<void>;
  updateOpening(id: string, side: Side, manual: Opening | null): Promise<void>;
  deleteGame(id: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setLastViewed(id: string, ply: number): Promise<void>;
  startAnalysis(id: string): Promise<void>;
  stopAnalysis(): void;
  analyzePosition(sfen: string): Promise<PositionAnalysis>;
  /** Start or reconnect a Cloud attempt for the game under the selected method. */
  startCloudAnalysis(id: string): Promise<void>;
  cancelCloudAnalysis(attemptId: string): Promise<void>;
  loadCloudResults(gameId: string): Promise<void>;
  resumeCloudJobs(): void;
  pauseCloudJobs(): void;
  clearError(): void;
}
export type { AnalysisJob } from './analysis-job';
interface Dependencies {
  openRepository(): Promise<LocalRepository>;
  analyze(sfen: string, conditions: AnalysisConditions): Promise<PositionAnalysis>;
  cancel(): void | Promise<void>;
  createId(): string;
  /** Cloud job integration. Absent in environments without a configured client. */
  cloud?: CloudDeps;
}
export function makeAppStore(deps: Dependencies) {
  let repository: LocalRepository | undefined;
  let initialization: Promise<void> | undefined;
  let writes = Promise.resolve();
  let engineTail: Promise<unknown> = Promise.resolve();
  let cancellationBarrier: Promise<void> = Promise.resolve();
  let generation = 0;
  let focusGeneration = 0;
  let focusResumeId: string | undefined;
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
    const cloud = deps.cloud
      ? makeCloudController(deps.cloud, {
          getAttempts: () => get().cloudAttempts,
          getGame: (id) => get().games.find((g) => g.id === id),
          getCloudMethodProfile: () => cloudProfileOf(get().settings.analysisMethod),
          getCloudPositions: (id) => get().games.find((g) => g.id === id)?.positions,
          repo,
          write,
          setAttempts: (fn) => set((state) => ({ cloudAttempts: fn(state.cloudAttempts) })),
          onResultsCommitted: (attemptId, rows) =>
            set((state) => {
              const byPly = new Map<number, CloudPositionResult>();
              for (const result of state.cloudResults[attemptId] ?? []) byPly.set(result.ply, result);
              for (const row of rows) byPly.set(row.ply, toCloudPositionResult(row));
              return {
                cloudResults: {
                  ...state.cloudResults,
                  [attemptId]: [...byPly.values()].sort((a, b) => a.ply - b.ply),
                },
              };
            }),
        })
      : undefined;
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
      cloudAttempts: [],
      cloudResults: {},
      cloudLoadError: null,
      clearError: () => set({ error: null }),
      initialize: () => {
        if (!initialization)
          initialization = (async () => {
            try {
              repository = await deps.openRepository();
              const data = await repository.load();
              let cloudAttempts: CloudAttempt[] = [];
              let cloudLoadError: string | null = null;
              if (deps.cloud && repository.cloud) {
                try {
                  cloudAttempts = await repository.cloud.attempts();
                } catch {
                  // Cloud read errors must never block game loading.
                  cloudLoadError =
                    'Cloud解析の保存データを読み込めませんでした。端末内解析と棋譜は通常どおり使えます。';
                }
              }
              set({ ...data, cloudAttempts, cloudLoadError, ready: true, error: null });
              cloud?.resume();
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
          const duplicate = get().games.find(
            (g) => g.identity === parsed.identity || sameRecordedGame(g, parsed),
          );
          if (duplicate)
            throw Object.assign(new Error('この棋譜は保存済みです。既存の棋譜を開けます。'), {
              existingId: duplicate.id,
            });
          const collision = get().games.find((g) => sameGameOccasion(g, parsed));
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
            manualResult: options.manualResult ?? null,
            id: deps.createId(),
            createdAt: new Date().toISOString(),
            favorite: false,
            lastViewedPly: 0,
            analysis: {},
          };
          await repo().insert(game);
          set((state) => ({ games: [game, ...state.games], error: null }));
          if (options.autoAnalyze ?? get().settings.autoAnalyze) {
            if (get().settings.analysisMethod === 'sekirei') {
              void get().startAnalysis(game.id);
            } else {
              void get()
                .startCloudAnalysis(game.id)
                .catch(() => undefined);
            }
          }
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
      updateOpening: (id, side, manual) =>
        write(async () => {
          const previous = get().games.find((g) => g.id === id);
          if (!previous) throw new Error('棋譜が見つかりません。');
          const game = {
            ...previous,
            openings: {
              ...previous.openings,
              [side]: { ...previous.openings[side], manual },
            },
          };
          await repo().save(game);
          replaceGame(game);
        }),
      deleteGame: (id) =>
        write(async () => {
          const blocking = get().cloudAttempts.find(
            (attempt) => attempt.gameId === id && attemptBlocksDelete(attempt),
          );
          if (blocking) {
            throw new Error(
              'この棋譜はCloud解析を実行中または未回収です。Cloud解析を取消してから削除してください。',
            );
          }
          if (get().analysisJob?.gameId === id) {
            get().stopAnalysis();
            set({ analysisJob: null });
          }
          await repo().delete(id);
          // The FK cascade removes attempt/result rows; drop their in-memory
          // copies so late results can never reappear for a deleted game.
          const gone = new Set(
            get()
              .cloudAttempts.filter((attempt) => attempt.gameId === id)
              .map((attempt) => attempt.attemptId),
          );
          set((state) => ({
            games: state.games.filter((g) => g.id !== id),
            cloudAttempts: state.cloudAttempts.filter((attempt) => attempt.gameId !== id),
            cloudResults: Object.fromEntries(
              Object.entries(state.cloudResults).filter(([attemptId]) => !gone.has(attemptId)),
            ),
          }));
        }),
      updateSettings: (patch) =>
        write(async () => {
          const settings = { ...get().settings, ...patch };
          const analysisChanged =
            settings.analysisNodes !== get().settings.analysisNodes ||
            settings.multiPV !== get().settings.multiPV;
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
          if (analysisChanged) get().stopAnalysis();
          const updated = new Map(reattributed.map((g) => [g.id, g]));
          set((state) => ({
            settings,
            games: state.games.map((g) => updated.get(g.id) ?? g),
            ...(analysisChanged ? { analysisJob: null } : {}),
          }));
        }),
      setLastViewed: (id, ply) =>
        get().updateGame(id, { lastViewedPly: ply, lastOpenedAt: new Date().toISOString() }),
      stopAnalysis: () => {
        generation++;
        focusGeneration++;
        focusResumeId = undefined;
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
          isCompatibleAnalysis(a, sfen, conditions);
        let completed = game.positions.filter((sfen, ply) =>
          reusable(game.analysis[ply], sfen),
        ).length;
        const budgetShortfallPlies: number[] = [];
        const makeJob = (status: AnalysisJob['status'], error?: string): AnalysisJob => ({
          gameId: id,
          status,
          completed,
          total: game.positions.length,
          budgetShortfallPlies: [...budgetShortfallPlies],
          ...(error === undefined ? {} : { error }),
        });
        const isCurrentRun = () => {
          const current = get().games.find((item) => item.id === id);
          return (
            run === generation &&
            !!current &&
            get().settings.analysisNodes === conditions.nodes &&
            get().settings.multiPV === conditions.multiPV
          );
        };
        set({ analysisJob: makeJob('running') });
        try {
          for (const [ply, sfen] of game.positions.entries()) {
            if (!isCurrentRun()) return;
            const current = get().games.find((g) => g.id === id);
            if (!current) return;
            if (reusable(current.analysis[ply], sfen)) continue;
            let result: PositionAnalysis;
            try {
              result = await engine(async () => {
                if (!isCurrentRun()) throw new Error('解析を停止しました。');
                return deps.analyze(sfen, conditions);
              });
            } catch (error) {
              if (!(error instanceof AnalysisBudgetIncompleteError)) throw error;
              // A budget shortfall is recoverable only for the still-current
              // run.  Cancellation, settings changes, deletion, and another
              // job must invalidate this response before it changes state.
              if (!isCurrentRun()) return;
              budgetShortfallPlies.push(ply);
              set({ analysisJob: makeJob('running') });
              continue;
            }
            if (!isCurrentRun()) return;
            if (!reusable(result, sfen))
              throw new Error('解析結果の局面・モデル・条件が一致しません。');
            await write(async () => {
              if (!isCurrentRun()) return;
              const latest = get().games.find((g) => g.id === id);
              if (!latest) return;
              const next = { ...latest, analysis: { ...latest.analysis, [ply]: result } };
              await repo().save(next);
              replaceGame(next);
            });
            if (!isCurrentRun()) return;
            completed++;
            set({ analysisJob: makeJob('running') });
          }
          if (!isCurrentRun()) return;
          set({
            analysisJob: budgetShortfallPlies.length ? makeJob('partial') : null,
          });
        } catch (error) {
          if (isCurrentRun())
            set({
              analysisJob: makeJob(
                'error',
                error instanceof Error ? error.message : '解析に失敗しました。',
              ),
            });
        }
      },
      analyzePosition: async (sfen) => {
        const resumeId =
          get().analysisJob?.status === 'running' ? get().analysisJob?.gameId : focusResumeId;
        get().stopAnalysis();
        focusResumeId = resumeId;
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
          if (!isCompatibleAnalysis(result, sfen, conditions))
            throw new Error('解析結果の局面・モデル・条件が一致しません。');
          return result;
        } finally {
          if (focus === focusGeneration) {
            focusResumeId = undefined;
            if (resumeId) void get().startAnalysis(resumeId);
          }
        }
      },
      startCloudAnalysis: async (id) => {
        if (!cloud) throw new Error('Cloud解析はこの環境では利用できません。');
        await cloud.start(id);
      },
      cancelCloudAnalysis: async (attemptId) => {
        if (!cloud) return;
        await cloud.cancel(attemptId);
      },
      loadCloudResults: async (gameId) => {
        const cloudRepo = deps.cloud && repository?.cloud;
        if (!cloudRepo) return;
        const attempts = get().cloudAttempts.filter((attempt) => attempt.gameId === gameId);
        const game = get().games.find((g) => g.id === gameId);
        const loaded = await write(() =>
          Promise.all(
            attempts.map(
              async (attempt) =>
                [attempt, await cloudRepo.results(attempt.attemptId)] as const,
            ),
          ),
        );
        set((state) => {
          const cloudResults = { ...state.cloudResults };
          for (const [attempt, rows] of loaded) {
            if (!game || attempt.gameIdentity !== game.identity) continue;
            const results: CloudPositionResult[] = [];
            for (const row of rows) {
              const expected = game.positions[row.ply];
              if (expected === undefined) continue;
              const valid = validateCloudResult(row, expected, attempt.profileId);
              if (valid) results.push(toCloudPositionResult(valid));
            }
            cloudResults[attempt.attemptId] = results;
          }
          return { cloudResults };
        });
      },
      resumeCloudJobs: () => cloud?.resume(),
      pauseCloudJobs: () => cloud?.pause(),
    };
  });
  return store;
}
