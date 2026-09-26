import { CURRENT_ANALYSIS_IDENTITY } from '../analysis/identity';
import { isCompatibleAnalysis } from '../analysis/cache';
import { CLOUD_PROFILES, type CloudAttempt, type CloudProfileId } from '../cloud/contract';
import { toCloudPositionResult, validateCloudResult } from '../cloud/results';
import type { PersistedCloudResult } from '../storage/cloud-repository';
import type {
  AnalysisCandidate,
  AnalysisConditions,
  GameRecord,
  PositionAnalysis,
} from '../domain/model';
import {
  COMPARISON_EXPORT_SCHEMA,
  COMPARISON_EXPORT_SCHEMA_VERSION,
  type CloudMethodExport,
  type ComparisonExport,
  type ExportScore,
  type PlyResult,
  type PlyRow,
  type SekireiMethodExport,
} from './schema.ts';

/**
 * In-app writer for the `meeshogi-comparison-export` v1 document (Plan §5).
 * Maps only stored, already-validated facts: never invents evaluations, times,
 * or winners. A stored row that fails validation becomes 'missing', not a
 * zero-filled or guessed value. No credentials, tokens, or endpoint strings
 * are written — the export carries no field that could hold them.
 */

export interface ComparisonExportInput {
  game: GameRecord;
  /** Stored Cloud attempts for this game (already filtered to game.identity). */
  attempts: CloudAttempt[];
  /** Persisted Cloud result rows keyed by attemptId. */
  results: Record<string, PersistedCloudResult[]>;
  generator: ComparisonExport['generator'];
  exportedAt: string;
}

export type Sha256Hex = (text: string) => Promise<string>;

const METHOD_FOR_PROFILE = { free: 'cloud-free', precision: 'cloud-precision' } as const;

/** SFEN side-to-move: 'b' → black. Export vocabulary uses black/white. */
function sideToMove(sfen: string): 'black' | 'white' | null {
  const turn = sfen.split(' ')[1];
  return turn === 'b' ? 'black' : turn === 'w' ? 'white' : null;
}

/** A checkmate position's winner is the side NOT to move; stalemate has none. */
function terminalWinner(kind: 'checkmate' | 'no-legal-moves', sfen: string) {
  if (kind === 'no-legal-moves') return null;
  const side = sideToMove(sfen);
  return side === 'black' ? 'white' : side === 'white' ? 'black' : null;
}

/**
 * Both analysis kinds keep {scoreCp, mate} in black perspective. A stored
 * mate=0/unknown-winner candidate decodes to both fields null — represented
 * honestly as mate 0 / winner 'unknown' (the only schema-allowed unknown).
 */
function toExportScore(candidate: AnalysisCandidate): ExportScore {
  if (candidate.scoreCp !== null) return { kind: 'cp', value: candidate.scoreCp };
  const mate = candidate.mate;
  if (mate === null) return { kind: 'mate', value: 0, winner: 'unknown' };
  return {
    kind: 'mate',
    value: mate,
    winner: mate > 0 ? 'black' : mate < 0 ? 'white' : 'unknown',
  };
}

function toExportCandidates(candidates: AnalysisCandidate[]) {
  return candidates.map((candidate) => ({
    move: candidate.usi,
    score: toExportScore(candidate),
  }));
}

type CloudJobStatus = NonNullable<CloudMethodExport['timing']['completion']>;

function cloudCompletion(status: CloudAttempt['status']): CloudJobStatus {
  switch (status) {
    case 'requesting':
    case 'queued':
      return 'queued';
    case 'running':
    case 'cancel-requested':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    // 'error' is a client-side terminal state; the server job's real outcome
    // is not known, so it exports as unknown rather than a claimed failure.
    case 'error':
      return 'unknown';
  }
}

