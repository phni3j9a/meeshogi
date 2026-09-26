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
import { createTestDb, type SqliteD1 } from './testDb';

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const WORKER = 'https://worker.test';

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
  };
}

type SessionScript = (body: SessionCall['body']) => string | Response;

function sessionBinding(name: string, calls: SessionCall[], script: SessionScript) {
  return {
    getByName: (stubName: string) => ({
      fetch: async (request: Request) => {
        const body = await request.json() as SessionCall['body'];
        calls.push({ binding: name, name: stubName, path: new URL(request.url).pathname, body });
        const output = script(body);
        return typeof output === 'string'
          ? new Response(output, { headers: { 'content-type': 'application/x-ndjson' } })
          : output;
      },
    }),
  };
}

const NO_SESSION = {
  getByName: () => ({ fetch: async () => new Response('not configured', { status: 503 }) }),
};

function makeJobsEnv(options: {
  d1?: SqliteD1;
  queue?: { send: (message: JobQueueMessage) => Promise<void> };
  normal?: unknown;
  standard3?: unknown;
}): Env {
  return {
    ANALYSIS_CONTAINER: (options.normal ?? NO_SESSION) as Env['ANALYSIS_CONTAINER'],
    ANALYSIS_BENCHMARK_STANDARD_2: NO_SESSION as unknown as Env['ANALYSIS_BENCHMARK_STANDARD_2'],
    ANALYSIS_BENCHMARK_STANDARD_3: (options.standard3 ?? NO_SESSION) as Env['ANALYSIS_BENCHMARK_STANDARD_3'],
    JOBS_DB: options.d1 as unknown as D1Database | undefined,
    JOBS_QUEUE: options.queue as unknown as Queue<JobQueueMessage> | undefined,
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

async function createJob(env: Env, credential: string, body: Record<string, unknown>, deps: { now?: () => number } = {}): Promise<Response> {
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
  options: { stopAfter?: number; end?: 'complete' | 'deadline' | 'error'; omitEnd?: boolean } = {},
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
}

function fakeBatch(bodies: JobQueueMessage[], attempts = 1): { batch: MessageBatch<JobQueueMessage>; messages: FakeMessage[] } {
  const messages = bodies.map((body, index) => ({
    id: `message-${index}`,
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: false,
    ack(this: FakeMessage) { this.acked = true; },
    retry(this: FakeMessage) { this.retried = true; },
  })) as FakeMessage[];
  const batch = {
    queue: 'meeshogi-jobs-staging',
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
    const { d1 } = createTestDb();
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

describe('POST /v1/jobs validation and limits', () => {
  it('requires authentication', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1 });
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
    const env = makeJobsEnv({ d1, queue: probe.queue });
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
    const env = makeJobsEnv({ d1 });
    const { credential } = await issueCredential(env);
    const cases: [Record<string, unknown> | string, number][] = [
      [jobBody(['2g2f'], { moveTimeMs: 3000 }), 400],           // arbitrary engine setting
      [jobBody(['2g2f'], { multiPV: 8 }), 400],
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

  it('never exceeds the active-job limit under concurrent submissions', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
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

  it('returns not_found for other owners and isolates results', async () => {
    const { d1 } = createTestDb();
    const env = makeJobsEnv({ d1, queue: queueProbe().queue });
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
    env.JOBS_QUEUE = fixed.queue as unknown as Queue<JobQueueMessage>;
    const replay = await createJob(env, credential, body);
    expect(replay.status).toBe(200);
    const view = await replay.json() as { jobId: string };
    expect(fixed.sent).toEqual([{ v: 1, jobId: view.jobId }]);
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

describe('queue consumer', () => {
  function consumerEnv(script: SessionScript, profile: JobProfileId = 'free') {
    const { d1 } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', calls, script),
      standard3: sessionBinding('ANALYSIS_BENCHMARK_STANDARD_3', calls, script),
    });
    void profile;
    return { d1, env, calls, sent: probe.sent };
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
    // Free jobs share the normal singleton instance (same instance as /internal/analyze).
    expect(calls[0].name).toBe('analysis-mvp-singleton');
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
      expect(row.result.candidates).toHaveLength(2); // free multiPV
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
    const { env, calls, sent } = consumerEnv((body) => {
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
  });

  it('aborts the stream on its own budget and continues from the cursor', async () => {
    // The fake clock jumps past the 720 s budget while the driver stream is
    // still open: committed progress is kept, a continuation is sent before
    // the ack, and a later delivery resumes from the cursor.
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
          },
          pull() {
            // The consumer asked for more data: the clock now jumps past its
            // own budget deadline while this stream stays open forever.
            fakeNow += JOB_CONSUMER.budgetMs + 60_000;
          },
        }), { headers: { 'content-type': 'application/x-ndjson' } });
      }),
    });
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f', '8c8d', '2f2e']);
    const first = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(first.batch, env, { now: () => fakeNow });
    expect(first.messages[0].acked).toBe(true);
    expect(hangingCalls).toHaveLength(1);
    // The admission send plus the continuation send both precede the ack.
    expect(probe.sent).toEqual([{ v: 1, jobId }, { v: 1, jobId }]);
    const partial = await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as Record<string, unknown>;
    expect(partial.status).toBe('running');
    expect(partial.nextPly).toBe(1);
    // A later delivery on a completing driver finishes the job from the cursor.
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
    const { env, calls } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const first = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(first.batch, env);
    const second = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(second.batch, env);
    expect(second.messages[0].acked).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('acks a cancelled delivery without starting a session', async () => {
    const { env, calls } = consumerEnv((body) => sessionLines(body.positions, 'free'));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const cancel = await handleV1Request(new Request(`${WORKER}/v1/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
    }), env);
    expect(cancel.status).toBe(200);
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(calls).toHaveLength(0);
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

  it('routes precision jobs to the standard-3 binding with profile conditions', async () => {
    const { d1, sqlite } = createTestDb();
    const probe = queueProbe();
    const calls: SessionCall[] = [];
    const env = makeJobsEnv({
      d1,
      queue: probe.queue,
      normal: sessionBinding('ANALYSIS_CONTAINER', calls, (body) => sessionLines(body.positions, 'precision')),
      standard3: sessionBinding('ANALYSIS_BENCHMARK_STANDARD_3', calls, (body) => sessionLines(body.positions, 'precision')),
    });
    const { credential, ownerId } = await issueCredential(env);
    sqlite.prepare('UPDATE owners SET precision_allowed = 1 WHERE owner_id = ?').run(ownerId);
    const { jobId } = await createGame(env, credential, ['2g2f'], { profileId: 'precision' });
    const { batch, messages } = fakeBatch([{ v: 1, jobId }]);
    await handleJobBatch(batch, env);
    expect(messages[0].acked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].binding).toBe('ANALYSIS_BENCHMARK_STANDARD_3');
    expect(calls[0].name).toBe('analysis-jobs-standard-3');
    expect(calls[0].body.conditions).toEqual(JOB_PROFILES.precision.conditions);
  });

  it('retries transient session failures and exhausts into a failed job', async () => {
    const { env } = consumerEnv(() => new Response('driver unavailable', { status: 503 }));
    const { credential } = await issueCredential(env);
    const { jobId } = await createGame(env, credential, ['2g2f']);
    const first = fakeBatch([{ v: 1, jobId }], 1);
    await handleJobBatch(first.batch, env);
    expect(first.messages[0].retried).toBe(true);
    expect((await (await handleV1Request(get(`/v1/jobs/${jobId}`, credential), env)).json() as { status: string }).status).toBe('running');
    const exhausted = fakeBatch([{ v: 1, jobId }], JOB_CONSUMER.maxRetries + 1);
    await handleJobBatch(exhausted.batch, env);
    expect(exhausted.messages[0].acked).toBe(true);
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
