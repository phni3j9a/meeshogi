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
import { handleJobBatch } from '../src/jobConsumer';
import { JOB_CONSUMER, JOB_LIMITS, JOB_PROFILES, type JobProfileId } from '../src/jobConfig';
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

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const WORKER = 'https://worker.test';
const STAGING_JOB_VARS = (JSON.parse(readFileSync(new URL('../wrangler.staging.jsonc', import.meta.url), 'utf8')) as {
  vars: Pick<Env, 'JOBS_ENFORCE_FREE_QUOTAS' | 'JOBS_REQUIRE_PRECISION_ALLOWLIST'>;
}).vars;

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
    const config = JSON.parse(readFileSync(new URL('../config/job-profiles.json', import.meta.url), 'utf8')) as { consumer: { maxRetries: number } };
    const wrangler = readFileSync(new URL('../wrangler.staging.jsonc', import.meta.url), 'utf8');
    const match = /"max_retries"\s*:\s*(\d+)/u.exec(wrangler);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(config.consumer.maxRetries);
    expect(JOB_CONSUMER.maxRetries).toBe(config.consumer.maxRetries);
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
      nowMs += 1000;
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
    // With equal configured limits (5/day and 5/60s) the daily quota masks the
    // rate limit at the API boundary; the trailing-window SQL is exercised
    // separately in jobStore tests with a wider daily limit.
    for (let index = 0; index < JOB_LIMITS.freeDailyJobs; index += 1) {
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

  it('admits more than five Free jobs in one minute with staging settings, and can restore quotas', async () => {
    const { d1, sqlite } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, access: STAGING_JOB_VARS });
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
    for (let index = 0; index < JOB_LIMITS.freeDailyJobs; index += 1) {
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

describe('queue consumer', () => {
  function consumerEnv(script: SessionScript, profile: JobProfileId = 'free', onCancel?: CancelScript) {
    const { d1, sqlite } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const freeBinding = sessionBinding('JOB_FREE_CONTAINER', calls, script, onCancel);
    const precisionBinding = sessionBinding('JOB_PRECISION_CONTAINER', calls, script, onCancel);
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      jobFree: freeBinding,
      jobPrecision: precisionBinding,
    });
    void profile;
    return { d1, sqlite, env, calls, sent: probe.sent, freeBinding, precisionBinding };
  }

  it('analyzes every position through one session and completes', async () => {
    const { env, calls } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(messages[0].retried).toBe(false);
    // One session carries every remaining position: the driver can keep a
    // single engine process for the whole job.
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(jobId);
    expect(calls[0].path).toBe('/session');
    expect(calls[0].body.contract).toBe('analysis-session-v1');
    expect(calls[0].body.profileId).toBe('free');
    expect(calls[0].body.positions.map((position) => position.ply)).toEqual([0, 1, 2]);
    for (const position of calls[0].body.positions) {
      expect(position.legalMoveCount).toBe(legalMoves(position.sfen).length);
      expect(position.legalMoveCount).toBeGreaterThanOrEqual(1);
    }
    expect(calls[0].body.conditions).toEqual(JOB_PROFILES.free.conditions);
    expect(calls[0].body.deadlineMs).toBeGreaterThan(0);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(job.status).toBe('completed');
    expect(job.analyzedPlies).toBe(3);
    const results = await (await handleV1Request(get(`/v1/jobs/${jobId}/results`, credential), env)).json() as {
      results: { ply: number; sfen: string; result: { status: string; sfen: string; candidates: unknown[] } }[];
    };
    expect(results.results.map((row) => row.ply)).toEqual([0, 1, 2]);
    for (const row of results.results) {
      expect(row.result.status).toBe('success');
      expect(row.result.candidates).toHaveLength(1); // free multiPV
      expect(row.result.sfen).toBe(row.sfen);
    }
  });

  it('sends the legal move count and accepts a reduced effective multiPV', async () => {
    // This position has exactly one legal move (1i2i), below the free MultiPV of 2.
    const ONE_MOVE_SFEN = 'k7r/9/9/9/9/8g/8g/9/8K b - 1';
    expect(legalMoves(ONE_MOVE_SFEN)).toEqual(['1i2i']);
    const { env, calls } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, [], { initialSfen: ONE_MOVE_SFEN });
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(calls).toHaveLength(1);
    // The driver uses legalMoveCount for its effective MultiPV = min(profile, legal).
    expect(calls[0].body.positions).toEqual([{ ply: 0, sfen: ONE_MOVE_SFEN, legalMoveCount: 1 }]);
    const results = await (await handleV1Request(get(`/v1/jobs/${jobId}/results`, credential), env)).json() as {
      results: { ply: number; result: { status: string; candidates: unknown[]; conditions: { actual: { multiPV: number } } } }[];
    };
    expect(results.results).toHaveLength(1);
    expect(results.results[0].result.status).toBe('success');
    expect(results.results[0].result.conditions.actual.multiPV).toBe(1);
    expect(results.results[0].result.candidates).toHaveLength(1);
  });

  it('sends a durable continuation after a deadline and resumes from the cursor', async () => {
    const { env, calls, sent, freeBinding, precisionBinding } = consumerEnv((body) => {
      const finish = body.positions[0]?.ply !== 0; // resume call completes everything
      return sessionLines(body.positions, 'free', finish ? {} : { stopAfter: 1, end: 'deadline' });
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d']);
    const first = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(first.batch, env);
    expect(first.messages[0].acked).toBe(true);
    // Commit/send/ack boundary: the continuation is sent before the ack.
    expect(sent).toEqual([{ v: 1, jobId }, { v: 1, jobId }]);
    expect(freeBinding.destroyedNames).toEqual([]);
    expect(precisionBinding.destroyedNames).toEqual([]);
    const partial = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(partial.status).toBe('running');
    expect(partial.nextPly).toBe(1);
    const second = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(second.batch, env);
    expect(second.messages[0].acked).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.positions.map((position) => position.ply)).toEqual([1, 2]);
    const done = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as { status: string };
    expect(done.status).toBe('completed');
    expect(freeBinding.destroyedNames).toEqual([jobId]);
  });

  it('sends a Precision continuation to the Precision Queue without stopping', async () => {
    const { d1, sqlite } = createTestDb();
    const freeQueue = queueProbe();
    const precisionQueue = queueProbe();
    const calls: SessionCall[] = [];
    const env = makeJobsEnv({
      d1,
      freeQueue: freeQueue.queue,
      precisionQueue: precisionQueue.queue,
      jobFree: sessionBinding('JOB_FREE_CONTAINER', calls, (body) => sessionLines(body.positions, 'free')),
      jobPrecision: sessionBinding('JOB_PRECISION_CONTAINER', calls, (body) => {
        const continueAfterFirst = body.positions[0]?.ply === 0;
        return sessionLines(body.positions, 'precision', continueAfterFirst ? { stopAfter: 1, end: 'deadline' } : {});
      }),
    });
    const { credential, ownerId } = await issueCredential(env);
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(ownerId);
    const { jobId } = await createGame(env, credential, ['2g2f'], { profileId: 'precision' });
    const precisionBinding = env.JOB_PRECISION_CONTAINER as unknown as { destroyedNames: string[] };
    const delivery = fakeBatch([{ v: 1, jobId }], 1, JOB_PROFILES.precision.queueName);
    await handleJobBatch(delivery.batch, env);
    expect(delivery.messages[0].acked).toBe(true);
    expect(precisionQueue.sent).toEqual([{ v: 1, jobId }, { v: 1, jobId }]);
    expect(freeQueue.sent).toEqual([]);
    expect(precisionBinding.destroyedNames ?? []).toEqual([]);
    expect(calls[0].name).toBe(jobId);
  });

  it('aborts a stalled stream on its own budget and retries without progress', async () => {
    // The fake clock jumps past the 720 s budget while the driver stream is
    // still open: the buffered lines are never processed, nothing commits, and
    // the delivery takes the standard retry instead of a continuation.
    let fakeNow = 1_700_000_000_000;
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const hangingCalls: SessionCall[] = [];
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', hangingCalls, (body) => {
        const conditions = JOB_PROFILES.free.conditions;
        const header = { type: 'session', contract: 'analysis-session-v1', profileId: 'free', conditions, driverBootId: 'd'.repeat(32), engineLaunch: 1, identity: EXPECTED_IDENTITY };
        const first = { type: 'result', ply: body.positions[0].ply, engineLaunch: 1, result: validResult(body.positions[0].sfen, conditions) };
        return new Response(new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`${JSON.stringify(header)}\n${JSON.stringify(first)}\n`));
            // Never closes: the driver would keep streaming; the consumer must stop on its own deadline.
          },
          pull() {
            // The consumer drained the first chunk and asked for more: jump
            // past the budget deadline now.
            fakeNow += JOB_CONSUMER.budgetMs + 60_000;
          },
        }), { headers: { 'content-type': 'application/x-ndjson' } });
      }),
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d', '2f2e']);
    const first = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(first.batch, env, { now: () => fakeNow });
    expect(first.messages[0].retried).toBe(true);
    expect(first.messages[0].acked).toBe(false);
    expect(hangingCalls).toHaveLength(1);
    expect(probe.sent).toEqual([{ v: 1, jobId }]); // admission only; no continuation
    const view = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(view.status).toBe('running');
    expect(view.nextPly).toBe(0);
  });

  it('stops at its own budget with buffered lines unprocessed, then resumes', async () => {
    // One stream chunk carries header + 3 results + end. The fake clock jumps
    // past the budget during the first commit: only one ply is committed, the
    // consumer sends a continuation before acking, and a later delivery
    // resumes from the cursor.
    let fakeNow = 1_700_000_000_000;
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', calls, (body) => new Response(sessionLines(body.positions, 'free'))),
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d', '2f2e']);
    // Expire the budget as the first result commit lands.
    const originalBatch = d1.batch.bind(d1);
    let bumped = false;
    d1.batch = (async (statements: Parameters<typeof originalBatch>[0]) => {
      const result = await originalBatch(statements);
      if (!bumped) {
        bumped = true;
        fakeNow += JOB_CONSUMER.budgetMs + 60_000;
      }
      return result;
    }) as typeof d1.batch;
    const first = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(first.batch, env, { now: () => fakeNow });
    expect(first.messages[0].acked).toBe(true);
    expect(calls).toHaveLength(1);
    // Admission plus the continuation send both precede the ack.
    expect(probe.sent).toEqual([{ v: 1, jobId }, { v: 1, jobId }]);
    const partial = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(partial.status).toBe('running');
    expect(partial.nextPly).toBe(1);
    // A later delivery resumes from the cursor and finishes the job.
    const completeCalls: SessionCall[] = [];
    const envComplete = makeJobsEnv({
      d1,
      queue: probe.queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', completeCalls, (body) => sessionLines(body.positions, 'free')),
    });
    const second = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(second.batch, envComplete);
    expect(second.messages[0].acked).toBe(true);
    expect(completeCalls[0].body.positions.map((position) => position.ply)).toEqual([1, 2, 3]);
    const done = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as { status: string };
    expect(done.status).toBe('completed');
  });

  it('ignores duplicate delivery of a completed job', async () => {
    const { env, calls, freeBinding } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const first = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(first.batch, env);
    const second = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(second.batch, env);
    expect(second.messages[0].acked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(freeBinding.destroyedNames).toEqual([jobId, jobId]);
  });

  it('acks a cancelled delivery without starting a session', async () => {
    const { env, calls, freeBinding } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const cancel = await handleV1Request(new Request(`${WORKER}/v1/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
    }), env);
    expect(cancel.status).toBe(200);
    expect(freeBinding.destroyedNames).toEqual([jobId]);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(calls).toHaveLength(0);
    expect(freeBinding.destroyedNames).toEqual([jobId, jobId]);
  });

  it('schedules cancellation stop with waitUntil only after D1 confirms cancelled', async () => {
    const { sqlite, env, freeBinding } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const tasks: Promise<unknown>[] = [];
    const response = await handleV1Request(postJson(`/v1/jobs/${jobId}/cancel`, credential, {}), env, {
      waitUntil: (task) => {
        expect(sqlite.prepare('SELECT status FROM jobs WHERE job_id = ?').get(jobId)).toEqual({ status: 'cancelled' });
        tasks.push(task);
      },
    });
    expect(response.status).toBe(200);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(freeBinding.destroyedNames).toEqual([jobId]);
  });

  it('acks a cancellation that races a transient Container response instead of retrying it', async () => {
    const { d1 } = createTestDb();
    let status = 'healthy';
    let jobId = '';
    let cancel = async () => undefined;
    const freeBinding = {
      destroyedNames: [] as string[],
      getByName: (name: string) => ({
        getState: async () => ({ status }),
        terminateJob: async () => { freeBinding.destroyedNames.push(name); status = 'stopped'; },
        fetch: async () => {
          await cancel();
          return new Response('container is shutting down', { status: 503 });
        },
      }),
    };
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: freeBinding });
    const { credential } = await issueCredential(env);
    jobId = (await createGame(env, credential, ['2g2f'])).jobId;
    cancel = async () => {
      const response = await handleV1Request(postJson(`/v1/jobs/${jobId}/cancel`, credential, {}), env);
      expect(response.status).toBe(200);
    };
    const delivery = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(delivery.batch, env);
    expect(delivery.messages[0].acked).toBe(true);
    expect(delivery.messages[0].retried).toBe(false);
    expect(freeBinding.destroyedNames).toEqual([jobId, jobId]);
  });

  it('does not commit a driver failure result and retries from the failed ply', async () => {
    const { env } = consumerEnv((body) => sessionWithDriverFailures(body, [0], 'engine_error'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].retried).toBe(true);
    expect(messages[0].acked).toBe(false);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(job.status).toBe('running');
    expect(job.nextPly).toBe(0);
    const results = await (await handleV1Request(get(`/v1/jobs/${jobId}/results`, credential), env)).json() as { results: unknown[] };
    expect(results.results).toHaveLength(0);
  });

  it('keeps committed progress when a later ply fails, retrying from the cursor', async () => {
    let sessionCalls = 0;
    const { env } = consumerEnv((body) => {
      sessionCalls += 1;
      // Only the first session reports a driver failure at ply 1; the resumed session succeeds.
      return sessionCalls === 1 ? sessionWithDriverFailures(body, [1], 'engine_error') : sessionLines(body.positions, 'free');
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].retried).toBe(true);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(job.status).toBe('running');
    expect(job.nextPly).toBe(1);
    const results = await (await handleV1Request(get(`/v1/jobs/${jobId}/results`, credential), env)).json() as {
      results: { ply: number; result: { status: string } }[];
    };
    expect(results.results.map((row) => [row.ply, row.result.status])).toEqual([[0, 'success']]);
    // A follow-up delivery resumes from the cursor and finishes the job.
    const second = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(second.batch, env);
    const done = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as { status: string; nextPly: number };
    expect(done.status).toBe('completed');
    expect(done.nextPly).toBe(3);
  });

  it('fails the job when the driver reports a permanent failure', async () => {
    const { env } = consumerEnv((body) => sessionWithDriverFailures(body, [1], 'identity_mismatch'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(messages[0].retried).toBe(false);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as {
      status: string; failure: { code: string };
    };
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('contract_violation');
  });

  it('marks the job failed when transient driver failures exhaust the retries', async () => {
    const { env } = consumerEnv((body) => sessionWithDriverFailures(body, [0], 'engine_error'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    // attempts === maxRetries is still a standard retry; maxRetries + 1 is final.
    const retriable = fakeBatch([{ v: 1, jobId }], JOB_CONSUMER.maxRetries);
    await handleJobBatch(retriable.batch, env);
    expect(retriable.messages[0].retried).toBe(true);
    const final = fakeBatch([{ v: 1, jobId }], JOB_CONSUMER.maxRetries + 1);
    await handleJobBatch(final.batch, env);
    expect(final.messages[0].acked).toBe(true);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as {
      status: string; failure: { code: string };
    };
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('retry_exhausted');
  });

  it('retries the delivery instead of acking when the failed state cannot be persisted', async () => {
    const { d1 } = createTestDb();
    const originalPrepare = d1.prepare.bind(d1);
    let failureWrites = 0;
    d1.prepare = ((sql: string) => {
      if (sql.includes('failure_code = ?')) {
        failureWrites += 1;
        return { bind: () => ({ run: async () => { throw new Error('transient D1 write error'); } }) };
      }
      return originalPrepare(sql);
    }) as typeof d1.prepare;
    const calls: SessionCall[] = [];
    const env = makeJobsEnv({
      d1,
      queue: queueProbe().queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', calls, () => new Response('busy', { status: 409 })),
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const delivery = fakeBatch([{ v: 1, jobId }], JOB_CONSUMER.maxRetries + 1);
    await handleJobBatch(delivery.batch, env);
    expect(failureWrites).toBe(1);
    // The failed state could not be persisted: the delivery goes back for retry/DLQ.
    expect(delivery.messages[0].acked).toBe(false);
    expect(delivery.messages[0].retried).toBe(true);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as { status: string };
    expect(job.status).not.toBe('failed');
  });

  it('routes precision jobs to the job-specific standard-3 binding with profile conditions', async () => {
    const { d1, sqlite } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      jobFree: sessionBinding('JOB_FREE_CONTAINER', calls, (body) => sessionLines(body.positions, 'precision')),
      jobPrecision: sessionBinding('JOB_PRECISION_CONTAINER', calls, (body) => sessionLines(body.positions, 'precision')),
    });
    const { credential, ownerId } = await issueCredential(env);
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(ownerId);
    const { jobId } = await createGame(env, credential, ['2g2f'], { profileId: 'precision' });
    const { batch, messages } = fakeBatch([{ v: 1, jobId }], 1, JOB_PROFILES.precision.queueName);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].binding).toBe('JOB_PRECISION_CONTAINER');
    expect(calls[0].name).toBe(jobId);
    expect(calls[0].body.conditions).toEqual(JOB_PROFILES.precision.conditions);
  });

  it('fails a delivery on the wrong profile Queue and stops the persisted jobId Container', async () => {
    const { env, calls, freeBinding } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const mismatch = fakeBatch([{ v: 1, jobId }], 1, JOB_PROFILES.precision.queueName);
    await handleJobBatch(mismatch.batch, env);
    expect(mismatch.messages[0].acked).toBe(true);
    expect(mismatch.messages[0].retried).toBe(false);
    expect(calls).toHaveLength(0);
    expect(freeBinding.destroyedNames).toEqual([jobId]);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as {
      status: string; failure: { code: string };
    };
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('queue_profile_mismatch');
  });

  it('keeps a completed delivery acked when Container shutdown fails and emits lifecycle logs', async () => {
    const { d1 } = createTestDb();
    const calls: SessionCall[] = [];
    const brokenStop = {
      getByName: (name: string) => ({
        getState: async () => ({ status: 'healthy' }),
        terminateJob: async () => { throw new Error('stop failed'); },
        fetch: async (request: Request) => {
          const body = await request.json() as SessionCall['body'];
          calls.push({ binding: 'JOB_FREE_CONTAINER', name, path: new URL(request.url).pathname, body });
          return new Response(sessionLines(body.positions, 'free'), {
            headers: { 'content-type': 'application/x-ndjson' },
          });
        },
      }),
    };
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: brokenStop });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const delivery = fakeBatch([{ v: 1, jobId }]);
    const logs: Record<string, unknown>[] = [];
    await handleJobBatch(delivery.batch, env, { log: (entry) => logs.push(entry) });
    expect(delivery.messages[0].acked).toBe(true);
    expect(delivery.messages[0].retried).toBe(false);
    expect(calls[0].name).toBe(jobId);
    const events = logs.map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining([
      'job_delivery_begin', 'job_container_fetch_begin', 'job_session_header_received',
      'job_first_result_committed', 'job_container_stop_result',
    ]));
    expect(logs.every((entry) => entry.jobId === jobId && entry.profile === 'free')).toBe(true);
  });

  it('retries transient session failures and exhausts into a failed job', async () => {
    const { env, freeBinding } = consumerEnv(() => new Response('x'.repeat(1500), { status: 503 }));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const first = fakeBatch([{ v: 1, jobId }], 1);
    const logs: Record<string, unknown>[] = [];
    await handleJobBatch(first.batch, env, { log: (entry) => logs.push(entry) });
    expect(first.messages[0].retried).toBe(true);
    expect(freeBinding.destroyedNames).toEqual([]);
    const retryLog = logs.find((entry) => entry.event === 'job_container_retry_response');
    expect(retryLog?.status).toBe(503);
    expect(retryLog?.bodyPrefix).toBe('x'.repeat(1024));
    expect((await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as { status: string }).status).toBe('running');
    const exhausted = fakeBatch([{ v: 1, jobId }], JOB_CONSUMER.maxRetries + 1);
    await handleJobBatch(exhausted.batch, env);
    expect(exhausted.messages[0].acked).toBe(true);
    expect(freeBinding.destroyedNames).toEqual([jobId]);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as {
      status: string; failure: { code: string };
    };
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('retry_exhausted');
  });

  it('fails the job on a contract violation instead of retrying forever', async () => {
    const { env } = consumerEnv(() => '{"type":"end","reason":"complete"}\n');
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as {
      status: string; failure: { code: string };
    };
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('contract_violation');
  });

  /** Cancels the job through the public API once its persisted cursor reaches atPly. */
  function cancelJobAfterPly(
    env: Env,
    credential: string,
    jobId: string,
    d1: SqliteD1,
    sqlite: ReturnType<typeof createTestDb>['sqlite'],
    atPly = 1,
  ): { done: () => boolean } {
    const state = { cancelled: false };
    const originalBatch = d1.batch.bind(d1);
    d1.batch = (async (statements: Parameters<typeof originalBatch>[0]) => {
      const out = await originalBatch(statements);
      if (!state.cancelled) {
        const row = sqlite.prepare('SELECT next_ply FROM jobs WHERE job_id = ?').get(jobId) as { next_ply?: number } | undefined;
        if (row && typeof row.next_ply === 'number' && row.next_ply >= atPly) {
          state.cancelled = true;
          const cancel = await handleV1Request(postJson(`/v1/jobs/${jobId}/cancel`, credential, {}), env);
          expect(cancel.status).toBe(200);
        }
      }
      return out;
    }) as typeof d1.batch;
    return { done: () => state.cancelled };
  }

  it('does not refetch a terminally cancelled job Container while the next job runs', async () => {
    const { d1, sqlite } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const sessionIdA = 'ab'.repeat(16);
    let jobAContainer: ReturnType<typeof sessionBinding> | undefined;
    let servedA = false;
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      jobFree: (jobAContainer = sessionBinding('JOB_FREE_CONTAINER', calls, (body) => {
        if (!servedA) {
          servedA = true;
          return sessionLines(body.positions, 'free', { sessionId: sessionIdA });
        }
        return sessionLines(body.positions, 'free', { sessionId: 'cd'.repeat(16) });
      })),
    });
    const { credential } = await issueCredential(env);
    const { jobId: jobA } = await createGame(env, credential, ['2g2f', '8c8d']);
    const cancelHook = cancelJobAfterPly(env, credential, jobA, d1, sqlite);

    const first = fakeBatch([{ v: 1, jobId: jobA }]);
    await handleJobBatch(first.batch, env);
    // The cancelled job's delivery still acks. Its terminated DO rejects
    // future fetches, so cleanup does not restart a dead Container.
    expect(cancelHook.done()).toBe(true);
    expect(first.messages[0].acked).toBe(true);
    expect(first.messages[0].retried).toBe(false);
    expect(jobAContainer?.lateFetches).toEqual([]);
    expect(calls.map((call) => call.path)).toEqual(['/session']);
    const jobAView = await (await handleV1Request(get(`/v1/jobs/${jobA}`, credential), env)).json() as { status: string };
    expect(jobAView.status).toBe('cancelled');

    // Job B's first delivery then completes on the freed container.
    const { jobId: jobB } = await createGame(env, credential, ['2g2f']);
    const second = fakeBatch([{ v: 1, jobId: jobB }]);
    await handleJobBatch(second.batch, env);
    expect(second.messages[0].acked).toBe(true);
    expect(second.messages[0].retried).toBe(false);
    const jobBView = await (await handleV1Request(get(`/v1/jobs/${jobB}`, credential), env)).json() as { status: string };
    expect(jobBView.status).toBe('completed');
    expect(calls.map((call) => call.path)).toEqual(['/session', '/session']);
  });

  it('retries with delaySeconds instead of an immediate retry when there is no sessionId to cancel', async () => {
    const { d1, sqlite } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const cancels: unknown[] = [];
    let servedA = false;
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', calls, (body) => {
        if (!servedA) {
          servedA = true;
          // An old driver image has no sessionId in its header.
          return sessionLines(body.positions, 'free');
        }
        return new Response(
          JSON.stringify({ status: 'failure', failure: { code: 'busy', message: 'An analysis is already running.' } }),
          { status: 409 },
        );
      }, (body) => {
        cancels.push(body.sessionId);
        return new Response(JSON.stringify({ schemaVersion: 1, cancelled: false }), { status: 200 });
      }),
    });
    const { credential } = await issueCredential(env);
    const { jobId: jobA } = await createGame(env, credential, ['2g2f', '8c8d']);
    const cancelHook = cancelJobAfterPly(env, credential, jobA, d1, sqlite);

    const first = fakeBatch([{ v: 1, jobId: jobA }]);
    await handleJobBatch(first.batch, env);
    expect(cancelHook.done()).toBe(true);
    expect(first.messages[0].acked).toBe(true);
    // Without a sessionId there is nothing to cancel; the wedged driver stays busy.
    expect(cancels).toEqual([]);

    const { jobId: jobB } = await createGame(env, credential, ['2g2f']);
    const second = fakeBatch([{ v: 1, jobId: jobB }]);
    await handleJobBatch(second.batch, env);
    expect(second.messages[0].retried).toBe(true);
    expect(second.messages[0].acked).toBe(false);
    expect(second.messages[0].retryOptions).toEqual({ delaySeconds: JOB_CONSUMER.retryDelaySeconds });
    const jobBView = await (await handleV1Request(get(`/v1/jobs/${jobB}`, credential), env)).json() as { status: string };
    expect(jobBView.status).toBe('running');
    expect(calls.map((call) => call.path)).toEqual(['/session', '/session']);
  });

  it('completes against a driver whose header has no sessionId and never cancels', async () => {
    const cancels: unknown[] = [];
    const { env } = consumerEnv((body) => sessionLines(body.positions, 'free'), undefined, (body) => {
      cancels.push(body.sessionId);
      return new Response(JSON.stringify({ schemaVersion: 1, cancelled: false }), { status: 200 });
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(cancels).toEqual([]);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as { status: string };
    expect(job.status).toBe('completed');
  });

  it('fails the job when the session header sessionId is malformed', async () => {
    const { env } = consumerEnv((body) => sessionLines(body.positions, 'free', { sessionId: 'not-a-session-id' }));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as {
      status: string; failure: { code: string };
    };
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('contract_violation');
  });

  it('cancels the driver session when the consumer deadline cuts the stream', async () => {
    let fakeNow = 1_700_000_000_000;
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const sessionId = 'ef'.repeat(16);
    const cancels: unknown[] = [];
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', calls,
        (body) => new Response(sessionLines(body.positions, 'free', { sessionId })),
        (body) => {
          cancels.push(body.sessionId);
          return new Response(JSON.stringify({ schemaVersion: 1, cancelled: true }), { status: 200 });
        }),
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d', '2f2e']);
    // Expire the budget as the first result commit lands (same pattern as the
    // buffered-lines deadline test above).
    const originalBatch = d1.batch.bind(d1);
    let bumped = false;
    d1.batch = (async (statements: Parameters<typeof originalBatch>[0]) => {
      const result = await originalBatch(statements);
      if (!bumped) {
        bumped = true;
        fakeNow += JOB_CONSUMER.budgetMs + 60_000;
      }
      return result;
    }) as typeof d1.batch;
    const first = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(first.batch, env, { now: () => fakeNow });
    expect(first.messages[0].acked).toBe(true);
    expect(cancels).toEqual([sessionId]);
    // Admission plus the continuation send both precede the ack.
    expect(probe.sent).toEqual([{ v: 1, jobId }, { v: 1, jobId }]);
    const partial = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(partial.status).toBe('running');
    expect(partial.nextPly).toBe(1);
  });

  it.each<[string, CancelScript]>([
    ['rejects', async () => { throw new Error('transport down'); }],
    ['non-200', async () => new Response('busy', { status: 500 })],
    ['hangs', () => new Promise<Response>(() => {})],
  ])('ignores a best-effort cancel that %s for an active abandoned session', async (_name, onCancel) => {
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const sessionId = 'ab'.repeat(16);
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      jobFree: sessionBinding('JOB_FREE_CONTAINER', calls,
        (body) => sessionLines(body.positions, 'free', { sessionId, omitEnd: true }),
        onCancel),
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d']);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env, { sessionCancelTimeoutMs: 25 });
    // The job remains active; an abandoned driver session gets best-effort cleanup.
    expect(messages[0].acked).toBe(true);
    expect(messages[0].retried).toBe(false);
    expect(calls.map((call) => call.path)).toEqual(['/session', '/session/cancel']);
    expect(probe.sent).toEqual([{ v: 1, jobId }, { v: 1, jobId }]);
  });

  it('acks a late session fetch after cancellation without restarting the terminated Container', async () => {
    const { d1 } = createTestDb();
    const calls: SessionCall[] = [];
    const binding = sessionBinding('JOB_FREE_CONTAINER', calls, body => sessionLines(body.positions, 'free'));
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const original = JobStore.prototype.markRunning;
    const spy = vi.spyOn(JobStore.prototype, 'markRunning').mockImplementationOnce(async function(this: JobStore, id, at) {
      const marked = await original.call(this, id, at);
      expect(marked).toBe(true);
      const cancelled = await handleV1Request(postJson(`/v1/jobs/${id}/cancel`, credential, {}), env);
      expect(cancelled.status).toBe(200);
      expect(await binding.getByName(id).getState()).toEqual({ status: 'stopped' });
      return marked;
    });
    try {
      const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
      await handleJobBatch(batch, env);
      expect(messages[0].acked).toBe(true);
      expect(calls).toEqual([]);
      expect(binding.lateFetches).toEqual(['/session']);
    } finally { spy.mockRestore(); }
  });

  it('does not fetch the Container when markRunning updates zero rows for a cancelled job', async () => {
    const { d1 } = createTestDb();
    const calls: SessionCall[] = [];
    const binding = sessionBinding('JOB_FREE_CONTAINER', calls, body => sessionLines(body.positions, 'free'));
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: binding });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const original = JobStore.prototype.markRunning;
    const spy = vi.spyOn(JobStore.prototype, 'markRunning').mockImplementationOnce(async function(this: JobStore, id, at) {
      const cancelled = await handleV1Request(postJson(`/v1/jobs/${id}/cancel`, credential, {}), env);
      expect(cancelled.status).toBe(200);
      return original.call(this, id, at);
    });
    try {
      const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
      await handleJobBatch(batch, env);
      expect(messages[0].acked).toBe(true);
      expect(calls).toEqual([]);
      expect(binding.lateFetches).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('acks terminal deliveries at the stop deadline and handles a late terminateJob rejection', async () => {
    const { d1, sqlite } = createTestDb();
    let terminateEntered = false;
    let rejectTerminate!: (error: Error) => void;
    const env = makeJobsEnv({ d1, queue: queueProbe().queue, jobFree: {
      getByName: () => ({
        getState: async () => ({ status: 'healthy' }),
        terminateJob: async () => {
          terminateEntered = true;
          await new Promise<void>((_resolve, reject) => { rejectTerminate = reject; });
        },
        fetch: async () => { throw new Error('unexpected fetch'); },
      }),
    } });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    sqlite.prepare("UPDATE jobs SET status = 'failed' WHERE job_id = ?").run(jobId);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    const logs: Record<string, unknown>[] = [];
    vi.useFakeTimers();
    try {
      const delivery = handleJobBatch(batch, env, { log: (entry) => logs.push(entry) });
      await vi.advanceTimersByTimeAsync(7_000);
      await delivery;
      expect(terminateEntered).toBe(true);
      expect(messages[0].acked).toBe(true);
      expect(logs).toContainEqual(expect.objectContaining({
        event: 'job_container_stop_result', stopped: false, timedOut: true,
      }));
      rejectTerminate(new Error('late terminate failure'));
      await Promise.resolve();
      await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });

  it('delays standard retries by attempt and still exhausts into a failed job', async () => {
    const { env } = consumerEnv(() => new Response('driver unavailable', { status: 503 }));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const first = fakeBatch([{ v: 1, jobId }], 1);
    await handleJobBatch(first.batch, env);
    expect(first.messages[0].retried).toBe(true);
    expect(first.messages[0].retryOptions).toEqual({ delaySeconds: JOB_CONSUMER.retryDelaySeconds });
    const retriable = fakeBatch([{ v: 1, jobId }], JOB_CONSUMER.maxRetries);
    await handleJobBatch(retriable.batch, env);
    expect(retriable.messages[0].retried).toBe(true);
    expect(retriable.messages[0].retryOptions).toEqual({ delaySeconds: JOB_CONSUMER.retryDelaySeconds * JOB_CONSUMER.maxRetries });
    const exhausted = fakeBatch([{ v: 1, jobId }], JOB_CONSUMER.maxRetries + 1);
    await handleJobBatch(exhausted.batch, env);
    expect(exhausted.messages[0].acked).toBe(true);
    expect(exhausted.messages[0].retried).toBe(false);
    const job = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as {
      status: string; failure: { code: string };
    };
    expect(job.status).toBe('failed');
    expect(job.failure.code).toBe('retry_exhausted');
  });

  it('acks malformed messages and unknown jobs without a session', async () => {
    const { env, calls } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { batch, messages } = fakeBatch([
      { v: 0, jobId: 'job_deadbeefdeadbeefdeadb' } as unknown as JobQueueMessage,
      { v: 1, jobId: 'job_deadbeefdeadbeefdeadb' },
    ]);
    await handleJobBatch(batch, env);
    expect(messages.every((message) => message.acked)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
