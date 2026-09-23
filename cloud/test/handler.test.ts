import { describe, expect, it } from 'vitest';
import { ANALYSIS_CONTRACT_VERSION, isCloudAnalysisResultV3 } from '../../src/cloud/analysis-contract';
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
    candidates: [
      { move: '7g7f', pvUsi: ['7g7f', '3c3d'], depth: 4, scoreCp: -35 },
      { move: '2g2f', pvUsi: ['2g2f', '8c8d'], depth: 4, scoreCp: 25 },
      { move: '3g3f', pvUsi: ['3g3f', '8c8d'], depth: 4, scoreCp: 10 },
    ],
    actualNodes: 320,
    completedDepth: 4,
    elapsedMs: 250,
    terminal: 'ok',
    requestedMultiPv: 3,
    effectiveMultiPv: 3,
    rootLegalMoveCount: 30,
    engineEpoch: 'epoch-1',
    restartCount: 0,
    processId: 1234,
    engineBestmove: '7g7f',
    stats: {
      enginePeakRssKiB: 4096,
      engineRssKiB: 3072,
      engineCpuMs: 120,
      containerMemUsageBytes: 12582912,
    },
  };
  healthBody: unknown = {
    ready: true,
    engineId: 'Fake USI Engine',
    engineBinarySha256: '0123456789ab',
    weightSha256: 'abcdef012345',
    cpuFlags: ['avx2'],
    avx2: true,
    engineEpoch: 'epoch-1',
    restartCount: 0,
    lastRestartReason: null,
    processId: 1234,
  };
  healthStatus = 200;
  stopBody: unknown = { stopped: true };

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/health') return response(this.healthBody, this.healthStatus);
    if (path === '/analyze') {
      if (this.analyzeStatus !== 200) return response(this.analyzeBody, this.analyzeStatus);
      const requestBody = await request.clone().json() as { multipv?: number; sfen?: string };
      const requestedMultiPv = requestBody.multipv ?? 1;
      const effectiveMultiPv = Math.min(requestedMultiPv, 30);
      const body = this.analyzeBody as Record<string, unknown>;
      return response({
        ...body,
        contractVersion: body.contractVersion ?? ANALYSIS_CONTRACT_VERSION,
        sfen: requestBody.sfen,
        requestedMultiPv,
        effectiveMultiPv,
        rootLegalMoveCount: 30,
        multipv: effectiveMultiPv,
        candidates: (body.candidates as unknown[]).slice(0, effectiveMultiPv),
      });
    }
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

function benchRequest(body: unknown, token = TOKEN): Request {
  return new Request('https://worker.test/v1/internal/bench/analyze', {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validV3Result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 3,
    analysisProfileId: 'free-v1',
    profileVersion: 1,
    engineId: 'Fake USI Engine',
    modelId: 'opaque-model@digest',
    sfen: SFEN,
    candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp: 35281 }],
    engineBestmove: '7g7f',
    actualNodes: 500,
    completedDepth: 4,
    elapsedMs: 1000,
    multipv: 1,
    requestedMultiPv: 2,
    effectiveMultiPv: 1,
    rootLegalMoveCount: 1,
    completedAt: '2026-09-24T00:00:00.000Z',
    terminal: 'ok',
    engineEpoch: 'e2b1d17a',
    restartCount: 1,
    processId: 42,
    ...overrides,
  };
}

