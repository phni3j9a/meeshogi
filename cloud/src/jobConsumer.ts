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
import {
  EXPECTED_IDENTITY,
  hasExpectedIdentity,
  legalMoves,
  validateDriverResult,
  type AnalysisResult,
  type DriverFailure,
} from './contract';
import { JOB_CONSUMER, JOB_PROFILES, type JobProfile, type JobProfileId } from './jobConfig';
import { D1RawDb, JobStore, type JobRow } from './jobStore';
import type { Env, JobQueueMessage } from './index';
import {
  getJobContainer,
  stopJobContainer,
  validateJobContainerProfile,
  type JobContainer,
  type JobContainerLog,
} from './jobContainers';

const SESSION_CONTRACT = 'analysis-session-v1';
const SESSION_PATH = '/session';
const SESSION_CANCEL_PATH = '/session/cancel';
const SESSION_CANCEL_TIMEOUT_MS = 5000;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_SESSION_LINE_BYTES = 64 * 1024;
/** The driver rejects sessions above this position count; extra positions are processed by a later session in the same delivery. */
const MAX_SESSION_POSITIONS = 512;
type RoutedContainer = JobContainer;

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
  log?: JobContainerLog;
}

function emit(deps: JobConsumerDeps, entry: Record<string, unknown>): void {
  const log = deps.log ?? ((value) => console.log(JSON.stringify(value)));
  try {
    log(entry);
  } catch {
    // Diagnostic output never changes message handling.
  }
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

async function readResponsePrefix(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  const deadline = Date.now() + 250;
  try {
    while (bytesRead < maxBytes) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const next = await beforeDeadline(reader.read(), remainingMs);
      if (next === SESSION_TIMEOUT) break;
      if (next.done) break;
      const remaining = maxBytes - bytesRead;
      const chunk = next.value.subarray(0, remaining);
      chunks.push(chunk);
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* disconnected transport */ }
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
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
  const container = getJobContainer(env, job.job_id, job.profile_id as JobProfileId);
  const deadlineMs = sessionDeadline - now();
  const controller = new AbortController();
  emit(deps, {
    event: 'job_container_fetch_begin', jobId: job.job_id, profile: job.profile_id,
    path: SESSION_PATH, deadlineMs,
  });
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
  if (response.status === 410) {
    controller.abort();
    await cancelBody(response);
    let persisted: JobRow | null;
    try {
      persisted = await store.jobById(job.job_id);
    } catch {
      // A transient D1 read failure keeps the original delivery eligible for retry.
      return RETRY;
    }
    if (persisted && isTerminal(persisted)) return DONE;
    return {
      kind: 'fail',
      code: 'contract_violation',
      message: 'The job Container rejected an active job as already terminated.',
    };
  }
  if (!response.ok) {
    if (response.status === 409 || response.status === 503 || response.status === 429 || response.status >= 500) {
      if (response.status === 503) {
        let bodyPrefix = '';
        try { bodyPrefix = await readResponsePrefix(response, 1024); } catch { /* retry behavior is unchanged */ }
        controller.abort();
        emit(deps, {
          event: 'job_container_retry_response', jobId: job.job_id, profile: job.profile_id,
          status: response.status, bodyPrefix,
        });
      } else {
        controller.abort();
        await cancelBody(response);
      }
      return RETRY;
    }
    controller.abort();
    await cancelBody(response);
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
        emit(deps, { event: 'job_session_header_received', jobId: job.job_id, profile: job.profile_id });
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
      if (progress === 1) {
        emit(deps, { event: 'job_first_result_committed', jobId: job.job_id, profile: job.profile_id, ply: expected.ply });
      }
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
      let persisted: JobRow | null = null;
      try {
        persisted = await store.jobById(job.job_id);
      } catch {
        // If D1 is unavailable, preserve the existing best-effort cleanup.
      }
      if (!persisted || !isTerminal(persisted)) {
        await cancelDriverSession(container, sessionId, cancelTimeoutMs, waitUntil);
      }
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
    try {
      validateJobContainerProfile(job.profile_id as JobProfileId);
    } catch {
      return { kind: 'fail', code: 'container_configuration', message: 'The job Container class does not match its profile instance type.' };
    }

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
    const markedRunning = await store.markRunning(jobId, iso(now()));
    if (!markedRunning) {
      // Cancellation may have committed between the active read and this
      // guarded UPDATE. Never open a session until the persisted row is fresh.
      const fresh = await store.jobById(jobId);
      if (!isActive(fresh)) return DONE;
      if (fresh.status !== 'running') return RETRY;
      if (fresh.next_ply !== job.next_ply) continue;
      job = fresh;
    }

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

/** Backoff lets a transient delivery settle while its job-specific Container stays warm. */
function retryMessage(message: Message<JobQueueMessage>): void {
  message.retry({ delaySeconds: JOB_CONSUMER.retryDelaySeconds * message.attempts });
}

function isJobProfileId(value: string): value is JobProfileId {
  return value === 'free' || value === 'precision';
}

function isTerminal(job: JobRow): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

async function stopTerminalRow(env: Env, job: JobRow | null, deps: JobConsumerDeps): Promise<void> {
  if (!job || !isTerminal(job) || !isJobProfileId(job.profile_id)) return;
  await stopJobContainer(env, job.job_id, job.profile_id, (entry) => emit(deps, entry));
}

async function stopPersistedTerminal(env: Env, store: JobStore, jobId: string, deps: JobConsumerDeps): Promise<void> {
  try {
    await stopTerminalRow(env, await store.jobById(jobId), deps);
  } catch {
    // State confirmation is best-effort and must not change ack/retry behavior.
  }
}

async function retryOrFinish(
  env: Env,
  store: JobStore,
  message: Message<JobQueueMessage>,
  jobId: string,
  now: () => number,
  deps: JobConsumerDeps,
): Promise<void> {
  // Cloudflare attempts start at 1: maxRetries standard retries mean the
  // delivery with attempts === maxRetries is still a retry and only
  // attempts === maxRetries + 1 is the final one.
  if (message.attempts > JOB_CONSUMER.maxRetries) {
    if (await persistFailed(store, jobId, 'retry_exhausted', 'The delivery reached the configured retry limit.', now)) {
      await stopPersistedTerminal(env, store, jobId, deps);
      message.ack();
    }
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
      await retryOrFinish(env, store, message, jobId, now, deps);
      continue;
    }
    if (!isActive(job)) {
      await stopTerminalRow(env, job, deps);
      message.ack();
      continue;
    }

    emit(deps, {
      event: 'job_delivery_begin', jobId, profile: job.profile_id,
      queue: batch.queue, attempt: message.attempts,
    });
    if (isJobProfileId(job.profile_id) && batch.queue !== JOB_PROFILES[job.profile_id].queueName) {
      const saved = await persistFailed(
        store, jobId, 'queue_profile_mismatch',
        `The delivery queue does not match persisted profile "${job.profile_id}".`, now,
      );
      if (saved) {
        await stopPersistedTerminal(env, store, jobId, deps);
        message.ack();
      } else {
        retryMessage(message);
      }
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
    // A cancellation can race a Container teardown and surface as a transport
    // retry. Re-read D1 before handling the outcome so a terminal job is acked
    // and stopped instead of being re-enqueued as a transient failure.
    try {
      const persisted = await store.jobById(jobId);
      if (persisted && !isActive(persisted)) {
        await stopTerminalRow(env, persisted, deps);
        message.ack();
        continue;
      }
    } catch {
      // Preserve the outcome when this diagnostic state read is unavailable.
    }
    switch (outcome.kind) {
      case 'done':
        await stopPersistedTerminal(env, store, jobId, deps);
        message.ack();
        break;
      case 'continue': {
        const profileId = isJobProfileId(job.profile_id) ? job.profile_id : null;
        const queue = profileId === 'free' ? env.JOBS_FREE_QUEUE
          : profileId === 'precision' ? env.JOBS_PRECISION_QUEUE : undefined;
        if (!queue || !profileId) {
          await retryOrFinish(env, store, message, jobId, now, deps);
          break;
        }
        try {
          await queue.send({ v: 1, jobId });
          message.ack();
        } catch {
          await retryOrFinish(env, store, message, jobId, now, deps);
        }
        break;
      }
      case 'retry':
        await retryOrFinish(env, store, message, jobId, now, deps);
        break;
      case 'fail':
        if (await persistFailed(store, jobId, outcome.code, outcome.message, now)) {
          await stopPersistedTerminal(env, store, jobId, deps);
          message.ack();
        }
        else retryMessage(message);
        break;
    }
  }
}
