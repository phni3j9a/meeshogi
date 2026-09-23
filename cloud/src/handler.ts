import {
  ANALYSIS_CONTRACT_VERSION,
  isCloudAnalysisResultV3,
  isStrictShogiSfen,
  type CloudAnalysisResultV3,
} from '../../src/cloud/analysis-contract';

const MAX_BODY_BYTES = 4096;
const INTERNAL_ANALYZE_PATH = '/v1/internal/analyze';
// Admin-only benchmark instrumentation. Keep this under /internal; it must never
// overlap the future public job API namespace.
const INTERNAL_BENCH_ANALYZE_PATH = '/v1/internal/bench/analyze';
const INTERNAL_HEALTH_PATH = '/v1/internal/health';
const INTERNAL_STOP_PATH = '/v1/internal/stop';

export type WorkerEnv = {
  STAGING_ADMIN_TOKEN?: string;
  ANALYSIS_PROFILE_ID?: string;
  ANALYSIS_PROFILE_VERSION?: string;
  ANALYSIS_MODEL_ID?: string;
};

export type DriverClient = {
  fetch(request: Request): Promise<Response>;
};

type AnalyzeInput = { sfen: string; movetimeMs: number; multipv: number };
type BenchAnalyzeInput = AnalyzeInput & {
  threads?: number;
  hashMb?: number;
  label?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function equalSecret(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isAuthorized(request: Request, expected: string): boolean {
  const authorization = request.headers.get('authorization');
  if (!authorization || authorization.length > 520) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match !== null && equalSecret(match[1], expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function parseAnalyzeInput(request: Request): Promise<AnalyzeInput | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['sfen', 'movetimeMs', 'multipv'])) return null;
  if (!isStrictShogiSfen(parsed.sfen)) return null;
  if (!Number.isSafeInteger(parsed.movetimeMs) || (parsed.movetimeMs as number) < 50 || (parsed.movetimeMs as number) > 30_000) return null;
  if (!Number.isSafeInteger(parsed.multipv) || (parsed.multipv as number) < 1 || (parsed.multipv as number) > 8) return null;
  return { sfen: parsed.sfen, movetimeMs: parsed.movetimeMs as number, multipv: parsed.multipv as number };
}

async function parseBenchAnalyzeInput(request: Request): Promise<BenchAnalyzeInput | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed);
  const requiredKeys = ['sfen', 'movetimeMs', 'multipv'];
  const allowedKeys = [...requiredKeys, 'threads', 'hashMb', 'label'];
  if (!requiredKeys.every((key) => keys.includes(key)) || keys.some((key) => !allowedKeys.includes(key))) return null;
  if (!isStrictShogiSfen(parsed.sfen)) return null;
  if (!Number.isSafeInteger(parsed.movetimeMs) || (parsed.movetimeMs as number) < 50 || (parsed.movetimeMs as number) > 30_000) return null;
  if (!Number.isSafeInteger(parsed.multipv) || (parsed.multipv as number) < 1 || (parsed.multipv as number) > 8) return null;
  if (parsed.threads !== undefined && (!Number.isSafeInteger(parsed.threads) || (parsed.threads as number) < 1 || (parsed.threads as number) > 2)) return null;
  if (parsed.hashMb !== undefined && (!Number.isSafeInteger(parsed.hashMb) || (parsed.hashMb as number) < 16 || (parsed.hashMb as number) > 512)) return null;
  if (
    parsed.label !== undefined &&
    (typeof parsed.label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(parsed.label))
  ) return null;

  return {
    sfen: parsed.sfen,
    movetimeMs: parsed.movetimeMs as number,
    multipv: parsed.multipv as number,
    ...(parsed.threads === undefined ? {} : { threads: parsed.threads as number }),
    ...(parsed.hashMb === undefined ? {} : { hashMb: parsed.hashMb as number }),
    ...(parsed.label === undefined ? {} : { label: parsed.label }),
  };
}

async function hasEmptyJsonObject(request: Request): Promise<boolean> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 512)) return false;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 512) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

function driverRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://container${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function analysisFailure(status = 500, reason?: unknown): Response {
  const body: Record<string, unknown> = { error: status === 503 ? 'container_not_ready' : 'analysis_failed' };
  if (typeof reason === 'string' && /^[a-z0-9_:-]{1,80}$/.test(reason)) body.reason = reason;
  return json(body, status);
}

async function mapDriverFailure(response: Response): Promise<Response> {
  if (response.status === 409) return json({ error: 'analysis_conflict' }, 409);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Keep the normal error envelope if the container returned no JSON.
  }
  const reason = isRecord(body) ? body.reason : undefined;
  if (response.status === 503) return analysisFailure(503, reason);
  return analysisFailure(response.status === 502 ? 502 : 500, reason);
}