describe('staging worker route guards', () => {
  it('accepts finite cp magnitudes through the shared save-validator bound', () => {
    for (const scoreCp of [-1_000_000, -35_281, 32_000, 35_281, 1_000_000]) {
      expect(isCloudAnalysisResultV3(validV3Result({
        candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp }],
      }))).toBe(true);
    }
    expect(isCloudAnalysisResultV3(validV3Result({
      candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp: 1_000_001 }],
    }))).toBe(false);
    expect(isCloudAnalysisResultV3(validV3Result({
      candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp: Number.MAX_SAFE_INTEGER + 1 }],
    }))).toBe(false);
  });

  it('requires effective MultiPV to match legal count and exact distinct completed candidates', () => {
    expect(isCloudAnalysisResultV3(validV3Result({ effectiveMultiPv: 2, multipv: 2 }))).toBe(false);
    expect(isCloudAnalysisResultV3(validV3Result({ rootLegalMoveCount: 3 }))).toBe(false);
    expect(isCloudAnalysisResultV3(validV3Result({
      candidates: [
        { move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp: 1 },
        { move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp: 2 },
      ],
      requestedMultiPv: 2,
      effectiveMultiPv: 2,
      rootLegalMoveCount: 3,
      multipv: 2,
    }))).toBe(false);
    expect(isCloudAnalysisResultV3(validV3Result({
      candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 3, scoreCp: 1 }],
    }))).toBe(false);
    expect(isCloudAnalysisResultV3(validV3Result({
      candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp: 1, lowerbound: true }],
    }))).toBe(false);
  });

  it('preserves zero-distance mate sign explicitly and rejects a bare numeric zero', () => {
    expect(isCloudAnalysisResultV3(validV3Result({
      terminal: 'mate',
      candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, mateSign: 'gote' }],
    }))).toBe(true);
    expect(isCloudAnalysisResultV3(validV3Result({
      terminal: 'mate',
      candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreMate: 0, mateSign: 'gote' }],
    }))).toBe(false);
    expect(isCloudAnalysisResultV3(validV3Result({
      terminal: 'mate',
      candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreMate: -3, mateSign: 'sente' }],
    }))).toBe(false);
  });

  it('distinguishes zero-legal-move context from normal move results', () => {
    expect(isCloudAnalysisResultV3(validV3Result({
      candidates: [],
      completedDepth: 0,
      multipv: 0,
      requestedMultiPv: 3,
      effectiveMultiPv: 0,
      rootLegalMoveCount: 0,
      terminal: 'no_legal_moves',
      terminalDetail: 'checkmate',
      engineBestmove: undefined,
    }))).toBe(true);
    expect(isCloudAnalysisResultV3(validV3Result({
      candidates: [],
      completedDepth: 0,
      multipv: 0,
      requestedMultiPv: 3,
      effectiveMultiPv: 0,
      rootLegalMoveCount: 0,
      terminal: 'no_legal_moves',
    }))).toBe(false);
  });

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
    expect(isCloudAnalysisResultV3(body)).toBe(true);
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0].headers.has('authorization')).toBe(false);
    expect(await driver.requests[0].json()).toEqual({ sfen: SFEN, movetime_ms: 250, multipv: 1 });
  });

  it('requires the same bearer authentication for the admin-only benchmark route', async () => {
    const driver = new FakeDriver();
    const missing = await handleRequest(
      new Request('https://worker.test/v1/internal/bench/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: SFEN, movetimeMs: 250, multipv: 2 }),
      }),
      env,
      driver,
    );
    const invalid = await handleRequest(benchRequest({ sfen: SFEN, movetimeMs: 250, multipv: 2 }, 'wrong'), env, driver);
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(driver.requests).toHaveLength(0);
  });

  it.each([
    ['malformed SFEN', { sfen: 'startpos' }],
    ['movetime below bound', { movetimeMs: 49 }],
    ['movetime above bound', { movetimeMs: 30001 }],
    ['MultiPV below bound', { multipv: 0 }],
    ['MultiPV above bound', { multipv: 9 }],
    ['threads below bound', { threads: 0 }],
    ['threads above bound', { threads: 3 }],
    ['fractional threads', { threads: 1.5 }],
    ['hash below bound', { hashMb: 15 }],
    ['hash above bound', { hashMb: 513 }],
    ['fractional hash', { hashMb: 16.5 }],
    ['invalid label', { label: 'has whitespace' }],
    ['unknown key', { options: { Threads: 2 } }],
  ])('validates benchmark %s before contacting the container', async (_name, extra) => {
    const driver = new FakeDriver();
    const result = await handleRequest(
      benchRequest({ sfen: SFEN, movetimeMs: 250, multipv: 2, ...extra }),
      env,
      driver,
    );
    expect(result.status).toBe(400);
    expect(driver.requests).toHaveLength(0);
  });

  it('forwards bounded benchmark controls and returns the contract with engine stats', async () => {
    const driver = new FakeDriver();
    const result = await handleRequest(
      benchRequest({ sfen: SFEN, movetimeMs: 500, multipv: 3, threads: 2, hashMb: 128, label: 'fixture:short-1' }),
      env,
      driver,
    );
    const body = await result.json() as Record<string, unknown>;
    expect(result.status).toBe(200);
    const { stats, ...contract } = body;
    expect(isCloudAnalysisResultV3(contract)).toBe(true);
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0].headers.has('authorization')).toBe(false);
    expect(await driver.requests[0].json()).toEqual({
      sfen: SFEN,
      movetime_ms: 500,
      multipv: 3,
      threads: 2,
      hash_mb: 128,
    });
    expect(body).not.toHaveProperty('label');
    expect(stats).toEqual({
      enginePeakRssKiB: 4096,
      engineRssKiB: 3072,
      engineCpuMs: 120,
      containerMemUsageBytes: 12582912,
    });
  });

  it('maps a benchmark container conflict and rejects out-of-namespace paths', async () => {
    const driver = new FakeDriver();
    driver.analyzeStatus = 409;
    const conflict = await handleRequest(
      benchRequest({ sfen: SFEN, movetimeMs: 250, multipv: 2 }),
      env,
      driver,
    );
    const publicJobPath = await handleRequest(
      new Request('https://worker.test/v1/jobs', { method: 'POST' }),
      env,
      driver,
    );
    expect(conflict.status).toBe(409);
    expect(publicJobPath.status).toBe(404);
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

  it('preserves a typed protocol error from the container', async () => {
    const driver = new FakeDriver();
    driver.analyzeStatus = 502;
    driver.analyzeBody = { error: 'analysis_failed', reason: 'score_cp_out_of_engine_range' };
    const result = await handleRequest(analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1 }), env, driver);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: 'analysis_failed', reason: 'score_cp_out_of_engine_range' });
  });

  it('rejects a v1 response and unsafe or out-of-range cp values', async () => {
    const driver = new FakeDriver();
    driver.analyzeBody = {
      ...(driver.analyzeBody as Record<string, unknown>),
      contractVersion: 1,
    };
    const legacy = await handleRequest(analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1 }), env, driver);
    expect(legacy.status).toBe(500);
    expect(await legacy.json()).toMatchObject({ reason: 'contract_validation_failed' });

    for (const scoreCp of [1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
      driver.analyzeBody = {
        ...(driver.analyzeBody as Record<string, unknown>),
        contractVersion: ANALYSIS_CONTRACT_VERSION,
        candidates: [{ move: '7g7f', pvUsi: ['7g7f'], depth: 4, scoreCp }],
      };
      const invalid = await handleRequest(analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1 }), env, driver);
      expect(invalid.status).toBe(500);
    }
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

  it('routes analyze and bench requests to the profile-selected driver, defaulting to free', async () => {
    const free = new FakeDriver();
    const precision = new FakeDriver();
    const resolver = (profile: 'free-v1' | 'precision-v1'): DriverClient =>
      profile === 'precision-v1' ? precision : free;

    const defaultResult = await handleRequest(
      analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1 }),
      env,
      resolver,
    );
    expect(defaultResult.status).toBe(200);
    expect(free.requests).toHaveLength(1);
    expect(precision.requests).toHaveLength(0);

    const precisionResult = await handleRequest(
      analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1, profile: 'precision-v1' }),
      env,
      resolver,
    );
    expect(precisionResult.status).toBe(200);
    expect(free.requests).toHaveLength(1);
    expect(precision.requests).toHaveLength(1);

    const benchResult = await handleRequest(
      benchRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1, threads: 2, hashMb: 256, profile: 'precision-v1' }),
      env,
      resolver,
    );
    expect(benchResult.status).toBe(200);
    expect(free.requests).toHaveLength(1);
    expect(precision.requests).toHaveLength(2);
  });

  it('rejects an unknown internal profile before contacting a driver', async () => {
    const free = new FakeDriver();
    const precision = new FakeDriver();
    const resolver = (profile: 'free-v1' | 'precision-v1'): DriverClient =>
      profile === 'precision-v1' ? precision : free;

    for (const result of [
      await handleRequest(analyzeRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1, profile: 'turbo-v9' }), env, resolver),
      await handleRequest(benchRequest({ sfen: SFEN, movetimeMs: 250, multipv: 1, profile: 'turbo-v9' }), env, resolver),
      await handleRequest(
        new Request('https://worker.test/v1/internal/health?profile=turbo-v9', { headers: authHeaders() }),
        env,
        resolver,
      ),
      await handleRequest(
        new Request('https://worker.test/v1/internal/stop', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ profile: 'turbo-v9' }),
        }),
        env,
        resolver,
      ),
    ]) {
      expect(result.status).toBe(400);
    }
    expect(free.requests).toHaveLength(0);
    expect(precision.requests).toHaveLength(0);
  });

  it('routes health and stop to the selected profile', async () => {
    const free = new FakeDriver();
    const precision = new FakeDriver();
    const resolver = (profile: 'free-v1' | 'precision-v1'): DriverClient =>
      profile === 'precision-v1' ? precision : free;

    const precisionHealth = await handleRequest(
      new Request('https://worker.test/v1/internal/health?profile=precision-v1', { headers: authHeaders() }),
      env,
      resolver,
    );
    expect(precisionHealth.status).toBe(200);
    expect(precision.requests).toHaveLength(1);
    expect(free.requests).toHaveLength(0);

    const defaultStop = await handleRequest(
      new Request('https://worker.test/v1/internal/stop', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      resolver,
    );
    expect(defaultStop.status).toBe(200);
    expect(free.requests).toHaveLength(1);

    const precisionStop = await handleRequest(
      new Request('https://worker.test/v1/internal/stop', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'precision-v1' }),
      }),
      env,
      resolver,
    );
    expect(precisionStop.status).toBe(200);
    expect(precision.requests).toHaveLength(2);
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
