import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    envVars: Record<string, string> = {};

    constructor(_ctx: unknown, _env: unknown) {}
  },
  getContainer: (binding: { getByName: (name: string) => unknown }, name: string) => binding.getByName(name),
}));
import {
  BENCHMARK_CONDITIONS,
  BENCHMARK_CONDITION_BY_ID,
  BENCHMARK_CONTRACT_VERSION,
  EXPECTED_IDENTITY,
  SEARCH_CONDITIONS,
  isLegalPv,
  isValidSfen,
  legalMoves,
} from '../src/contract';
import { AnalysisContainer, handleRequest, type Env } from '../src/index';
import { Position } from 'tsshogi';

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const TERMINAL_MATE = '2+Lk1+S3/9/1N1BB4/9/9/9/9/9/4K4 w LP 4';
const TERMINAL_NO_MOVES = 'k8/9/9/9/9/2nn1nn2/9/3p1p3/4K4 b - 1';
const TWO_MOVES = 'k8/9/9/9/9/9/9/8r/4K4 b - 1';
const SYNTHETIC_MIDDLEGAME = '1nrg3n1/l2s2k2/p1p1gp1pl/1p1pp2s1/6P1p/b1P5P/PP1PPP1P1/L1KSRSG2/1NG4NL b BP 1';
const SYNTHETIC_MATE_IN_ONE = '2p2+B2k/1+B3g2p/1P2L1Gpn/p1P2p3/3p2p2/lpG1NP3/P1KP+p3+l/LS1S2SP+n/1NR1S1+pg1 b RPp 1';
const GIB = 1024 ** 3;

function benchmarkRuntime(instanceType: 'standard-2' | 'standard-3') {
  const vcpu = instanceType === 'standard-2' ? 1 : 2;
  const expectedMemory = (instanceType === 'standard-2' ? 6 : 8) * GIB;
  return {
    driverBootId: 'b'.repeat(32),
    expectedInstanceType: instanceType,
    osCpuCount: vcpu,
    affinityCpuCount: vcpu,
    cpuMax: null,
    cpuQuota: null,
    memoryMaxBytes: null,
    memTotalBytes: expectedMemory - GIB / 2,
    rootDiskTotalBytes: 32 * GIB,
  };
}

const DRIVER_HEALTH = {
  schemaVersion: 1,
  status: 'ready',
  driverBootId: 'b'.repeat(32),
  verifyStopEngineOnceEnabled: true,
  verifyStopEngineOnceConsumed: false,
  driverVersion: EXPECTED_IDENTITY.driverVersion,
  contractVersion: EXPECTED_IDENTITY.contractVersion,
  expectedInstanceType: 'standard-2',
  runtime: benchmarkRuntime('standard-2'),
  identityDigests: {
    engineSha256: EXPECTED_IDENTITY.engineSha256,
    weightSha256: EXPECTED_IDENTITY.weightSha256,
    optionsSha256: EXPECTED_IDENTITY.optionsSha256,
    sourceArchiveSha256: EXPECTED_IDENTITY.sourceArchiveSha256,
    sourceTreeSha256: EXPECTED_IDENTITY.sourceTreeSha256,
  },
};

function candidate(move: string, nextMove: string, value: number) {
  return { move, pv: [move, nextMove], score: { kind: 'cp', value } };
}

function success(sfen: string, multiPV = Math.min(3, legalMoves(sfen).length)): Record<string, any> {
  const pvs = sfen === STARTPOS
    ? [candidate('7g7f', '3c3d', 42), candidate('2g2f', '8c8d', -15), candidate('6g6f', '4c4d', 7)]
    : sfen === TWO_MOVES
      ? legalMoves(sfen).map((move, index) => ({ move, pv: [move], score: { kind: 'cp', value: index ? -8 : 12 } }))
      : [candidate('5i5h', '9a9b', 12), candidate('5i4h', '9a9b', -8)];
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'success',
    terminal: null,
    candidates: pvs.slice(0, multiPV),
    meta: { nodes: 1200, completedDepth: 8, elapsedMs: 1500 },
    conditions: {
      requested: SEARCH_CONDITIONS,
      actual: { ...SEARCH_CONDITIONS, multiPV },
    },
    identity: EXPECTED_IDENTITY,
  };
}

