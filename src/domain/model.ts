export type Side = 'black' | 'white';
export type AnalysisMethod = 'sekirei' | 'cloud-free' | 'cloud-precision';
export const ANALYSIS_METHODS = ['sekirei', 'cloud-free', 'cloud-precision'] as const;
export const ANALYSIS_METHOD_LABELS: Record<AnalysisMethod, string> = {
  sekirei: '端末内（Sekirei）',
  'cloud-free': 'Cloud・無料',
  'cloud-precision': 'Cloud・精密',
};
export function cloudProfileOf(method: AnalysisMethod): 'free' | 'precision' | null {
  return method === 'cloud-free' ? 'free' : method === 'cloud-precision' ? 'precision' : null;
}
export const PIECE_SET_IDS = ['tsuge', 'shiraki', 'sakura', 'seiji'] as const;
export type PieceSetId = (typeof PIECE_SET_IDS)[number];
export type Service = 'shogiwars' | 'kiou' | 'unknown';
export type GameResult = 'black-win' | 'white-win' | 'draw' | 'interrupted' | 'unknown';
export type Opening = 'static' | 'fourth-file' | 'central' | 'third-file' | 'opposing' | 'unknown';
export type Formation = 'double-static' | 'static-ranging' | 'double-ranging' | 'unknown';
export interface OpeningTag {
  automatic: Opening;
  manual: Opening | null;
}
export interface GameMove {
  usi: string;
  label: string;
  elapsedMs: number;
  totalElapsedMs: number;
}
export interface ParsedGame {
  rawKif: string;
  identity: string;
  blackName: string;
  whiteName: string;
  blackRank: string | null;
  whiteRank: string | null;
  startedAt: string;
  endedAt: string | null;
  timeControl: string;
  headers: Record<string, string>;
  service: Service;
  result: GameResult;
  termination: string;
  moves: GameMove[];
  /** Initial position followed by each mainline ply. */
  positions: string[];
  openings: { black: OpeningTag; white: OpeningTag; ruleVersion: string };
}
export interface AnalysisConditions {
  nodes: number;
  multiPV: number;
}
export interface AnalysisCandidate {
  usi: string;
  pv: string[];
  scoreCp: number | null;
  mate: number | null;
  depth: number;
}
export interface MateProof {
  status: 'proven' | 'not-found' | 'incomplete';
  plies?: 1 | 3;
  side: Side;
  pv: string[];
}
export interface AnalysisMeta {
  requestedNodes: number;
  nodes: number;
  completedDepth: number;
  fallback: boolean;
  budgetReached: boolean;
}
export interface PositionAnalysis {
  sfen: string;
  engineId: string;
  modelId: string;
  status: 'complete';
  meta: AnalysisMeta;
  conditions: AnalysisConditions;
  /** Every score is normalized to black's perspective. */
  candidates: AnalysisCandidate[];
  /** Set when the SFEN has no legal move; terminal positions have no PV. */
  terminal?: 'checkmate' | 'no-legal-moves';
  mateProof: MateProof | null;
  completedAt: string;
  /**
   * JS wall time (ms) of the analyze() call that produced this row. Absent on
   * results stored before call timing existed — never inferred elsewhere.
   */
  callElapsedMs?: number;
  /** runId of the whole-game analysis run that produced this row. */
  runId?: string;
}
/**
 * Record of the latest Sekirei whole-game analysis run, persisted with the
 * game. Absent for results stored before run timing existed; the comparison
 * export reports those values as null/unknown rather than guessing.
 */
export interface SekireiRunRecord {
  /** Identifies the run; doubles as the export's attemptId for Sekirei. */
  runId: string;
  /** Conditions snapshot of this run. */
  conditions: AnalysisConditions;
  /** JS-measured wall clock covering the whole pass over all plies (ms). */
  wholeGameWallMs: number;
  /** Plies answered by a stored compatible result instead of a new search. */
  cacheReuseCount: number;
  /** The run stopped before covering every ply (cancel/invalidation/error). */
  interrupted: boolean;
  /** The run continued from results persisted by earlier runs. */
  resumed: boolean;
  completion: 'completed' | 'partial' | 'interrupted';
}
export interface GameRecord extends ParsedGame {
  /** App-only correction; the result parsed from rawKif remains unchanged. */
  manualResult?: GameResult | null;
  id: string;
  createdAt: string;
  favorite: boolean;
  lastViewedPly: number;
  lastOpenedAt?: string;
  mySide: Side | null;
  attribution: 'automatic' | 'manual' | 'ambiguous' | 'none';
  analysis: Record<number, PositionAnalysis>;
  /** Latest Sekirei whole-game run record; absent for pre-timing data. */
  analysisRun?: SekireiRunRecord;
}
export interface Settings {
  playerNames: Record<Service, string[]>;
  autoAnalyze: boolean;
  analysisMethod: AnalysisMethod;
  analysisNodes: number;
  multiPV: number;
  theme: 'system' | 'light' | 'dark';
  pieceSet: PieceSetId;
  boardFlip: boolean;
  showArrows: boolean;
  showMateBadges: boolean;
  haptics: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  playerNames: { shogiwars: [], kiou: [], unknown: [] },
  autoAnalyze: true,
  analysisMethod: 'sekirei',
  analysisNodes: 10000,
  multiPV: 2,
  theme: 'system',
  pieceSet: 'tsuge',
  boardFlip: false,
  showArrows: true,
  showMateBadges: true,
  haptics: true,
};
export interface StatFilter {
  month?: string;
  service?: Service;
  side?: Side;
  opening?: Opening;
  openingSide?: 'self' | 'opponent';
}
/** winRate is a ratio in [0, 1], or null when there are no decided games. */
export interface Tally {
  total: number;
  wins: number;
  losses: number;
  draws: number;
  interrupted: number;
  unknown: number;
  winRate: number | null;
}
export interface Statistics extends Tally {
  games: GameRecord[];
  months: { month: string; tally: Tally }[];
  sides: Record<Side, Tally>;
  services: Record<Service, Tally>;
  openings: { opening: Opening; tally: Tally }[];
  formations: { formation: Formation; tally: Tally }[];
  trend: { gameId: string; winRate: number | null }[];
}
export const SERVICE_LABELS: Record<Service, string> = {
  shogiwars: '将棋ウォーズ',
  kiou: '棋桜',
  unknown: 'その他・不明',
};
export const OPENING_LABELS: Record<Opening, string> = {
  static: '居飛車',
  'fourth-file': '四間飛車',
  central: '中飛車',
  'third-file': '三間飛車',
  opposing: '向かい飛車',
  unknown: '未分類',
};
export const SIDE_LABELS: Record<Side, string> = { black: '先手', white: '後手' };
export const FORMATION_LABELS: Record<Formation, string> = {
  'double-static': '相居飛車',
  'static-ranging': '対抗形',
  'double-ranging': '相振り飛車',
  unknown: '未分類',
};
export const RESULT_LABELS: Record<GameResult, string> = {
  'black-win': '先手の勝ち',
  'white-win': '後手の勝ち',
  draw: '引き分け',
  interrupted: '中断',
  unknown: '結果不明',
};
export function effectiveResult(game: Pick<GameRecord, 'result' | 'manualResult'>): GameResult {
  return game.manualResult ?? game.result;
}
