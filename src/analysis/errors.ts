import type { AnalysisConditions, AnalysisMeta } from '../domain/model';

/**
 * The native bridge proved that this position reached its node budget before
 * completing the first iterative-deepening result.  It is recoverable for a
 * whole-game scan, but it is not a PositionAnalysis and must never be saved.
 */
export class AnalysisBudgetIncompleteError extends Error {
  readonly sfen: string;
  readonly conditions: AnalysisConditions;
  readonly meta: AnalysisMeta;

  constructor(sfen: string, conditions: AnalysisConditions, meta: AnalysisMeta) {
    super(
      'この局面は探索量が不足して成立しませんでした。設定の解析量（ノード数）を増やすか、「この局面を深く解析」をお試しください。',
    );
    this.name = 'AnalysisBudgetIncompleteError';
    this.sfen = sfen;
    this.conditions = { ...conditions };
    this.meta = { ...meta };
    Object.setPrototypeOf(this, AnalysisBudgetIncompleteError.prototype);
  }
}
