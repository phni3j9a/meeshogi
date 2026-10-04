/** Queue-independent runner for one durable job slice. */
import {
  EXPECTED_IDENTITY,
  hasExpectedIdentity,
  legalMoves,
  validateDriverResult,
  type AnalysisResult,
  type DriverFailure,
} from './contract';
import { JOB_PROFILES, type JobInstanceType, type JobProfile, type JobProfileId } from './jobConfig';
import { type JobRow, JobStore } from './jobStore';

const SESSION_CONTRACT = 'analysis-session-v1';
const SESSION_PATH = '/session';
const SESSION_CANCEL_PATH = '/session/cancel';
const SESSION_CANCEL_TIMEOUT_MS = 5000;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_SESSION_LINE_BYTES = 64 * 1024;
/** The driver rejects sessions above this position count; extra positions are processed by a later session in the same delivery. */
const MAX_SESSION_POSITIONS = 512;
const NO_CONTAINER_INSTANCE = 'there is no container instance that can be provided to this durable object';
const CAPACITY_RESPONSE_PREFIX_LIMIT = 1024;
export type JobRunOutcome =
  | { kind: 'resume' }
  | { kind: 'done' }
  | { kind: 'continue' }
  | { kind: 'retry' }
  | { kind: 'capacity'; message: string }
  | { kind: 'fail'; code: string; message: string };

const DONE: JobRunOutcome = { kind: 'done' };
const RESUME: JobRunOutcome = { kind: 'resume' };
const CONTINUE: JobRunOutcome = { kind: 'continue' };
const RETRY: JobRunOutcome = { kind: 'retry' };

export type JobRunnerLog = (entry: Record<string, unknown>) => void;

export interface JobRunnerDeps {
  store: JobStore;
  jobId: string;
  /** Container transport supplied by the owning Durable Object. */
  transport: (request: Request) => Promise<Response>;
  signal: AbortSignal;
  budgetMs: number;
  tailMarginMs: number;
  instanceType: JobInstanceType;
  now?: () => number;
  waitUntil?: (task: Promise<unknown>) => void;
  /** Bound for the best-effort /session/cancel fetch; overridable so tests stay fast. */
  sessionCancelTimeoutMs?: number;
  onTerminal?: () => void | Promise<void>;
  log?: JobRunnerLog;
}

