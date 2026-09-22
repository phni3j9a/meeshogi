import { describe, expect, it } from 'vitest';
import { currentGameAnalysis, isCompatibleAnalysis } from '../../src/analysis/cache';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import type { PositionAnalysis } from '../../src/domain/model';

const analysis: PositionAnalysis = {
  ...CURRENT_ANALYSIS_IDENTITY,
  sfen: '4k4/9/4G4/9/9/9/9/9/K8 b G 1',
  conditions: { nodes: 10000, multiPV: 2 },
  candidates: [{ usi: 'G*5b', pv: ['G*5b'], scoreCp: null, mate: 1, depth: 1 }],
  mateProof: { status: 'proven', plies: 1, side: 'black', pv: ['G*5b'] },
  completedAt: '2026-09-12T00:00:00.000Z',
};

describe('saved analysis compatibility', () => {
  it('requires the exact position, engine, model, node budget and candidate count', () => {
    expect(isCompatibleAnalysis(analysis, analysis.sfen, analysis.conditions)).toBe(true);
    for (const changed of [
      { ...analysis, sfen: analysis.sfen.replace(' b ', ' w ') },
      { ...analysis, engineId: 'previous-engine' },
      { ...analysis, modelId: 'previous-weight' },
      { ...analysis, conditions: { ...analysis.conditions, nodes: 50000 } },
      { ...analysis, conditions: { ...analysis.conditions, multiPV: 3 } },
      { ...analysis, status: 'incomplete' } as unknown as PositionAnalysis,
    ])
      expect(isCompatibleAnalysis(changed, analysis.sfen, analysis.conditions)).toBe(false);
    expect(isCompatibleAnalysis(null, analysis.sfen, analysis.conditions)).toBe(false);
  });

  it('preserves graph gaps and excludes stale proof/results from completion without deleting them', () => {
    const old = { ...analysis, engineId: 'old-engine' };
    const game = {
      positions: [analysis.sfen, analysis.sfen, analysis.sfen],
      analysis: { 0: analysis, 1: old },
    };
    const selected = currentGameAnalysis(game, analysis.conditions);
    expect(selected).toEqual([analysis, null, null]);
    expect(selected.filter(Boolean)).toHaveLength(1);
    expect(game.analysis[1]).toBe(old);
    expect(currentGameAnalysis(game, { nodes: 50000, multiPV: 2 })).toEqual([null, null, null]);
  });
});
