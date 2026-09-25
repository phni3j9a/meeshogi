import { Container, getContainer } from '@cloudflare/containers';
import {
  EXPECTED_IDENTITY,
  BENCHMARK_CONDITION_BY_ID,
  BENCHMARK_CONTRACT_VERSION,
  SEARCH_CONDITIONS,
  failure,
  isValidSfen,
  legalMoves,
  hasBenchmarkRuntime,
  benchmarkRuntimeMismatch,
  MAX_BODY_BYTES,
  type BenchmarkValidationDiagnostic,
  validateDriverResult,
  validateBenchmarkDriverResult,
} from './contract';
import { Position } from 'tsshogi';

export interface Env {
  ANALYSIS_INTERNAL_TOKEN?: string;
  ANALYSIS_VERIFY_STOP_ENGINE_ONCE?: string;
  ANALYSIS_BENCHMARK_ENABLED?: string;
  ANALYSIS_EXPECTED_INSTANCE_TYPE?: 'standard-2' | 'standard-3';
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  ANALYSIS_CONTAINER: DurableObjectNamespace<AnalysisContainer>;
}

function workerVersionFields(env: Env): Record<string, string> {
  const metadata = env.CF_VERSION_METADATA;
  if (!metadata || typeof metadata.id !== 'string' || !metadata.id) return {};
  return {
    workerVersionId: metadata.id,
    ...(typeof metadata.tag === 'string' && metadata.tag ? { workerVersionTag: metadata.tag } : {}),
    ...(typeof metadata.timestamp === 'string' && metadata.timestamp ? { workerVersionTimestamp: metadata.timestamp } : {}),
  };
}

const ANALYSIS_PATH = '/internal/analyze';
const HEALTH_PATH = '/internal/health';
const BENCHMARK_PATH = '/internal/benchmark';
const IDENTITY_DIGEST_KEYS = [
  'engineSha256',
  'weightSha256',
  'optionsSha256',
  'sourceArchiveSha256',
  'sourceTreeSha256',
] as const;

export class AnalysisContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...(env.ANALYSIS_VERIFY_STOP_ENGINE_ONCE === '1' ? { ANALYSIS_VERIFY_STOP_ENGINE_ONCE: '1' } : {}),
      ...(env.ANALYSIS_BENCHMARK_ENABLED === '1' ? { ANALYSIS_BENCHMARK_ENABLED: '1' } : {}),
      ...(env.ANALYSIS_EXPECTED_INSTANCE_TYPE ? { ANALYSIS_EXPECTED_INSTANCE_TYPE: env.ANALYSIS_EXPECTED_INSTANCE_TYPE } : {}),
    };
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    return null;
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function unauthorized(status: number, code: 'auth_unconfigured' | 'unauthorized'): Response {
  const message = code === 'auth_unconfigured' ? 'Internal analysis is not configured.' : 'Unauthorized.';
  return json(failure(code, message), status);
}

function authorize(request: Request, env: Env): Response | null {
  const expectedToken = env.ANALYSIS_INTERNAL_TOKEN;
  if (!expectedToken) return unauthorized(503, 'auth_unconfigured');
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || !constantTimeEqual(authorization.slice(7), expectedToken)) {
    return unauthorized(401, 'unauthorized');
  }
  return null;
}

function isDriverHealth(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  const digests = health.identityDigests;
  if (typeof digests !== 'object' || digests === null || Array.isArray(digests)) return false;
  const digestRecord = digests as Record<string, unknown>;
  return health.schemaVersion === 1
    && health.status === 'ready'
    && typeof health.driverBootId === 'string'
    && /^[0-9a-f]{32}$/u.test(health.driverBootId)
    && typeof health.verifyStopEngineOnceEnabled === 'boolean'
    && typeof health.verifyStopEngineOnceConsumed === 'boolean'
    && typeof health.driverVersion === 'string'
    && health.driverVersion.length > 0
    && typeof health.contractVersion === 'string'
    && health.contractVersion.length > 0
    && ['standard-2', 'standard-3'].includes(String(health.expectedInstanceType))
    && hasBenchmarkRuntime(health.runtime, String(health.expectedInstanceType), health.driverBootId)
    && IDENTITY_DIGEST_KEYS.every((key) => typeof digestRecord[key] === 'string' && /^[0-9a-f]{64}$/u.test(digestRecord[key] as string));
}

