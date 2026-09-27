import { toDisplayChartValue } from './chart-value.ts';
import {
  COMPARISON_METHODS,
  COMPARED_METHODS,
  REFERENCE_METHOD,
  type CloudMethodExport,
  type ComparisonExport,
  type ComparisonMethod,
  type ExportScore,
  type ExportTerminal,
  type MethodExport,
  type PlyResult,
  type PlyStatus,
  type SekireiMethodExport,
} from './schema.ts';

/**
 * 比較export（schemaVersion 1）から Plan §5 の指標を決定的に計算する。
 * すべての比率は分子/分母を保持し、分母 0 は rate: null（レポートでは N/A）。
 * mate/terminal を cp に換算しない。欠測区間をまたいだ比較・変動は行わない。
 */

export const COMPARISON_SUMMARY_SCHEMA = 'meeshogi-comparison-summary' as const;
export const COMPARISON_SUMMARY_VERSION = 1 as const;

export type PhaseId = 'opening' | 'middlegame' | 'endgame';
export const PHASE_IDS: readonly PhaseId[] = ['opening', 'middlegame', 'endgame'];
export const PHASE_LABELS: Record<PhaseId, string> = {
  opening: '序盤（ply 0–40）',
  middlegame: '中盤（ply 41–90）',
  endgame: '終盤（ply 91+）',
};

/** ply 番号による便宜区分。局面内容から実際の戦況を判定するものではない。 */
export function phaseOfPly(ply: number): PhaseId {
  if (ply <= 40) return 'opening';
  if (ply <= 90) return 'middlegame';
  return 'endgame';
}

