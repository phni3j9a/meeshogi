/**
 * Queue consumer for Issue #21 jobs.
 *
 * One delivery resumes a job from the persisted cursor: it commits local
 * terminal positions, then calls the driver `POST /session` endpoint and
 * streams per-position results, committing each line inside a guarded D1
 * batch. When the session ends before all plies are analyzed (deadline or a
 * recoverable error) a continuation message is durably sent before the
 * current message is acked. Transient failures use the standard Queue retry;
 * contract violations and retry exhaustion mark the job failed.
 */
import { getContainer } from '@cloudflare/containers';
import {
  EXPECTED_IDENTITY,
  SINGLETON_TARGET_ID,
  hasExpectedIdentity,
  legalMoves,
  validateDriverResult,
  type AnalysisResult,
  type DriverFailure,
} from './contract';
import { JOB_CONSUMER, JOB_PROFILES, type JobProfile, type JobProfileId } from './jobConfig';
import { D1RawDb, JobStore, type JobRow } from './jobStore';
import type { AnalysisContainer, BenchmarkStandard3Container, Env, JobQueueMessage } from './index';

const SESSION_CONTRACT = 'analysis-session-v1';
const SESSION_PATH = '/session';
const SESSION_CANCEL_PATH = '/session/cancel';
const SESSION_CANCEL_TIMEOUT_MS = 5000;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_SESSION_LINE_BYTES = 64 * 1024;
/** The driver rejects sessions above this position count; extra positions are processed by a later session in the same delivery. */
const MAX_SESSION_POSITIONS = 512;
const JOB_CONTAINER_NAMES: Record<JobProfile['instanceType'], string> = {
  // Free jobs share the normal singleton instance so the max_instances=1 app
  // cannot fail to start while it is alive; contention surfaces as the
  // driver's single-request busy guard and takes the transient retry path.
  'standard-2': SINGLETON_TARGET_ID,
  'standard-3': 'analysis-jobs-standard-3',
};

type RoutedContainer =
  | ReturnType<typeof getContainer<AnalysisContainer>>
  | ReturnType<typeof getContainer<BenchmarkStandard3Container>>;

type Outcome =
  | { kind: 'resume' }
  | { kind: 'done' }
  | { kind: 'continue' }
  | { kind: 'retry' }
  | { kind: 'fail'; code: string; message: string };

const DONE: Outcome = { kind: 'done' };
const RESUME: Outcome = { kind: 'resume' };
const CONTINUE: Outcome = { kind: 'continue' };
const RETRY: Outcome = { kind: 'retry' };

export interface JobConsumerDeps {
  now?: () => number;
  waitUntil?: (task: Promise<unknown>) => void;
  /** Bound for the best-effort /session/cancel fetch; overridable so tests stay fast. */
  sessionCancelTimeoutMs?: number;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function isActive(job: JobRow | null): job is JobRow {
  return job !== null && (job.status === 'queued' || job.status === 'running');
}

const SESSION_TIMEOUT = Symbol('session timeout');

async function beforeDeadline<T>(pending: Promise<T>, ms: number): Promise<T | typeof SESSION_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof SESSION_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(SESSION_TIMEOUT), Math.max(ms, 1));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A disconnected transport may already have errored the body.
  }
}

/**
 * Container POST whose response always has an owner (Issue #30 rules): the
 * request carries the caller's AbortController signal, a response that arrives
 * after the consumer stopped waiting gets its body cancelled, and the pending
 * fetch is tied to waitUntil so it can still settle. Returns the Response,
 * SESSION_TIMEOUT when the deadline elapsed first, or null when the fetch
 * rejected.
 */
