import { handPieceTypes, Position, Square } from 'tsshogi';

export const CONTRACT_VERSION = 'analysis-json-v1';
export const DRIVER_VERSION = 'usi-driver-v1';
export const MAX_BODY_BYTES = 1024;
export const MAX_SFEN_BYTES = 256;

export const SEARCH_CONDITIONS = Object.freeze({
  threads: 1,
  hashMb: 64,
  moveTimeMs: 1500,
  multiPV: 3,
});

export const EXPECTED_IDENTITY = Object.freeze({
  engineName: 'YaneuraOu NNUE 9.70git 64AVX2',
  engineSha256: '0cb27c8302f6eb357cd360372defe172401519c06fb4bf28eb2bf72ee0f39d80',
  modelId: 'Suisho11 Plus SFNN_halfka2_1024_7_64_k3k3',
  weightSha256: 'a78b7f889843037d344f482623b3febd124ead5c1f34f134d9f1c2c78cd0f829',
  optionsSha256: '9c242cd8820c158292af4a6d58890e37ae060000a9a6344d7a549abf7f44f0b3',
  sourceArchiveSha256: '3bd58802922c245e44fdc8fea57019f86b14960a52b7581e39d8b815ee5a4b80',
  sourceTreeSha256: '3b57f1ce5ff6587e9bab35ae6ee397d31f527da469ad0cf85d7de839790af0f6',
  sourceArchive: 'yaneuraou-V970-dev-mac-all.7z',
  buildInfo: 'YaneuraOu V970-dev source archive; make normal YANEURAOU_ENGINE_SFNN_halfka2_1024_7_64_k3k3 TARGET_CPU=AVX2 COMPILER=g++',
  driverVersion: DRIVER_VERSION,
  contractVersion: CONTRACT_VERSION,
});

export type FailureCode =
  | 'auth_unconfigured'
  | 'unauthorized'
  | 'invalid'
  | 'busy'
  | 'timeout'
  | 'identity_mismatch'
  | 'engine_error';

export type Score =
  | { kind: 'cp'; value: number }
  | { kind: 'mate'; value: number; winningSide: 'sente' | 'gote' | 'unknown' };

export type Candidate = { move: string; pv: string[]; score: Score };

export type DriverVerificationEvidence = {
  driverBootId: string;
  engineEpoch: number;
  enginePid: number;
  engineReaped: true;
  waitReturned: true;
  waitReturnCode: number;
  stopInjected: boolean;
};

export type AnalysisResult = {
  schemaVersion: 1;
  sfen: string;
  perspective: 'sente';
  status: 'success' | 'incomplete' | 'terminal';
  terminal: 'checkmate' | 'no-legal-moves' | null;
  candidates: Candidate[];
  meta: { nodes: number | null; completedDepth: number | null; elapsedMs: number | null };
  conditions: {
    requested: typeof SEARCH_CONDITIONS;
    actual: {
      threads: number;
      hashMb: number;
      moveTimeMs: number;
      multiPV: number;
    } | null;
  };
  identity: typeof EXPECTED_IDENTITY;
  verification?: DriverVerificationEvidence;
};

export type FailureResult = {
  schemaVersion: 1;
  sfen: string | null;
  status: 'failure';
  failure: { code: FailureCode; message: string };
};

export function failure(
  code: FailureCode,
  message: string,
  sfen: string | null = null,
): FailureResult {
  return { schemaVersion: 1, sfen, status: 'failure', failure: { code, message } };
}

export function isValidSfen(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SFEN_BYTES) return false;
  if (new TextEncoder().encode(value).byteLength > MAX_SFEN_BYTES) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value) || value.trim() !== value) return false;
  if (!/^[0-9KkLlNnSsGgBbRrPp/+ bw-]+$/u.test(value)) return false;
  const fields = value.split(' ');
  if (fields.length !== 4 || !/^[1-9][0-9]*$/u.test(fields[3])) return false;
  if (fields[2] !== '-' && !/^(?:[1-9][0-9]*)?[PLNSGBRplnsgbr](?:(?:[1-9][0-9]*)?[PLNSGBRplnsgbr])*$/u.test(fields[2])) return false;
  return Position.isValidSFEN(value);
}

export function legalMoves(sfen: string): string[] {
  const position = Position.newBySFEN(sfen);
  if (!position) return [];
  const moves = new Set<string>();
  const add = (move: ReturnType<typeof position.createMove>): void => {
    if (!move) return;
    try {
      if (position.isValidMove(move)) moves.add(move.usi);
    } catch {
      // Invalid hand/board combinations are not legal moves.
    }
  };

  for (const from of position.board.listSquaresByColor(position.color)) {
    for (const to of Square.all) {
      const move = position.createMove(from, to);
      add(move);
      if (move) {
        try {
          add(move.withPromote());
        } catch {
          // This destination cannot promote.
        }
      }
    }
  }
  const hand = position.hand(position.color);
  for (const pieceType of handPieceTypes) {
    if (hand.count(pieceType) === 0) continue;
    for (const to of Square.all) add(position.createMove(pieceType, to));
  }
  return [...moves].sort();
}

export function isLegalPv(sfen: string, moves: unknown): moves is string[] {
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > 256) return false;
  let position = Position.newBySFEN(sfen);
  if (!position) return false;
  for (const usi of moves) {
    if (typeof usi !== 'string') return false;
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move) || !position.doMove(move)) return false;
  }
  return true;
}

