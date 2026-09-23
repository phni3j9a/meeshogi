export const ANALYSIS_CONTRACT_VERSION = 3 as const;

export const ANALYSIS_TERMINAL_STATUSES = [
  'ok',
  'mate',
  'incomplete',
  'position_failed:engine_timeout',
  'position_failed:engine_exit',
  'position_failed:engine_restart_failed',
  'position_failed:protocol_error',
  'win',
  'resign',
  'none',
  'no_legal_moves',
  'cancelled',
  'failed',
] as const;

export type AnalysisTerminalStatus = (typeof ANALYSIS_TERMINAL_STATUSES)[number];
export type AnalysisMateSign = 'sente' | 'gote' | 'unknown';
export type AnalysisCandidate = {
  move: string;
  pvUsi: string[];
  depth: number;
  scoreCp?: number;
  scoreMate?: number;
  /** Preserves the sign of USI `mate -0` and identifies an unknown distance. */
  mateSign?: AnalysisMateSign;
};

export type CloudAnalysisResultV3 = {
  contractVersion: typeof ANALYSIS_CONTRACT_VERSION;
  analysisProfileId: string;
  profileVersion: number;
  engineId: string;
  modelId: string;
  sfen: string;
  candidates: AnalysisCandidate[];
  /**
   * The engine's own bestmove, kept even when it differs from the first
   * candidate of the last fully completed MultiPV block. Required when
   * terminal is `ok`, `mate`, or `incomplete`; absent otherwise.
   */
  engineBestmove?: string;
  actualNodes: number;
  completedDepth: number;
  elapsedMs: number;
  /** Retained as an alias for the number of returned candidates. */
  multipv: number;
  requestedMultiPv: number;
  effectiveMultiPv: number;
  rootLegalMoveCount: number;
  completedAt: string;
  terminal: AnalysisTerminalStatus;
  /** Process identity that produced this response, even if a restart followed. */
  engineEpoch: string;
  restartCount: number;
  processId: number;
  terminalDetail?: 'checkmate' | 'no_legal_moves' | 'declaration_win';
};