function benchmarkInstanceFailure(
  sfen: string,
  conditionId: string,
  expectedInstanceType: string | null,
  driverBootId: string,
  engineEpoch: number,
  buildId: string | undefined,
  gitCommit: string | undefined,
  runtime: Record<string, unknown>,
  identityDigests: Record<string, unknown>,
  runtimeMismatch: string,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    contractVersion: BENCHMARK_CONTRACT_VERSION,
    sfen,
    perspective: 'sente',
    status: 'failure',
    failure: { code: 'instance_mismatch', message: 'Container runtime evidence does not match the benchmark condition.' },
    conditionId,
    expectedInstanceType,
    driverBootId,
    engineEpoch,
    ...(buildId ? { buildId } : {}),
    ...(gitCommit ? { gitCommit } : {}),
    runtime,
    identityDigests,
    runtimeMismatch,
  };
}

function benchmarkValidationDetail(
  diagnostic: BenchmarkValidationDiagnostic,
  driverResult: unknown,
  containerHttpStatus: number,
): string {
  const result = typeof driverResult === 'object' && driverResult !== null && !Array.isArray(driverResult)
    ? driverResult as Record<string, unknown>
    : {};
  const safeLabel = (value: unknown): string | null =>
    typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/u.test(value) ? value : null;
  const driverStatus = safeLabel(result.status) ?? 'unknown';
  const failureValue = typeof result.failure === 'object' && result.failure !== null && !Array.isArray(result.failure)
    ? result.failure as Record<string, unknown>
    : {};
  const failureCode = safeLabel(failureValue.code);
  return [
    `check=${diagnostic.check ?? 'unknown'}`,
    `driverStatus=${driverStatus}`,
    ...(failureCode ? [`failureCode=${failureCode}`] : []),
    `containerHttpStatus=${containerHttpStatus}`,
  ].join('; ');
}