/** Identity of the stored data, taken from the first still-valid result row. */
function cloudIdentity(
  stored: PersistedCloudResult[],
  game: GameRecord,
  profileId: CloudProfileId,
): CloudMethodExport['identity'] {
  for (const persisted of stored) {
    const expected = game.positions[persisted.ply];
    if (expected === undefined) continue;
    const row = validateCloudResult(persisted, expected, profileId);
    if (!row) continue;
    const identity = (row.result as Record<string, unknown>).identity as Record<string, unknown>;
    const field = (key: string) =>
      typeof identity[key] === 'string' ? (identity[key] as string) : null;
    return {
      engineName: field('engineName'),
      modelId: field('modelId'),
      engineSha256: field('engineSha256'),
      weightSha256: field('weightSha256'),
      optionsSha256: field('optionsSha256'),
      sourceArchiveSha256: field('sourceArchiveSha256'),
      sourceTreeSha256: field('sourceTreeSha256'),
      driverVersion: field('driverVersion'),
      contractVersion: field('contractVersion'),
    };
  }
  return null;
}

function cloudPlyResult(
  persisted: PersistedCloudResult | undefined,
  expectedSfen: string,
  profileId: CloudProfileId,
): PlyResult {
  if (!persisted) return { status: 'missing' };
  // Re-validate the stored row against this game's position; anything that no
  // longer passes the contract is excluded rather than exported as data.
  const row = validateCloudResult(persisted, expectedSfen, profileId);
  if (!row) return { status: 'missing' };
  const display = toCloudPositionResult(row);
  const timing =
    display.meta.elapsedMs === null
      ? undefined
      : ({ kind: 'server-search', elapsedMs: display.meta.elapsedMs } as const);
  const observed = {
    nodes: display.meta.nodes,
    completedDepth: display.meta.completedDepth,
    multiPV: display.candidates.length || null,
    engineLaunch: row.engineLaunch,
  };
  if (row.status === 'terminal') {
    const kind = display.terminal ?? 'no-legal-moves';
    return {
      status: 'terminal',
      sfen: row.sfen,
      terminal: { kind, winner: terminalWinner(kind, row.sfen) },
      observed,
      ...(timing ? { timing } : {}),
    };
  }
  if (row.status === 'incomplete') {
    return { status: 'incomplete', sfen: row.sfen, observed, ...(timing ? { timing } : {}) };
  }
  const candidates = toExportCandidates(display.candidates);
  return {
    status: 'complete',
    sfen: row.sfen,
    evaluation: candidates[0]?.score ?? { kind: 'mate', value: 0, winner: 'unknown' },
    candidates,
    observed,
    ...(timing ? { timing } : {}),
  };
}

/** Latest attempt for one profile whose stored gameIdentity matches the game. */
function selectedAttempt(
  attempts: CloudAttempt[],
  game: GameRecord,
  profileId: CloudProfileId,
): CloudAttempt | undefined {
  return attempts
    .filter((a) => a.profileId === profileId && a.gameIdentity === game.identity)
    .sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.attemptId.localeCompare(a.attemptId),
    )[0];
}

function sekireiPlyResult(
  row: PositionAnalysis | undefined,
  sfen: string,
  conditions: AnalysisConditions,
  runId: string | undefined,
  runRecorded: boolean,
): PlyResult {
  if (!row || !isCompatibleAnalysis(row, sfen, conditions)) return { status: 'missing' };
  if (row.terminal) {
    return {
      status: 'terminal',
      sfen: row.sfen,
      terminal: { kind: row.terminal, winner: terminalWinner(row.terminal, row.sfen) },
      observed: { nodes: row.meta.nodes, completedDepth: row.meta.completedDepth },
    };
  }
  const candidates = toExportCandidates(row.candidates);
  // Rows written by another run (or by pre-runId code) were reused, not
  // freshly searched: they are flagged and carry no call timing.
  const fromCache = runRecorded ? row.runId !== runId : undefined;
  const timing =
    !fromCache && typeof row.callElapsedMs === 'number'
      ? ({ kind: 'app-call', elapsedMs: row.callElapsedMs } as const)
      : undefined;
  return {
    status: 'complete',
    sfen: row.sfen,
    evaluation: candidates[0].score,
    candidates,
    observed: { nodes: row.meta.nodes, completedDepth: row.meta.completedDepth },
    ...(timing ? { timing } : {}),
    ...(fromCache !== undefined ? { fromCache } : {}),
  };
}

/**
 * The declared Sekirei conditions: the recorded run's snapshot when present;
 * otherwise the conditions shared by the largest compatible stored set (legacy
 * data has no run record). Rows that don't match are reported 'missing'.
 */
