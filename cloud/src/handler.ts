import {
  ANALYSIS_CONTRACT_VERSION,
  isCloudAnalysisResultV1,
  isStrictShogiSfen,
  type CloudAnalysisResultV1,
} from '../../src/cloud/analysis-contract';

const MAX_BODY_BYTES = 4096;
const INTERNAL_ANALYZE_PATH = '/v1/internal/analyze';
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

function analysisFailure(status = 500): Response {
  return json({ error: status === 503 ? 'container_not_ready' : 'analysis_failed' }, status);
}

export async function handleRequest(request: Request, env: WorkerEnv, driver: DriverClient): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== INTERNAL_ANALYZE_PATH && url.pathname !== INTERNAL_HEALTH_PATH && url.pathname !== INTERNAL_STOP_PATH) {
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
    if (response.status === 409) return json({ error: 'analysis_conflict' }, 409);
    if (response.status === 503) return analysisFailure(503);
    if (!response.ok) return analysisFailure(500);

    const payload: unknown = await response.json();
    if (!isRecord(payload)) return analysisFailure(500);
    const profileVersion = Number(env.ANALYSIS_PROFILE_VERSION ?? '1');
    const result: CloudAnalysisResultV1 = {
      contractVersion: ANALYSIS_CONTRACT_VERSION,
      analysisProfileId: env.ANALYSIS_PROFILE_ID ?? 'fixed-sfen-staging-v1',
      profileVersion,
      engineId: typeof payload.engineId === 'string' ? payload.engineId : '',
      modelId: env.ANALYSIS_MODEL_ID ?? 'analysis-model-staging-v1',
      sfen: input.sfen,
      candidates: payload.candidates as CloudAnalysisResultV1['candidates'],
      actualNodes: payload.actualNodes as number,
      completedDepth: payload.completedDepth as number,
      elapsedMs: payload.elapsedMs as number,
      multipv: input.multipv,
      completedAt: new Date().toISOString(),
      terminal: payload.terminal as CloudAnalysisResultV1['terminal'],
    };
    if (!isCloudAnalysisResultV1(result)) return analysisFailure(500);
    return json(result);
  } catch {
    return analysisFailure(503);
  }
}