function benchmarkSuccess(sfen: string, conditionId: string): Record<string, any> {
  const condition = BENCHMARK_CONDITION_BY_ID.get(conditionId)!;
  const effective = Math.min(condition.multiPV, legalMoves(sfen).length);
  const candidates = sfen === STARTPOS
    ? [candidate('7g7f', '3c3d', 42), candidate('2g2f', '8c8d', -15), candidate('6g6f', '4c4d', 7)].slice(0, effective)
    : success(sfen, effective).candidates;
  return {
    schemaVersion: 2,
    contractVersion: BENCHMARK_CONTRACT_VERSION,
    sfen,
    perspective: 'sente',
    status: 'success',
    terminal: null,
    candidates,
    conditionId,
    expectedInstanceType: condition.instanceType,
    driverBootId: 'b'.repeat(32),
    driverVersion: 'test-driver',
    engineEpoch: 1,
    runtime: benchmarkRuntime(condition.instanceType),
    identityDigests: DRIVER_HEALTH.identityDigests,
    conditions: {
      requested: condition,
      actual: {
        instanceType: condition.instanceType,
        threads: condition.threads,
        hashMb: condition.hashMb,
        moveTimeMs: condition.moveTimeMs,
        multiPV: condition.multiPV,
        effectiveMultiPV: effective,
      },
    },
    meta: {
      nodes: 1200,
      completedDepth: 8,
      searchElapsedMs: 100,
      engineNps: 12000,
      derivedNps: 12000,
      processElapsedMs: 165,
      processCpuSeconds: 0.12,
    },
  };
}

function makeEnv(
  response?: (payload: unknown) => unknown | Response,
  token?: string,
  verificationFlag?: string,
  containerHealth: Record<string, unknown> | Response = DRIVER_HEALTH,
  benchmarkEnabled = false,
  expectedInstanceType: 'standard-2' | 'standard-3' = 'standard-2',
): Env & { calls: number[]; forwardedPaths: string[] } {
  const calls: number[] = [];
  const forwardedPaths: string[] = [];
  const binding = {
    getByName: () => ({
      fetch: async (request: Request) => {
        calls.push(1);
        const path = new URL(request.url).pathname;
        forwardedPaths.push(path);
        if (path === '/health') {
          return containerHealth instanceof Response ? containerHealth : Response.json(containerHealth);
        }
        const payload = await request.json();
        const result = response
          ? response(payload)
          : Object.hasOwn(payload as object, 'conditionId')
            ? benchmarkSuccess((payload as { sfen: string }).sfen, (payload as { conditionId: string }).conditionId)
            : success((payload as { sfen: string }).sfen);
        return result instanceof Response ? result : Response.json(result);
      },
    }),
  };
  return {
    ANALYSIS_INTERNAL_TOKEN: token,
    ANALYSIS_VERIFY_STOP_ENGINE_ONCE: verificationFlag,
    ANALYSIS_BENCHMARK_ENABLED: benchmarkEnabled ? '1' : undefined,
    ANALYSIS_EXPECTED_INSTANCE_TYPE: expectedInstanceType,
    ANALYSIS_CONTAINER: binding as unknown as Env['ANALYSIS_CONTAINER'],
    calls,
    forwardedPaths,
  };
}

function request(body: string, options: {
  token?: string;
  contentType?: string;
  method?: string;
  extraHeaders?: Record<string, string>;
} = {}) {
  const headers = new Headers();
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.contentType !== undefined) headers.set('content-type', options.contentType);
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers.set(name, value);
  return new Request('https://staging.example/internal/analyze', {
    method: options.method ?? 'POST',
    headers,
    body,
  });
}