function declaredSekireiConditions(
  game: GameRecord,
  run: GameRecord['analysisRun'],
): AnalysisConditions | null {
  if (run) return run.conditions;
  const counts = new Map<string, { conditions: AnalysisConditions; count: number; first: number }>();
  for (const [key, row] of Object.entries(game.analysis)) {
    const ply = Number(key);
    if (!row || row.engineId !== CURRENT_ANALYSIS_IDENTITY.engineId) continue;
    if (row.modelId !== CURRENT_ANALYSIS_IDENTITY.modelId) continue;
    const id = `${row.conditions.nodes}:${row.conditions.multiPV}`;
    const entry = counts.get(id) ?? { conditions: row.conditions, count: 0, first: ply };
    entry.count += 1;
    counts.set(id, entry);
  }
  return (
    [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0]?.conditions ??
    null
  );
}

export async function buildComparisonExport(
  input: ComparisonExportInput,
  sha256Hex: Sha256Hex,
): Promise<ComparisonExport> {
  const { game, attempts, results, generator, exportedAt } = input;
  const moves = game.moves.map((move) => move.usi);
  const moveListHash = await sha256Hex(`${game.positions[0]}\n${moves.join(' ')}`);

  const methods: ComparisonExport['methods'] = {};
  const plies: PlyRow[] = game.positions.map((sfen, ply) => ({ ply, sfen, results: {} }));

  const run = game.analysisRun;
  const sekireiConditions = declaredSekireiConditions(game, run);
  const sekireiPresent = run !== undefined || sekireiConditions !== null;
  if (sekireiPresent) {
    const conditions = sekireiConditions ?? run!.conditions;
    methods.sekirei = {
      method: 'sekirei',
      attemptId: run?.runId ?? `sekirei-stored-${game.id}`,
      identity: { ...CURRENT_ANALYSIS_IDENTITY },
      conditions,
      timing: run
        ? {
            wholeGameWallMs: run.wholeGameWallMs,
            cacheReuseCount: run.cacheReuseCount,
            interrupted: run.interrupted,
            resumed: run.resumed,
            completion: run.completion,
          }
        : {
            wholeGameWallMs: null,
            cacheReuseCount: null,
            interrupted: null,
            resumed: null,
            completion: 'unknown',
          },
    } satisfies SekireiMethodExport;
    for (const row of plies) {
      row.results.sekirei = sekireiPlyResult(
        game.analysis[row.ply],
        row.sfen,
        conditions,
        run?.runId,
        run !== undefined,
      );
    }
  }

  for (const profileId of ['free', 'precision'] as const) {
    const attempt = selectedAttempt(attempts, game, profileId);
    if (!attempt) continue;
    const method = METHOD_FOR_PROFILE[profileId];
    const stored = results[attempt.attemptId] ?? [];
    const byPly = new Map<number, PersistedCloudResult>();
    for (const persisted of stored) {
      if (persisted.ply >= 0 && persisted.ply < game.positions.length && !byPly.has(persisted.ply))
        byPly.set(persisted.ply, persisted);
    }
    methods[method] = {
      method,
      attemptId: attempt.attemptId,
      jobId: attempt.jobId,
      profileId,
      identity: cloudIdentity(stored, game, profileId),
      conditions: { requested: { ...CLOUD_PROFILES[profileId] } },
      timing: {
        createdAt: attempt.createdAt,
        finishedAt: attempt.finishedAt,
        completion: cloudCompletion(attempt.status),
      },
    } satisfies CloudMethodExport;
    for (const row of plies) {
      row.results[method] = cloudPlyResult(byPly.get(row.ply), row.sfen, profileId);
    }
  }

  return {
    schema: COMPARISON_EXPORT_SCHEMA,
    schemaVersion: COMPARISON_EXPORT_SCHEMA_VERSION,
    exportedAt,
    generator,
    game: {
      initialSfen: game.positions[0],
      moveCount: game.moves.length,
      moves,
      moveListHash,
      label: `${game.startedAt} ${game.blackName} vs ${game.whiteName}`,
    },
    methods,
    plies,
  };
}