function hasExactIdentity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Record<string, unknown>;
  return Object.entries(EXPECTED_IDENTITY).every(([key, expected]) => identity[key] === expected);
}

export type DriverFailure = {
  schemaVersion: 1;
  sfen: string;
  perspective: 'sente';
  status: 'failure';
  failure: { code: 'busy' | 'timeout' | 'identity_mismatch' | 'engine_error'; message: string };
  identity: typeof EXPECTED_IDENTITY;
  verification?: DriverVerificationEvidence;
};

function hasValidVerificationEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.driverBootId === 'string' && /^[0-9a-f]{32}$/u.test(evidence.driverBootId)
    && Number.isSafeInteger(evidence.engineEpoch) && typeof evidence.engineEpoch === 'number' && evidence.engineEpoch > 0
    && Number.isSafeInteger(evidence.enginePid) && typeof evidence.enginePid === 'number' && evidence.enginePid > 0
    && evidence.engineReaped === true
    && evidence.waitReturned === true
    && Number.isSafeInteger(evidence.waitReturnCode) && typeof evidence.waitReturnCode === 'number'
    && typeof evidence.stopInjected === 'boolean';
}

export function validateDriverResult(
  value: unknown,
  sfen: string,
  rootLegalMoves: string[],
): AnalysisResult | DriverFailure | null {
  if (typeof value !== 'object' || value === null) return null;
  const result = value as Record<string, unknown>;
  if (result.schemaVersion !== 1 || result.sfen !== sfen || result.perspective !== 'sente') return null;
  if (!hasExactIdentity(result.identity)) return null;
  if (Object.hasOwn(result, 'verification') && !hasValidVerificationEvidence(result.verification)) return null;

  if (result.status === 'failure') {
    const failureValue = result.failure;
    if (typeof failureValue !== 'object' || failureValue === null) return null;
    const failureRecord = failureValue as Record<string, unknown>;
    if (!['busy', 'timeout', 'identity_mismatch', 'engine_error'].includes(String(failureRecord.code))) {
      return null;
    }
    if (typeof failureRecord.message !== 'string') return null;
    return value as DriverFailure;
  }
  if (!['success', 'incomplete'].includes(String(result.status)) || result.terminal !== null) return null;

  const conditions = result.conditions;
  if (typeof conditions !== 'object' || conditions === null) return null;
  const requested = (conditions as Record<string, unknown>).requested;
  const actual = (conditions as Record<string, unknown>).actual;
  if (
    typeof requested !== 'object' ||
    requested === null ||
    Object.entries(SEARCH_CONDITIONS).some(
      ([key, expected]) => (requested as Record<string, unknown>)[key] !== expected,
    )
  ) {
    return null;
  }
  const expectedMultiPV = Math.min(SEARCH_CONDITIONS.multiPV, rootLegalMoves.length);
  if (typeof actual !== 'object' || actual === null) return null;
  const actualRecord = actual as Record<string, unknown>;
  if (
    actualRecord.threads !== SEARCH_CONDITIONS.threads ||
    actualRecord.hashMb !== SEARCH_CONDITIONS.hashMb ||
    actualRecord.moveTimeMs !== SEARCH_CONDITIONS.moveTimeMs ||
    actualRecord.multiPV !== expectedMultiPV
  ) {
    return null;
  }

  const meta = result.meta;
  if (typeof meta !== 'object' || meta === null) return null;
  const metaRecord = meta as Record<string, unknown>;
  const positiveOrNull = (item: unknown): item is number | null =>
    item === null || (Number.isSafeInteger(item) && typeof item === 'number' && item > 0);
  if (
    !positiveOrNull(metaRecord.nodes) ||
    !positiveOrNull(metaRecord.completedDepth) ||
    !positiveOrNull(metaRecord.elapsedMs)
  ) {
    return null;
  }
  if (!Array.isArray(result.candidates)) return null;

  if (result.status === 'incomplete') {
    if (result.candidates.length !== 0 || metaRecord.completedDepth !== null) return null;
    return value as AnalysisResult;
  }
  if (
    result.candidates.length !== expectedMultiPV ||
    metaRecord.nodes === null ||
    metaRecord.completedDepth === null ||
    metaRecord.elapsedMs === null
  ) {
    return null;
  }

  const seenMoves = new Set<string>();
  for (const candidateValue of result.candidates) {
    if (typeof candidateValue !== 'object' || candidateValue === null) return null;
    const candidate = candidateValue as Record<string, unknown>;
    if (
      typeof candidate.move !== 'string' ||
      !rootLegalMoves.includes(candidate.move) ||
      seenMoves.has(candidate.move) ||
      !Array.isArray(candidate.pv) ||
      candidate.pv[0] !== candidate.move ||
      !isLegalPv(sfen, candidate.pv)
    ) {
      return null;
    }
    seenMoves.add(candidate.move);
    if (typeof candidate.score !== 'object' || candidate.score === null) return null;
    const score = candidate.score as Record<string, unknown>;
    if (!Number.isSafeInteger(score.value) || typeof score.value !== 'number') return null;
    if (score.kind === 'mate') {
      if (!['sente', 'gote', 'unknown'].includes(String(score.winningSide))) return null;
    } else if (score.kind !== 'cp') {
      return null;
    }
  }
  return value as AnalysisResult;
}
