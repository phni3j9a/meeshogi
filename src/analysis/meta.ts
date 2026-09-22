import type { AnalysisConditions, AnalysisMeta } from '../domain/model';

const MAX_NODES = 10_000_000;
const MAX_DEPTH = 64;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Validate the persisted/native metadata without coercing damaged values. */
export function isValidAnalysisMeta(value: unknown, conditions: unknown): value is AnalysisMeta {
  if (!object(conditions) || !object(value)) return false;
  return (
    integer(conditions.nodes, 1, MAX_NODES) &&
    integer(value.requestedNodes, 1, MAX_NODES) &&
    value.requestedNodes === conditions.nodes &&
    integer(value.nodes, 0, value.requestedNodes) &&
    integer(value.completedDepth, 0, MAX_DEPTH) &&
    typeof value.fallback === 'boolean' &&
    value.fallback === false &&
    typeof value.budgetReached === 'boolean' &&
    value.budgetReached === value.nodes >= value.requestedNodes
  );
}
