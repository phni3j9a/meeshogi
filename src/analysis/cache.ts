import type { AnalysisConditions, GameRecord, PositionAnalysis } from '../domain/model';
import { CURRENT_ANALYSIS_IDENTITY } from './identity';

export function isCompatibleAnalysis(
  analysis: PositionAnalysis | null | undefined,
  sfen: string,
  conditions: AnalysisConditions,
): analysis is PositionAnalysis {
  const status = (analysis as (PositionAnalysis & { status?: unknown }) | null | undefined)?.status;
  return (
    !!analysis &&
    (status === undefined || status === 'complete') &&
    analysis.sfen === sfen &&
    analysis.engineId === CURRENT_ANALYSIS_IDENTITY.engineId &&
    analysis.modelId === CURRENT_ANALYSIS_IDENTITY.modelId &&
    analysis.conditions.nodes === conditions.nodes &&
    analysis.conditions.multiPV === conditions.multiPV
  );
}

/** Keep one slot per mainline position; old results never become zero-valued graph points. */
export function currentGameAnalysis(
  game: Pick<GameRecord, 'positions' | 'analysis'>,
  conditions: AnalysisConditions,
): (PositionAnalysis | null)[] {
  return game.positions.map((sfen, ply) =>
    isCompatibleAnalysis(game.analysis[ply], sfen, conditions)
      ? game.analysis[ply]
      : null,
  );
}