async function ownedContainerPost(
  container: RoutedContainer,
  path: string,
  body: unknown,
  controller: AbortController,
  timeoutMs: number,
  waitUntil?: JobConsumerDeps['waitUntil'],
): Promise<Response | typeof SESSION_TIMEOUT | null> {
  let abandoned = false;
  try {
    const pending = container.fetch(new Request(`http://analysis-container${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    })).then(async (lateResponse) => {
      if (abandoned) await cancelBody(lateResponse);
      return lateResponse;
    });
    waitUntil?.(pending.then(() => undefined, () => undefined));
    const response = await beforeDeadline(pending, timeoutMs);
    if (response === SESSION_TIMEOUT) {
      abandoned = true;
      controller.abort();
      return SESSION_TIMEOUT;
    }
    return response;
  } catch {
    abandoned = true;
    controller.abort();
    return null;
  }
}

/**
 * Best-effort stop of a driver session that was left without its `end` line.
 * Never throws and never changes the delivery outcome: a missed cancel is
 * covered by the next /session superseding the orphaned one.
 */
async function cancelDriverSession(
  container: RoutedContainer,
  sessionId: string,
  timeoutMs: number,
  waitUntil?: JobConsumerDeps['waitUntil'],
): Promise<void> {
  try {
    const controller = new AbortController();
    const response = await ownedContainerPost(
      container, SESSION_CANCEL_PATH, { sessionId }, controller, timeoutMs, waitUntil,
    );
    if (response !== null && response !== SESSION_TIMEOUT) await cancelBody(response);
  } catch {
    // Best-effort cleanup never fails the delivery.
  }
}

function terminalResult(sfen: string, terminal: 'checkmate' | 'no-legal-moves', profile: JobProfile): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'terminal',
    terminal,
    candidates: [],
    meta: { nodes: null, completedDepth: null, elapsedMs: null },
    conditions: { requested: profile.conditions, actual: null },
    identity: EXPECTED_IDENTITY,
  };
}

function sessionContainer(env: Env, profile: JobProfile): RoutedContainer {
  if (profile.instanceType === 'standard-3') {
    return getContainer<BenchmarkStandard3Container>(env.ANALYSIS_BENCHMARK_STANDARD_3, JOB_CONTAINER_NAMES['standard-3']);
  }
  return getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, JOB_CONTAINER_NAMES['standard-2']);
}

/** Returns the driver's session id (absent on old images), or null when the header violates the contract. */
function parseSessionHeader(value: unknown, job: JobRow, profile: JobProfile): { sessionId: string | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  if (line.type !== 'session' || line.contract !== SESSION_CONTRACT || line.profileId !== job.profile_id) return null;
  if (!Number.isSafeInteger(line.engineLaunch) || (line.engineLaunch as number) < 1) return null;
  if (typeof line.driverBootId !== 'string' || !/^[0-9a-f]{32}$/u.test(line.driverBootId)) return null;
  if (!hasExpectedIdentity(line.identity)) return null;
  const conditions = line.conditions;
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) return null;
  const record = conditions as Record<string, unknown>;
  if (!Object.entries(profile.conditions).every(([key, expected]) => record[key] === expected)) return null;
  const sessionId = line.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId))) return null;
  return { sessionId: sessionId ?? null };
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The driver may already have closed the stream.
  }
}

async function runSession(
  env: Env,
  store: JobStore,
  job: JobRow,
  profile: JobProfile,
  positions: { ply: number; sfen: string; legalMoveCount: number }[],
  sessionDeadline: number,
  now: () => number,
  deps: JobConsumerDeps = {},
): Promise<Outcome> {
  const waitUntil = deps.waitUntil;
  const cancelTimeoutMs = deps.sessionCancelTimeoutMs ?? SESSION_CANCEL_TIMEOUT_MS;
  const container = sessionContainer(env, profile);
  const deadlineMs = sessionDeadline - now();
  const controller = new AbortController();
  const started = await ownedContainerPost(
    container,
    SESSION_PATH,
    {
      contract: SESSION_CONTRACT,
      profileId: job.profile_id,
      conditions: profile.conditions,
      positions,
      deadlineMs,
    },
    controller,
    deadlineMs,
    waitUntil,
  );
  if (started === null || started === SESSION_TIMEOUT) return RETRY;
  const response = started;
  if (!response.ok) {
    controller.abort();
    await cancelBody(response);
    if (response.status === 409 || response.status === 503 || response.status === 429 || response.status >= 500) {
      return RETRY;
    }
    if (response.status >= 400 && response.status < 500) {
      return { kind: 'fail', code: 'driver_rejected', message: `Driver rejected the session request (HTTP ${response.status}).` };
    }
    return RETRY;
  }
  if (!response.body) {
    controller.abort();
    return RETRY;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let headerSeen = false;
  let sessionId: string | null = null;
  let received = 0;
  let progress = 0;
  let endReason: string | null = null;
  const readStep = async (): Promise<'eof' | 'timeout' | { line: string }> => {
    while (true) {
      // The consumer deadline bounds buffered-line processing too, not just
      // stream reads: a large chunk of ready results must not outrun the budget.
      const remaining = sessionDeadline - now();
      if (remaining <= 0) return 'timeout';
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return { line };
      }
      const chunk = await beforeDeadline(reader.read(), remaining);
      if (chunk === SESSION_TIMEOUT) return 'timeout';
      if (chunk.done) {
        if (buffer.trim().length > 0) {
          const line = buffer;
          buffer = '';
          return { line };
        }
        return 'eof';
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_SESSION_LINE_BYTES) {
        throw new Error('session line exceeds the byte limit');
      }
    }
  };

  try {
    while (true) {
      const step = await readStep();
      if (step === 'timeout') {
        return progress > 0 ? CONTINUE : RETRY;
      }
      if (step === 'eof') break;
      const raw = step.line.trim();
      if (!raw) continue;
      if (raw.length > MAX_SESSION_LINE_BYTES) {
        return { kind: 'fail', code: 'contract_violation', message: 'Session line exceeds the byte limit.' };
      }
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        return { kind: 'fail', code: 'contract_violation', message: 'Session line is not valid JSON.' };
      }
      if (!headerSeen) {
        const header = parseSessionHeader(line, job, profile);
        if (!header) {
          return { kind: 'fail', code: 'contract_violation', message: 'Invalid session header.' };
        }
        headerSeen = true;
        sessionId = header.sessionId;
        continue;
      }
      const record = line as Record<string, unknown>;
      if (record?.type === 'end') {
        endReason = typeof record.reason === 'string' ? record.reason : null;
        if (endReason !== 'complete' && endReason !== 'deadline' && endReason !== 'error') {
          return { kind: 'fail', code: 'contract_violation', message: 'Invalid session end reason.' };
        }
        break;
      }
      if (record?.type !== 'result') {
        return { kind: 'fail', code: 'contract_violation', message: 'Unexpected session line type.' };
      }
      const expected = positions[received];
      const engineLaunch = record.engineLaunch;
      if (!expected || record.ply !== expected.ply
        || !Number.isSafeInteger(engineLaunch) || (engineLaunch as number) < 1) {
        return { kind: 'fail', code: 'contract_violation', message: 'Session result ply is out of order.' };
      }
      const validated = validateDriverResult(record.result, expected.sfen, legalMoves(expected.sfen), profile.conditions);
      if (!validated) {
        return { kind: 'fail', code: 'contract_violation', message: 'Session result failed contract validation.' };
      }
      if ((validated as DriverFailure).status === 'failure') {
        // Driver execution failures never advance the cursor: a worker-validated
        // position rejected as invalid, or an identity mismatch reported by the
        // driver, is a permanent contract break; every other failure code is a
        // transient engine fault retried from this ply by the standard Queue
        // retry. The failed ply itself is never committed.
        const code = String((validated as DriverFailure).failure?.code ?? 'unknown');
        if (code === 'invalid' || code === 'identity_mismatch') {
          return {
            kind: 'fail',
            code: 'contract_violation',
            message: `Driver reported a permanent failure for ply ${expected.ply}: ${code}.`,
          };
        }
        return RETRY;
      }
      if (sessionDeadline - now() <= 0) {
        return progress > 0 ? CONTINUE : RETRY;
      }
      const committed = await store.commitResult(
        job.job_id,
        expected.ply,
        expected.sfen,
        (validated as AnalysisResult | DriverFailure).status,
        engineLaunch as number,
        JSON.stringify(validated),
        iso(now()),
      );
      if (!committed) {
        // A cancelled job commits nothing; a cursor mismatch is transient.
        const fresh = await store.jobById(job.job_id);
        return isActive(fresh) ? RETRY : DONE;
      }
      progress += 1;
      received += 1;
    }
  } catch {
    return RETRY;
  } finally {
    // Includes protocol end before HTTP EOF, cancellation, invalid data and
    // persistence failures. Abort the transport too: cancelling the returned
    // IdentityTransformStream alone need not unblock its pending upstream read.
    controller.abort();
    await cancelReader(reader);
    reader.releaseLock();
    // Leaving without the driver's `end` line orphans the session: the driver
    // keeps its busy guard until something stops it (Issue #29). Ask it to
    // stop our session so the next job does not burn its retries on 409 busy.
    if (sessionId !== null && endReason === null) {
      await cancelDriverSession(container, sessionId, cancelTimeoutMs, waitUntil);
    }
  }

  if (endReason === 'complete' && received === positions.length) return RESUME;
  // A driver-side error end takes the same transient path as a failure line;
  // a deadline end is a clean boundary and continues with a fresh message.
  if (endReason === 'error') return RETRY;
  return progress > 0 ? CONTINUE : RETRY;
}

async function driveJob(
  env: Env,
  store: JobStore,
  jobId: string,
  budgetDeadline: number,
  now: () => number,
  deps: JobConsumerDeps,
): Promise<Outcome> {
  for (;;) {
    if (budgetDeadline - now() <= 0) return CONTINUE;
    let job = await store.jobById(jobId);
    if (!isActive(job)) return DONE;
    const profile = JOB_PROFILES[job.profile_id as JobProfileId];
    if (!profile) return { kind: 'fail', code: 'unknown_profile', message: `Unknown profile "${job.profile_id}".` };

    // Commit locally-determined terminal positions (only reachable at the end
    // of a validated game) without involving the engine.
    while (job.next_ply < job.total_plies) {
      const position = await store.positionAt(jobId, job.next_ply);
      if (!position) return { kind: 'fail', code: 'missing_position', message: 'Persisted position row is missing.' };
      if (!position.terminal) break;
      const committed = await store.commitResult(
        jobId,
        position.ply,
        position.sfen,
        'terminal',
        null,
        JSON.stringify(terminalResult(position.sfen, position.terminal, profile)),
        iso(now()),
      );
      if (!committed) {
        const fresh = await store.jobById(jobId);
        return isActive(fresh) ? RETRY : DONE;
      }
      job = (await store.jobById(jobId))!;
      if (!isActive(job)) return DONE;
    }
    if (job.next_ply >= job.total_plies) {
      await store.markCompleted(jobId, iso(now()));
      return DONE;
    }

    const remaining = await store.positionsFrom(jobId, job.next_ply);
    const positions: { ply: number; sfen: string; legalMoveCount: number }[] = [];
    for (const position of remaining) {
      if (position.terminal || positions.length >= MAX_SESSION_POSITIONS) break;
      positions.push({ ply: position.ply, sfen: position.sfen, legalMoveCount: Math.min(legalMoves(position.sfen).length, 600) });
    }
    if (positions.length === 0) return RETRY;
    const sessionDeadline = budgetDeadline - JOB_CONSUMER.tailMarginMs;
    if (sessionDeadline - now() <= 0) return RETRY;
    await store.markRunning(jobId, iso(now()));

    const outcome = await runSession(env, store, job, profile, positions, sessionDeadline, now, deps);
    if (outcome.kind !== 'resume') return outcome;
  }
}

/** Returns true when the failed state was persisted. A false return keeps the delivery eligible for the standard retry/DLQ instead of an ack that would lose it. */
async function persistFailed(store: JobStore, jobId: string, code: string, message: string, now: () => number): Promise<boolean> {
  try {
    await store.markFailed(jobId, code, message, iso(now()));
    return true;
  } catch {
    return false;
  }
}

/** Backoff between redeliveries (Issue #29): a wedged driver session needs time to release the container's busy guard before the next delivery arrives. */
function retryMessage(message: Message<JobQueueMessage>): void {
  message.retry({ delaySeconds: JOB_CONSUMER.retryDelaySeconds * message.attempts });
}

async function retryOrFinish(
  store: JobStore,
  message: Message<JobQueueMessage>,
  jobId: string,
  now: () => number,
): Promise<void> {
  // Cloudflare attempts start at 1: maxRetries standard retries mean the
  // delivery with attempts === maxRetries is still a retry and only
  // attempts === maxRetries + 1 is the final one.
  if (message.attempts > JOB_CONSUMER.maxRetries) {
    if (await persistFailed(store, jobId, 'retry_exhausted', 'The delivery reached the configured retry limit.', now)) message.ack();
    else retryMessage(message);
    return;
  }
  retryMessage(message);
}

export async function handleJobBatch(
  batch: MessageBatch<JobQueueMessage>,
  env: Env,
  deps: JobConsumerDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  for (const message of batch.messages) {
    const body = message.body;
    const jobId = typeof body?.jobId === 'string' ? body.jobId : null;
    if (body?.v !== 1 || !jobId) {
      message.ack();
      continue;
    }
    if (!env.JOBS_DB) {
      // Nothing can be persisted, so the delivery is never confirmed: let the
      // standard retry exhaust into the dead-letter queue instead of acking.
      retryMessage(message);
      continue;
    }
    const store = new JobStore(new D1RawDb(env.JOBS_DB));
    let job: JobRow | null;
    try {
      job = await store.jobById(jobId);
    } catch {
      // A transient read failure must not lose the delivery.
      await retryOrFinish(store, message, jobId, now);
      continue;
    }
    if (!isActive(job)) {
      message.ack();
      continue;
    }

    const budgetDeadline = now() + JOB_CONSUMER.budgetMs;
    let outcome: Outcome;
    try {
      outcome = await driveJob(env, store, jobId, budgetDeadline, now, deps);
    } catch {
      outcome = RETRY;
    }

    if (outcome.kind === 'resume') outcome = DONE;
    switch (outcome.kind) {
      case 'done':
        message.ack();
        break;
      case 'continue': {
        if (!env.JOBS_QUEUE) {
          await retryOrFinish(store, message, jobId, now);
          break;
        }
        try {
          await env.JOBS_QUEUE.send({ v: 1, jobId });
          message.ack();
        } catch {
          await retryOrFinish(store, message, jobId, now);
        }
        break;
      }
      case 'retry':
        await retryOrFinish(store, message, jobId, now);
        break;
      case 'fail':
        if (await persistFailed(store, jobId, outcome.code, outcome.message, now)) message.ack();
        else retryMessage(message);
        break;
    }
  }
}