function emit(deps: Pick<JobRunnerDeps, 'log'>, entry: Record<string, unknown>): void {
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

function isActive(job: JobRow | null): job is JobRow & { status: 'queued' | 'running' } {
  return job !== null && (job.status === 'queued' || job.status === 'running');
}

function isTerminal(job: JobRow): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
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
export function capacityWaitMessage(value: unknown): string | null {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const lower = message.toLowerCase();
  const sdkCapacityResponse = lower.includes('there is no container instance available at this time')
    && lower.includes('max concurrent instance count');
  return lower.includes(NO_CONTAINER_INSTANCE) || sdkCapacityResponse ? message.slice(0, 1024) : null;
}

type PostFailure = { kind: 'capacity'; message: string };

async function ownedContainerPost(
  transport: JobRunnerDeps['transport'],
  path: string,
  body: unknown,
  controller: AbortController,
  signal: AbortSignal,
  timeoutMs: number,
  waitUntil?: JobRunnerDeps['waitUntil'],
): Promise<Response | typeof SESSION_TIMEOUT | PostFailure | null> {
  let abandoned = false;
  try {
    const pending = transport(new Request(`http://analysis-container${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([controller.signal, signal]),
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
  } catch (error) {
    abandoned = true;
    controller.abort();
    const capacity = capacityWaitMessage(error);
    if (capacity) return { kind: 'capacity', message: capacity };
    return null;
  }
}

/**
 * Best-effort stop of a driver session that was left without its `end` line.
 * Never throws and never changes the delivery outcome: a missed cancel is
 * covered by the next /session superseding the orphaned one.
 */
async function cancelDriverSession(
  transport: JobRunnerDeps['transport'],
  sessionId: string,
  signal: AbortSignal,
  timeoutMs: number,
  waitUntil?: JobRunnerDeps['waitUntil'],
): Promise<void> {
  try {
    if (signal.aborted) return;
    const controller = new AbortController();
    const response = await ownedContainerPost(
      transport, SESSION_CANCEL_PATH, { sessionId }, controller, signal, timeoutMs, waitUntil,
    );
    if (response instanceof Response) await cancelBody(response);
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

export async function runSession(
  store: JobStore,
  transport: JobRunnerDeps['transport'],
  runSignal: AbortSignal,
  job: JobRow,
  profile: JobProfile,
  positions: { ply: number; sfen: string; legalMoveCount: number }[],
  sessionDeadline: number,
  now: () => number,
  deps: JobRunnerDeps,
): Promise<JobRunOutcome> {
  const waitUntil = deps.waitUntil;
  const cancelTimeoutMs = deps.sessionCancelTimeoutMs ?? SESSION_CANCEL_TIMEOUT_MS;
  const deadlineMs = sessionDeadline - now();
  const controller = new AbortController();
  emit(deps, {
    event: 'job_container_fetch_begin', jobId: job.job_id, profile: job.profile_id,
    path: SESSION_PATH, deadlineMs,
  });
  const started = await ownedContainerPost(
    transport,
    SESSION_PATH,
    {
      contract: SESSION_CONTRACT,
      profileId: job.profile_id,
      conditions: profile.conditions,
      positions,
      deadlineMs,
    },
    controller,
    runSignal,
    deadlineMs,
    waitUntil,
  );
  if (started === null || started === SESSION_TIMEOUT) return RETRY;
  if (typeof started === 'object' && 'kind' in started && started.kind === 'capacity') return started;
  if (!(started instanceof Response)) return RETRY;
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
    if (persisted && isTerminal(persisted)) {
      await deps.onTerminal?.();
      return DONE;
    }
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
        try { bodyPrefix = await readResponsePrefix(response, CAPACITY_RESPONSE_PREFIX_LIMIT); } catch { /* retry behavior is unchanged */ }
        controller.abort();
        emit(deps, {
          event: 'job_container_retry_response', jobId: job.job_id, profile: job.profile_id,
          status: response.status, bodyPrefix,
        });
        if (capacityWaitMessage(bodyPrefix)) return { kind: 'capacity', message: bodyPrefix.slice(0, 1024) };
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
        // transient engine fault retried from this ply by the DO's scheduled
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
        if (!isActive(fresh)) {
          await deps.onTerminal?.();
          return DONE;
        }
        return RETRY;
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
      if (!runSignal.aborted && (!persisted || !isTerminal(persisted))) {
        await cancelDriverSession(transport, sessionId, runSignal, cancelTimeoutMs, waitUntil);
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
  deps: JobRunnerDeps,
): Promise<JobRunOutcome> {
  const { store, jobId, signal } = deps;
  const now = deps.now ?? (() => Date.now());
  const budgetDeadline = now() + deps.budgetMs;
  for (;;) {
    if (signal.aborted) return DONE;
    if (budgetDeadline - now() <= 0) return CONTINUE;
    let job = await store.jobById(jobId);
    if (!isActive(job)) {
      if (job && isTerminal(job)) await deps.onTerminal?.();
      return DONE;
    }
    const profile = JOB_PROFILES[job.profile_id as JobProfileId];
    if (!profile) return { kind: 'fail', code: 'unknown_profile', message: `Unknown profile "${job.profile_id}".` };
    if (profile.instanceType !== deps.instanceType) {
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
      const fresh = await store.jobById(jobId);
      if (!isActive(fresh)) {
        await deps.onTerminal?.();
        return DONE;
      }
      job = fresh;
    }
    if (job.next_ply >= job.total_plies) {
      if (!await store.markCompleted(jobId, iso(now()))) {
        const fresh = await store.jobById(jobId);
        if (!isActive(fresh)) {
          await deps.onTerminal?.();
          return DONE;
        }
        return RETRY;
      }
      return DONE;
    }

    const remaining = await store.positionsFrom(jobId, job.next_ply);
    const positions: { ply: number; sfen: string; legalMoveCount: number }[] = [];
    for (const position of remaining) {
      if (position.terminal || positions.length >= MAX_SESSION_POSITIONS) break;
      positions.push({ ply: position.ply, sfen: position.sfen, legalMoveCount: Math.min(legalMoves(position.sfen).length, 600) });
    }
    if (positions.length === 0) return RETRY;
    const sessionDeadline = budgetDeadline - deps.tailMarginMs;
    if (sessionDeadline - now() <= 0) return RETRY;
    const markedRunning = await store.markRunning(jobId, iso(now()));
    if (!markedRunning) {
      // Cancellation may have committed between the active read and this
      // guarded UPDATE. Never open a session until the persisted row is fresh.
      const fresh = await store.jobById(jobId);
      if (!isActive(fresh)) {
        await deps.onTerminal?.();
        return DONE;
      }
      if (fresh.status !== 'running') return RETRY;
      if (fresh.next_ply !== job.next_ply) continue;
      job = fresh;
    }

    emit(deps, { event: 'job_runner_session_begin', jobId, profile: job.profile_id, cursor: job.next_ply });
    const outcome = await runSession(store, deps.transport, signal, job, profile, positions, sessionDeadline, now, deps);
    emit(deps, {
      event: 'job_runner_session_end', jobId, profile: job.profile_id,
      cursor: (await store.jobById(jobId))?.next_ply ?? null, outcome: outcome.kind,
    });
    if (outcome.kind !== 'resume') return outcome;
  }
}


export const runJobSlice = driveJob;