export interface Stats {
  count: number;
  median: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

export interface Ratio {
  numerator: number;
  denominator: number;
  rate: number | null;
}

/** cloud/bench/aggregate.py の quantile と同じ線形補間。 */
export function quantile(values: readonly number[], probability: number): number | null {
  const data = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (data.length === 0) return null;
  if (data.length === 1) return data[0];
  const position = (data.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return data[lower];
  return data[lower] + (data[upper] - data[lower]) * (position - lower);
}

export function stats(values: readonly number[]): Stats {
  const data = values.filter((v) => Number.isFinite(v));
  return {
    count: data.length,
    median: quantile(data, 0.5),
    p90: quantile(data, 0.9),
    min: data.length ? Math.min(...data) : null,
    max: data.length ? Math.max(...data) : null,
    mean: data.length ? data.reduce((a, b) => a + b, 0) / data.length : null,
  };
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

type PairKind =
  | 'complete-complete'
  | 'terminal-terminal'
  | 'terminal-mismatch'
  | 'incomplete'
  | 'missing'
  | 'sfen-mismatch';

/** 1 ply の比較観測。missing/incomplete/sfen-mismatch は品質分母から外れる。 */
interface PairObs {
  ply: number;
  phase: PhaseId;
  kind: PairKind;
  /** 行（棋譜）側の局面 SFEN。 */
  rowSfen: string;
  /** 'absent' = 結果行自体が無い（宣言済み方式の欠落）。'missing' と区別する。 */
  cmpStatus: PlyStatus | 'absent';
  refStatus: PlyStatus | 'absent';
  /** 結果ソースが報告した sfen（不一致検出の証跡用）。 */
  cmpSfen?: string;
  refSfen?: string;
  /** status==='complete' の生評価（先手視点）。 */
  cmpEvaluation?: ExportScore;
  refEvaluation?: ExportScore;
  cmpTerminal?: ExportTerminal;
  refTerminal?: ExportTerminal;
  /** kind==='missing' のときの欠測側。 */
  missingSide?: 'both' | 'compared' | 'reference';
  /** kind==='incomplete' のときの欠測側。 */
  comparedIncomplete?: boolean;
  referenceIncomplete?: boolean;
  cpDiff?: number;
  top1Equal?: boolean;
  refBestIncluded?: boolean;
  refScoreKind?: 'cp' | 'mate';
  cmpScoreKind?: 'cp' | 'mate';
  mateWinnerAgree?: boolean;
  mateDistanceExact?: boolean;
  refMateUnknown?: boolean;
  cmpMateUnknown?: boolean;
  terminalKindAgree?: boolean;
  terminalWinnerAgree?: boolean;
  cmpCandidateCount?: number;
}

function isComplete(result: PlyResult | undefined): result is PlyResult {
  return (
    !!result &&
    result.status === 'complete' &&
    !!result.evaluation &&
    Array.isArray(result.candidates) &&
    result.candidates.length > 0
  );
}

function collectPair(
  ply: number,
  cmp: PlyResult | undefined,
  ref: PlyResult | undefined,
  rowSfen: string,
): PairObs {
  const phase = phaseOfPly(ply);
  const base = {
    ply,
    phase,
    rowSfen,
    cmpStatus: cmp?.status ?? ('absent' as const),
    refStatus: ref?.status ?? ('absent' as const),
    cmpSfen: cmp?.sfen,
    refSfen: ref?.sfen,
    cmpEvaluation: cmp?.status === 'complete' ? cmp.evaluation : undefined,
    refEvaluation: ref?.status === 'complete' ? ref.evaluation : undefined,
    cmpTerminal: cmp?.status === 'terminal' ? cmp.terminal : undefined,
    refTerminal: ref?.status === 'terminal' ? ref.terminal : undefined,
  };
  const cmpMissing = !cmp || cmp.status === 'missing';
  const refMissing = !ref || ref.status === 'missing';
  if (cmpMissing || refMissing) {
    return {
      ...base,
      kind: 'missing',
      missingSide: cmpMissing && refMissing ? 'both' : cmpMissing ? 'compared' : 'reference',
    };
  }
  // 結果ソースの sfen と行の sfen が異なる場合、その ply は比較しない。
  if (
    (cmp.sfen !== undefined && cmp.sfen !== rowSfen) ||
    (ref.sfen !== undefined && ref.sfen !== rowSfen)
  ) {
    return { ...base, kind: 'sfen-mismatch' };
  }
  if (cmp.status === 'incomplete' || ref.status === 'incomplete') {
    return {
      ...base,
      kind: 'incomplete',
      comparedIncomplete: cmp.status === 'incomplete',
      referenceIncomplete: ref.status === 'incomplete',
    };
  }
  if (cmp.status === 'terminal' || ref.status === 'terminal') {
    if (cmp.status === 'terminal' && ref.status === 'terminal') {
      return {
        ...base,
        kind: 'terminal-terminal',
        terminalKindAgree: cmp.terminal?.kind === ref.terminal?.kind,
        terminalWinnerAgree: cmp.terminal?.winner === ref.terminal?.winner,
      };
    }
    return { ...base, kind: 'terminal-mismatch' };
  }
  // complete × complete
  const obs: PairObs = { ...base, kind: 'complete-complete' };
  if (isComplete(cmp) && isComplete(ref)) {
    const cmpTop = cmp.candidates?.[0];
    const refTop = ref.candidates?.[0];
    if (!cmpTop || !refTop || !cmp.evaluation || !ref.evaluation) return obs;
    obs.cmpCandidateCount = cmp.candidates?.length;
    obs.top1Equal = cmpTop.move === refTop.move;
    obs.refBestIncluded = (cmp.candidates ?? []).some((c) => c.move === refTop.move);
    obs.cmpScoreKind = cmp.evaluation.kind;
    obs.refScoreKind = ref.evaluation.kind;
    if (cmp.evaluation.kind === 'cp' && ref.evaluation.kind === 'cp') {
      obs.cpDiff = cmp.evaluation.value - ref.evaluation.value;
    }
    if (cmp.evaluation.kind === 'mate' && ref.evaluation.kind === 'mate') {
      obs.mateWinnerAgree = cmp.evaluation.winner === ref.evaluation.winner;
      obs.mateDistanceExact = cmp.evaluation.value === ref.evaluation.value;
      obs.refMateUnknown = ref.evaluation.winner === 'unknown';
      obs.cmpMateUnknown = cmp.evaluation.winner === 'unknown';
    }
  }
  return obs;
}

export interface Coverage {
  plies: number;
  /** missing/sfen-mismatch 以外の pair 数（incomplete・terminal を含む）。 */
  comparedPairs: number;
  missingBoth: number;
  missingCompared: number;
  missingReference: number;
  sfenMismatch: number;
  incompleteCompared: number;
  incompleteReference: number;
  completePairs: number;
  terminalPairs: number;
  terminalMismatchPairs: number;
}

export interface PhaseMetrics {
  plies: number;
  /** missing/sfen-mismatch/incomplete 以外の pair 数。 */
  comparablePairs: number;
  cpPairs: number;
  cpDiff: Stats;
  cpAbsDiff: Stats;
  top1: Ratio;
  bestMoveInclusion: Ratio;
}

/** ply 行が品質分母から外れた理由。null = 比較可能（complete×complete / terminal×terminal）。 */
export type PlyExclusion =
  | 'missing-both'
  | 'missing-compared'
  | 'missing-reference'
  | 'incomplete-both'
  | 'incomplete-compared'
  | 'incomplete-reference'
  | 'sfen-mismatch'
  | 'terminal-mismatch';

/** 1方式側の生の見え方。'absent' は結果行自体が無い（missing と区別する内訳）。 */
export interface PlySideView {
  status: PlyStatus | 'absent';
  /** 結果ソースが報告した sfen（行 sfen と異なる場合の証跡）。 */
  sfen?: string;
  /** status==='complete' の生評価（先手視点。cp または mate{value,winner}）。 */
  evaluation?: ExportScore;
  /** status==='terminal' の終局情報。 */
  terminal?: ExportTerminal;
}

/**
 * 局面ごとの比較行（Plan §5「局面ごとの先手視点CP差と絶対差」）。
 * mate/terminal を cp に換算しない。両側が有効な cp のときだけ cpDiff/cpAbsDiff を持つ。
 */
export interface PlyComparisonRow {
  ply: number;
  /** 行（棋譜）側の局面 SFEN（完全な文字列）。 */
  sfen: string;
  compared: PlySideView;
  reference: PlySideView;
  cpDiff: number | null;
  cpAbsDiff: number | null;
  exclusion: PlyExclusion | null;
}

function exclusionOf(obs: PairObs): PlyExclusion | null {
  switch (obs.kind) {
    case 'missing':
      return obs.missingSide === 'both'
        ? 'missing-both'
        : obs.missingSide === 'compared'
          ? 'missing-compared'
          : 'missing-reference';
    case 'incomplete':
      return obs.comparedIncomplete && obs.referenceIncomplete
        ? 'incomplete-both'
        : obs.comparedIncomplete
          ? 'incomplete-compared'
          : 'incomplete-reference';
    case 'sfen-mismatch':
      return 'sfen-mismatch';
    case 'terminal-mismatch':
      return 'terminal-mismatch';
    default:
      return null;
  }
}

function sideView(
  status: PlyStatus | 'absent',
  sfen: string | undefined,
  evaluation: ExportScore | undefined,
  terminal: ExportTerminal | undefined,
): PlySideView {
  return {
    status,
    ...(sfen !== undefined ? { sfen } : {}),
    ...(evaluation !== undefined ? { evaluation } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
  };
}

/** PairObs → 局面別の比較行。 ply 順は入力の plies 順（validator が ply===index を保証）。 */
function pairToPlyRow(obs: PairObs): PlyComparisonRow {
  return {
    ply: obs.ply,
    sfen: obs.rowSfen,
    compared: sideView(obs.cmpStatus, obs.cmpSfen, obs.cmpEvaluation, obs.cmpTerminal),
    reference: sideView(obs.refStatus, obs.refSfen, obs.refEvaluation, obs.refTerminal),
    cpDiff: obs.cpDiff ?? null,
    cpAbsDiff: obs.cpDiff !== undefined ? Math.abs(obs.cpDiff) : null,
    exclusion: exclusionOf(obs),
  };
}

export interface PairwiseSummary {
  /** 比較される側の方式（reference は常に cloud-precision）。 */
  method: ComparisonMethod;
  coverage: Coverage;
  /** 両側が有効な cp を持つ pair のみ（mate/terminal は cp に換算しない）。cmp − ref の符号差。 */
  cpDiff: Stats;
  cpAbsDiff: Stats;
  top1Agreement: Ratio;
  refBestMoveInclusion: Ratio;
  candidateCounts: { requested: number | null; effective: Stats };
  scoreKind: { bothCp: number; bothMate: number; refCpCmpMate: number; refMateCmpCp: number };
  /** mate×mate pair のみ。winner unknown は unknown として比較する。距離一致は品質指標ではない。 */
  mateWinner: {
    pairs: number;
    agree: number;
    disagree: number;
    refUnknown: number;
    cmpUnknown: number;
    distanceExact: number;
  };
  terminal: {
    pairs: number;
    kindAgree: number;
    kindDisagree: number;
    winnerAgree: number;
    winnerDisagree: number;
    /** 片側だけ terminal の pair（terminal と評価値の不一致）。 */
    oneSidedPairs: number;
  };
  byPhase: Record<PhaseId, PhaseMetrics>;
  /**
   * 局面ごとの比較行（ply 昇順・決定的）。export 単位の summary にのみ付ける。
   * 複数 export の合算では別棋譜の ply が衝突するため空配列。
   */
  plyRows: PlyComparisonRow[];
}

function summarizePairs(
  method: ComparisonMethod,
  pairs: PairObs[],
  plies: number,
  requestedCandidates: number | null,
  includePlyRows: boolean,
): PairwiseSummary {
  const complete = pairs.filter((p) => p.kind === 'complete-complete' && p.top1Equal !== undefined);
  const cpPairs = complete.filter((p) => p.cpDiff !== undefined);
  const matePairs = complete.filter((p) => p.mateWinnerAgree !== undefined);
  const terminalPairs = pairs.filter((p) => p.kind === 'terminal-terminal');
  const incompletePairs = pairs.filter((p) => p.kind === 'incomplete');
  const missing = pairs.filter((p) => p.kind === 'missing');

  const byPhase = {} as Record<PhaseId, PhaseMetrics>;
  for (const phase of PHASE_IDS) {
    const inPhase = pairs.filter((p) => p.phase === phase);
    const phaseComplete = inPhase.filter((p) => p.top1Equal !== undefined);
    const phaseCp = phaseComplete.filter((p) => p.cpDiff !== undefined);
    byPhase[phase] = {
      plies: inPhase.length,
      comparablePairs: inPhase.filter(
        (p) => p.kind !== 'missing' && p.kind !== 'sfen-mismatch' && p.kind !== 'incomplete',
      ).length,
      cpPairs: phaseCp.length,
      cpDiff: stats(phaseCp.map((p) => p.cpDiff as number)),
      cpAbsDiff: stats(phaseCp.map((p) => Math.abs(p.cpDiff as number))),
      top1: ratio(phaseComplete.filter((p) => p.top1Equal).length, phaseComplete.length),
      bestMoveInclusion: ratio(
        phaseComplete.filter((p) => p.refBestIncluded).length,
        phaseComplete.length,
      ),
    };
  }

  return {
    method,
    coverage: {
      plies,
      comparedPairs: pairs.filter((p) => p.kind !== 'missing' && p.kind !== 'sfen-mismatch').length,
      missingBoth: missing.filter((p) => p.missingSide === 'both').length,
      missingCompared: missing.filter((p) => p.missingSide === 'compared').length,
      missingReference: missing.filter((p) => p.missingSide === 'reference').length,
      sfenMismatch: pairs.filter((p) => p.kind === 'sfen-mismatch').length,
      incompleteCompared: incompletePairs.filter((p) => p.comparedIncomplete).length,
      incompleteReference: incompletePairs.filter((p) => p.referenceIncomplete).length,
      completePairs: complete.length,
      terminalPairs: terminalPairs.length,
      terminalMismatchPairs: pairs.filter((p) => p.kind === 'terminal-mismatch').length,
    },
    cpDiff: stats(cpPairs.map((p) => p.cpDiff as number)),
    cpAbsDiff: stats(cpPairs.map((p) => Math.abs(p.cpDiff as number))),
    top1Agreement: ratio(complete.filter((p) => p.top1Equal).length, complete.length),
    refBestMoveInclusion: ratio(
      complete.filter((p) => p.refBestIncluded).length,
      complete.length,
    ),
    candidateCounts: {
      requested: requestedCandidates,
      effective: stats(
        complete.map((p) => p.cmpCandidateCount).filter((v): v is number => typeof v === 'number'),
      ),
    },
    scoreKind: {
      bothCp: complete.filter((p) => p.refScoreKind === 'cp' && p.cmpScoreKind === 'cp').length,
      bothMate: complete.filter((p) => p.refScoreKind === 'mate' && p.cmpScoreKind === 'mate')
        .length,
      refCpCmpMate: complete.filter((p) => p.refScoreKind === 'cp' && p.cmpScoreKind === 'mate')
        .length,
      refMateCmpCp: complete.filter((p) => p.refScoreKind === 'mate' && p.cmpScoreKind === 'cp')
        .length,
    },
    mateWinner: {
      pairs: matePairs.length,
      agree: matePairs.filter((p) => p.mateWinnerAgree).length,
      disagree: matePairs.filter((p) => p.mateWinnerAgree === false).length,
      refUnknown: matePairs.filter((p) => p.refMateUnknown).length,
      cmpUnknown: matePairs.filter((p) => p.cmpMateUnknown).length,
      distanceExact: matePairs.filter((p) => p.mateDistanceExact).length,
    },
    terminal: {
      pairs: terminalPairs.length,
      kindAgree: terminalPairs.filter((p) => p.terminalKindAgree).length,
      kindDisagree: terminalPairs.filter((p) => p.terminalKindAgree === false).length,
      winnerAgree: terminalPairs.filter((p) => p.terminalWinnerAgree).length,
      winnerDisagree: terminalPairs.filter((p) => p.terminalWinnerAgree === false).length,
      oneSidedPairs: pairs.filter((p) => p.kind === 'terminal-mismatch').length,
    },
    byPhase,
    plyRows: includePlyRows ? pairs.map(pairToPlyRow) : [],
  };
}

function collectCoveragePairs(data: ComparisonExport, method: ComparisonMethod): PairObs[] {
  return data.plies.map((row) =>
    collectPair(row.ply, row.results[method], row.results[REFERENCE_METHOD], row.sfen),
  );
}

export interface VolatilitySummary {
  method: ComparisonMethod;
  /** 表示値が有効な ply 数。 */
  validPlies: number;
  /** 結果側 sfen が行 sfen と異なり null 化した行数（pair 比較と同じ除外規則）。 */
  sfenMismatchRows: number;
  /** 両端が有効な隣接 ply 対の |Δ表示値|（±1500 clip 済みの表示値）。欠測区間は橋接しない。 */
  adjacentAbsDiff: Stats;
  /** 隣接対は先頭 ply の区分に入れる。 */
  byPhase: Record<PhaseId, { pairs: number; adjacentAbsDiff: Stats }>;
}

/**
 * 方式別の表示値系列。結果側 sfen が行 sfen と異なる行は、アプリがその結果を
 * 表示対象から外すのと同じ規則で null にする（別局面の評価を隣接差に使わない）。
 */
function methodDisplaySeries(
  data: ComparisonExport,
  method: ComparisonMethod,
): { series: (number | null)[]; sfenMismatchRows: number } {
  let sfenMismatchRows = 0;
  const series = data.plies.map((row) => {
    const result = row.results[method];
    if (result !== undefined && result.sfen !== undefined && result.sfen !== row.sfen) {
      sfenMismatchRows += 1;
      return null;
    }
    return toDisplayChartValue(result);
  });
  return { series, sfenMismatchRows };
}

function summarizeVolatility(
  method: ComparisonMethod,
  series: (number | null)[],
  plies: number[],
): Omit<VolatilitySummary, 'sfenMismatchRows'> {
  const diffs: { ply: number; diff: number }[] = [];
  for (let i = 0; i + 1 < series.length; i++) {
    const a = series[i];
    const b = series[i + 1];
    if (a === null || b === null) continue;
    diffs.push({ ply: plies[i], diff: Math.abs(b - a) });
  }
  const byPhase = {} as Record<PhaseId, { pairs: number; adjacentAbsDiff: Stats }>;
  for (const phase of PHASE_IDS) {
    const inPhase = diffs.filter((d) => phaseOfPly(d.ply) === phase);
    byPhase[phase] = {
      pairs: inPhase.length,
      adjacentAbsDiff: stats(inPhase.map((d) => d.diff)),
    };
  }
  return {
    method,
    validPlies: series.filter((v) => v !== null).length,
    adjacentAbsDiff: stats(diffs.map((d) => d.diff)),
    byPhase,
  };
}

export type RunKind =
  | 'fresh-complete'
  | 'completed-with-cache-reuse'
  | 'partial'
  | 'interrupted'
  | 'unknown';

export interface MethodTimingSummary {
  method: ComparisonMethod;
  /** 全局時間の計測境界。 */
  boundary: 'app-js-wall' | 'server-job';
  /** Sekirei の実行種別。Cloud は常に 'server-job'（resume は job の server 継続であり client cache ではない）。 */
  runKind: RunKind | 'server-job';
  completion: string;
  /** Sekirei: JS 計測の全局壁時計。Cloud: createdAt→finishedAt の server 壁時計（queue/retry 込み）。 */
  wholeGameWallMs: number | null;
  /** ply 単位の計測種別。Sekirei='app-call'（cache 再利用 ply は含まない）、Cloud='server-search'（search+drain のみ）。 */
  perPositionKind: 'app-call' | 'server-search' | null;
  perPosition: Stats;
  /** Sekirei: 新規探索せず保存済み結果を再利用した ply 数。 */
  cacheReuseCount: number | null;
  interrupted: boolean | null;
  serverWindow: { createdAt: string; finishedAt: string } | null;
  /** 結果行の observed から見た実探索量（complete 行のみ）。 */
  observedNodes: Stats;
  observedDepth: Stats;
}

/**
 * 今回の実行が記録した事実だけで分類する（再利用元の完了履歴は追跡しない）。
 * `completed` + `cacheReuseCount` 既知 0 + 非中断 が確認できる実行だけが
 * `fresh-complete`（新規全局時間の比較対象）。不明な項目は 0/false に
 * 倒さず `unknown` とする。
 */
function sekireiRunKind(timing: SekireiMethodExport['timing']): RunKind {
  if (timing.completion === 'interrupted' || timing.interrupted === true) return 'interrupted';
  if (timing.completion === 'partial') return 'partial';
  if (timing.completion === 'completed') {
    if (timing.cacheReuseCount !== null && timing.cacheReuseCount > 0) {
      return 'completed-with-cache-reuse';
    }
    if (timing.cacheReuseCount === 0 && timing.interrupted === false) return 'fresh-complete';
    return 'unknown';
  }
  return 'unknown';
}

function summarizeTiming(
  data: ComparisonExport,
  method: ComparisonMethod,
): MethodTimingSummary | null {
  const methodExport = data.methods[method];
  if (!methodExport) return null;
  const rows = data.plies
    .map((row) => row.results[method])
    .filter((r): r is PlyResult => r !== undefined);
  const perPosition = stats(
    rows
      .map((r) => r.timing?.elapsedMs)
      .filter((v): v is number => typeof v === 'number'),
  );
  const perPositionKind = rows.some((r) => r.timing?.kind === 'server-search')
    ? ('server-search' as const)
    : rows.some((r) => r.timing?.kind === 'app-call')
      ? ('app-call' as const)
      : null;
  const completeRows = rows.filter((r) => r.status === 'complete');
  const observedNodes = stats(
    completeRows
      .map((r) => r.observed?.nodes)
      .filter((v): v is number => typeof v === 'number'),
  );
  const observedDepth = stats(
    completeRows
      .map((r) => r.observed?.completedDepth)
      .filter((v): v is number => typeof v === 'number'),
  );

  if (methodExport.method === 'sekirei') {
    const timing = methodExport.timing;
    return {
      method,
      boundary: 'app-js-wall',
      runKind: sekireiRunKind(timing),
      completion: timing.completion,
      wholeGameWallMs: timing.wholeGameWallMs ?? null,
      perPositionKind,
      perPosition,
      cacheReuseCount: timing.cacheReuseCount ?? null,
      interrupted: timing.interrupted ?? null,
      serverWindow: null,
      observedNodes,
      observedDepth,
    };
  }
  const timing = (methodExport as CloudMethodExport).timing;
  const serverWallMs =
    timing.createdAt !== null && timing.finishedAt !== null
      ? Date.parse(timing.finishedAt) - Date.parse(timing.createdAt)
      : null;
  return {
    method,
    boundary: 'server-job',
    runKind: 'server-job',
    completion: timing.completion,
    wholeGameWallMs: serverWallMs,
    perPositionKind,
    perPosition,
    cacheReuseCount: null,
    interrupted: null,
    serverWindow:
      timing.createdAt !== null && timing.finishedAt !== null
        ? { createdAt: timing.createdAt, finishedAt: timing.finishedAt }
        : null,
    observedNodes,
    observedDepth,
  };
}

export interface MethodStatusCounts {
  present: boolean;
  attemptId: string | null;
  /**
   * 宣言済み方式の全 ply 走査カウント。合計は必ず棋譜の局面数（plies.length）になる。
   * `missing` は明示 'missing' 行と結果行なし（absent）の合算、`absent` はその内訳。
   */
  statusCounts: {
    complete: number;
    incomplete: number;
    terminal: number;
    missing: number;
    /** missing のうち結果行自体が無い ply 数（明示 missing と区別する）。 */
    absent: number;
  };
  /** 方式レベルの export 記録（条件・identity・timing 入力）。未実行なら null。 */
  detail: MethodExport | null;
}

export interface ExportSummary {
  /** 入力識別（CLI が渡すファイル名など）。 */
  source: string;
  exportedAt: string;
  generator: ComparisonExport['generator'];
  game: { moveListHash: string; initialSfen: string; moveCount: number; label?: string };
  /** moves+initialSfen から再計算した hash の一致。CLI 未検証時は null。 */
  moveListHashVerified: boolean | null;
  methods: Record<ComparisonMethod, MethodStatusCounts>;
  comparisons: PairwiseSummary[];
  volatility: VolatilitySummary[];
  timing: MethodTimingSummary[];
}

export interface ComparisonSummary {
  schema: typeof COMPARISON_SUMMARY_SCHEMA;
  schemaVersion: typeof COMPARISON_SUMMARY_VERSION;
  reference: { method: typeof REFERENCE_METHOD; note: string };
  inputs: {
    source: string;
    moveListHash: string;
    moveCount: number;
    exportedAt: string;
    platform: string;
  }[];
  exports: ExportSummary[];
  /** 全 export の pair を合算した集計（比較は各 export 内の方式間のみ）。 */
  overall: {
    exportsWithReference: number;
    comparisons: PairwiseSummary[];
    volatility: VolatilitySummary[];
  };
}

function requestedCandidateCount(data: ComparisonExport, method: ComparisonMethod): number | null {
  const methodExport = data.methods[method];
  if (!methodExport) return null;
  if (methodExport.method === 'sekirei') return methodExport.conditions.multiPV;
  return methodExport.conditions.requested.multiPV ?? null;
}

export function aggregateExport(
  data: ComparisonExport,
  source: string,
  moveListHashVerified: boolean | null = null,
): ExportSummary {
  const methods = {} as Record<ComparisonMethod, MethodStatusCounts>;
  for (const method of COMPARISON_METHODS) {
    // 宣言済み方式は全 ply を走査し、結果行なし（undefined）も missing に数える。
    const rows = data.plies.map((row) => row.results[method]);
    const absent = rows.filter((r) => r === undefined).length;
    methods[method] = {
      present: data.methods[method] !== undefined,
      attemptId: data.methods[method]?.attemptId ?? null,
      detail: data.methods[method] ?? null,
      statusCounts: {
        complete: rows.filter((r) => r?.status === 'complete').length,
        incomplete: rows.filter((r) => r?.status === 'incomplete').length,
        terminal: rows.filter((r) => r?.status === 'terminal').length,
        missing: rows.filter((r) => r === undefined || r.status === 'missing').length,
        absent,
      },
    };
  }

  const comparisons: PairwiseSummary[] = [];
  if (data.methods[REFERENCE_METHOD] !== undefined) {
    for (const method of COMPARED_METHODS) {
      if (data.methods[method] === undefined) continue;
      comparisons.push(
        summarizePairs(
          method,
          collectCoveragePairs(data, method),
          data.plies.length,
          requestedCandidateCount(data, method),
          true,
        ),
      );
    }
  }

  const volatility: VolatilitySummary[] = [];
  for (const method of COMPARISON_METHODS) {
    if (data.methods[method] === undefined) continue;
    const { series, sfenMismatchRows } = methodDisplaySeries(data, method);
    volatility.push({
      ...summarizeVolatility(
        method,
        series,
        data.plies.map((row) => row.ply),
      ),
      sfenMismatchRows,
    });
  }

  const timing = COMPARISON_METHODS.map((method) => summarizeTiming(data, method)).filter(
    (t): t is MethodTimingSummary => t !== null,
  );

  return {
    source,
    exportedAt: data.exportedAt,
    generator: data.generator,
    game: {
      moveListHash: data.game.moveListHash,
      initialSfen: data.game.initialSfen,
      moveCount: data.game.moveCount,
      ...(data.game.label !== undefined ? { label: data.game.label } : {}),
    },
    moveListHashVerified,
    methods,
    comparisons,
    volatility,
    timing,
  };
}

/** 複数 export の合算集計。比較は各 export 内の方式間で行い、pair を pool する。 */
export function aggregateAll(
  inputs: { source: string; data: ComparisonExport; moveListHashVerified?: boolean | null }[],
): ComparisonSummary {
  const exports = inputs.map((input) =>
    aggregateExport(input.data, input.source, input.moveListHashVerified ?? null),
  );

  const pooledPairs = new Map<ComparisonMethod, PairObs[]>();
  const pooledVolatility = new Map<
    ComparisonMethod,
    { diffs: { ply: number; diff: number }[]; sfenMismatchRows: number }
  >();
  let exportsWithReference = 0;

  for (const input of inputs) {
    const data = input.data;
    if (data.methods[REFERENCE_METHOD] !== undefined) exportsWithReference += 1;
    for (const method of COMPARISON_METHODS) {
      if (data.methods[method] === undefined) continue;
      // per-export と同じ規則で SFEN 不一致行を null 化してから隣接差を取る。
      const { series, sfenMismatchRows } = methodDisplaySeries(data, method);
      const diffs: { ply: number; diff: number }[] = [];
      for (let i = 0; i + 1 < series.length; i++) {
        if (series[i] === null || series[i + 1] === null) continue;
        diffs.push({
          ply: data.plies[i].ply,
          diff: Math.abs((series[i + 1] as number) - (series[i] as number)),
        });
      }
      const entry = pooledVolatility.get(method) ?? { diffs: [], sfenMismatchRows: 0 };
      entry.diffs.push(...diffs);
      entry.sfenMismatchRows += sfenMismatchRows;
      pooledVolatility.set(method, entry);
    }
    if (data.methods[REFERENCE_METHOD] === undefined) continue;
    for (const method of COMPARED_METHODS) {
      if (data.methods[method] === undefined) continue;
      const list = pooledPairs.get(method) ?? [];
      list.push(...collectCoveragePairs(data, method));
      pooledPairs.set(method, list);
    }
  }

  const comparisons: PairwiseSummary[] = [];
  for (const method of COMPARED_METHODS) {
    const pairs = pooledPairs.get(method);
    if (!pairs || pairs.length === 0) continue;
    // requested は export ごとに異なり得るため全体集計では null（export 単位の表を参照）。
    // 局面別行も export 単位でのみ意味を持つため合算では作らない。
    comparisons.push(summarizePairs(method, pairs, pairs.length, null, false));
  }

  const volatility: VolatilitySummary[] = [];
  for (const method of COMPARISON_METHODS) {
    const pooled = pooledVolatility.get(method);
    if (!pooled) continue;
    const diffs = pooled.diffs;
    const validPlies = exports.reduce(
      (sum, e) => sum + (e.volatility.find((v) => v.method === method)?.validPlies ?? 0),
      0,
    );
    const byPhase = {} as Record<PhaseId, { pairs: number; adjacentAbsDiff: Stats }>;
    for (const phase of PHASE_IDS) {
      const inPhase = diffs.filter((d) => phaseOfPly(d.ply) === phase);
      byPhase[phase] = {
        pairs: inPhase.length,
        adjacentAbsDiff: stats(inPhase.map((d) => d.diff)),
      };
    }
    volatility.push({
      method,
      validPlies,
      sfenMismatchRows: pooled.sfenMismatchRows,
      adjacentAbsDiff: stats(diffs.map((d) => d.diff)),
      byPhase,
    });
  }

  return {
    schema: COMPARISON_SUMMARY_SCHEMA,
    schemaVersion: COMPARISON_SUMMARY_VERSION,
    reference: {
      method: REFERENCE_METHOD,
      note: 'Cloud Precision（5000ms / MultiPV 3）を深い reference として使う。正解・棋力保証ではない。Issue #20 benchmark の 10000ms / MultiPV 3 基準条件とは別の条件。',
    },
    inputs: exports.map((e) => ({
      source: e.source,
      moveListHash: e.game.moveListHash,
      moveCount: e.game.moveCount,
      exportedAt: e.exportedAt,
      platform: e.generator.platform,
    })),
    exports,
    overall: { exportsWithReference, comparisons, volatility },
  };
}