function v3Result(input: AnalyzeInput, payload: Record<string, unknown>, env: WorkerEnv): CloudAnalysisResultV3 | null {
  if (payload.contractVersion !== ANALYSIS_CONTRACT_VERSION) return null;
  if (payload.sfen !== input.sfen || payload.requestedMultiPv !== input.multipv) return null;
  const profileVersion = Number(env.ANALYSIS_PROFILE_VERSION ?? '1');
  const result: CloudAnalysisResultV3 = {
    contractVersion: ANALYSIS_CONTRACT_VERSION,
    analysisProfileId: env.ANALYSIS_PROFILE_ID ?? 'fixed-sfen-staging-v2',
    profileVersion,
    engineId: typeof payload.engineId === 'string' ? payload.engineId : '',
    modelId: env.ANALYSIS_MODEL_ID ?? 'analysis-model-staging-v1',
    sfen: input.sfen,
    candidates: payload.candidates as CloudAnalysisResultV3['candidates'],
    actualNodes: payload.actualNodes as number,
    completedDepth: payload.completedDepth as number,
    elapsedMs: payload.elapsedMs as number,
    multipv: payload.effectiveMultiPv as number,
    requestedMultiPv: payload.requestedMultiPv as number,
    effectiveMultiPv: payload.effectiveMultiPv as number,
    rootLegalMoveCount: payload.rootLegalMoveCount as number,
    completedAt: new Date().toISOString(),
    terminal: payload.terminal as CloudAnalysisResultV3['terminal'],
    engineEpoch: payload.engineEpoch as string,
    restartCount: payload.restartCount as number,
    processId: payload.processId as number,
    ...(payload.terminalDetail === undefined ? {} : { terminalDetail: payload.terminalDetail as CloudAnalysisResultV3['terminalDetail'] }),
    ...(payload.engineBestmove === undefined ? {} : { engineBestmove: payload.engineBestmove as string }),
  };
  if (result.requestedMultiPv !== input.multipv) return null;
  if (!isCloudAnalysisResultV3(result)) return null;
  return result;
}

export async function handleRequest(request: Request, env: WorkerEnv, driver: DriverClient): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname !== INTERNAL_ANALYZE_PATH &&
    url.pathname !== INTERNAL_BENCH_ANALYZE_PATH &&
    url.pathname !== INTERNAL_HEALTH_PATH &&
    url.pathname !== INTERNAL_STOP_PATH
  ) {
    return json({ error: 'not_found' }, 404);
  }

  const expectedToken = env.STAGING_ADMIN_TOKEN;
  if (!expectedToken) return json({ error: 'service_not_configured' }, 503);
  if (!isAuthorized(request, expectedToken)) return json({ error: 'unauthorized' }, 401);

  if (url.pathname === INTERNAL_HEALTH_PATH) {
    if (request.method !== 'GET') return json({ error: 'not_found' }, 404);
    try {
      const response = await driver.fetch(driverRequest('/health', 'GET'));
      const body: unknown = await response.json();
      if (!response.ok || !isRecord(body) || body.ready !== true) return json(body, 503);
      return json(body);
    } catch {
      return json({ error: 'container_not_ready' }, 503);
    }
  }

  if (url.pathname === INTERNAL_STOP_PATH) {
    if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!(await hasEmptyJsonObject(request))) return json({ error: 'invalid_request' }, 400);
    try {
      const response = await driver.fetch(driverRequest('/stop', 'POST', {}));
      if (!response.ok) return analysisFailure(response.status === 503 ? 503 : 500);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.stopped !== 'boolean') return analysisFailure(500);
      return json({ stopped: payload.stopped }, 200);
    } catch {
      return analysisFailure(503);
    }
  }

  if (url.pathname === INTERNAL_BENCH_ANALYZE_PATH) {
    if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
    const input = await parseBenchAnalyzeInput(request);
    if (!input) return json({ error: 'invalid_request' }, 400);

    try {
      const response = await driver.fetch(
        driverRequest('/analyze', 'POST', {
          sfen: input.sfen,
          movetime_ms: input.movetimeMs,
          multipv: input.multipv,
          ...(input.threads === undefined ? {} : { threads: input.threads }),
          ...(input.hashMb === undefined ? {} : { hash_mb: input.hashMb }),
        }),
      );
      if (!response.ok) return mapDriverFailure(response);

      const payload: unknown = await response.json();
      if (!isRecord(payload)) return analysisFailure(500);
      const result = v3Result(input, payload, env);
      if (!result) return analysisFailure(500, 'contract_validation_failed');

      const stats: Record<string, number> = {};
      if (isRecord(payload.stats)) {
        for (const field of ['enginePeakRssKiB', 'engineRssKiB', 'engineCpuMs', 'containerMemUsageBytes']) {
          const value = payload.stats[field];
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) stats[field] = value;
        }
      }
      return json({ ...result, stats });
    } catch {
      return analysisFailure(503);
    }
  }

  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
  const input = await parseAnalyzeInput(request);
  if (!input) return json({ error: 'invalid_request' }, 400);

  try {
    const response = await driver.fetch(
      driverRequest('/analyze', 'POST', {
        sfen: input.sfen,
        movetime_ms: input.movetimeMs,
        multipv: input.multipv,
      }),
    );
    if (!response.ok) return mapDriverFailure(response);

    const payload: unknown = await response.json();
    if (!isRecord(payload)) return analysisFailure(500);
    const result = v3Result(input, payload, env);
    if (!result) return analysisFailure(500, 'contract_validation_failed');
    return json(result);
  } catch {
    return analysisFailure(503);
  }
}
