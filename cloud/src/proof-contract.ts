export const PROOF_BUDGET_VERSION = 'sekirei-proof-ops-v2';

export type DriverProofResult = 'proven' | 'not-mate' | 'budget-exceeded' | 'in-check-invalid';
export type DriverProof = {
  result: DriverProofResult;
  plies: 1 | 3 | null;
  line: string[] | null;
  nodesUsed: number;
  budget: number;
  budgetVersion: typeof PROOF_BUDGET_VERSION;
};

export type StoredProof = {
  result: 'proven' | 'not-mate' | 'unknown' | 'invalid';
  requestedPlies: 3;
  plies: 1 | 3 | null;
  line: string[] | null;
  nodesUsed: number;
  budget: number;
  budgetVersion: typeof PROOF_BUDGET_VERSION;
  reason?: 'budget-exceeded' | 'in-check-invalid';
};

const USI_MOVE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

export function parseDriverProof(value: unknown, requestedPlies: 1 | 3, requestedBudget: number): DriverProof | null {
  if (!isRecord(value) || !exactKeys(value, ['result', 'plies', 'line', 'nodesUsed', 'budget', 'budgetVersion'])) return null;
  if (!['proven', 'not-mate', 'budget-exceeded', 'in-check-invalid'].includes(String(value.result))) return null;
  if (value.budgetVersion !== PROOF_BUDGET_VERSION || value.budget !== requestedBudget) return null;
  if (typeof value.nodesUsed !== 'number' || !Number.isSafeInteger(value.nodesUsed) || value.nodesUsed < 0 || value.nodesUsed > requestedBudget) return null;

  if (value.result === 'proven') {
    if (value.plies !== 1 && value.plies !== 3) return null;
    if (value.plies > requestedPlies || !Array.isArray(value.line) || value.line.length !== value.plies) return null;
    if (!value.line.every((move) => typeof move === 'string' && USI_MOVE.test(move))) return null;
    return value as DriverProof;
  }
  if (value.plies !== null || value.line !== null) return null;
  return value as DriverProof;
}

export function toStoredProof(proof: DriverProof): StoredProof {
  if (proof.result === 'budget-exceeded') {
    return {
      requestedPlies: 3, result: 'unknown', plies: null, line: null,
      nodesUsed: proof.nodesUsed, budget: proof.budget, budgetVersion: proof.budgetVersion,
      reason: 'budget-exceeded',
    };
  }
  if (proof.result === 'in-check-invalid') {
    return {
      requestedPlies: 3, result: 'invalid', plies: null, line: null,
      nodesUsed: proof.nodesUsed, budget: proof.budget, budgetVersion: proof.budgetVersion,
      reason: 'in-check-invalid',
    };
  }
  return {
    requestedPlies: 3, result: proof.result, plies: proof.plies, line: proof.line,
    nodesUsed: proof.nodesUsed, budget: proof.budget, budgetVersion: proof.budgetVersion,
  };
}
