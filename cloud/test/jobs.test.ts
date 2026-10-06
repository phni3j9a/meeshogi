/**
 * End-to-end tests for the Issue #21 public job API and Queue consumer.
 * Persistence uses real SQLite; the Container session stream is faked so the
 * consumer's cursor, continuation, retry, and cancellation behavior are
 * verified deterministically.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    envVars: Record<string, string> = {};
    constructor(_ctx: unknown, _env: unknown) {}
  },
  getContainer: (binding: { getByName: (name: string) => unknown }, name: string) => binding.getByName(name),
}));

import { EXPECTED_IDENTITY, legalMoves, type SearchConditions } from '../src/contract';
import { handleJobBatch, requeueStaleJobs } from '../src/jobConsumer';
import { JOB_EXECUTION, JOB_LIMITS, JOB_PROFILES, type JobProfileId } from '../src/jobConfig';
import { readFileSync } from 'node:fs';
import { limitDay, handleV1Request, MAX_JOB_BODY_BYTES, MAX_JOB_MOVES } from '../src/jobs';
import {
  AnalysisContainer,
  BenchmarkStandard3Container,
  handleRequest,
  type Env,
  type JobQueueMessage,
} from '../src/index';
import { Position } from 'tsshogi';
import { JobStore } from '../src/jobStore';
import { createTestDb, type SqliteD1 } from './testDb';

const START_RPC_TIMEOUT_FOR_TEST_MS = 5_000;

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const WORKER = 'https://worker.test';
const STAGING_JOB_VARS = (JSON.parse(readFileSync(new URL('../wrangler.staging.jsonc', import.meta.url), 'utf8')) as {
  vars: Pick<Env, 'JOBS_ENFORCE_FREE_QUOTAS' | 'JOBS_REQUIRE_PRECISION_ALLOWLIST'>;
}).vars;
const QUOTAS_DISABLED_VARS: Pick<Env, 'JOBS_ENFORCE_FREE_QUOTAS' | 'JOBS_REQUIRE_PRECISION_ALLOWLIST'> = {
  JOBS_ENFORCE_FREE_QUOTAS: 'false',
  JOBS_REQUIRE_PRECISION_ALLOWLIST: 'false',
};

interface SessionCall {
  binding: string;
  name: string;
  path: string;
  body: {
    contract: string;
    profileId: string;
    conditions: Record<string, unknown>;
    positions: { ply: number; sfen: string; legalMoveCount: number }[];
    deadlineMs: number;
    /** Only present on /session/cancel calls. */
    sessionId?: unknown;
  };
}

type SessionScript = (body: SessionCall['body']) => string | Response;

type CancelScript = (body: SessionCall['body']) => Response | Promise<Response>;

function sessionBinding(name: string, calls: SessionCall[], script: SessionScript, onCancel?: CancelScript) {
  const states = new Map<string, string>();
  const destroyedNames: string[] = [];
  const lateFetches: string[] = [];
  const terminatedNames = new Set<string>();
  return {
    destroyedNames,
    lateFetches,
    getByName: (stubName: string) => {
      if (!states.has(stubName)) states.set(stubName, 'healthy');
      return {
      getState: async () => ({ status: states.get(stubName) }),
      destroy: async () => { destroyedNames.push(stubName); states.set(stubName, 'stopped'); },
      terminateJob: async () => {
        terminatedNames.add(stubName);
        destroyedNames.push(stubName);
        states.set(stubName, 'stopped');
      },
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (terminatedNames.has(stubName)) {
          lateFetches.push(path);
          return new Response(JSON.stringify({ status: 'terminated' }), {
            status: 410,
            headers: { 'content-type': 'application/json' },
          });
        }
        const body = await request.json() as SessionCall['body'];
        calls.push({ binding: name, name: stubName, path, body });
        if (path === '/session/cancel') {
          if (onCancel) return onCancel(body);
          return new Response(JSON.stringify({ schemaVersion: 1, cancelled: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const output = script(body);
        return typeof output === 'string'
          ? new Response(output, { headers: { 'content-type': 'application/x-ndjson' } })
          : output;
      },
    };
    },
  };
}

const NO_SESSION = {
  getByName: () => ({
    getState: async () => ({ status: 'stopped' }),
    terminateJob: async () => undefined,
    fetch: async () => new Response('not configured', { status: 503 }),
  }),
};

function makeJobsEnv(options: {
  d1?: SqliteD1;
  queue?: { send: (message: JobQueueMessage) => Promise<void> };
  freeQueue?: { send: (message: JobQueueMessage) => Promise<void> };
  precisionQueue?: { send: (message: JobQueueMessage) => Promise<void> };
  normal?: unknown;
  standard3?: unknown;
  jobFree?: unknown;
  jobPrecision?: unknown;
  access?: Pick<Env, 'JOBS_ENFORCE_FREE_QUOTAS' | 'JOBS_REQUIRE_PRECISION_ALLOWLIST'>;
}): Env {
  return {
    ANALYSIS_CONTAINER: (options.normal ?? NO_SESSION) as Env['ANALYSIS_CONTAINER'],
    ANALYSIS_BENCHMARK_STANDARD_2: NO_SESSION as unknown as Env['ANALYSIS_BENCHMARK_STANDARD_2'],
    ANALYSIS_BENCHMARK_STANDARD_3: (options.standard3 ?? NO_SESSION) as Env['ANALYSIS_BENCHMARK_STANDARD_3'],
    JOB_FREE_CONTAINER: (options.jobFree ?? options.normal ?? NO_SESSION) as Env['JOB_FREE_CONTAINER'],
    JOB_PRECISION_CONTAINER: (options.jobPrecision ?? options.standard3 ?? NO_SESSION) as Env['JOB_PRECISION_CONTAINER'],
    JOBS_DB: options.d1 as unknown as D1Database | undefined,
    JOBS_FREE_QUEUE: (options.freeQueue ?? options.queue) as unknown as Queue<JobQueueMessage> | undefined,
    JOBS_PRECISION_QUEUE: (options.precisionQueue ?? options.queue) as unknown as Queue<JobQueueMessage> | undefined,
    ...options.access,
  } as Env;
}

function queueProbe(): { sent: JobQueueMessage[]; queue: { send: (message: JobQueueMessage) => Promise<void> } } {
  const sent: JobQueueMessage[] = [];
  return { sent, queue: { send: async (message: JobQueueMessage) => { sent.push(message); } } };
}

const LONG_GAME_OPENING = ['2g2f', '8c8d', '2f2e', '8d8e', '2e2d', '8e8f'];
const LONG_GAME_CYCLE = ['2h2g', '8b8c', '2g2h', '8c8b'];

function legalGame(plyCount: number): string[] {
  const position = Position.newBySFEN(STARTPOS)!;
  const planned = [...LONG_GAME_OPENING];
  while (planned.length < plyCount) {
    planned.push(LONG_GAME_CYCLE[(planned.length - LONG_GAME_OPENING.length) % LONG_GAME_CYCLE.length]);
  }
  const moves: string[] = [];
  for (const usi of planned) {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move)) break;
    position.doMove(move);
    moves.push(usi);
  }
  return moves;
}

function jobBody(moves: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: `key-${Math.random().toString(36).slice(2, 12)}`,
    profileId: 'free',
    initialSfen: STARTPOS,
    moves,
    ...overrides,
  };
}

