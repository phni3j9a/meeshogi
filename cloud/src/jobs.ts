/**
 * Public job API for Issue #21: server-issued anonymous credentials and
 * owner-scoped asynchronous game-analysis jobs on D1 + Queue.
 */
import { isValidSfen, legalMoves } from './contract';
import { json, readBody } from './httpUtil';
import { JOB_LIMITS, type JobProfileId } from './jobConfig';
import { D1RawDb, JobStore, type JobRow, type OwnerRow } from './jobStore';
import { Position } from 'tsshogi';
import type { Env, JobQueueMessage } from './index';

export const MAX_JOB_BODY_BYTES = 32 * 1024;
export const MAX_JOB_MOVES = 512;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const RESULTS_DEFAULT_LIMIT = 100;
export const RESULTS_MAX_LIMIT = 200;

export const CREDENTIAL_PREFIX = 'mcd1_';
const CREDENTIAL_RE = /^mcd1_[A-Za-z0-9_-]{43}$/u;
const JOB_ID_RE = /^job_[0-9a-f]{24}$/u;
const USI_MOVE_RE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/u;

export interface JobApiDeps {
  now?: () => number;
}

type JobFailureCode =
  | 'auth_unconfigured'
  | 'unauthorized'
  | 'invalid'
  | 'not_found'
  | 'idempotency_conflict'
  | 'profile_not_allowed'
  | 'daily_quota_exceeded'
  | 'rate_limited'
  | 'active_job_limit'
  | 'enqueue_failed'
  | 'unconfigured'
  | 'engine_error';

function jobFailure(code: JobFailureCode, message: string): Record<string, unknown> {
  return { schemaVersion: 1, status: 'failure', failure: { code, message } };
}

