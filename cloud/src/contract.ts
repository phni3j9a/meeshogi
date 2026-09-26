import { handPieceTypes, Position, Square } from 'tsshogi';
import benchmarkManifest from '../bench/conditions.json' with { type: 'json' };

export const CONTRACT_VERSION = 'analysis-json-v1';
export const BENCHMARK_CONTRACT_VERSION = 'analysis-json-v2';
export const DRIVER_VERSION = 'usi-driver-v1';
export const MAX_BODY_BYTES = 1024;
export const MAX_SFEN_BYTES = 256;
const BENCHMARK_IDENTITY_DIGEST_KEYS = [
  'engineSha256', 'weightSha256', 'optionsSha256', 'sourceArchiveSha256', 'sourceTreeSha256',
] as const;

function hasBenchmarkIdentityDigests(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const digests = value as Record<string, unknown>;
  return Object.keys(digests).length === BENCHMARK_IDENTITY_DIGEST_KEYS.length
    && BENCHMARK_IDENTITY_DIGEST_KEYS.every((key) => typeof digests[key] === 'string' && /^[0-9a-f]{64}$/u.test(digests[key] as string));
}

export type SearchConditions = {
  threads: number;
  hashMb: number;
  moveTimeMs: number;
  multiPV: number;
};

/** Instance name of the normal standard-2 Container — shared by the synchronous /internal routes and Free job sessions. */
export const SINGLETON_TARGET_ID = 'analysis-mvp-singleton';

export const SEARCH_CONDITIONS: SearchConditions = Object.freeze({
  threads: 1,
  hashMb: 64,
  moveTimeMs: 1500,
  multiPV: 3,
});

export type BenchmarkCondition = {
  conditionId: string;
  instanceType: 'standard-2' | 'standard-3';
  threads: number;
  hashMb: number;
  moveTimeMs: number;
  multiPV: number;
  role: 'candidate' | 'reference';
};

export const BENCHMARK_CONDITIONS = benchmarkManifest.conditions as unknown as readonly BenchmarkCondition[];
export const BENCHMARK_CONDITION_BY_ID = new Map(
  BENCHMARK_CONDITIONS.map((condition) => [condition.conditionId, condition]),
);

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
  | 'instance_mismatch'
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
  failure: { code: FailureCode; message: string; detail?: string };
};

