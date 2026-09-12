import type { AnalysisConditions, GameRecord, PositionAnalysis } from '../domain/model';
import { CURRENT_ANALYSIS_IDENTITY } from './identity';

export function isCompatibleAnalysis(
  analysis: PositionAnalysis | null | undefined,
  sfen: string,
  conditions: AnalysisConditions,
  identity = CURRENT_ANALYSIS_IDENTITY,
): analysis is PositionAnalysis {
  return (
    !!analysis &&
    analysis.sfen === sfen &&
    analysis.engineId === identity.engineId &&
    analysis.modelId === identity.modelId &&
    analysis.conditions.nodes === conditions.nodes &&
    analysis.conditions.multiPV === conditions.multiPV
  );
}

/** Keep one slot per mainline position; old results never become zero-valued graph points. */
export function currentGameAnalysis(
  game: Pick<GameRecord, 'positions' | 'analysis'>,
  conditions: AnalysisConditions,
  identity = CURRENT_ANALYSIS_IDENTITY,
): (PositionAnalysis | null)[] {
  return game.positions.map((sfen, ply) =>
    isCompatibleAnalysis(game.analysis[ply], sfen, conditions, identity)
      ? game.analysis[ply]
      : null,
  );
}