async function result(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('staging analysis Worker boundary', () => {
  it('bundles 48 unique comparison conditions and one fixed reference', () => {
    expect(BENCHMARK_CONDITIONS).toHaveLength(49);
    expect(new Set(BENCHMARK_CONDITIONS.map((condition) => condition.conditionId)).size).toBe(49);
    expect(BENCHMARK_CONDITIONS.filter((condition) => condition.role === 'candidate')).toHaveLength(48);
    expect(BENCHMARK_CONDITIONS.filter((condition) => condition.role === 'reference')).toMatchObject([
      { instanceType: 'standard-3', threads: 2, hashMb: 64, moveTimeMs: 10000, multiPV: 3 },
    ]);
  });

  it('passes the verification stop flag to the Container only when configured on the Worker', async () => {
    const verificationEnv = makeEnv(undefined, 'secret-token', '1');
    const normalEnv = makeEnv(undefined, 'secret-token');
    const verificationContainer = new AnalysisContainer({} as DurableObjectState<{}>, verificationEnv);
    const normalContainer = new AnalysisContainer({} as DurableObjectState<{}>, normalEnv);

    expect(verificationContainer.envVars).toEqual({ ANALYSIS_VERIFY_STOP_ENGINE_ONCE: '1', ANALYSIS_EXPECTED_INSTANCE_TYPE: 'standard-2' });
    expect(normalContainer.envVars).toEqual({ ANALYSIS_EXPECTED_INSTANCE_TYPE: 'standard-2' });

    const health = new Request('https://staging.example/internal/health', {
      method: 'GET',
      headers: { authorization: 'Bearer secret-token' },
    });
    const ready = await handleRequest(health, verificationEnv);
    expect(ready.status).toBe(200);
    expect(await result(ready)).toEqual({
      ...DRIVER_HEALTH,
      workerVerifyStopEngineOnceEnabled: true,
      workerBenchmarkEnabled: false,
      workerExpectedInstanceType: 'standard-2',
    });
    expect(verificationEnv.forwardedPaths).toEqual(['/health']);

    const unavailableEnv = makeEnv(undefined, 'secret-token', '1', new Response('not ready', { status: 503 }));
    const unavailable = await handleRequest(health, unavailableEnv);
    expect(unavailable.status).toBe(502);
    expect(unavailableEnv.forwardedPaths).toEqual(['/health']);
  });

  it('includes Cloudflare Worker version metadata in health when the binding is available', async () => {
    const env = makeEnv(undefined, 'secret-token');
    env.CF_VERSION_METADATA = { id: 'worker-version-id', tag: 'benchmark-deploy', timestamp: '2026-09-25T12:00:00.000Z' };
    const response = await handleRequest(
      new Request('https://staging.example/internal/health', {
        method: 'GET',
        headers: { authorization: 'Bearer secret-token' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await result(response)).toMatchObject({
      workerVersionId: 'worker-version-id',
      workerVersionTag: 'benchmark-deploy',
      workerVersionTimestamp: '2026-09-25T12:00:00.000Z',
      identityDigests: DRIVER_HEALTH.identityDigests,
    });
  });

  it('keeps benchmark mode explicitly off and rejects invalid condition input', async () => {
    const disabled = makeEnv(undefined, 'secret-token');
    const off = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'standard-2-t1-100ms-mpv2' }),
      }),
      disabled,
    );
    expect(off.status).toBe(404);
    expect(disabled.calls).toHaveLength(0);

    const enabled = makeEnv(undefined, 'secret-token', undefined, DRIVER_HEALTH, true);
    const unauthenticated = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'standard-2-t1-100ms-mpv2' }),
      }),
      enabled,
    );
    expect(unauthenticated.status).toBe(401);
    expect(enabled.calls).toHaveLength(0);

    const wrongType = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'reference-standard-3-t2-10000ms-mpv3' }),
      }),
      enabled,
    );
    expect(wrongType.status).toBe(409);
    expect(enabled.calls).toHaveLength(0);

    const unknown = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'unknown' }),
      }),
      enabled,
    );
    expect(unknown.status).toBe(400);
    expect(enabled.calls).toHaveLength(0);
  });

  it('accepts only a condition ID and validates benchmark v2 observations', async () => {
    const env = makeEnv(undefined, 'secret-token', undefined, DRIVER_HEALTH, true);
    const valid = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'standard-2-t1-100ms-mpv2' }),
      }),
      env,
    );
    expect(valid.status).toBe(200);
    const validPayload = await result(valid);
    expect(validPayload).toMatchObject({
      schemaVersion: 2,
      contractVersion: BENCHMARK_CONTRACT_VERSION,
      conditionId: 'standard-2-t1-100ms-mpv2',
      expectedInstanceType: 'standard-2',
      meta: { searchElapsedMs: 100, processElapsedMs: 165, nodes: 1200 },
    });
    expect(validPayload).not.toHaveProperty('identity');
    expect(env.forwardedPaths).toEqual(['/benchmark']);
    expect(env.calls).toHaveLength(1);

    const invalidObservation = benchmarkSuccess(STARTPOS, 'standard-2-t1-100ms-mpv2');
    (invalidObservation.conditions as any).actual.moveTimeMs = 10000;
    const invalidEnv = makeEnv(() => invalidObservation, 'secret-token', undefined, DRIVER_HEALTH, true);
    const rejected = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'standard-2-t1-100ms-mpv2' }),
      }),
      invalidEnv,
    );
    expect(rejected.status).toBe(502);
    expect((await result(rejected)).failure).toMatchObject({ code: 'engine_error' });
  });

  it('validates a real Python driver v2 response from a fake USI process', async () => {
    const generated = execFileSync('python3', ['container/benchmark_response_fixture.py'], { encoding: 'utf8' });
    const driverResponse = JSON.parse(generated) as Record<string, unknown>;
    const env = makeEnv(() => driverResponse, 'secret-token', undefined, DRIVER_HEALTH, true);
    const response = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'standard-2-t1-100ms-mpv2' }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await result(response)).toMatchObject({
      status: 'success',
      terminal: null,
      identityDigests: driverResponse.identityDigests,
      conditionId: 'standard-2-t1-100ms-mpv2',
    });
  });

  it('rejects benchmark measurements when observed CPU or memory evidence disagrees', async () => {
    const observation = benchmarkSuccess(STARTPOS, 'standard-2-t1-100ms-mpv2');
    (observation.runtime as any).osCpuCount = 2;
    (observation.runtime as any).affinityCpuCount = 2;
    const env = makeEnv(() => observation, 'secret-token', undefined, DRIVER_HEALTH, true);
    const rejected = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: STARTPOS, conditionId: 'standard-2-t1-100ms-mpv2' }),
      }),
      env,
    );
    expect(rejected.status).toBe(409);
    expect(await result(rejected)).toMatchObject({
      status: 'failure',
      failure: { code: 'instance_mismatch' },
      runtimeMismatch: 'cpu_count_mismatch',
      runtime: { osCpuCount: 2, affinityCpuCount: 2, memTotalBytes: 5.5 * GIB },
    });
  });

  it('includes measured runtime proof for terminal benchmark positions', async () => {
    const env = makeEnv(undefined, 'secret-token', undefined, DRIVER_HEALTH, true);
    const terminal = await handleRequest(
      new Request('https://staging.example/internal/benchmark', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sfen: TERMINAL_MATE, conditionId: 'standard-2-t1-100ms-mpv2' }),
      }),
      env,
    );
    expect(terminal.status).toBe(200);
    expect(await result(terminal)).toMatchObject({
      status: 'terminal',
      terminal: 'checkmate',
      driverBootId: 'b'.repeat(32),
      runtime: { osCpuCount: 1, affinityCpuCount: 1, memTotalBytes: 5.5 * GIB, rootDiskTotalBytes: 32 * GIB },
    });
    expect(env.forwardedPaths).toEqual(['/health']);
  });

  it('does not allow an analysis request field or header to toggle the verification stop', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const response = await handleRequest(
      new Request('https://staging.example/internal/analyze', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
          'x-analysis-verify-stop-engine-once': '1',
        },
        body: JSON.stringify({ sfen: STARTPOS, verificationStopEngineOnce: true }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(env.calls).toHaveLength(0);

    const ordinaryEnv = makeEnv(() => success(STARTPOS), 'secret-token');
    const ordinaryContainer = new AnalysisContainer({} as DurableObjectState<{}>, ordinaryEnv);
    const ordinaryResponse = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), {
        token: 'secret-token',
        contentType: 'application/json',
        extraHeaders: { 'x-analysis-verify-stop-engine-once': '1' },
      }),
      ordinaryEnv,
    );
    expect(ordinaryResponse.status).toBe(200);
    expect(ordinaryContainer.envVars).toEqual({ ANALYSIS_EXPECTED_INSTANCE_TYPE: 'standard-2' });
    expect(ordinaryEnv.calls).toHaveLength(1);
  });

  it('preserves validated one-shot timeout and fresh-engine evidence from the Container', async () => {
    const timeoutEvidence = {
      driverBootId: 'a'.repeat(32),
      engineEpoch: 1,
      enginePid: 321,
      engineReaped: true,
      waitReturned: true,
      waitReturnCode: -9,
      stopInjected: true,
    };
    const timeoutEnv = makeEnv(() => ({
      schemaVersion: 1,
      sfen: STARTPOS,
      perspective: 'sente',
      status: 'failure',
      failure: { code: 'timeout', message: 'The engine exceeded the fixed search deadline.' },
      identity: EXPECTED_IDENTITY,
      verification: timeoutEvidence,
    }), 'secret-token');
    const timeout = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      timeoutEnv,
    );
    expect(timeout.status).toBe(504);
    expect(await result(timeout)).toMatchObject({ verification: timeoutEvidence });

    const recoveryEvidence = { ...timeoutEvidence, engineEpoch: 2, enginePid: 322, waitReturnCode: 0, stopInjected: false };
    const recovery = success(STARTPOS);
    recovery.verification = recoveryEvidence;
    const recoveryEnv = makeEnv(() => recovery, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      recoveryEnv,
    );
    expect(response.status).toBe(200);
    expect(await result(response)).toMatchObject({ verification: recoveryEvidence });
  });

  it('requires a configured bearer secret and never calls the Container on auth failure', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const missing = await handleRequest(request(JSON.stringify({ sfen: STARTPOS })), env);
    const wrong = await handleRequest(request(JSON.stringify({ sfen: STARTPOS }), { token: 'wrong' }), env);
    const unsetEnv = makeEnv(undefined, undefined);
    const unset = await handleRequest(request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token' }), unsetEnv);

    expect(missing.status).toBe(401);
    expect((await result(missing)).failure).toMatchObject({ code: 'unauthorized' });
    expect(wrong.status).toBe(401);
    expect((await result(wrong)).failure).toMatchObject({ code: 'unauthorized' });
    expect(unset.status).toBe(503);
    expect((await result(unset)).failure).toMatchObject({ code: 'auth_unconfigured' });
    expect(env.calls).toHaveLength(0);
    expect(unsetEnv.calls).toHaveLength(0);
  });

  it('rejects invalid JSON, oversized bodies, extra fields, bad SFEN, newlines, and control characters', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const invalidJson = await handleRequest(request('{', { token: 'secret-token', contentType: 'application/json' }), env);
    const oversized = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }) + ' '.repeat(1100), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const extra = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS, command: 'quit' }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const malformed = await handleRequest(
      request(JSON.stringify({ sfen: 'not sfen' }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const newline = await handleRequest(
      request(JSON.stringify({ sfen: `${STARTPOS}\nquit` }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const control = await handleRequest(
      request(JSON.stringify({ sfen: `${STARTPOS}\u0001` }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );

    for (const response of [invalidJson, oversized, extra, malformed, newline, control]) {
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(env.calls).toHaveLength(0);
    expect(isValidSfen(STARTPOS)).toBe(true);
    expect(isValidSfen(`${STARTPOS}\r\n`)).toBe(false);
  });

  it('accepts legal SFEN move numbers containing zero at the Worker boundary', async () => {
    const baseSuccess = success(STARTPOS);
    const env = makeEnv(
      (payload) => ({ ...baseSuccess, sfen: (payload as { sfen: string }).sfen }),
      'secret-token',
    );

    for (const moveNumber of ['10', '20', '100']) {
      const sfen = STARTPOS.replace(/ 1$/u, ` ${moveNumber}`);
      expect(isValidSfen(sfen)).toBe(true);
      const response = await handleRequest(
        request(JSON.stringify({ sfen }), { token: 'secret-token', contentType: 'application/json' }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await result(response)).toMatchObject({ status: 'success', sfen });
    }

    expect(env.calls).toHaveLength(3);
    expect(isValidSfen(STARTPOS.replace('lnsgkgsnl', '0nsgkgsnl'))).toBe(false);
    expect(isValidSfen(STARTPOS.replace(' b - 1', ' b 10P 10'))).toBe(true);
    expect(isValidSfen(STARTPOS.replace(' b - 1', ' b 0P 10'))).toBe(false);
    expect(isValidSfen(STARTPOS.replace(' b - 1', ' b - 0'))).toBe(false);
  });

  it('distinguishes checkmate and no-legal-moves without starting engine work', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const checkmate = await handleRequest(
      request(JSON.stringify({ sfen: TERMINAL_MATE }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const noMoves = await handleRequest(
      request(JSON.stringify({ sfen: TERMINAL_NO_MOVES }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(checkmate.status).toBe(200);
    expect(await result(checkmate)).toMatchObject({ status: 'terminal', terminal: 'checkmate', candidates: [], meta: { nodes: null, completedDepth: null, elapsedMs: null } });
    expect(noMoves.status).toBe(200);
    expect(await result(noMoves)).toMatchObject({ status: 'terminal', terminal: 'no-legal-moves', candidates: [] });
    expect(env.calls).toHaveLength(0);
  });

  it('keeps the staging middlegame and mate-in-one fixtures legal and public', () => {
    expect(isValidSfen(SYNTHETIC_MIDDLEGAME)).toBe(true);
    expect(legalMoves(SYNTHETIC_MIDDLEGAME).length).toBeGreaterThan(0);
    expect(isValidSfen(SYNTHETIC_MATE_IN_ONE)).toBe(true);
    const matingMoves = legalMoves(SYNTHETIC_MATE_IN_ONE).filter((usi) => {
      const position = Position.newBySFEN(SYNTHETIC_MATE_IN_ONE);
      const move = position?.createMoveByUSI(usi);
      if (!position || !move || !position.isValidMove(move)) return false;
      const after = position.clone();
      if (!after.doMove(move)) return false;
      return after.checked && legalMoves(after.sfen).length === 0;
    });
    expect(matingMoves.length).toBeGreaterThan(0);
  });

  it('caps effective MultiPV to the legal move count and returns only validated lines', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: TWO_MOVES }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(response.status).toBe(200);
    expect(legalMoves(TWO_MOVES)).toHaveLength(2);
    expect(env.calls).toHaveLength(1);
    expect(await result(response)).toMatchObject({
      status: 'success',
      candidates: [{ score: { kind: 'cp' } }, { score: { kind: 'cp' } }],
      conditions: { requested: { multiPV: 3 }, actual: { multiPV: 2 } },
    });
  });

  it('returns typed JSON when Container port startup returns a plain-text unavailable response', async () => {
    const env = makeEnv(
      () => new Response('Failed to start container: port not ready', { status: 500 }),
      'secret-token',
    );
    const response = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );

    expect(response.status).toBe(502);
    const payload = await result(response);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      sfen: STARTPOS,
      status: 'failure',
      failure: { code: 'engine_error', message: 'Analysis container returned an invalid response.' },
    });
    expect(JSON.stringify(payload)).not.toContain('port not ready');
  });

  it('returns typed JSON when Container fetch rejects during startup', async () => {
    const env = makeEnv(() => {
      throw new Error('internal container-start detail');
    }, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );

    expect(response.status).toBe(502);
    const payload = await result(response);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      sfen: STARTPOS,
      status: 'failure',
      failure: { code: 'engine_error', message: 'Analysis container is unavailable.' },
    });
    expect(JSON.stringify(payload)).not.toContain('internal container-start detail');
  });

  it('accepts sente-perspective cp and mate scores but rejects an illegal PV', async () => {
    const mateResult = success(STARTPOS);
    mateResult.candidates[0] = {
      move: '7g7f',
      pv: ['7g7f', '3c3d'],
      score: { kind: 'mate', value: 5, winningSide: 'sente' },
    };
    const mateEnv = makeEnv(() => mateResult, 'secret-token');
    const mate = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      mateEnv,
    );
    expect(mate.status).toBe(200);
    expect(((await result(mate)).candidates as Array<Record<string, unknown>>)[0]).toMatchObject({
      score: { kind: 'mate', value: 5, winningSide: 'sente' },
    });

    const illegalResult = success(STARTPOS);
    illegalResult.candidates[0] = candidate('7g7f', '9a8b', 1);
    const illegalEnv = makeEnv(() => illegalResult, 'secret-token');
    const illegal = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      illegalEnv,
    );
    expect(illegal.status).toBe(502);
    expect((await result(illegal)).failure).toMatchObject({ code: 'engine_error' });
    expect(isLegalPv(STARTPOS, ['7g7f', '3c3d'])).toBe(true);
    expect(isLegalPv(STARTPOS, ['7g7f', '9a8b'])).toBe(false);
  });

  it('fails closed when the image identity differs from the expected manifest', async () => {
    const mismatched = success(STARTPOS);
    mismatched.identity = { ...EXPECTED_IDENTITY, weightSha256: '0'.repeat(64) } as unknown as typeof EXPECTED_IDENTITY;
    const env = makeEnv(() => mismatched, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(response.status).toBe(502);
    expect((await result(response)).failure).toMatchObject({ code: 'engine_error' });
  });

  it.each([
    ['busy', 409],
    ['timeout', 504],
  ] as const)('keeps the %s failure typed at the Worker boundary', async (code, status) => {
    const downstream = {
      schemaVersion: 1,
      sfen: STARTPOS,
      perspective: 'sente',
      status: 'failure',
      failure: { code, message: `synthetic ${code}` },
      identity: EXPECTED_IDENTITY,
    };
    const env = makeEnv(() => downstream, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(response.status).toBe(status);
    expect((await result(response)).failure).toMatchObject({ code });
  });

  it('does not expose the analysis route through another path or method', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const wrongPath = await handleRequest(new Request('https://staging.example/debug'), env);
    const wrongMethod = await handleRequest(new Request('https://staging.example/internal/analyze', { method: 'GET' }), env);
    expect(wrongPath.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(env.calls).toHaveLength(0);
  });
});