export function failure(
  code: FailureCode,
  message: string,
  sfen: string | null = null,
  detail?: string,
): FailureResult {
  return {
    schemaVersion: 1,
    sfen,
    status: 'failure',
    failure: { code, message, ...(detail ? { detail } : {}) },
  };
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

export function hasExpectedIdentity(value: unknown): boolean {
  return hasExactIdentity(value);
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
  expectedConditions: SearchConditions = SEARCH_CONDITIONS,
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
    Object.entries(expectedConditions).some(
      ([key, expected]) => (requested as Record<string, unknown>)[key] !== expected,
    )
  ) {
    return null;
  }
  const expectedMultiPV = Math.min(expectedConditions.multiPV, rootLegalMoves.length);
  if (typeof actual !== 'object' || actual === null) return null;
  const actualRecord = actual as Record<string, unknown>;
  if (
    actualRecord.threads !== expectedConditions.threads ||
    actualRecord.hashMb !== expectedConditions.hashMb ||
    actualRecord.moveTimeMs !== expectedConditions.moveTimeMs ||
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

function safePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function hasBenchmarkRuntime(value: unknown, expectedInstanceType: string | null, driverBootId?: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const runtime = value as Record<string, unknown>;
  if (
    runtime.expectedInstanceType !== expectedInstanceType ||
    typeof runtime.driverBootId !== 'string' || !/^[0-9a-f]{32}$/u.test(runtime.driverBootId) ||
    !(runtime.osCpuCount === null || safePositiveInteger(runtime.osCpuCount)) ||
    !(runtime.affinityCpuCount === null || safePositiveInteger(runtime.affinityCpuCount)) ||
    !(runtime.cpuMax === null || typeof runtime.cpuMax === 'string') ||
    !(runtime.cpuQuota === null || safeNonNegativeNumber(runtime.cpuQuota)) ||
    !(runtime.memoryMaxBytes === null || safePositiveInteger(runtime.memoryMaxBytes)) ||
    !(runtime.memTotalBytes === null || safePositiveInteger(runtime.memTotalBytes)) ||
    !(runtime.rootDiskTotalBytes === null || safePositiveInteger(runtime.rootDiskTotalBytes))
  ) return false;
  return driverBootId === undefined || runtime.driverBootId === driverBootId;
}

export function benchmarkRuntimeMismatch(value: unknown, expectedInstanceType: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'runtime_missing';
  const runtime = value as Record<string, unknown>;
  const expectedCpu = expectedInstanceType === 'standard-2' ? 1 : 2;
  const expectedMemory = (expectedInstanceType === 'standard-2' ? 6 : 8) * 1024 ** 3;
  const minimumMemory = expectedMemory - 1.5 * 1024 ** 3;
  const maximumMemory = expectedMemory + 0.25 * 1024 ** 3;
  if (runtime.expectedInstanceType !== expectedInstanceType) return 'driver_expected_instance_type_mismatch';
  if (runtime.osCpuCount !== expectedCpu || runtime.affinityCpuCount !== expectedCpu) return 'cpu_count_mismatch';
  if (typeof runtime.memTotalBytes !== 'number' || !Number.isSafeInteger(runtime.memTotalBytes)
    || runtime.memTotalBytes < minimumMemory || runtime.memTotalBytes > maximumMemory) return 'mem_total_mismatch';
  if (runtime.cpuQuota !== null && (typeof runtime.cpuQuota !== 'number'
    || Math.abs(runtime.cpuQuota - expectedCpu) > 0.05)) return 'cpu_quota_mismatch';
  if (runtime.memoryMaxBytes !== null && (typeof runtime.memoryMaxBytes !== 'number'
    || runtime.memoryMaxBytes < minimumMemory || runtime.memoryMaxBytes > maximumMemory)) return 'memory_limit_mismatch';
  return null;
}

export type BenchmarkDriverFailure = {
  schemaVersion: 2;
  contractVersion: typeof BENCHMARK_CONTRACT_VERSION;
  sfen: string;
  perspective: 'sente';
  status: 'failure';
  failure: {
    code: 'busy' | 'timeout' | 'identity_mismatch' | 'instance_mismatch' | 'engine_error';
    message: string;
    diagnostics?: {
      exitCode: number | null;
      terminatingSignal: string | null;
      waitReturnCode: number;
      stdoutEof: boolean;
      lastInfo: { depth: number; nodes: number | null; timeMs: number | null; adopted: false } | null;
      lastNonInfoLineKind: string | null;
    };
  };
  conditionId: string;
  driverBootId: string;
  engineEpoch: number;
  expectedInstanceType: string | null;
  buildId?: string;
  gitCommit?: string;
  runtime: Record<string, unknown>;
  identityDigests: Record<string, unknown>;
  runtimeMismatch?: string;
};

export type BenchmarkValidationDiagnostic = { check?: string };

/** Validate the benchmark-only contract without changing v1 validation semantics. */
export function validateBenchmarkDriverResult(
  value: unknown,
  sfen: string,
  rootLegalMoves: string[],
  condition: BenchmarkCondition,
  diagnostic?: BenchmarkValidationDiagnostic,
): Record<string, unknown> | BenchmarkDriverFailure | null {
  const reject = (check: string): null => {
    if (diagnostic && diagnostic.check === undefined) diagnostic.check = check;
    return null;
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject('result.object');
  const result = value as Record<string, unknown>;
  if (result.schemaVersion !== 2) return reject('schemaVersion');
  if (result.contractVersion !== BENCHMARK_CONTRACT_VERSION) return reject('contractVersion');
  if (result.sfen !== sfen) return reject('sfen');
  if (result.perspective !== 'sente') return reject('perspective');
  if (result.conditionId !== condition.conditionId) return reject('conditionId');
  if (!hasBenchmarkIdentityDigests(result.identityDigests)) return reject('identityDigests');
  if (!(result.expectedInstanceType === null || result.expectedInstanceType === 'standard-2' || result.expectedInstanceType === 'standard-3')) return reject('expectedInstanceType');
  if (typeof result.driverBootId !== 'string' || !/^[0-9a-f]{32}$/u.test(result.driverBootId)) return reject('driverBootId');
  if (!(typeof result.engineEpoch === 'number' && Number.isSafeInteger(result.engineEpoch) && result.engineEpoch >= 0)) return reject('engineEpoch');
  if (typeof result.driverVersion !== 'string' || result.driverVersion.length === 0) return reject('driverVersion');
  if (!hasBenchmarkRuntime(result.runtime, result.expectedInstanceType)) return reject('runtime.shape');
  const runtime = result.runtime as Record<string, unknown>;
  if (runtime.driverBootId !== result.driverBootId) return reject('runtime.driverBootId');

  if (result.status === 'failure') {
    const failureValue = result.failure;
    if (typeof failureValue !== 'object' || failureValue === null || Array.isArray(failureValue)) return reject('failure.object');
    const failureRecord = failureValue as Record<string, unknown>;
    if (!['busy', 'timeout', 'identity_mismatch', 'instance_mismatch', 'engine_error'].includes(String(failureRecord.code))) return reject('failure.code');
    if (typeof failureRecord.message !== 'string') return reject('failure.message');
    const evidenceMismatch = result.expectedInstanceType !== condition.instanceType
      ? 'driver_expected_instance_type_mismatch'
      : benchmarkRuntimeMismatch(runtime, condition.instanceType);
    if (failureRecord.code === 'instance_mismatch') {
      return evidenceMismatch || result.runtimeMismatch === 'condition_instance_type_mismatch'
        ? value as BenchmarkDriverFailure
        : reject('failure.instance_mismatch_unsubstantiated');
    }
    if (evidenceMismatch) return {
      schemaVersion: 2,
      contractVersion: BENCHMARK_CONTRACT_VERSION,
      sfen,
      perspective: 'sente',
      status: 'failure',
      failure: { code: 'instance_mismatch', message: 'Container runtime evidence does not match the benchmark condition.' },
      conditionId: condition.conditionId,
      driverBootId: result.driverBootId,
      engineEpoch: result.engineEpoch,
      expectedInstanceType: result.expectedInstanceType,
      ...(typeof result.buildId === 'string' ? { buildId: result.buildId } : {}),
      ...(typeof result.gitCommit === 'string' ? { gitCommit: result.gitCommit } : {}),
      runtime,
      identityDigests: result.identityDigests,
      runtimeMismatch: evidenceMismatch,
    };
    return value as BenchmarkDriverFailure;
  }
  const evidenceMismatch = result.expectedInstanceType !== condition.instanceType
    ? 'driver_expected_instance_type_mismatch'
    : benchmarkRuntimeMismatch(runtime, condition.instanceType);
  if (evidenceMismatch) return {
    schemaVersion: 2,
    contractVersion: BENCHMARK_CONTRACT_VERSION,
    sfen,
    perspective: 'sente',
    status: 'failure',
    failure: { code: 'instance_mismatch', message: 'Container runtime evidence does not match the benchmark condition.' },
    conditionId: condition.conditionId,
    driverBootId: result.driverBootId,
    engineEpoch: result.engineEpoch,
    expectedInstanceType: result.expectedInstanceType,
    ...(typeof result.buildId === 'string' ? { buildId: result.buildId } : {}),
    ...(typeof result.gitCommit === 'string' ? { gitCommit: result.gitCommit } : {}),
    runtime,
    identityDigests: result.identityDigests,
    runtimeMismatch: evidenceMismatch,
  };
  if (!['success', 'incomplete'].includes(String(result.status)) || result.terminal !== null) return reject('status_or_terminal');
  if (!safePositiveInteger(result.engineEpoch)) return reject('engineEpoch');

  const conditions = result.conditions;
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) return reject('conditions.object');
  const requested = (conditions as Record<string, unknown>).requested;
  const actual = (conditions as Record<string, unknown>).actual;
  if (typeof requested !== 'object' || requested === null || Array.isArray(requested)) return reject('conditions.requested');
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return reject('conditions.actual');
  const expected = {
    conditionId: condition.conditionId,
    instanceType: condition.instanceType,
    threads: condition.threads,
    hashMb: condition.hashMb,
    moveTimeMs: condition.moveTimeMs,
    multiPV: condition.multiPV,
  };
  const requestedRecord = requested as Record<string, unknown>;
  if (Object.entries(expected).some(([key, item]) => requestedRecord[key] !== item)) return reject('conditions.requested.values');
  const effectiveMultiPV = Math.min(condition.multiPV, rootLegalMoves.length);
  const actualRecord = actual as Record<string, unknown>;
  if (
    actualRecord.threads !== condition.threads || actualRecord.hashMb !== condition.hashMb ||
    actualRecord.moveTimeMs !== condition.moveTimeMs || actualRecord.multiPV !== condition.multiPV ||
    actualRecord.effectiveMultiPV !== effectiveMultiPV || actualRecord.instanceType !== condition.instanceType
  ) return reject('conditions.actual.values');

  const meta = result.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return reject('meta.object');
  const m = meta as Record<string, unknown>;
  const nullablePositive = (item: unknown): item is number | null => item === null || safePositiveInteger(item);
  const nullableNonNegative = (item: unknown): item is number | null => item === null || safeNonNegativeNumber(item);
  if (
    !nullablePositive(m.nodes) || !nullablePositive(m.completedDepth) ||
    !nullablePositive(m.searchElapsedMs) || !nullablePositive(m.processElapsedMs) ||
    !nullableNonNegative(m.engineNps) || !nullableNonNegative(m.derivedNps) ||
    !nullableNonNegative(m.processCpuSeconds)
  ) return reject('meta.values');
  if (!Array.isArray(result.candidates)) return reject('candidates.array');
  if (result.status === 'incomplete') {
    if (result.candidates.length !== 0 || m.nodes !== null || m.completedDepth !== null ||
      m.searchElapsedMs !== null || m.engineNps !== null || m.derivedNps !== null) return reject('incomplete.adopted_metrics');
    if (Object.hasOwn(result, 'lastInfo')) {
      const lastInfo = result.lastInfo;
      if (typeof lastInfo !== 'object' || lastInfo === null || Array.isArray(lastInfo)) return reject('lastInfo.object');
      const info = lastInfo as Record<string, unknown>;
      if (!safePositiveInteger(info.depth) || !(info.nodes === null || safePositiveInteger(info.nodes)) ||
        !(info.timeMs === null || safeNonNegativeNumber(info.timeMs)) || info.adopted !== false) return reject('lastInfo.values');
    }
    return value as Record<string, unknown>;
  }
  if (
    result.candidates.length !== effectiveMultiPV || m.nodes === null || m.completedDepth === null ||
    m.searchElapsedMs === null || m.processElapsedMs === null
  ) return reject('success.metrics_or_candidate_count');

  const seenMoves = new Set<string>();
  for (const candidateValue of result.candidates) {
    if (typeof candidateValue !== 'object' || candidateValue === null || Array.isArray(candidateValue)) return reject('candidate.object');
    const candidate = candidateValue as Record<string, unknown>;
    if (
      typeof candidate.move !== 'string' || !rootLegalMoves.includes(candidate.move) || seenMoves.has(candidate.move) ||
      !Array.isArray(candidate.pv) || candidate.pv[0] !== candidate.move || !isLegalPv(sfen, candidate.pv)
    ) return reject('candidate.move_or_pv');
    seenMoves.add(candidate.move);
    if (typeof candidate.score !== 'object' || candidate.score === null || Array.isArray(candidate.score)) return reject('candidate.score');
    const score = candidate.score as Record<string, unknown>;
    if (!Number.isSafeInteger(score.value) || typeof score.value !== 'number') return reject('candidate.score.value');
    if (score.kind === 'mate') {
      if (!['sente', 'gote', 'unknown'].includes(String(score.winningSide))) return reject('candidate.score.winningSide');
    } else if (score.kind !== 'cp') return reject('candidate.score.kind');
  }
  return value as Record<string, unknown>;
}
