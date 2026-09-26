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
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function isActive(job: JobRow | null): job is JobRow {
  return job !== null && (job.status === 'queued' || job.status === 'running');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isSessionHeader(value: unknown, job: JobRow, profile: JobProfile): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  if (line.type !== 'session' || line.contract !== SESSION_CONTRACT || line.profileId !== job.profile_id) return false;
  if (!Number.isSafeInteger(line.engineLaunch) || (line.engineLaunch as number) < 1) return false;
  if (typeof line.driverBootId !== 'string' || !/^[0-9a-f]{32}$/u.test(line.driverBootId)) return false;
  if (!hasExpectedIdentity(line.identity)) return false;
  const conditions = line.conditions;
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) return false;
  const record = conditions as Record<string, unknown>;
  return Object.entries(profile.conditions).every(([key, expected]) => record[key] === expected);
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
): Promise<Outcome> {
  const container = sessionContainer(env, profile);
  const deadlineMs = sessionDeadline - now();
  let response: Response;
  try {
    response = await Promise.race([
      container.fetch(new Request(`http://analysis-container${SESSION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contract: SESSION_CONTRACT,
          profileId: job.profile_id,
          conditions: profile.conditions,
          positions,
          deadlineMs,
        }),
      })),
      sleep(Math.max(deadlineMs, 1)).then((): never => {
        throw new Error('session start deadline');
      }),
    ]);
  } catch {
    return RETRY;
  }
  if (!response.ok) {
    await response.text().catch(() => '');
    if (response.status === 409 || response.status === 503 || response.status === 429 || response.status >= 500) {
      return RETRY;
    }
    if (response.status >= 400 && response.status < 500) {
      return { kind: 'fail', code: 'driver_rejected', message: `Driver rejected the session request (HTTP ${response.status}).` };
    }
    return RETRY;
  }
  if (!response.body) return RETRY;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let headerSeen = false;
  let received = 0;
  let progress = 0;
  let endReason: string | null = null;
  const abort = async (outcome: Outcome): Promise<Outcome> => {
    await cancelReader(reader);
    return outcome;
  };
  const readStep = async (): Promise<'eof' | 'timeout' | { line: string }> => {
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return { line };
      }
      const remaining = sessionDeadline - now();
      if (remaining <= 0) return 'timeout';
      const chunk = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => 'timeout' as const),
      ]);
      if (chunk === 'timeout') return 'timeout';
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
        return await abort(progress > 0 ? CONTINUE : RETRY);
      }
      if (step === 'eof') break;
      const raw = step.line.trim();
      if (!raw) continue;
      if (raw.length > MAX_SESSION_LINE_BYTES) {
        return await abort({ kind: 'fail', code: 'contract_violation', message: 'Session line exceeds the byte limit.' });
      }
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        return await abort({ kind: 'fail', code: 'contract_violation', message: 'Session line is not valid JSON.' });
      }
      if (!headerSeen) {
        if (!isSessionHeader(line, job, profile)) {
          return await abort({ kind: 'fail', code: 'contract_violation', message: 'Invalid session header.' });
        }
        headerSeen = true;
        continue;
      }
      const record = line as Record<string, unknown>;
      if (record?.type === 'end') {
        endReason = typeof record.reason === 'string' ? record.reason : null;
        if (endReason !== 'complete' && endReason !== 'deadline' && endReason !== 'error') {
          return await abort({ kind: 'fail', code: 'contract_violation', message: 'Invalid session end reason.' });
        }
        break;
      }
      if (record?.type !== 'result') {
        return await abort({ kind: 'fail', code: 'contract_violation', message: 'Unexpected session line type.' });
      }
      const expected = positions[received];
      const engineLaunch = record.engineLaunch;
      if (!expected || record.ply !== expected.ply
        || !Number.isSafeInteger(engineLaunch) || (engineLaunch as number) < 1) {
        return await abort({ kind: 'fail', code: 'contract_violation', message: 'Session result ply is out of order.' });
      }
      const validated = validateDriverResult(record.result, expected.sfen, legalMoves(expected.sfen), profile.conditions);
      if (!validated) {
        return await abort({ kind: 'fail', code: 'contract_violation', message: 'Session result failed contract validation.' });
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
        return await abort(isActive(fresh) ? RETRY : DONE);
      }
      progress += 1;
      received += 1;
    }
  } catch {
    await cancelReader(reader);
    return RETRY;
  }

  if (endReason === 'complete' && received === positions.length) return RESUME;
  return progress > 0 ? CONTINUE : RETRY;
}

async function driveJob(
  env: Env,
  store: JobStore,
  jobId: string,
  budgetDeadline: number,
  now: () => number,
): Promise<Outcome> {
  for (;;) {
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

    const outcome = await runSession(env, store, job, profile, positions, sessionDeadline, now);
    if (outcome.kind !== 'resume') return outcome;
  }
}

async function markFailedQuietly(store: JobStore, jobId: string, code: string, message: string, now: () => number): Promise<void> {
  try {
    await store.markFailed(jobId, code, message, iso(now()));
  } catch {
    // Failing to persist the failure must not produce another retry loop.
  }
}

async function retryOrFinish(
  store: JobStore,
  message: Message<JobQueueMessage>,
  jobId: string,
  now: () => number,
): Promise<void> {
  if (message.attempts >= JOB_CONSUMER.maxAttempts) {
    await markFailedQuietly(store, jobId, 'retry_exhausted', 'The delivery reached the configured retry limit.', now);
    message.ack();
    return;
  }
  message.retry();
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
      if (message.attempts >= JOB_CONSUMER.maxAttempts) message.ack();
      else message.retry();
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
      outcome = await driveJob(env, store, jobId, budgetDeadline, now);
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
        await markFailedQuietly(store, jobId, outcome.code, outcome.message, now);
        message.ack();
        break;
    }
  }
}
