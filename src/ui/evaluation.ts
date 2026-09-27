import { CURRENT_ANALYSIS_IDENTITY } from '../analysis/identity';
import { isValidAnalysisMeta } from '../analysis/meta';
import type { AnalysisCandidate, MateProof, PositionAnalysis, Side } from '../domain/model';

export type EvaluationValue =
  | { kind: 'centipawn'; value: number }
  | { kind: 'black-mate'; plies: number }
  | { kind: 'white-mate'; plies: number }
  | { kind: 'checkmate'; value: number; winner: Side }
  | { kind: 'missing' };

export type EvaluationSource = Pick<AnalysisCandidate, 'scoreCp' | 'mate'> | null | undefined;

export const EVALUATION_CHART_EDGE = 1500;

function sideToMove(sfen: string): Side | undefined {
  const side = sfen.trim().split(/\s+/u)[1];
  return side === 'b' ? 'black' : side === 'w' ? 'white' : undefined;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Convert one normalized engine candidate into the value used by every evaluation surface. */
export function toEvaluationValue(source: EvaluationSource): EvaluationValue {
  if (source && isFiniteNumber(source.scoreCp)) {
    return { kind: 'centipawn', value: source.scoreCp };
  }

  if (source && isFiniteNumber(source.mate) && source.mate !== 0) {
    return source.mate > 0
      ? { kind: 'black-mate', plies: Math.abs(source.mate) }
      : { kind: 'white-mate', plies: Math.abs(source.mate) };
  }

  return { kind: 'missing' };
}

export function formatEvaluation(value: EvaluationValue): string {
  switch (value.kind) {
    case 'centipawn':
      return `${value.value > 0 ? '+' : ''}${value.value}`;
    case 'black-mate':
      return `+M${value.plies}`;
    case 'white-mate':
      return `-M${value.plies}`;
    case 'checkmate':
      return `${value.winner === 'black' ? '先手勝ち' : '後手勝ち'}・詰み終局`;
    case 'missing':
      return '—';
  }
}

export function toEvaluationChartValue(value: EvaluationValue): number | null {
  switch (value.kind) {
    case 'centipawn':
      return value.value;
    case 'black-mate':
      return EVALUATION_CHART_EDGE;
    case 'white-mate':
      return -EVALUATION_CHART_EDGE;
    case 'checkmate':
      return value.value;
    case 'missing':
      return null;
  }
}

/**
 * The minimal shape needed to resolve a display evaluation — satisfied by both
 * Sekirei PositionAnalysis rows and persisted CloudPositionResult rows.
 */
export interface DisplayResult {
  sfen: string;
  terminal?: 'checkmate' | 'no-legal-moves' | null;
  candidates: AnalysisCandidate[];
}

/**
 * Resolve the display value of one already-trusted result. Callers are
 * responsible for identity/condition checks before trusting stored data.
 */
export function resolveDisplayEvaluation(
  result: DisplayResult | null | undefined,
): EvaluationValue {
  if (!result) return { kind: 'missing' };
  if (result.terminal === 'no-legal-moves') return { kind: 'missing' };
  if (result.terminal === 'checkmate') {
    const side = sideToMove(result.sfen);
    if (!side) return { kind: 'missing' };
    const winner: Side = side === 'white' ? 'black' : 'white';
    return {
      kind: 'checkmate',
      value: winner === 'black' ? EVALUATION_CHART_EDGE : -EVALUATION_CHART_EDGE,
      winner,
    };
  }
  return toEvaluationValue(result.candidates[0]);
}

/**
 * Resolve the current-position display value from one complete analysis.
 *
 * This intentionally takes the whole result so terminal summaries cannot be
 * confused with an ordinary candidate score.  Stored results from a previous
 * engine/model identity are kept for migration-free loading but are not
 * displayable here.
 */
export function resolveCurrentEvaluation(
  analysis: PositionAnalysis | null | undefined,
): EvaluationValue {
  if (!analysis) return { kind: 'missing' };
  if (analysis.status !== 'complete' || !isValidAnalysisMeta(analysis.meta, analysis.conditions)) {
    return { kind: 'missing' };
  }
  if (
    analysis.engineId !== CURRENT_ANALYSIS_IDENTITY.engineId ||
    analysis.modelId !== CURRENT_ANALYSIS_IDENTITY.modelId
  ) {
    return { kind: 'missing' };
  }
  return resolveDisplayEvaluation(analysis);
}

export function isDisplayableMateProof(
  proof: MateProof | null | undefined,
  sideToMove: Side | undefined,
): proof is MateProof & { status: 'proven'; plies: 1 | 3 } {
  return (
    proof?.status === 'proven' &&
    (proof.plies === 1 || proof.plies === 3) &&
    sideToMove !== undefined &&
    proof.side === sideToMove
  );
}