function postJson(url: string, credential: string | null, body: unknown): Request {
  return new Request(`${WORKER}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(url: string, credential: string): Request {
  return new Request(`${WORKER}${url}`, { headers: { authorization: `Bearer ${credential}` } });
}

async function issueCredential(env: Env): Promise<{ credential: string; ownerId: string }> {
  const response = await handleRequest(new Request(`${WORKER}/v1/credentials`, { method: 'POST' }), env);
  expect(response.status).toBe(201);
  const body = await response.json() as { credential: string; ownerId: string };
  return body;
}

async function createJob(
  env: Env,
  credential: string,
  body: Record<string, unknown>,
  deps: { now?: () => number; waitUntil?: (task: Promise<unknown>) => void } = {},
): Promise<Response> {
  return handleV1Request(postJson('/v1/jobs', credential, body), env, deps);
}

async function createGame(env: Env, credential: string, moves: string[], overrides: Record<string, unknown> = {}, deps: { now?: () => number } = {}): Promise<{ jobId: string }> {
  const response = await createJob(env, credential, jobBody(moves, overrides), deps);
  expect(response.status).toBe(201);
  return await response.json() as { jobId: string };
}

function sessionLines(
  positions: { ply: number; sfen: string }[],
  profileId: JobProfileId,
  options: { stopAfter?: number; end?: 'complete' | 'deadline' | 'error'; omitEnd?: boolean; sessionId?: string } = {},
): string {
  const conditions = JOB_PROFILES[profileId].conditions;
  const lines: unknown[] = [{
    type: 'session',
    contract: 'analysis-session-v1',
    profileId,
    conditions: { ...conditions },
    driverBootId: 'a'.repeat(32),
    engineLaunch: 1,
    identity: EXPECTED_IDENTITY,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  }];
  for (const position of positions.slice(0, options.stopAfter ?? positions.length)) {
    lines.push({ type: 'result', ply: position.ply, engineLaunch: 1, result: validResult(position.sfen, conditions) });
  }
  if (!options.omitEnd) lines.push({ type: 'end', reason: options.end ?? 'complete' });
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function validResult(sfen: string, conditions: SearchConditions): Record<string, unknown> {
  const moves = legalMoves(sfen);
  const multiPV = Math.min(conditions.multiPV, moves.length);
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'success',
    terminal: null,
    candidates: moves.slice(0, multiPV).map((move, index) => ({
      move,
      pv: [move],
      score: { kind: 'cp', value: 12 - index },
    })),
    meta: { nodes: 1200, completedDepth: 6, elapsedMs: 200 },
    conditions: { requested: { ...conditions }, actual: { ...conditions, multiPV } },
    identity: EXPECTED_IDENTITY,
  };
}

/** A driver failure line for the requested positions: plies not in failingPlies return a valid success. */
function sessionWithDriverFailures(
  body: SessionCall['body'],
  failingPlies: number[],
  code: string,
  profileId: JobProfileId = 'free',
  end: 'complete' | 'deadline' | 'error' = 'error',
): string {
  const conditions = JOB_PROFILES[profileId].conditions;
  const lines: unknown[] = [{
    type: 'session',
    contract: 'analysis-session-v1',
    profileId,
    conditions: { ...conditions },
    driverBootId: 'c'.repeat(32),
    engineLaunch: 1,
    identity: EXPECTED_IDENTITY,
  }];
  for (const position of body.positions) {
    const result = failingPlies.includes(position.ply)
      ? {
        schemaVersion: 1,
        sfen: position.sfen,
        perspective: 'sente',
        status: 'failure',
        failure: { code, message: `driver reported ${code}` },
        identity: EXPECTED_IDENTITY,
      }
      : validResult(position.sfen, conditions);
    lines.push({ type: 'result', ply: position.ply, engineLaunch: 1, result });
  }
  lines.push({ type: 'end', reason: end });
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

interface FakeMessage extends Message<JobQueueMessage> {
  acked: boolean;
  retried: boolean;
  retryOptions?: { delaySeconds?: number };
}

function fakeBatch(
  bodies: JobQueueMessage[],
  attempts = 1,
  queue = 'meeshogi-jobs-free-staging',
): { batch: MessageBatch<JobQueueMessage>; messages: FakeMessage[] } {
  const messages = bodies.map((body, index) => ({
    id: `message-${index}`,
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: false,
    retryOptions: undefined as FakeMessage['retryOptions'],
    ack(this: FakeMessage) { this.acked = true; },
    retry(this: FakeMessage, options?: { delaySeconds?: number }) {
      this.retried = true;
      this.retryOptions = options;
    },
  })) as FakeMessage[];
  const batch = {
    queue,
    messages,
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<JobQueueMessage>;
  return { batch, messages };
}

describe('POST /v1/credentials', () => {
  it('issues an install-scoped credential and stores only its hash', async () => {
    const { d1, sqlite } = createTestDb();
    const env = makeJobsEnv({ d1 });
    const { credential, ownerId } = await issueCredential(env);
    expect(credential).toMatch(/^mcd1_[A-Za-z0-9_-]{43}$/u);
    expect(ownerId).toMatch(/^own_[0-9a-f]{24}$/u);
    const rows = sqlite.prepare('SELECT owner_id, credential_hash, precision_allowed FROM owners').all() as {
      owner_id: string; credential_hash: string; precision_allowed: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id).toBe(ownerId);
    expect(rows[0].credential_hash).not.toBe(credential);
    expect(rows[0].credential_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0].precision_allowed).toBe(0);
  });

  it('accepts an empty JSON object and rejects malformed input', async () => {
    const { d1, sqlite } = createTestDb();
    const env = makeJobsEnv({ d1 });
    const withObject = await handleRequest(new Request(`${WORKER}/v1/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), env);
    expect(withObject.status).toBe(201);
    const bad = await handleRequest(new Request(`${WORKER}/v1/credentials`, {
      method: 'POST',
      body: 'not json',
    }), env);
    expect(bad.status).toBe(400);
    const wrongMethod = await handleRequest(new Request(`${WORKER}/v1/credentials`, { method: 'GET' }), env);
    expect(wrongMethod.status).toBe(405);
  });
});

