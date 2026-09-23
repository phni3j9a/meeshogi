export const ANALYSIS_CONTRACT_VERSION = 1 as const;

export const ANALYSIS_TERMINAL_STATUSES = [
  'ok',
  'mate',
  'mate0',
  'resign',
  'timeout',
  'error',
  'cancelled',
  'incomplete',
] as const;

export type AnalysisTerminalStatus = (typeof ANALYSIS_TERMINAL_STATUSES)[number];

export type AnalysisCandidate = {
  move: string;
  pvUsi: string[];
  scoreCp?: number;
  scoreMate?: number;
};

export type CloudAnalysisResultV1 = {
  contractVersion: typeof ANALYSIS_CONTRACT_VERSION;
  analysisProfileId: string;
  profileVersion: number;
  engineId: string;
  modelId: string;
  sfen: string;
  candidates: AnalysisCandidate[];
  actualNodes: number;
  completedDepth: number;
  elapsedMs: number;
  multipv: number;
  completedAt: string;
  terminal: AnalysisTerminalStatus;
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
  'actualNodes',
  'completedDepth',
  'elapsedMs',
  'multipv',
  'completedAt',
  'terminal',
]);
const CANDIDATE_KEYS = new Set(['move', 'pvUsi', 'scoreCp', 'scoreMate']);

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

export function isCloudAnalysisResultV1(value: unknown): value is CloudAnalysisResultV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, RESULT_KEYS)) return false;
  if (value.contractVersion !== ANALYSIS_CONTRACT_VERSION) return false;
  if (typeof value.analysisProfileId !== 'string' || value.analysisProfileId.length === 0) return false;
  if (!Number.isSafeInteger(value.profileVersion) || (value.profileVersion as number) < 1) return false;
  if (typeof value.engineId !== 'string' || value.engineId.length === 0) return false;
  if (typeof value.modelId !== 'string' || value.modelId.length === 0) return false;
  if (!isShogiSfen(value.sfen)) return false;
  if (!Number.isSafeInteger(value.actualNodes) || (value.actualNodes as number) < 0) return false;
  if (!Number.isSafeInteger(value.completedDepth) || (value.completedDepth as number) < 0) return false;
  if (!Number.isSafeInteger(value.elapsedMs) || (value.elapsedMs as number) < 0) return false;
  if (!Number.isSafeInteger(value.multipv) || (value.multipv as number) < 1 || (value.multipv as number) > 8) return false;
  if (typeof value.completedAt !== 'string') return false;
  const completedAtMs = Date.parse(value.completedAt);
  if (!Number.isFinite(completedAtMs) || new Date(completedAtMs).toISOString() !== value.completedAt) return false;
  if (!(ANALYSIS_TERMINAL_STATUSES as readonly unknown[]).includes(value.terminal)) return false;
  if (!Array.isArray(value.candidates) || value.candidates.length > 8) return false;

  let hasMateScore = false;
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, CANDIDATE_KEYS)) return false;
    if (typeof candidate.move !== 'string' || !USI_MOVE_RE.test(candidate.move)) return false;
    if (!Array.isArray(candidate.pvUsi) || candidate.pvUsi.length < 1 || candidate.pvUsi.length > 64) return false;
    if (!candidate.pvUsi.every((move) => typeof move === 'string' && USI_MOVE_RE.test(move))) return false;
    if (candidate.pvUsi[0] !== candidate.move) return false;
    const hasCp = Object.hasOwn(candidate, 'scoreCp');
    const hasMate = Object.hasOwn(candidate, 'scoreMate');
    if (hasCp === hasMate) return false;
    if (hasCp && (!Number.isSafeInteger(candidate.scoreCp) || (candidate.scoreCp as number) < -32000 || (candidate.scoreCp as number) > 32000)) return false;
    if (hasMate && (!Number.isSafeInteger(candidate.scoreMate) || Math.abs(candidate.scoreMate as number) > 100000)) return false;
    hasMateScore ||= hasMate;
  }

  if ((value.terminal === 'ok' || value.terminal === 'mate') && value.candidates.length === 0) return false;
  if (value.terminal === 'mate' && !hasMateScore) return false;
  if (value.terminal === 'ok' && hasMateScore) return false;
  return true;
}

export function isStrictShogiSfen(sfen: unknown): sfen is string {
  return isShogiSfen(sfen);
}