function invalid(message: string): Response {
  return json(jobFailure('invalid', message), 400);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomHex(bytes: number): string {
  return [...randomBytes(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomCredential(): string {
  const bytes = randomBytes(32);
  const base64 = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${CREDENTIAL_PREFIX}${base64}`;
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

/** Calendar day in the configured limit time zone, e.g. "2026-09-26". */
export function limitDay(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: JOB_LIMITS.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

async function authenticate(request: Request, store: JobStore): Promise<OwnerRow | Response> {
  const authorization = request.headers.get('authorization') ?? '';
  const credential = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!CREDENTIAL_RE.test(credential)) {
    return json(jobFailure('unauthorized', 'A valid anonymous credential is required.'), 401);
  }
  const owner = await store.ownerByCredentialHash(await sha256Hex(credential));
  if (!owner) return json(jobFailure('unauthorized', 'Unknown credential.'), 401);
  return owner;
}

function jobView(job: JobRow, counts: Record<string, number> = {}): Record<string, unknown> {
  return {
    jobId: job.job_id,
    status: job.status,
    profileId: job.profile_id,
    totalPlies: job.total_plies,
    nextPly: job.next_ply,
    analyzedPlies: job.next_ply,
    resultCounts: counts,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    ...(job.finished_at ? { finishedAt: job.finished_at } : {}),
    ...(job.status === 'failed' && job.failure_code
      ? { failure: { code: job.failure_code, message: job.failure_message } }
      : {}),
  };
}

type ValidatedPosition = { ply: number; sfen: string; terminal: 'checkmate' | 'no-legal-moves' | null };

function replayGame(initialSfen: string, moves: string[]): { positions?: ValidatedPosition[]; error?: string } {
  const start = Position.newBySFEN(initialSfen);
  if (!start) return { error: 'initialSfen is not a valid SFEN.' };
  const positions: ValidatedPosition[] = [];
  const record = (position: Position, ply: number): void => {
    const sfen = position.sfen;
    const terminal = legalMoves(sfen).length === 0
      ? (position.checked ? 'checkmate' : 'no-legal-moves')
      : null;
    positions.push({ ply, sfen, terminal });
  };
  record(start, 0);
  const position = start;
  for (const [index, usi] of moves.entries()) {
    if (!USI_MOVE_RE.test(usi)) return { error: `moves[${index}] is not a USI move.` };
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move)) {
      return { error: `moves[${index}] is not legal in the played position.` };
    }
    position.doMove(move);
    record(position, index + 1);
  }
  return { positions };
}

async function enqueue(env: Env, jobId: string): Promise<Response | null> {
  if (!env.JOBS_QUEUE) return json(jobFailure('unconfigured', 'Job queue is not configured.'), 503);
  const message: JobQueueMessage = { v: 1, jobId };
  try {
    await env.JOBS_QUEUE.send(message);
  } catch {
    return json(jobFailure('enqueue_failed', 'The job was persisted but could not be enqueued; resubmit with the same idempotency key.'), 503);
  }
  return null;
}

async function handleCreateCredential(request: Request, env: Env, now: () => number): Promise<Response> {
  if (request.method !== 'POST') return json(jobFailure('invalid', 'Method not allowed.'), 405);
  if (!env.JOBS_DB) return json(jobFailure('unconfigured', 'Job database is not configured.'), 503);
  const body = await readBody(request, MAX_JOB_BODY_BYTES);
  if (body === null) return json(jobFailure('invalid', 'Request body exceeds the size limit.'), 413);
  if (body.byteLength > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return invalid('Request body is not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return invalid('Expected an empty JSON object or an empty body.');
    }
  }
  const credential = randomCredential();
  const credentialHash = await sha256Hex(credential);
  const ownerId = `own_${credentialHash.slice(0, 24)}`;
  const store = new JobStore(new D1RawDb(env.JOBS_DB));
  try {
    await store.createOwner(ownerId, credentialHash, isoNow(now));
  } catch {
    return json(jobFailure('engine_error', 'Could not persist the credential.'), 500);
  }
  return json({ credential, ownerId, createdAt: isoNow(now) }, 201);
}

async function handleCreateJob(request: Request, env: Env, now: () => number): Promise<Response> {
  if (request.method !== 'POST') return json(jobFailure('invalid', 'Method not allowed.'), 405);
  if (!env.JOBS_DB) return json(jobFailure('unconfigured', 'Job database is not configured.'), 503);
  const store = new JobStore(new D1RawDb(env.JOBS_DB));
  const auth = await authenticate(request, store);
  if (auth instanceof Response) return auth;
  const owner = auth;

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json(jobFailure('invalid', 'Expected application/json.'), 415);
  }
  const body = await readBody(request, MAX_JOB_BODY_BYTES);
  if (body === null) return json(jobFailure('invalid', `Request body exceeds the ${MAX_JOB_BODY_BYTES} byte limit.`), 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return invalid('Request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('Expected a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 4
    || typeof record.idempotencyKey !== 'string'
    || record.idempotencyKey.length < 1 || record.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || !/^[A-Za-z0-9._:-]+$/u.test(record.idempotencyKey)
    || (record.profileId !== 'free' && record.profileId !== 'precision')
    || !isValidSfen(record.initialSfen)
    || !Array.isArray(record.moves) || record.moves.length > MAX_JOB_MOVES
    || record.moves.some((move) => typeof move !== 'string')) {
    return invalid('Expected exactly {idempotencyKey, profileId, initialSfen, moves}; profileId must be free or precision.');
  }
  const profileId = record.profileId as JobProfileId;
  if (profileId === 'precision' && owner.precision_allowed !== 1) {
    return json(jobFailure('profile_not_allowed', 'The precision profile requires a server-side allowlist entry.'), 403);
  }
  const moves = record.moves as string[];
  const replay = replayGame(record.initialSfen as string, moves);
  if (!replay.positions) return invalid(replay.error ?? 'Illegal game input.');
  const positions = replay.positions;

  // Hash the canonical replayed initial position, not the raw request string:
  // equivalent SFEN spellings and hand-piece order normalize to the same job.
  const canonicalInitialSfen = positions[0].sfen;
  const inputHash = await sha256Hex(JSON.stringify({
    initialSfen: canonicalInitialSfen,
    moves,
    profileId,
  }));
  const nowMs = now();
  const jobId = `job_${randomHex(12)}`;
  let admitted: 'inserted' | 'skipped';
  try {
    admitted = await store.admitJob({
      jobId,
      ownerId: owner.owner_id,
      idempotencyKey: record.idempotencyKey,
      inputHash,
      profileId,
      initialSfen: canonicalInitialSfen,
      movesJson: JSON.stringify(moves),
      totalPlies: positions.length,
      createdMs: nowMs,
      jstDay: limitDay(nowMs),
      isoNow: isoNow(now),
      positions,
      maxActiveJobs: JOB_LIMITS.maxActiveJobsPerOwner,
      freeDailyJobs: JOB_LIMITS.freeDailyJobs,
      freeRateMaxJobs: JOB_LIMITS.freeRateMaxJobs,
      freeRateWindowMs: JOB_LIMITS.freeRateWindowSeconds * 1000,
    });
  } catch {
    admitted = 'skipped';
  }
  if (admitted === 'inserted') {
    const enqueueFailure = await enqueue(env, jobId);
    if (enqueueFailure) return enqueueFailure;
    const created = await store.jobById(jobId);
    return json({ ...jobView(created!), idempotentReplay: false }, 201);
  }

  const existing = await store.jobByIdempotency(owner.owner_id, record.idempotencyKey);
  if (existing) {
    if (existing.input_hash !== inputHash) {
      return json(jobFailure('idempotency_conflict', 'The idempotency key was already used with a different input.'), 409);
    }
    if (existing.status === 'queued' || existing.status === 'running') {
      const enqueueFailure = await enqueue(env, existing.job_id);
      if (enqueueFailure) return enqueueFailure;
    }
    return json({ ...jobView(existing, await store.resultCounts(existing.job_id)), idempotentReplay: true }, 200);
  }

  const counts = await store.admissionCounts(
    owner.owner_id,
    limitDay(nowMs),
    nowMs - JOB_LIMITS.freeRateWindowSeconds * 1000,
  );
  if (counts.active >= JOB_LIMITS.maxActiveJobsPerOwner) {
    return json(jobFailure('active_job_limit', 'An active job already exists for this owner.'), 429);
  }
  if (profileId === 'free') {
    if (counts.freeToday >= JOB_LIMITS.freeDailyJobs) {
      return json(jobFailure('daily_quota_exceeded', 'The daily Free job quota is exhausted.'), 429);
    }
    if (counts.freeInWindow >= JOB_LIMITS.freeRateMaxJobs) {
      return json(jobFailure('rate_limited', 'Too many new jobs in the trailing window.'), 429);
    }
  }
  return json(jobFailure('engine_error', 'Job admission could not be completed.'), 503);
}

async function handleGetJob(request: Request, env: Env, jobId: string): Promise<Response> {
  if (request.method !== 'GET') return json(jobFailure('invalid', 'Method not allowed.'), 405);
  if (!env.JOBS_DB) return json(jobFailure('unconfigured', 'Job database is not configured.'), 503);
  const store = new JobStore(new D1RawDb(env.JOBS_DB));
  const auth = await authenticate(request, store);
  if (auth instanceof Response) return auth;
  const job = await store.jobForOwner(jobId, auth.owner_id);
  if (!job) return json(jobFailure('not_found', 'Job not found.'), 404);
  return json(jobView(job, await store.resultCounts(job.job_id)));
}

async function handleGetJobResults(request: Request, env: Env, jobId: string): Promise<Response> {
  if (request.method !== 'GET') return json(jobFailure('invalid', 'Method not allowed.'), 405);
  if (!env.JOBS_DB) return json(jobFailure('unconfigured', 'Job database is not configured.'), 503);
  const store = new JobStore(new D1RawDb(env.JOBS_DB));
  const auth = await authenticate(request, store);
  if (auth instanceof Response) return auth;
  const job = await store.jobForOwner(jobId, auth.owner_id);
  if (!job) return json(jobFailure('not_found', 'Job not found.'), 404);

  const params = new URL(request.url).searchParams;
  const afterPlyRaw = params.get('afterPly');
  const limitRaw = params.get('limit');
  const afterPly = afterPlyRaw === null ? -1 : Number(afterPlyRaw);
  const limit = limitRaw === null ? RESULTS_DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isSafeInteger(afterPly) || afterPly < -1 || afterPly > MAX_JOB_MOVES) {
    return invalid('afterPly must be an integer >= -1.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RESULTS_MAX_LIMIT) {
    return invalid(`limit must be an integer in [1, ${RESULTS_MAX_LIMIT}].`);
  }
  const rows = await store.resultsPage(jobId, afterPly, limit);
  const results = rows.map((row) => ({
    ply: row.ply,
    sfen: row.sfen,
    engineLaunch: row.engine_launch,
    result: JSON.parse(row.result_json) as unknown,
  }));
  const lastPly = results.length > 0 ? results[results.length - 1].ply : afterPly;
  return json({
    jobId: job.job_id,
    status: job.status,
    totalPlies: job.total_plies,
    nextPly: job.next_ply,
    analyzedPlies: job.next_ply,
    results,
    nextAfterPly: lastPly,
    hasMore: lastPly < job.next_ply - 1,
  });
}

async function handleCancelJob(request: Request, env: Env, jobId: string, now: () => number): Promise<Response> {
  if (request.method !== 'POST') return json(jobFailure('invalid', 'Method not allowed.'), 405);
  if (!env.JOBS_DB) return json(jobFailure('unconfigured', 'Job database is not configured.'), 503);
  const store = new JobStore(new D1RawDb(env.JOBS_DB));
  const auth = await authenticate(request, store);
  if (auth instanceof Response) return auth;
  const job = await store.jobForOwner(jobId, auth.owner_id);
  if (!job) return json(jobFailure('not_found', 'Job not found.'), 404);
  await store.cancelJob(jobId, auth.owner_id, isoNow(now));
  const current = await store.jobById(jobId);
  return json({ ...jobView(current!, await store.resultCounts(jobId)), cancelled: current!.status === 'cancelled' });
}

export async function handleV1Request(request: Request, env: Env, deps: JobApiDeps = {}): Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/v1/credentials') return handleCreateCredential(request, env, now);
  if (path === '/v1/jobs') return handleCreateJob(request, env, now);
  const jobMatch = /^\/v1\/jobs\/([^/]+)(\/results|\/cancel)?$/u.exec(path);
  if (!jobMatch || !JOB_ID_RE.test(jobMatch[1])) {
    return json(jobFailure('not_found', 'Not found.'), 404);
  }
  const [, jobId, sub] = jobMatch;
  if (sub === '/results') return handleGetJobResults(request, env, jobId);
  if (sub === '/cancel') return handleCancelJob(request, env, jobId, now);
  return handleGetJob(request, env, jobId);
}
