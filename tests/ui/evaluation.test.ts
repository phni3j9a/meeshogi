import { describe, expect, it } from 'vitest';
import type { MateProof, Side } from '../../src/domain/model';
import {
  EVALUATION_CHART_EDGE,
  formatEvaluation,
  isDisplayableMateProof,
  toEvaluationChartValue,
  toEvaluationValue,
} from '../../src/ui/evaluation';

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
