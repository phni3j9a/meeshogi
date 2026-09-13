import type { AnalysisCandidate, MateProof, Side } from '../domain/model';

export type EvaluationValue =
  | { kind: 'centipawn'; value: number }
  | { kind: 'black-mate'; plies: number }
  | { kind: 'white-mate'; plies: number }
  | { kind: 'missing' };

export type EvaluationSource = Pick<AnalysisCandidate, 'scoreCp' | 'mate'> | null | undefined;

export const EVALUATION_CHART_EDGE = 1500;

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
    case 'missing':
      return null;
  }
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