async function readJsonBody(request: Request): Promise<{ record: Record<string, unknown> } | Response> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json(failure('invalid', 'Expected application/json.'), 415);
  }
  const bytes = await readBody(request);
  if (!bytes) return json(failure('invalid', 'Request body exceeds the 1024 byte limit.'), 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return json(failure('invalid', 'Request body is not valid JSON.'), 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(failure('invalid', 'Expected a JSON object.'), 400);
  }
  return { record: body as Record<string, unknown> };
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === HEALTH_PATH) {
    if (request.method !== 'GET') return json(failure('invalid', 'Method not allowed.'), 405);
    const authFailure = authorize(request, env);
    if (authFailure) return authFailure;
    try {
      const container = getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, 'analysis-mvp-singleton');
      const response = await container.fetch(new Request('http://analysis-container/health', { method: 'GET' }));
      if (!response.ok) return json(failure('engine_error', 'Analysis container health is unavailable.'), 502);
      const text = await response.text();
      if (text.length > 8192) return json(failure('engine_error', 'Analysis container health exceeded the response limit.'), 502);
      let driverHealth: unknown;
      try {
        driverHealth = JSON.parse(text);
      } catch {
        return json(failure('engine_error', 'Analysis container returned an invalid health response.'), 502);
      }
      if (!isDriverHealth(driverHealth)) {
        return json(failure('engine_error', 'Analysis container health failed contract validation.'), 502);
      }
      return json({
        ...driverHealth,
        ...workerVersionFields(env),
        workerVerifyStopEngineOnceEnabled: env.ANALYSIS_VERIFY_STOP_ENGINE_ONCE === '1',
        workerBenchmarkEnabled: env.ANALYSIS_BENCHMARK_ENABLED === '1',
        workerExpectedInstanceType: env.ANALYSIS_EXPECTED_INSTANCE_TYPE ?? null,
      });
    } catch {
      return json(failure('engine_error', 'Analysis container health is unavailable.'), 502);
    }
  }
  if (url.pathname === BENCHMARK_PATH) {
    if (env.ANALYSIS_BENCHMARK_ENABLED !== '1') return json(failure('invalid', 'Not found.'), 404);
    if (request.method !== 'POST') return json(failure('invalid', 'Method not allowed.'), 405);
    const authFailure = authorize(request, env);
    if (authFailure) return authFailure;
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;
    const { record } = parsed;
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'sfen') || !Object.hasOwn(record, 'conditionId') || !isValidSfen(record.sfen)) {
      return json(failure('invalid', 'Expected only a valid SFEN and a manifest condition ID.'), 400);
    }
    if (typeof record.conditionId !== 'string') return json(failure('invalid', 'Unknown benchmark condition.'), 400);
    const condition = BENCHMARK_CONDITION_BY_ID.get(record.conditionId);
    if (!condition) return json(failure('invalid', 'Unknown benchmark condition.'), 400);
    if (env.ANALYSIS_EXPECTED_INSTANCE_TYPE !== condition.instanceType) {
      return json(failure('instance_mismatch', 'Benchmark condition does not match the deployed instance type.', record.sfen), 409);
    }
    const sfen = record.sfen;
    const rootMoves = legalMoves(sfen);
    const position = Position.newBySFEN(sfen);
    if (!position) return json(failure('invalid', 'SFEN is invalid.'), 400);
    if (rootMoves.length === 0) {
      const terminal: 'checkmate' | 'no-legal-moves' = position.checked ? 'checkmate' : 'no-legal-moves';
      try {
        const container = getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, 'analysis-mvp-singleton');
        const healthResponse = await container.fetch(new Request('http://analysis-container/health', { method: 'GET' }));
        if (!healthResponse.ok) return json(failure('engine_error', 'Analysis container health is unavailable.', sfen), 502);
        const healthText = await healthResponse.text();
        if (healthText.length > 8192) return json(failure('engine_error', 'Analysis container health exceeded the response limit.', sfen), 502);
        let driverHealth: unknown;
        try {
          driverHealth = JSON.parse(healthText);
        } catch {
          return json(failure('engine_error', 'Analysis container returned an invalid health response.', sfen), 502);
        }
        if (!isDriverHealth(driverHealth)) return json(failure('engine_error', 'Analysis container health failed contract validation.', sfen), 502);
        const runtime = driverHealth.runtime as Record<string, unknown>;
        const runtimeMismatch = driverHealth.expectedInstanceType !== condition.instanceType
          ? 'driver_expected_instance_type_mismatch'
          : benchmarkRuntimeMismatch(runtime, condition.instanceType);
        if (runtimeMismatch) {
          return json(benchmarkInstanceFailure(
            sfen,
            condition.conditionId,
            String(driverHealth.expectedInstanceType),
            String(driverHealth.driverBootId),
            0,
            typeof driverHealth.buildId === 'string' ? driverHealth.buildId : undefined,
            typeof driverHealth.gitCommit === 'string' ? driverHealth.gitCommit : undefined,
            runtime,
            driverHealth.identityDigests as Record<string, unknown>,
            runtimeMismatch,
          ), 409);
        }
        return json({
          schemaVersion: 2,
          contractVersion: BENCHMARK_CONTRACT_VERSION,
          sfen,
          perspective: 'sente',
          status: 'terminal',
          terminal,
          candidates: [],
          conditionId: condition.conditionId,
          expectedInstanceType: condition.instanceType,
          driverBootId: driverHealth.driverBootId,
          engineEpoch: 0,
          driverVersion: driverHealth.driverVersion,
          buildId: driverHealth.buildId,
          gitCommit: driverHealth.gitCommit,
          identityDigests: driverHealth.identityDigests,
          runtime,
          conditions: { requested: condition, actual: null },
          meta: { nodes: null, completedDepth: null, searchElapsedMs: null, engineNps: null, derivedNps: null, processElapsedMs: null, processCpuSeconds: null },
        });
      } catch {
        return json(failure('engine_error', 'Analysis container health is unavailable.', sfen), 502);
      }
    }
    try {
      const container = getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, 'analysis-mvp-singleton');
      const internalRequest = new Request('http://analysis-container/benchmark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sfen, legalMoveCount: rootMoves.length, conditionId: condition.conditionId }),
      });
      const response = await container.fetch(internalRequest);
      const text = await response.text();
      if (text.length > 64 * 1024) return json(failure('engine_error', 'Benchmark result exceeded the response limit.', sfen), 502);
      let driverResult: unknown;
      try {
        driverResult = JSON.parse(text);
      } catch {
        return json(failure('engine_error', 'Analysis container returned an invalid response.', sfen), 502);
      }
      const diagnostic: BenchmarkValidationDiagnostic = {};
      const validated = validateBenchmarkDriverResult(driverResult, sfen, rootMoves, condition, diagnostic);
      if (!validated) {
        return json(failure(
          'engine_error',
          'Benchmark result failed contract validation.',
          sfen,
          benchmarkValidationDetail(diagnostic, driverResult, response.status),
        ), 502);
      }
      if (validated.status === 'failure') {
        const failureRecord = validated.failure as { code: string };
        const status = failureRecord.code === 'busy' || failureRecord.code === 'instance_mismatch' ? 409 : failureRecord.code === 'timeout' ? 504 : 502;
        return json(validated, status);
      }
      return json({ ...validated, ...workerVersionFields(env) });
    } catch {
      return json(failure('engine_error', 'Analysis container is unavailable.', sfen), 502);
    }
  }
  if (url.pathname !== ANALYSIS_PATH) return json(failure('invalid', 'Not found.'), 404);
  if (request.method !== 'POST') return json(failure('invalid', 'Method not allowed.'), 405);

  const authFailure = authorize(request, env);
  if (authFailure) return authFailure;

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json(failure('invalid', 'Expected application/json.'), 415);
  }
  const bytes = await readBody(request);
  if (!bytes) return json(failure('invalid', 'Request body exceeds the 1024 byte limit.'), 413);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return json(failure('invalid', 'Request body is not valid JSON.'), 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(failure('invalid', 'Expected a JSON object with one SFEN field.'), 400);
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'sfen') || !isValidSfen(record.sfen)) {
    const echo = typeof record.sfen === 'string' && !/[\u0000-\u001f\u007f]/u.test(record.sfen)
      ? record.sfen.slice(0, 256)
      : null;
    return json(failure('invalid', 'SFEN must be valid, single-line shogi notation.' , echo), 400);
  }
  const sfen = record.sfen;
  const position = Position.newBySFEN(sfen);
  if (!position) return json(failure('invalid', 'SFEN is invalid.'), 400);
  const rootMoves = legalMoves(sfen);
  if (rootMoves.length === 0) {
    const terminal: 'checkmate' | 'no-legal-moves' = position.checked ? 'checkmate' : 'no-legal-moves';
    return json({
      schemaVersion: 1,
      sfen,
      perspective: 'sente',
      status: 'terminal',
      terminal,
      candidates: [],
      meta: { nodes: null, completedDepth: null, elapsedMs: null },
      conditions: { requested: SEARCH_CONDITIONS, actual: null },
      identity: EXPECTED_IDENTITY,
    });
  }

  try {
    const container = getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, 'analysis-mvp-singleton');
    const internalRequest = new Request('http://analysis-container/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sfen, legalMoveCount: rootMoves.length }),
    });
    const response = await container.fetch(internalRequest);
    const text = await response.text();
    if (text.length > 64 * 1024) return json(failure('engine_error', 'Analysis result exceeded the response limit.', sfen), 502);
    let driverResult: unknown;
    try {
      driverResult = JSON.parse(text);
    } catch {
      return json(failure('engine_error', 'Analysis container returned an invalid response.', sfen), 502);
    }
    const validated = validateDriverResult(driverResult, sfen, rootMoves);
    if (!validated) return json(failure('engine_error', 'Analysis result failed contract validation.', sfen), 502);
    if (validated.status === 'failure') {
      const status = validated.failure.code === 'busy' ? 409 : validated.failure.code === 'timeout' ? 504 : 502;
      return json(validated, status);
    }
    return json(validated);
  } catch {
    return json(failure('engine_error', 'Analysis container is unavailable.', sfen), 502);
  }
}

export default { fetch: handleRequest };
