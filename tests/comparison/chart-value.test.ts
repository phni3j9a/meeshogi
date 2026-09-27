import { describe, expect, it } from 'vitest';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import type { PositionAnalysis } from '../../src/domain/model';
import {
  resolveCurrentEvaluation,
  toEvaluationChartValue,
  toEvaluationValue,
} from '../../src/ui/evaluation';
import {
  clipToChartEdge,
  displayChartSeries,
  EVALUATION_CHART_EDGE,
  toDisplayChartValue,
} from '../../src/comparison/chart-value';
import type { PlyResult } from '../../src/comparison/schema';
import { cand, completeResult, cp, mate, sfenAt } from './fixtures';

/** アプリ本体の PositionAnalysis（complete・現行 identity）を組み立てる。 */
function analysisOf(source: { scoreCp: number | null; mate: number | null }, terminal?: 'checkmate' | 'no-legal-moves', sfen = sfenAt(1)): PositionAnalysis {
  return {
    ...CURRENT_ANALYSIS_IDENTITY,
    sfen,
    status: 'complete',
    meta: { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: false, budgetReached: true },
    conditions: { nodes: 1, multiPV: 1 },
    candidates: [{ usi: '7g7f', pv: ['7g7f'], scoreCp: source.scoreCp, mate: source.mate, depth: 1 }],
    ...(terminal !== undefined ? { terminal } : {}),
    mateProof: null,
    completedAt: '2026-09-26T00:00:00.000Z',
  };
}

function appChartValue(source: { scoreCp: number | null; mate: number | null } | undefined) {
  const raw = toEvaluationChartValue(toEvaluationValue(source));
  return raw === null ? null : clipToChartEdge(raw);
}

describe('表示値写像がアプリ本体と一致する', () => {
  it.each([
    { name: 'cp そのまま', source: { scoreCp: 240, mate: null }, export: cp(240) },
    { name: 'cp ゼロ', source: { scoreCp: 0, mate: null }, export: cp(0) },
    { name: 'cp 上限超えは clip', source: { scoreCp: 9999, mate: null }, export: cp(9999) },
    { name: 'cp 下限超えは clip', source: { scoreCp: -9999, mate: null }, export: cp(-9999) },
    { name: '先手 mate は +1500', source: { scoreCp: null, mate: 5 }, export: mate(5, 'black') },
    { name: '後手 mate は −1500', source: { scoreCp: null, mate: -7 }, export: mate(-7, 'white') },
    { name: 'mate 0 / unknown は欠測', source: { scoreCp: null, mate: 0 }, export: mate(0, 'unknown') },
  ])('$name', ({ source, export: score }) => {
    const result: PlyResult = completeResult('x', score, [cand('7g7f', score)]);
    expect(toDisplayChartValue(result)).toBe(appChartValue(source));
  });

  it('terminal checkmate を本体の resolveCurrentEvaluation と同じ ±1500 に写像する', () => {
    // checkmateWhiteToMove 相当: 後手番で詰み → 先手勝ち
    const whiteToMove = '4k4/3RG4/9/9/9/9/9/9/8K w - 1';
    const blackToMove = '8k/9/9/9/9/9/9/3rg4/4K4 b - 1';
    const appBlack = toEvaluationChartValue(
      resolveCurrentEvaluation(analysisOf({ scoreCp: null, mate: null }, 'checkmate', whiteToMove)),
    );
    const appWhite = toEvaluationChartValue(
      resolveCurrentEvaluation(analysisOf({ scoreCp: null, mate: null }, 'checkmate', blackToMove)),
    );
    expect(appBlack).toBe(EVALUATION_CHART_EDGE);
    expect(appWhite).toBe(-EVALUATION_CHART_EDGE);
    expect(
      toDisplayChartValue({ status: 'terminal', terminal: { kind: 'checkmate', winner: 'black' } }),
    ).toBe(appBlack);
    expect(
      toDisplayChartValue({ status: 'terminal', terminal: { kind: 'checkmate', winner: 'white' } }),
    ).toBe(appWhite);
  });

  it('no-legal-moves・incomplete・missing・行なしは欠測', () => {
    const appNoLegal = toEvaluationChartValue(
      resolveCurrentEvaluation(analysisOf({ scoreCp: null, mate: null }, 'no-legal-moves')),
    );
    expect(appNoLegal).toBeNull();
    expect(
      toDisplayChartValue({ status: 'terminal', terminal: { kind: 'no-legal-moves', winner: null } }),
    ).toBeNull();
    expect(toDisplayChartValue({ status: 'incomplete' })).toBeNull();
    expect(toDisplayChartValue({ status: 'missing' })).toBeNull();
    expect(toDisplayChartValue(null)).toBeNull();
    expect(toDisplayChartValue(undefined)).toBeNull();
  });

  it('displayChartSeries は null をそのまま残して区間を橋接しない', () => {
    const series = displayChartSeries([
      completeResult('x', cp(100), [cand('7g7f', cp(100))]),
      { status: 'missing' },
      completeResult('x', mate(3, 'black'), [cand('7g7f', mate(3, 'black'))]),
      null,
      { status: 'terminal', terminal: { kind: 'checkmate', winner: 'white' } },
    ]);
    expect(series).toEqual([100, null, EVALUATION_CHART_EDGE, null, -EVALUATION_CHART_EDGE]);
  });
});
