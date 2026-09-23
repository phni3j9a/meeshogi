import { describe, expect, it } from 'vitest';
import { isCloudAnalysisResultV1 } from '../../src/cloud/analysis-contract';
import { handleRequest, type DriverClient, type WorkerEnv } from '../src/handler';

const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const TOKEN = 'staging-test-token-do-not-log';
const env: WorkerEnv = {
  STAGING_ADMIN_TOKEN: TOKEN,
  ANALYSIS_PROFILE_ID: 'fixed-sfen-staging-v1',
  ANALYSIS_PROFILE_VERSION: '1',
  ANALYSIS_MODEL_ID: 'analysis-model-staging-v1',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

class FakeDriver implements DriverClient {
  requests: Request[] = [];
  analyzeStatus = 200;
  analyzeBody: unknown = {
    engineId: 'Fake USI Engine',
    candidates: [{ move: '7g7f', pvUsi: ['7g7f', '3c3d'], scoreCp: -35 }],
    actualNodes: 320,
    completedDepth: 4,
    elapsedMs: 250,
    terminal: 'ok',
  };
  healthBody: unknown = {
    ready: true,
    engineId: 'Fake USI Engine',
    engineBinarySha256: '0123456789ab',
    weightSha256: 'abcdef012345',
    cpuFlags: ['avx2'],
    avx2: true,
  };
  healthStatus = 200;
  stopBody: unknown = { stopped: true };

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/health') return response(this.healthBody, this.healthStatus);
    if (path === '/analyze') return response(this.analyzeBody, this.analyzeStatus);
    if (path === '/stop') return response(this.stopBody);
    return response({ error: 'not_found' }, 404);
  }
}

function authHeaders(token = TOKEN): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function analyzeRequest(body: unknown, token = TOKEN): Request {
  return new Request('https://worker.test/v1/internal/analyze', {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('staging worker route guards', () => {
  it('rejects missing and invalid bearer credentials without forwarding', async () => {
    const driver = new FakeDriver();
    const missing = await handleRequest(
      new Request('https://worker.test/v1/internal/health'),
      env,
      driver,
    );
    const invalid = await handleRequest(
      new Request('https://worker.test/v1/internal/health', { headers: authHeaders('wrong') }),
      env,
      driver,
    );
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).not.toContain('wrong');
    expect(driver.requests).toHaveLength(0);
  });

  it('returns 503 when the staging secret has not been configured', async () => {
    const result = await handleRequest(
      new Request('https://worker.test/v1/internal/health', { headers: authHeaders() }),
      {},
      new FakeDriver(),
    );
    expect(result.status).toBe(503);
  });

  it.each([
    ['malformed SFEN', { sfen: 'startpos', movetimeMs: 250, multipv: 1 }],
    ['oversized movetime', { sfen: SFEN, movetimeMs: 30001, multipv: 1 }],
    ['undersized movetime', { sfen: SFEN, movetimeMs: 49, multipv: 1 }],
    ['oversized MultiPV', { sfen: SFEN, movetimeMs: 250, multipv: 9 }],
    ['unknown fields', { sfen: SFEN, movetimeMs: 250, multipv: 1, options: { Threads: 8 } }],
  ])('rejects %s before contacting the container', async (_name, body) => {
    const driver = new FakeDriver();
    const result = await handleRequest(analyzeRequest(body), env, driver);
    expect(result.status).toBe(400);
    expect(driver.requests).toHaveLength(0);
  });

  it('returns a validated versioned contract and does not forward the bearer token', async () => {
    const driver = new FakeDriver();
    const result = await handleRequest(analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1 }), env, driver);
    const body: unknown = await result.json();
    expect(result.status).toBe(200);
    expect(isCloudAnalysisResultV1(body)).toBe(true);
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0].headers.has('authorization')).toBe(false);
    expect(await driver.requests[0].json()).toEqual({ sfen: SFEN, movetime_ms: 250, multipv: 1 });
  });

  it('maps a concurrent container request to 409 and startup failure to 503', async () => {
    const driver = new FakeDriver();
    driver.analyzeStatus = 409;
    const conflict = await handleRequest(analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1 }), env, driver);
    expect(conflict.status).toBe(409);

    driver.analyzeStatus = 503;
    const unavailable = await handleRequest(analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1 }), env, driver);
    expect(unavailable.status).toBe(503);
  });

  it('protects health and distinguishes not-ready from a healthy container', async () => {
    const driver = new FakeDriver();
    driver.healthBody = { ready: false, reason: 'engine_start_failed' };
    driver.healthStatus = 503;
    const result = await handleRequest(
      new Request('https://worker.test/v1/internal/health', { headers: authHeaders() }),
      env,
      driver,
    );
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ready: false, reason: 'engine_start_failed' });
  });

  it('validates the explicit stop request and returns the driver result', async () => {
    const driver = new FakeDriver();
    const invalid = await handleRequest(
      new Request('https://worker.test/v1/internal/stop', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'stop' }),
      }),
      env,
      driver,
    );
    expect(invalid.status).toBe(400);
    expect(driver.requests).toHaveLength(0);

    driver.stopBody = { stopped: false };
    const stopped = await handleRequest(
      new Request('https://worker.test/v1/internal/stop', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      driver,
    );
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ stopped: false });
    expect(driver.requests[0].headers.has('authorization')).toBe(false);
  });

  it('returns 404 for unrelated routes', async () => {
    const result = await handleRequest(
      new Request('https://worker.test/'),
      env,
      new FakeDriver(),
    );
    expect(result.status).toBe(404);
  });
});
