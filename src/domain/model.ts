export type Side = 'black' | 'white';
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
export interface PositionAnalysis {
  sfen: string;
  engineId: string;
  modelId: string;
  conditions: AnalysisConditions;
  /** Every score is normalized to black's perspective. */
  candidates: AnalysisCandidate[];
  /** Set when the SFEN has no legal move; terminal positions have no PV. */
  terminal?: 'checkmate' | 'no-legal-moves';
  mateProof: MateProof | null;
  completedAt: string;
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
}
export interface Settings {
  playerNames: Record<Service, string[]>;
  autoAnalyze: boolean;
  analysisNodes: number;
  multiPV: number;
  theme: 'system' | 'light' | 'dark';
  boardFlip: boolean;
  showArrows: boolean;
  showMateBadges: boolean;
  haptics: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  playerNames: { shogiwars: [], kiou: [], unknown: [] },
  autoAnalyze: true,
  analysisNodes: 10000,
  multiPV: 2,
  theme: 'system',
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