describe.each([
  { name: 'default restricted settings', access: {} },
  { name: 'development staging settings', access: STAGING_JOB_VARS },
])('POST /v1/jobs invariant checks ($name)', ({ access }) => {
  it('requires authentication', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, access });
    const noAuth = await handleRequest(postJson('/v1/jobs', null, jobBody(['2g2f'])), env);
    expect(noAuth.status).toBe(401);
    const wrongCredential = await handleRequest(postJson('/v1/jobs', `mcd1_${'a'.repeat(43)}`, jobBody(['2g2f'])), env);
    expect(wrongCredential.status).toBe(401);
    const malformed = await handleRequest(postJson('/v1/jobs', 'shared-secret', jobBody(['2g2f'])), env);
    expect(malformed.status).toBe(401);
  });

  it('creates a job for a valid game and enqueues its id', async () => {
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const env = makeJobsEnv({ d1, queue: probe.queue, access });
    const { credential } = await issueCredential(env);
    const response = await createJob(env, credential, jobBody(['2g2f', '8c8d'], { idempotencyKey: 'game-1' }));
    expect(response.status).toBe(201);
    const view = await response.json() as Record<string, unknown>;
    expect(view.jobId).toMatch(/^job_[0-9a-f]{24}$/u);
    expect(view.status).toBe('queued');
    expect(view.profileId).toBe('free');
    expect(view.totalPlies).toBe(3);
    expect(view.nextPly).toBe(0);
    expect(view.idempotentReplay).toBe(false);
    expect(probe.sent).toEqual([{ v: 1, jobId: view.jobId }]);
  });

  it('rejects malformed requests and raw engine settings', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, access });
    const { credential } = await issueCredential(env);
    const cases: [Record<string, unknown> | string, number][] = [
      [jobBody(['2g2f'], { moveTimeMs: 3000 }), 400],           // arbitrary engine setting
      [jobBody(['2g2f'], { multiPV: 8 }), 400],
      [jobBody(['2g2f'], { JOBS_ENFORCE_FREE_QUOTAS: 'false' }), 400],
      [jobBody(['2g2f'], { JOBS_REQUIRE_PRECISION_ALLOWLIST: 'false' }), 400],
      [jobBody(['2g2f'], { profileId: 'turbo' }), 400],
      [jobBody(['2g2f'], { initialSfen: 'not a sfen' }), 400],
      [jobBody(['2g2f'], { moves: '2g2f' }), 400],
      [jobBody(['9j9k']), 400],                                  // impossible square syntax
      [jobBody(['7g7i']), 400],                                  // syntactic but illegal move
      [jobBody(['P*5e']), 400],                                  // drop without a pawn in hand
    ];
    for (const [body, status] of cases) {
      const response = await handleV1Request(postJson('/v1/jobs', credential, body), env);
      expect(response.status).toBe(status);
    }
    const tooManyMoves = jobBody(new Array(MAX_JOB_MOVES + 1).fill('7g7f') as string[]);
    expect((await createJob(env, credential, tooManyMoves)).status).toBe(400);
    const oversized = new Request(`${WORKER}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: ' '.repeat(MAX_JOB_BODY_BYTES + 1),
    });
    expect((await handleV1Request(oversized, env)).status).toBe(413);
    const noJson = new Request(`${WORKER}/v1/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
      body: '{}',
    });
    expect((await handleV1Request(noJson, env)).status).toBe(415);
  });
});

