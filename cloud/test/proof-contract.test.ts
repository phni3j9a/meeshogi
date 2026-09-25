import { describe, expect, it } from 'vitest';
import { parseDriverProof, toStoredProof } from '../src/proof-contract';

const budget = 10_000;

describe('bounded mate proof contract', () => {
  it('preserves actual one-ply plies and its legal representative line', () => {
    const proof = parseDriverProof({
      result: 'proven', plies: 1, line: ['7g7f'], nodesUsed: 2, budget, budgetVersion: 'sekirei-proof-ops-v2',
    }, 3, budget);
    expect(proof?.plies).toBe(1);
    expect(proof && toStoredProof(proof)).toMatchObject({ requestedPlies: 3, result: 'proven', plies: 1, line: ['7g7f'] });
  });

  it('rejects unknown results, wrong budget versions, over-budget nodes and invalid lines', () => {
    const valid = { result: 'not-mate', plies: null, line: null, nodesUsed: 10, budget, budgetVersion: 'sekirei-proof-ops-v2' };
    expect(parseDriverProof({ ...valid, result: 'maybe' }, 3, budget)).toBeNull();
    expect(parseDriverProof({ ...valid, budgetVersion: 'sekirei-proof-ops-v1' }, 3, budget)).toBeNull();
    expect(parseDriverProof({ ...valid, nodesUsed: budget + 1 }, 3, budget)).toBeNull();
    expect(parseDriverProof({ ...valid, result: 'proven', plies: 3, line: ['7g7f'] }, 3, budget)).toBeNull();
    expect(parseDriverProof({ ...valid, budget: budget + 1 }, 3, budget)).toBeNull();
  });

  it('maps budget and in-check failures to non-badge unknown/invalid envelopes', () => {
    const exceeded = parseDriverProof({
      result: 'budget-exceeded', plies: null, line: null, nodesUsed: budget, budget, budgetVersion: 'sekirei-proof-ops-v2',
    }, 3, budget);
    const invalid = parseDriverProof({
      result: 'in-check-invalid', plies: null, line: null, nodesUsed: 0, budget, budgetVersion: 'sekirei-proof-ops-v2',
    }, 3, budget);
    expect(exceeded && toStoredProof(exceeded)).toMatchObject({ result: 'unknown', reason: 'budget-exceeded', plies: null, line: null });
    expect(invalid && toStoredProof(invalid)).toMatchObject({ result: 'invalid', reason: 'in-check-invalid', plies: null, line: null });
  });
});
