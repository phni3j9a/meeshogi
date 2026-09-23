import { describe, expect, it } from 'vitest';
import type { MateProof, Side } from '../../src/domain/model';
import type { PositionAnalysis } from '../../src/domain/model';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import {
  EVALUATION_CHART_EDGE,
  formatEvaluation,
  isDisplayableMateProof,
  resolveCurrentEvaluation,
  toEvaluationChartValue,
  toEvaluationValue,
} from '../../src/ui/evaluation';

const checkmateWhiteToMove: PositionAnalysis = {
  ...CURRENT_ANALYSIS_IDENTITY,
  sfen: '4k4/3RG4/9/9/9/9/9/9/8K w - 1',
  status: 'complete',
  meta: { requestedNodes: 1, nodes: 0, completedDepth: 0, fallback: false, budgetReached: false },
  conditions: { nodes: 1, multiPV: 1 },
  candidates: [],
  terminal: 'checkmate',
  mateProof: null,
  completedAt: '2026-09-22T00:00:00.000Z',
};
const checkmateBlackToMove: PositionAnalysis = {
  ...CURRENT_ANALYSIS_IDENTITY,
  sfen: '8k/9/9/9/9/9/9/3rg4/4K4 b - 1',
  status: 'complete',
  meta: { requestedNodes: 1, nodes: 0, completedDepth: 0, fallback: false, budgetReached: false },
  conditions: { nodes: 1, multiPV: 1 },
  candidates: [],
  terminal: 'checkmate',
  mateProof: null,
  completedAt: '2026-09-22T00:00:00.000Z',
};
const noLegalMoves: PositionAnalysis = {
  ...CURRENT_ANALYSIS_IDENTITY,
  sfen: 'k8/9/9/9/9/9/4n4/2r6/4K4 b - 1',
  status: 'complete',
  meta: { requestedNodes: 1, nodes: 0, completedDepth: 0, fallback: false, budgetReached: false },
  conditions: { nodes: 1, multiPV: 1 },
  candidates: [],
  terminal: 'no-legal-moves',
  mateProof: null,
  completedAt: '2026-09-22T00:00:00.000Z',
};

describe('評価値の表示変換', () => {
  it.each([
    {
      name: '先手有利の評価値',
      source: { scoreCp: 240, mate: null },
      formatted: '+240',
      chart: 240,
    },
    {
      name: '互角の評価値',
      source: { scoreCp: 0, mate: null },
      formatted: '0',
      chart: 0,
    },
    {
      name: '先手の5手詰め',
      source: { scoreCp: null, mate: 5 },
      formatted: '+M5',
      chart: EVALUATION_CHART_EDGE,
    },
    {
      name: '後手の5手詰め',
      source: { scoreCp: null, mate: -5 },
      formatted: '-M5',
      chart: -EVALUATION_CHART_EDGE,
    },
    {
      name: '未解析',
      source: undefined,
      formatted: '—',
      chart: null,
    },
  ])('$nameを共通の表示値へ変換する', ({ source, formatted, chart }) => {
    const value = toEvaluationValue(source);
    expect(formatEvaluation(value)).toBe(formatted);
    expect(toEvaluationChartValue(value)).toBe(chart);
  });

  it('mate 0、解析候補の欠測、5手以上のmateを安全に扱う', () => {
    expect(toEvaluationValue({ scoreCp: null, mate: 0 })).toEqual({ kind: 'missing' });
    expect(formatEvaluation(toEvaluationValue(null))).toBe('—');
    expect(toEvaluationValue({ scoreCp: null, mate: 7 })).toEqual({
      kind: 'black-mate',
      plies: 7,
    });
    expect(toEvaluationValue({ scoreCp: null, mate: -7 })).toEqual({
      kind: 'white-mate',
      plies: 7,
    });
  });

  it('欠測をまたぐグラフの点をnullのまま保持する', () => {
    const values = [
      { scoreCp: 0, mate: null },
      undefined,
      { scoreCp: null, mate: 5 },
      undefined,
      { scoreCp: null, mate: -5 },
    ].map((source) => toEvaluationChartValue(toEvaluationValue(source)));
    expect(values).toEqual([0, null, EVALUATION_CHART_EDGE, null, -EVALUATION_CHART_EDGE]);
  });
});