describe('POST /v1/jobs validation and limits', () => {
  it('accepts a game longer than a typical 150-move record', async () => {
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const env = makeJobsEnv({ d1, queue: probe.queue });
    const { credential } = await issueCredential(env);
    const moves = legalGame(160);
    expect(moves.length).toBe(160);
    const response = await createJob(env, credential, jobBody(moves));
    expect(response.status).toBe(201);
    const view = await response.json() as { totalPlies: number };
    expect(view.totalPlies).toBe(161);
  });

  it('replays idempotent submissions without consuming capacity', async () => {
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const env = makeJobsEnv({ d1, queue: probe.queue });
    const { credential } = await issueCredential(env);
    const body = jobBody(['2g2f'], { idempotencyKey: 'stable-key' });
    const first = await createJob(env, credential, body);
    expect(first.status).toBe(201);
    const firstView = await first.json() as { jobId: string };
    // The job is still active; a retry with the same key must replay, not hit the active limit.
    const replay = await createJob(env, credential, body);
    expect(replay.status).toBe(200);
    const replayView = await replay.json() as Record<string, unknown>;
    expect(replayView.jobId).toBe(firstView.jobId);
    expect(replayView.idempotentReplay).toBe(true);
    const conflict = await createJob(env, credential, jobBody(['2g2f', '3c3d'], { idempotencyKey: 'stable-key' }));
    expect(conflict.status).toBe(409);
  });

  it('treats equivalent SFEN spellings and hand order as the same input', async () => {
    const { d1, sqlite } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
    const { credential, ownerId } = await issueCredential(env);
    const key = 'normalized-sfen-key';
    const first = await createJob(env, credential, jobBody(['2g2f'], { idempotencyKey: key }));
    expect(first.status).toBe(201);
    const { jobId } = await first.json() as { jobId: string };
    // "/81/" spells the same empty row as "/9/"; the canonical replayed SFEN is hashed, not the raw string.
    const equivalent = STARTPOS.replace('/9/9/9/', '/81/9/9/');
    expect(Position.newBySFEN(equivalent)!.sfen).toBe(STARTPOS);
    const replay = await createJob(env, credential, jobBody(['2g2f'], { idempotencyKey: key, initialSfen: equivalent }));
    expect(replay.status).toBe(200);
    expect((await replay.json() as { jobId: string; idempotentReplay: boolean })).toMatchObject({ jobId, idempotentReplay: true });
    // Hand piece order also normalizes: "LP" and "PL" describe the same position.
    const { credential: otherCredential } = await issueCredential(env);
    const handA = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b LP 1';
    const handB = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b PL 1';
    expect(Position.newBySFEN(handA)!.sfen).toBe(Position.newBySFEN(handB)!.sfen);
    const handJob = await createJob(env, otherCredential, jobBody([], { idempotencyKey: 'hand-key', initialSfen: handA }));
    expect(handJob.status).toBe(201);
    const { jobId: handJobId } = await handJob.json() as { jobId: string };
    const handReplay = await createJob(env, otherCredential, jobBody([], { idempotencyKey: 'hand-key', initialSfen: handB }));
    expect(handReplay.status).toBe(200);
    expect((await handReplay.json() as { jobId: string }).jobId).toBe(handJobId);
    // A different move list or profile with the same key is a conflict.
    const conflict = await createJob(env, credential, jobBody(['2g2f', '8c8d'], { idempotencyKey: key, initialSfen: equivalent }));
    expect(conflict.status).toBe(409);
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(ownerId);
    const profileConflict = await createJob(env, credential, jobBody(['2g2f'], { idempotencyKey: key, profileId: 'precision' }));
    expect(profileConflict.status).toBe(409);
  });

  it.each([{}, STAGING_JOB_VARS])('never exceeds the active-job limit under concurrent submissions (access %j)', async (access) => {
    const { d1 } = createTestDb();
    const batchErrors: string[] = [];
    const rawBatch = d1.batch.bind(d1);
    d1.batch = (async (statements: Parameters<typeof rawBatch>[0]) => {
      try {
        return await rawBatch(statements);
      } catch (error) {
        batchErrors.push(String(error));
        throw error;
      }
    }) as typeof d1.batch;
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, access });
    const { credential } = await issueCredential(env);
    // Six concurrent POSTs for one owner: exactly one may pass the conditional INSERT.
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => createJob(env, credential, jobBody(['2g2f'], { idempotencyKey: `concurrent-${index}` }))),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    for (const response of responses) {
      if (response.status !== 429) continue;
      const body = await response.json() as { failure: { code: string } };
      expect(body.failure.code).toBe('active_job_limit');
    }
    expect(batchErrors).toHaveLength(0);
  });

  it('keeps the queue max_retries consistent between config and the wrangler template', async () => {
    const config = JSON.parse(readFileSync(new URL('../config/job-profiles.json', import.meta.url), 'utf8')) as { execution: { maxRetries: number } };
    const wrangler = readFileSync(new URL('../wrangler.staging.jsonc', import.meta.url), 'utf8');
    const match = /"max_retries"\s*:\s*(\d+)/u.exec(wrangler);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(config.execution.maxRetries);
    expect(JOB_EXECUTION.maxRetries).toBe(config.execution.maxRetries);
  });

  it('enforces the active-job limit per owner', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
    const { credential } = await issueCredential(env);
    await createGame(env, credential, ['2g2f']);
    const denied = await createJob(env, credential, jobBody(['2g2f'], { idempotencyKey: 'second' }));
    expect(denied.status).toBe(429);
    expect((await denied.json() as { failure: { code: string } }).failure.code).toBe('active_job_limit');
  });

  it('enforces the daily Free quota including cancelled jobs, resetting at the JST boundary', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
    const { credential } = await issueCredential(env);
    let nowMs = Date.parse('2026-09-26T14:00:00Z'); // 23:00 JST on 2026-09-26
    const deps = { now: () => nowMs };
    for (let index = 0; index < JOB_LIMITS.freeDailyJobs; index += 1) {
      const { jobId } = await createGame(env, credential, ['2g2f'], { idempotencyKey: `day-${index}` }, deps);
      const cancel = await handleV1Request(new Request(`${WORKER}/v1/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
      }), env, deps);
      expect(cancel.status).toBe(200);
      // Spaced so the trailing window never fills before the daily quota does.
      nowMs += 15_000;
    }
    const denied = await createJob(env, credential, jobBody(['2g2f']), deps);
    expect(denied.status).toBe(429);
    expect((await denied.json() as { failure: { code: string } }).failure.code).toBe('daily_quota_exceeded');
    // After the JST boundary the next day admits a job again.
    nowMs = Date.parse('2026-09-26T15:00:01Z'); // 00:00:01 JST on 2026-09-27
    const nextDay = await createJob(env, credential, jobBody(['2g2f']), deps);
    expect(nextDay.status).toBe(201);
    expect(limitDay(Date.parse('2026-09-26T14:59:59Z'))).toBe('2026-09-26');
    expect(limitDay(Date.parse('2026-09-26T15:00:00Z'))).toBe('2026-09-27');
  });

  it('enforces the trailing-60-second admission window at the API boundary', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
    const { credential } = await issueCredential(env);
    let nowMs = Date.parse('2026-09-26T03:00:00Z');
    const deps = { now: () => nowMs };
    // The daily quota (10) is wider than the trailing window (5/60s), so the
    // rate limit is what refuses the next submission here.
    expect(JOB_LIMITS.freeDailyJobs).toBeGreaterThan(JOB_LIMITS.freeRateMaxJobs);
    for (let index = 0; index < JOB_LIMITS.freeRateMaxJobs; index += 1) {
      const { jobId } = await createGame(env, credential, ['2g2f'], { idempotencyKey: `rate-${index}` }, deps);
      const cancel = await handleV1Request(new Request(`${WORKER}/v1/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}` },
      }), env, deps);
      expect(cancel.status).toBe(200);
      nowMs += 10_000; // 10 seconds between submissions: the trailing window stays full.
    }
    const denied = await createJob(env, credential, jobBody(['2g2f']), deps);
    expect(denied.status).toBe(429);
    expect((await denied.json() as { failure: { code: string } }).failure.code).toBe('rate_limited');
  });

  it('enforces the Free quotas with the checked-in staging settings (Issue #45)', () => {
    expect(JOB_LIMITS.freeDailyJobs).toBe(10);
    expect(STAGING_JOB_VARS.JOBS_ENFORCE_FREE_QUOTAS).toBe('true');
    expect(STAGING_JOB_VARS.JOBS_REQUIRE_PRECISION_ALLOWLIST).toBe('false');
  });

  it('gates the precision profile behind the server-side allowlist', async () => {
    const { d1, sqlite } = createTestDb();
    const probe = queueProbe();
    const env = makeJobsEnv({ d1, queue: probe.queue });
    const { credential, ownerId } = await issueCredential(env);
    const denied = await createJob(env, credential, jobBody(['2g2f'], { profileId: 'precision' }));
    expect(denied.status).toBe(403);
    expect((await denied.json() as { failure: { code: string } }).failure.code).toBe('profile_not_allowed');
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(ownerId);
    const allowed = await createJob(env, credential, jobBody(['2g2f'], { profileId: 'precision' }));
    expect(allowed.status).toBe(201);
    expect((await allowed.json() as { profileId: string }).profileId).toBe('precision');
  });

  it('admits more than the quotas when they are disabled, and can restore them', async () => {
    const { d1, sqlite } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, access: QUOTAS_DISABLED_VARS });
    const { credential } = await issueCredential(env);
    let nowMs = Date.parse('2026-09-27T14:59:59Z');
    const deps = { now: () => nowMs };
    const total = Math.max(JOB_LIMITS.freeDailyJobs, JOB_LIMITS.freeRateMaxJobs) + 2;
    for (let index = 0; index < total; index += 1) {
      const { jobId } = await createGame(env, credential, ['2g2f'], { idempotencyKey: `dev-${index}` }, deps);
      expect((await handleV1Request(postJson(`/v1/jobs/${jobId}/cancel`, credential, {}), env, deps)).status).toBe(200);
    }
    const restricted = { ...env, JOBS_ENFORCE_FREE_QUOTAS: 'true' };
    const denied = await createJob(restricted, credential, jobBody(['2g2f']), deps);
    expect(denied.status).toBe(429);
    expect((await denied.json() as { failure: { code: string } }).failure.code).toBe('daily_quota_exceeded');
    // Existing jobs and their keys still work after restoring the limits.
    const replay = await createJob(restricted, credential, jobBody(['2g2f'], { idempotencyKey: 'dev-0' }), deps);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: total });
    // At midnight the daily allowance resets, but the restored rate limit still
    // sees jobs accepted in the preceding minute while quotas were disabled.
    nowMs += 2_000;
    const rateDenied = await createJob(restricted, credential, jobBody(['2g2f']), deps);
    expect(rateDenied.status).toBe(429);
    expect((await rateDenied.json() as { failure: { code: string } }).failure.code).toBe('rate_limited');
    nowMs += 60_000;
    expect((await createJob(restricted, credential, jobBody(['2g2f']), deps)).status).toBe(201);
  });

  it.each(['true', 'FALSE', '0', ''])('enforces both checks unless explicitly disabled (value %j)', async (value) => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({
      d1, queue: queueProbe().queue,
      access: { JOBS_ENFORCE_FREE_QUOTAS: value, JOBS_REQUIRE_PRECISION_ALLOWLIST: value },
    });
    const { credential } = await issueCredential(env);
    const deps = { now: () => Date.parse('2026-09-27T03:00:00Z') };
    const precision = await createJob(env, credential, jobBody([], { profileId: 'precision' }), deps);
    expect(precision.status).toBe(403);
    for (let index = 0; index < Math.min(JOB_LIMITS.freeDailyJobs, JOB_LIMITS.freeRateMaxJobs); index += 1) {
      const { jobId } = await createGame(env, credential, [], { idempotencyKey: `restricted-${index}` }, deps);
      expect((await handleV1Request(postJson(`/v1/jobs/${jobId}/cancel`, credential, {}), env, deps)).status).toBe(200);
    }
    expect((await createJob(env, credential, jobBody([]), deps)).status).toBe(429);
  });

  it('allows Precision for a fresh staging owner without changing its allowlist, and shares the active slot with Free', async () => {
    const { d1, sqlite } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, access: STAGING_JOB_VARS });
    const { credential, ownerId } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f'], { profileId: 'precision' });
    expect(sqlite.prepare('SELECT precision_allowed FROM owners WHERE owner_id = ?').get(ownerId)).toEqual({ precision_allowed: 0 });
    const concurrent = await createJob(env, credential, jobBody(['2g2f']));
    expect(concurrent.status).toBe(429);
    expect((await concurrent.json() as { failure: { code: string } }).failure.code).toBe('active_job_limit');
    expect((await handleV1Request(postJson(`/v1/jobs/${jobId}/cancel`, credential, {}), env)).status).toBe(200);
    const restricted = { ...env, JOBS_REQUIRE_PRECISION_ALLOWLIST: 'true' };
    const denied = await createJob(restricted, credential, jobBody(['2g2f'], { profileId: 'precision' }));
    expect(denied.status).toBe(403);
    expect((await denied.json() as { failure: { code: string } }).failure.code).toBe('profile_not_allowed');
    // Both settings act independently: restoring the allowlist leaves Free usable.
    expect((await createJob(restricted, credential, jobBody(['2g2f']))).status).toBe(201);
  });

  it.each([{}, STAGING_JOB_VARS])('returns not_found for other owners and isolates results (access %j)', async (access) => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, access });
    const first = await issueCredential(env);
    const second = await issueCredential(env);
    const { jobId } = await createGame(env, first.credential, ['2g2f']);
    expect((await handleV1Request(get(`/v1/jobs/${jobId}`, second.credential), env)).status).toBe(404);
    expect((await handleV1Request(get(`/v1/jobs/${jobId}/results`, second.credential), env)).status).toBe(404);
    const cancelOther = await handleV1Request(new Request(`${WORKER}/v1/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${second.credential}` },
    }), env);
    expect(cancelOther.status).toBe(404);
    const mine = await handleV1Request(get(`/v1/jobs/${jobId}`, first.credential), env);
    expect(mine.status).toBe(200);
    expect((await mine.json() as { status: string }).status).toBe('queued');
  });

  it('reports persisted-but-unqueued jobs honestly when enqueue fails', async () => {
    const { d1 } = createTestDb();
    const brokenQueue = { send: async (_message: JobQueueMessage) => { throw new Error('queue down'); } };
    const env = makeJobsEnv({ d1, queue: brokenQueue });
    const { credential } = await issueCredential(env);
    const body = jobBody(['2g2f'], { idempotencyKey: 'enqueue-retry' });
    const failed = await createJob(env, credential, body);
    expect(failed.status).toBe(503);
    expect((await failed.json() as { failure: { code: string } }).failure.code).toBe('enqueue_failed');
    // The job row exists; a resubmission with the same key retries the enqueue.
    const fixed = queueProbe();
    env.JOBS_FREE_QUEUE = fixed.queue as unknown as Queue<JobQueueMessage>;
    env.JOBS_PRECISION_QUEUE = fixed.queue as unknown as Queue<JobQueueMessage>;
    const replay = await createJob(env, credential, body);
    expect(replay.status).toBe(200);
    const view = await replay.json() as { jobId: string };
    expect(fixed.sent).toEqual([{ v: 1, jobId: view.jobId }]);
  });

  it('routes create and idempotent replay through the persisted profile queue', async () => {
    const { d1, sqlite } = createTestDb();
    const freeQueue = queueProbe();
    const precisionQueue = queueProbe();
    const env = makeJobsEnv({ d1, freeQueue: freeQueue.queue, precisionQueue: precisionQueue.queue });
    const freeOwner = await issueCredential(env);
    const precisionOwner = await issueCredential(env);
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(precisionOwner.ownerId);

    const free = await createJob(env, freeOwner.credential, jobBody([], { idempotencyKey: 'profile-free' }));
    const precisionBody = jobBody([], { idempotencyKey: 'profile-precision', profileId: 'precision' });
    const precision = await createJob(env, precisionOwner.credential, precisionBody);
    expect(free.status).toBe(201);
    expect(precision.status).toBe(201);
    const freeId = (await free.json() as { jobId: string }).jobId;
    const precisionId = (await precision.json() as { jobId: string }).jobId;
    expect(freeQueue.sent).toEqual([{ v: 1, jobId: freeId }]);
    expect(precisionQueue.sent).toEqual([{ v: 1, jobId: precisionId }]);

    const replay = await createJob(env, precisionOwner.credential, precisionBody);
    expect(replay.status).toBe(200);
    expect(precisionQueue.sent).toEqual([{ v: 1, jobId: precisionId }, { v: 1, jobId: precisionId }]);
    expect(freeQueue.sent).toHaveLength(1);
  });
});

describe('GET /v1/jobs/:id/results parameters', () => {
  it('bounds afterPly and limit', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    expect((await handleV1Request(get(`/v1/jobs/${jobId}/results`, credential), env)).status).toBe(200);
    expect((await handleV1Request(get(`/v1/jobs/${jobId}/results?limit=0`, credential), env)).status).toBe(400);
    expect((await handleV1Request(get(`/v1/jobs/${jobId}/results?limit=201`, credential), env)).status).toBe(400);
    expect((await handleV1Request(get(`/v1/jobs/${jobId}/results?afterPly=-2`, credential), env)).status).toBe(400);
    expect((await handleV1Request(get(`/v1/jobs/${jobId}/results?afterPly=x`, credential), env)).status).toBe(400);
  });
});

describe('GET /internal/jobs/:id/container', () => {
  it('uses only the persisted profile and getState without fetching the Container', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
    env.ANALYSIS_INTERNAL_TOKEN = 'internal-secret';
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const stateNames: string[] = [];
    let fetches = 0;
    env.JOB_FREE_CONTAINER = {
      getByName: (name: string) => ({
        getState: async () => { stateNames.push(name); return { status: 'stopped' }; },
        fetch: async () => { fetches += 1; return new Response('unexpected'); },
      }),
    } as unknown as Env['JOB_FREE_CONTAINER'];
    const unauthorized = await handleRequest(new Request(`${WORKER}/internal/jobs/${jobId}/container`), env);
    expect(unauthorized.status).toBe(401);
    const response = await handleRequest(new Request(`${WORKER}/internal/jobs/${jobId}/container`, {
      headers: { authorization: 'Bearer internal-secret' },
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jobId, profileId: 'free', containerState: { status: 'stopped' }, readOnly: true,
    });
    expect(stateNames).toEqual([jobId]);
    expect(fetches).toBe(0);
  });
});

describe('queue start consumer and stale-job recovery', () => {
  function startBinding(start: (name: string, input: { jobId: string; profileId: JobProfileId }) => Promise<unknown>) {
    const calls: { name: string; jobId: string; profileId: JobProfileId }[] = [];
    let stops = 0;
    const binding = {
      calls,
      get stops() { return stops; },
      getByName: (name: string) => ({
        startJob: async (input: { jobId: string; profileId: JobProfileId }) => {
          calls.push({ name, ...input });
          return start(name, input);
        },
        terminateJob: async () => { stops += 1; },
        getState: async () => ({ status: 'stopped' }),
        fetch: async () => new Response('unexpected', { status: 500 }),
      }),
    };
    return binding;
  }

  it('acks an active job only after the profile DO accepts a finite start RPC', async () => {
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const free = startBinding(async (_name, input) => ({ accepted: true, generation: input.profileId === 'free' ? 17 : 18 }));
    const precision = startBinding(async (_name, input) => ({ accepted: true, generation: 18 }));
    const env = makeJobsEnv({ d1, freeQueue: probe.queue, precisionQueue: probe.queue, jobFree: free, jobPrecision: precision });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const delivery = fakeBatch([{ v: 1, jobId }]);
    const events: Record<string, unknown>[] = [];
    await handleJobBatch(delivery.batch, env, { log: (entry) => events.push(entry) });
    expect(delivery.messages[0].acked).toBe(true);
    expect(delivery.messages[0].retried).toBe(false);
    expect(free.calls).toEqual([{ name: jobId, jobId, profileId: 'free' }]);
    expect(precision.calls).toEqual([]);
    expect(events.map((event) => event.event)).toEqual([
      'job_delivery_begin', 'job_start_accepted', 'job_queue_ack',
    ]);
    expect(events[2]).toMatchObject({ generation: 17, reason: 'start-accepted' });
  });

  it('does not ack while the start RPC is pending', async () => {
    const { d1 } = createTestDb();
    let accept!: (value: unknown) => void;
    const binding = startBinding(() => new Promise((resolve) => { accept = resolve; }));
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const delivery = fakeBatch([{ v: 1, jobId }]);
    const pending = handleJobBatch(delivery.batch, env);
    while (!accept) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivery.messages[0].acked).toBe(false);
    accept({ accepted: true, generation: 1 });
    await pending;
    expect(delivery.messages[0].acked).toBe(true);
  });

  it('retries a timed out start RPC without changing the active D1 job', async () => {
    const { d1 } = createTestDb();
    const binding = startBinding(() => new Promise(() => {}));
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const delivery = fakeBatch([{ v: 1, jobId }], 2);
    vi.useFakeTimers();
    try {
      const pending = handleJobBatch(delivery.batch, env);
      await vi.advanceTimersByTimeAsync(START_RPC_TIMEOUT_FOR_TEST_MS);
      await pending;
      expect(delivery.messages[0].retried).toBe(true);
      expect(delivery.messages[0].acked).toBe(false);
      expect((await new JobStore(d1.rawDb).jobById(jobId))?.status).toBe('queued');
    } finally { vi.useRealTimers(); }
  });

  it('marks a queue/profile mismatch with the existing failure code', async () => {
    const { d1 } = createTestDb();
    const binding = startBinding(async () => ({ accepted: true, generation: 1 }));
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const delivery = fakeBatch([{ v: 1, jobId }], 1, JOB_PROFILES.precision.queueName);
    await handleJobBatch(delivery.batch, env);
    expect(delivery.messages[0].acked).toBe(true);
    expect(binding.calls).toEqual([]);
    const job = await new JobStore(d1.rawDb).jobById(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.failure_code).toBe('queue_profile_mismatch');
  });

  it('routes Precision starts to the job-specific standard-3 binding', async () => {
    const { d1, sqlite } = createTestDb();
    const free = startBinding(async () => ({ accepted: true, generation: 1 }));
    const precision = startBinding(async () => ({ accepted: true, generation: 1 }));
    const env = makeJobsEnv({
      d1,
      freeQueue: queueProbe().queue,
      precisionQueue: queueProbe().queue,
      jobFree: free,
      jobPrecision: precision,
      access: STAGING_JOB_VARS,
    });
    const { credential, ownerId } = await issueCredential(env);
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(ownerId);
    const { jobId } = await createGame(env, credential, ['2g2f'], { profileId: 'precision' });
    const delivery = fakeBatch([{ v: 1, jobId }], 1, JOB_PROFILES.precision.queueName);
    await handleJobBatch(delivery.batch, env);
    expect(delivery.messages[0].acked).toBe(true);
    expect(precision.calls).toEqual([{ name: jobId, jobId, profileId: 'precision' }]);
    expect(free.calls).toEqual([]);
  });

  it('leaves an active job queued when the final Queue start attempt fails', async () => {
    const { d1 } = createTestDb();
    const binding = startBinding(async () => { throw new Error('RPC unavailable'); });
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const final = fakeBatch([{ v: 1, jobId }], JOB_EXECUTION.maxRetries + 1);
    await handleJobBatch(final.batch, env);
    expect(final.messages[0].retried).toBe(true);
    expect(final.messages[0].acked).toBe(false);
    const job = await new JobStore(d1.rawDb).jobById(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.failure_code).toBeNull();
  });

  it('requeues stale jobs to their persisted profile Queue without changing public job timestamps', async () => {
    const { d1, sqlite } = createTestDb();
    const freeQueue = queueProbe();
    const precisionQueue = queueProbe();
    const env = makeJobsEnv({ d1, freeQueue: freeQueue.queue, precisionQueue: precisionQueue.queue, access: STAGING_JOB_VARS });
    const freeCredential = await issueCredential(env);
    const { jobId: freeId } = await createGame(env, freeCredential.credential, ['2g2f']);
    const precisionCredential = await issueCredential(env);
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(precisionCredential.ownerId);
    const { jobId: precisionId } = await createGame(env, precisionCredential.credential, ['2g2f'], { profileId: 'precision' });
    freeQueue.sent.length = 0;
    precisionQueue.sent.length = 0;
    sqlite.prepare("UPDATE jobs SET updated_at = '2026-10-01T00:00:00.000Z'").run();
    const result = await requeueStaleJobs(env, { now: () => Date.parse('2026-10-04T00:00:00.000Z') });
    expect(result).toEqual({ scanned: 2, sent: 2 });
    expect(freeQueue.sent).toEqual([{ v: 1, jobId: freeId }]);
    expect(precisionQueue.sent).toEqual([{ v: 1, jobId: precisionId }]);
    expect(sqlite.prepare('SELECT status, updated_at, last_recovery_at FROM jobs ORDER BY job_id').all()).toEqual([
      { status: 'queued', updated_at: '2026-10-01T00:00:00.000Z', last_recovery_at: '2026-10-04T00:00:00.000Z' },
      { status: 'queued', updated_at: '2026-10-01T00:00:00.000Z', last_recovery_at: '2026-10-04T00:00:00.000Z' },
    ]);
  });

  it('includes the stale cutoff boundary and enforces the bounded scan limit', async () => {
    const { d1, sqlite } = createTestDb();
    const freeQueue = queueProbe();
    const env = makeJobsEnv({ d1, freeQueue: freeQueue.queue, precisionQueue: freeQueue.queue, access: STAGING_JOB_VARS });
    const owners = await Promise.all([issueCredential(env), issueCredential(env), issueCredential(env)]);
    const atBoundary = await createGame(env, owners[0].credential, ['2g2f']);
    const newer = await createGame(env, owners[1].credential, ['2g2f']);
    const older = await createGame(env, owners[2].credential, ['2g2f']);
    const cutoff = Date.parse('2026-10-04T00:00:00.000Z') - 15 * 60_000;
    sqlite.prepare('UPDATE jobs SET updated_at = ? WHERE job_id = ?').run(new Date(cutoff).toISOString(), atBoundary.jobId);
    sqlite.prepare('UPDATE jobs SET updated_at = ? WHERE job_id = ?').run(new Date(cutoff + 1).toISOString(), newer.jobId);
    sqlite.prepare('UPDATE jobs SET updated_at = ?, status = \'running\' WHERE job_id = ?')
      .run(new Date(cutoff - 1).toISOString(), older.jobId);

    freeQueue.sent.length = 0;
    const allStale = await requeueStaleJobs(env, { now: () => Date.parse('2026-10-04T00:00:00.000Z'), limit: 100 });
    expect(allStale).toEqual({ scanned: 2, sent: 2 });
    expect(freeQueue.sent).toEqual([
      { v: 1, jobId: older.jobId },
      { v: 1, jobId: atBoundary.jobId },
    ]);

    freeQueue.sent.length = 0;
    const bounded = await requeueStaleJobs(env, { now: () => Date.parse('2026-10-04T00:00:00.000Z'), limit: 1 });
    expect(bounded).toEqual({ scanned: 1, sent: 1 });
    expect(freeQueue.sent).toEqual([{ v: 1, jobId: older.jobId }]);
    expect((await new JobStore(d1.rawDb).jobById(newer.jobId))?.updated_at).toBe(new Date(cutoff + 1).toISOString());
  });

  it('reaches every stale row over repeated bounded scans, including running capacity waits', async () => {
    const { d1, sqlite } = createTestDb();
    const freeQueue = queueProbe();
    const env = makeJobsEnv({ d1, freeQueue: freeQueue.queue, precisionQueue: freeQueue.queue, access: STAGING_JOB_VARS });
    const insertOwner = sqlite.prepare(
      'INSERT INTO owners (owner_id, credential_hash, precision_allowed, created_at) VALUES (?, ?, 0, ?)',
    );
    const insertJob = sqlite.prepare(`INSERT INTO jobs (
      job_id, owner_id, idempotency_key, input_hash, profile_id, initial_sfen, moves_json,
      total_plies, status, next_ply, jst_day, created_ms, created_at, updated_at, last_recovery_at
    ) VALUES (?, ?, ?, 'stale-input', 'free', 'sfen', '[]', 2, ?, ?, '2026-10-03', 0, ?, ?, ?)`);
    const updatedAt = '2026-10-03T00:00:00.000Z';
    const previouslyAcceptedAt = '2026-10-03T12:00:00.000Z';
    const jobIds: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const ownerId = `owner_stale_${suffix}`;
      const jobId = `job_stale_${suffix}`;
      const isCapacityWait = index < 125;
      insertOwner.run(ownerId, `hash_${suffix}`, updatedAt);
      insertJob.run(
        jobId,
        ownerId,
        `key_${suffix}`,
        isCapacityWait ? 'running' : 'queued',
        isCapacityWait ? 1 : 0,
        updatedAt,
        updatedAt,
        isCapacityWait ? previouslyAcceptedAt : null,
      );
      jobIds.push(jobId);
    }

    const scanStart = Date.parse('2026-10-04T00:00:00.000Z');
    for (let scan = 0; scan < 8; scan += 1) {
      const result = await requeueStaleJobs(env, { now: () => scanStart + scan * 60_000, limit: 100 });
      expect(result.scanned).toBe(100);
    }

    expect(new Set(freeQueue.sent.map((message) => message.jobId)).size).toBe(jobIds.length);
    expect(new Set(freeQueue.sent.map((message) => message.jobId))).toEqual(new Set(jobIds));
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE updated_at = ? AND next_ply IN (0, 1) AND last_recovery_at IS NOT NULL`).get(updatedAt)).toEqual({ count: 205 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running' AND next_ply = 1").get())
      .toEqual({ count: 125 });
  });

  it('waits for D1 cancellation confirmation before scheduling the stop task', async () => {
    const { d1, sqlite } = createTestDb();
    let stopCalls = 0;
    const binding = {
      getByName: () => ({
        terminateJob: async () => { stopCalls += 1; },
        getState: async () => ({ status: 'stopped' }),
      }),
    };
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding, access: STAGING_JOB_VARS });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const scheduled: Promise<unknown>[] = [];
    const response = await handleV1Request(postJson(`/v1/jobs/${jobId}/cancel`, credential, {}), env, {
      waitUntil: (task) => {
        expect(sqlite.prepare('SELECT status FROM jobs WHERE job_id = ?').get(jobId)).toEqual({ status: 'cancelled' });
        scheduled.push(task);
      },
    });
    expect(response.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(stopCalls).toBe(1);

    const second = await createGame(env, credential, ['2g2f']);
    const originalPrepare = d1.prepare.bind(d1);
    d1.prepare = ((sql: string) => {
      if (sql.includes("SET status = 'cancelled'")) {
        return { bind: () => ({ run: async () => ({ success: true, meta: { changes: 0 } }) }) } as never;
      }
      return originalPrepare(sql);
    }) as typeof d1.prepare;
    const noStop: Promise<unknown>[] = [];
    const unchanged = await handleV1Request(postJson(`/v1/jobs/${second.jobId}/cancel`, credential, {}), env, {
      waitUntil: (task) => { noStop.push(task); },
    });
    expect(unchanged.status).toBe(200);
    expect(noStop).toHaveLength(0);
    expect(stopCalls).toBe(1);
  });

  it('acks terminal deliveries when container stop reaches its finite deadline and handles a late rejection', async () => {
    const { d1, sqlite } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: {
      getByName: () => ({
        terminateJob: () => new Promise<void>((_resolve, reject) => { setTimeout(() => reject(new Error('late stop rejection')), 7_000); }),
        getState: async () => ({ status: 'healthy' }),
      }),
    } });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    sqlite.prepare("UPDATE jobs SET status = 'completed' WHERE job_id = ?").run(jobId);
    const delivery = fakeBatch([{ v: 1, jobId }]);
    const logs: Record<string, unknown>[] = [];
    vi.useFakeTimers();
    try {
      const pending = handleJobBatch(delivery.batch, env, { log: (entry) => logs.push(entry) });
      await vi.advanceTimersByTimeAsync(6_000);
      await pending;
      expect(delivery.messages[0].acked).toBe(true);
      expect(delivery.messages[0].retried).toBe(false);
      expect(logs).toContainEqual(expect.objectContaining({
        event: 'job_container_stop_result', jobId, profile: 'free', stopped: false, timedOut: true,
      }));
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      expect(delivery.messages[0].acked).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('acks malformed and missing-job messages without starting a Container', async () => {
    const { d1 } = createTestDb();
    const binding = startBinding(async () => ({ accepted: true, generation: 1 }));
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding });
    const delivery = fakeBatch([
      { v: 0, jobId: 'job_bad_payload' } as unknown as JobQueueMessage,
      { v: 1, jobId: 'job_missing_row' },
    ]);
    await handleJobBatch(delivery.batch, env);
    expect(delivery.messages.every((message) => message.acked)).toBe(true);
    expect(binding.calls).toEqual([]);
  });
});
