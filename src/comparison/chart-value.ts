import type { PlyResult } from './schema.ts';

/**
 * アプリが評価値グラフに表示する値への写像のミラー。
 *
 * 本体は `src/ui/evaluation.ts` の `resolveCurrentEvaluation` → `toEvaluationChartValue`
 * と、`src/ui/charts.tsx` の `y()` が行う ±1500 への clamp である。
 * Node の type stripping で直接実行されるこのモジュールは拡張子なし import を
 * 解決できないため、既存コードを import せず同じ規則をここに写している。
 * 等価性は `tests/comparison/chart-value.test.ts` が本体の関数と突き合わせて検証する。
 *
 * 規約（本体と同一）:
 * - cp → そのままの値（表示時に ±1500 へ clamp）。
 * - mate（勝者判明）→ ±1500。mate 0 / winner unknown → 欠測。
 * - terminal checkmate → 勝者側 ±1500。no-legal-moves → 欠測。
 * - incomplete / missing → 欠測（グラフに点を打たない）。
 */

export const EVALUATION_CHART_EDGE = 1500;

export function clipToChartEdge(value: number): number {
  return Math.max(-EVALUATION_CHART_EDGE, Math.min(EVALUATION_CHART_EDGE, value));
}

/**
 * 1 ply・1方式の export 結果を、グラフに表示される値（欠測は null）へ変換する。
 * 返り値は ±1500 へ clip 済みの「表示値」。生の cp 差とは別の指標として扱うこと。
 */
export function toDisplayChartValue(result: PlyResult | null | undefined): number | null {
  if (!result) return null;
  if (result.status === 'terminal') {
    if (result.terminal?.kind !== 'checkmate') return null;
    return result.terminal.winner === 'black' ? EVALUATION_CHART_EDGE : -EVALUATION_CHART_EDGE;
  }
  if (result.status !== 'complete') return null;
  const evaluation = result.evaluation;
  if (!evaluation) return null;
  if (evaluation.kind === 'cp') return clipToChartEdge(evaluation.value);
  // mate: 勝者不明（mate 0）は欠測。winner と符号の一致は validator が保証する。
  if (evaluation.winner === 'black') return EVALUATION_CHART_EDGE;
  if (evaluation.winner === 'white') return -EVALUATION_CHART_EDGE;
  return null;
}

/** ply 列から表示値の系列を作る（欠測は null のまま、区間を橋接しない）。 */
export function displayChartSeries(
  results: (PlyResult | null | undefined)[],
): (number | null)[] {
  return results.map((result) => toDisplayChartValue(result));
}