describe('詰み証明バッジの表示条件', () => {
  const provenBlack: MateProof = { status: 'proven', plies: 1, side: 'black', pv: ['7g7f'] };
  const provenWhite: MateProof = { status: 'proven', plies: 3, side: 'white', pv: ['3c3d'] };
  const badgeVisible = (showMateBadges: boolean, proof: MateProof | null, side: Side | undefined) =>
    showMateBadges && isDisplayableMateProof(proof, side);

  it('通常探索のmateだけではバッジ条件にならない', () => {
    const ordinaryMate = toEvaluationValue({ scoreCp: null, mate: 5 });
    expect(formatEvaluation(ordinaryMate)).toBe('+M5');
    expect(badgeVisible(true, null, 'black')).toBe(false);
  });

  it('証明なし、未発見、不完全、不一致手番は表示しない', () => {
    expect(isDisplayableMateProof(undefined, 'black')).toBe(false);
    expect(isDisplayableMateProof({ status: 'not-found', side: 'black', pv: [] }, 'black')).toBe(
      false,
    );
    expect(isDisplayableMateProof({ status: 'incomplete', side: 'black', pv: [] }, 'black')).toBe(
      false,
    );
    expect(isDisplayableMateProof(provenBlack, 'white')).toBe(false);
    expect(isDisplayableMateProof(provenBlack, undefined)).toBe(false);
    expect(
      isDisplayableMateProof(
        { status: 'proven', plies: 5, side: 'black', pv: [] } as unknown as MateProof,
        'black',
      ),
    ).toBe(false);
  });

  it('証明済みの1手／3手詰めで手番が一致する場合だけ表示する', () => {
    expect(isDisplayableMateProof(provenBlack, 'black')).toBe(true);
    expect(isDisplayableMateProof(provenWhite, 'white')).toBe(true);
  });

  it('設定OFFなら証明済みでも最終表示条件はfalseになる', () => {
    expect(badgeVisible(false, provenBlack, 'black')).toBe(false);
    expect(badgeVisible(true, provenBlack, 'black')).toBe(true);
  });
});

describe('現在局面の評価 resolver', () => {
  it('詰み終局を先手視点の符号と勝者表示へ変換する', () => {
    const blackWin = resolveCurrentEvaluation(checkmateWhiteToMove);
    const whiteWin = resolveCurrentEvaluation(checkmateBlackToMove);
    expect(blackWin).toEqual({ kind: 'checkmate', value: 1500, winner: 'black' });
    expect(whiteWin).toEqual({ kind: 'checkmate', value: -1500, winner: 'white' });
    expect(formatEvaluation(blackWin)).toBe('先手勝ち・詰み終局');
    expect(formatEvaluation(whiteWin)).toBe('後手勝ち・詰み終局');
    expect(toEvaluationChartValue(blackWin)).toBe(1500);
    expect(toEvaluationChartValue(whiteWin)).toBe(-1500);
  });

  it('no-legal-moves、旧identity、未解析は全て欠測のままにする', () => {
    expect(resolveCurrentEvaluation(noLegalMoves)).toEqual({ kind: 'missing' });
    expect(resolveCurrentEvaluation(undefined)).toEqual({ kind: 'missing' });
    expect(resolveCurrentEvaluation({ ...checkmateWhiteToMove, engineId: 'old-engine' })).toEqual({
      kind: 'missing',
    });
    expect(
      resolveCurrentEvaluation({
        ...checkmateWhiteToMove,
        status: 'incomplete',
      } as unknown as PositionAnalysis),
    ).toEqual({ kind: 'missing' });
  });

  it('盤面の反転に相当する表示状態を変えても符号を変えない', () => {
    const valueBeforeFlip = resolveCurrentEvaluation(checkmateWhiteToMove);
    const valueAfterFlip = resolveCurrentEvaluation(checkmateWhiteToMove);
    expect(valueAfterFlip).toEqual(valueBeforeFlip);
    expect(toEvaluationChartValue(valueAfterFlip)).toBe(1500);
  });
});