const USI_MOVE_RE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;
const RESULT_KEYS = new Set([
  'contractVersion',
  'analysisProfileId',
  'profileVersion',
  'engineId',
  'modelId',
  'sfen',
  'candidates',
  'engineBestmove',
  'actualNodes',
  'completedDepth',
  'elapsedMs',
  'multipv',
  'requestedMultiPv',
  'effectiveMultiPv',
  'rootLegalMoveCount',
  'completedAt',
  'terminal',
  'engineEpoch',
  'restartCount',
  'processId',
  'terminalDetail',
]);
const CANDIDATE_KEYS = new Set(['move', 'pvUsi', 'depth', 'scoreCp', 'scoreMate', 'mateSign']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isShogiSfen(sfen: unknown): sfen is string {
  if (typeof sfen !== 'string' || sfen.length > 256 || sfen.trim() !== sfen) return false;
  const fields = sfen.split(/\s+/);
  if (fields.length !== 4) return false;
  const [board, turn, hands, moveNumber] = fields;
  if (turn !== 'b' && turn !== 'w') return false;
  if (!/^[1-9][0-9]*$/.test(moveNumber)) return false;
  if (hands !== '-' && !/^(?:[1-9][0-9]*)?[PLNSGBRplnsgbr](?:(?:[1-9][0-9]*)?[PLNSGBRplnsgbr])*$/u.test(hands)) {
    return false;
  }

  const ranks = board.split('/');
  if (ranks.length !== 9) return false;
  return ranks.every((rank) => {
    let files = 0;
    for (let index = 0; index < rank.length; index += 1) {
      const char = rank[index];
      if (/[1-9]/.test(char)) {
        if (index > 0 && /[1-9]/.test(rank[index - 1])) return false;
        files += Number(char);
        continue;
      }
      if (char === '+') {
        const promoted = rank[index + 1];
        if (!promoted || !/[PLNSBRplnsbr]/.test(promoted)) return false;
        files += 1;
        index += 1;
        continue;
      }
      if (!/[PLNSGBRKplnsgbrk]/.test(char)) return false;
      files += 1;
    }
    return files === 9;
  });
}

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validTerminal(value: unknown): value is AnalysisTerminalStatus {
  return (ANALYSIS_TERMINAL_STATUSES as readonly unknown[]).includes(value);
}

function candidateHasExactScore(candidate: Record<string, unknown>): boolean {
  const hasCp = Object.hasOwn(candidate, 'scoreCp');
  const hasMateDistance = Object.hasOwn(candidate, 'scoreMate');
  const hasMateSign = Object.hasOwn(candidate, 'mateSign');
  if (hasCp) {
    return !hasMateDistance && !hasMateSign && isSafeIntegerInRange(candidate.scoreCp, -1_000_000, 1_000_000);
  }
  if (!hasMateSign) return false;
  if (candidate.mateSign !== 'sente' && candidate.mateSign !== 'gote' && candidate.mateSign !== 'unknown') return false;
  if (!hasMateDistance) return true;
  if (!isSafeIntegerInRange(candidate.scoreMate, -100_000, 100_000) || candidate.scoreMate === 0) return false;
  return candidate.mateSign === (candidate.scoreMate > 0 ? 'sente' : 'gote');
}

export function isCloudAnalysisResultV3(value: unknown): value is CloudAnalysisResultV3 {
  if (!isRecord(value) || !hasOnlyKeys(value, RESULT_KEYS)) return false;
  if (value.contractVersion !== ANALYSIS_CONTRACT_VERSION) return false;
  if (typeof value.analysisProfileId !== 'string' || value.analysisProfileId.length === 0) return false;
  if (!isSafeIntegerInRange(value.profileVersion, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (typeof value.engineId !== 'string' || value.engineId.length === 0) return false;
  if (typeof value.modelId !== 'string' || value.modelId.length === 0) return false;
  if (!isShogiSfen(value.sfen)) return false;
  if (!isSafeIntegerInRange(value.actualNodes, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isSafeIntegerInRange(value.completedDepth, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isSafeIntegerInRange(value.elapsedMs, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isSafeIntegerInRange(value.requestedMultiPv, 1, 8)) return false;
  if (!isSafeIntegerInRange(value.rootLegalMoveCount, 0, 512)) return false;
  const expectedEffective = Math.min(value.requestedMultiPv, value.rootLegalMoveCount);
  if (!isSafeIntegerInRange(value.effectiveMultiPv, 0, 8) || value.effectiveMultiPv !== expectedEffective) return false;
  if (!isSafeIntegerInRange(value.multipv, 0, 8) || value.multipv !== value.effectiveMultiPv) return false;
  if (typeof value.completedAt !== 'string') return false;
  const completedAtMs = Date.parse(value.completedAt);
  if (!Number.isFinite(completedAtMs) || new Date(completedAtMs).toISOString() !== value.completedAt) return false;
  if (!validTerminal(value.terminal)) return false;
  if (typeof value.engineEpoch !== 'string' || value.engineEpoch.length === 0 || value.engineEpoch.length > 128) return false;
  if (!isSafeIntegerInRange(value.restartCount, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isSafeIntegerInRange(value.processId, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (value.terminalDetail !== undefined && !['checkmate', 'no_legal_moves', 'declaration_win'].includes(value.terminalDetail as string)) {
    return false;
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > 8) return false;

  const candidateMoves = new Set<string>();
  let hasMateScore = false;
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, CANDIDATE_KEYS)) return false;
    if (typeof candidate.move !== 'string' || !USI_MOVE_RE.test(candidate.move)) return false;
    if (candidateMoves.has(candidate.move)) return false;
    candidateMoves.add(candidate.move);
    if (!Array.isArray(candidate.pvUsi) || candidate.pvUsi.length < 1 || candidate.pvUsi.length > 64) return false;
    if (!candidate.pvUsi.every((move) => typeof move === 'string' && USI_MOVE_RE.test(move))) return false;
    if (candidate.pvUsi[0] !== candidate.move) return false;
    if (!isSafeIntegerInRange(candidate.depth, 1, Number.MAX_SAFE_INTEGER)) return false;
    if (!candidateHasExactScore(candidate)) return false;
    hasMateScore ||= Object.hasOwn(candidate, 'scoreMate') || Object.hasOwn(candidate, 'mateSign');
  }

  if (value.terminal === 'ok' || value.terminal === 'mate') {
    if (value.effectiveMultiPv < 1 || value.candidates.length !== value.effectiveMultiPv) return false;
    if (value.completedDepth < 1 || !value.candidates.every((candidate) => candidate.depth === value.completedDepth)) return false;
    if (value.terminal === 'mate' && !hasMateScore) return false;
    if (value.terminal === 'ok' && hasMateScore) return false;
  } else if (value.candidates.length !== 0) {
    return false;
  }

  if (value.terminal === 'no_legal_moves' || value.terminal === 'none') {
    if (value.rootLegalMoveCount !== 0 || value.effectiveMultiPv !== 0) return false;
    if (value.terminalDetail !== 'checkmate' && value.terminalDetail !== 'no_legal_moves') return false;
  }
  if (value.terminal === 'win' && value.terminalDetail !== 'declaration_win') return false;
  const expectsBestmove = value.terminal === 'ok' || value.terminal === 'mate' || value.terminal === 'incomplete';
  if (expectsBestmove) {
    if (typeof value.engineBestmove !== 'string' || !USI_MOVE_RE.test(value.engineBestmove)) return false;
  } else if (value.engineBestmove !== undefined) {
    return false;
  }
  return true;
}

export function isStrictShogiSfen(sfen: unknown): sfen is string {
  return isShogiSfen(sfen);
}
