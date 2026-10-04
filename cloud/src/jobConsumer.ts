/** Queue messages only deliver durable starts; the owning DO drives execution. */
import { JOB_PROFILES, type JobProfileId } from './jobConfig';
import { D1RawDb, JobStore, type JobRow, type StaleActiveJobRow } from './jobStore';
import type { Env, JobQueueMessage } from './index';
import { getJobContainer, stopJobContainer, type JobContainerLog } from './jobContainers';

const START_RPC_TIMEOUT_MS = 5_000;

export interface JobConsumerDeps {
  now?: () => number;
  log?: JobContainerLog;
}

function emit(deps: JobConsumerDeps, entry: Record<string, unknown>): void {
  try { (deps.log ?? ((value) => console.log(JSON.stringify(value))))(entry); } catch { /* logs are best effort */ }
}

function isActive(job: JobRow | null): job is JobRow & { status: 'queued' | 'running' } {
  return job !== null && (job.status === 'queued' || job.status === 'running');
}

function isTerminal(job: JobRow): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

function isJobProfileId(value: string): value is JobProfileId {
  return value === 'free' || value === 'precision';
}

function retryMessage(message: Message<JobQueueMessage>): void {
  const delaySeconds = Math.min(30, 10 * Math.max(message.attempts, 1));
  message.retry({ delaySeconds });
}

async function stopTerminalRow(env: Env, job: JobRow | null, deps: JobConsumerDeps): Promise<void> {
  if (!job || !isTerminal(job) || !isJobProfileId(job.profile_id)) return;
  await stopJobContainer(env, job.job_id, job.profile_id, (entry) => emit(deps, entry));
}

async function failActiveJob(
  env: Env,
  store: JobStore,
  jobId: string,
  code: string,
  detail: string,
  now: () => number,
  deps: JobConsumerDeps,
): Promise<boolean> {
  try {
    await store.markFailed(jobId, code, detail, new Date(now()).toISOString());
    const fresh = await store.jobById(jobId);
    if (fresh && isTerminal(fresh)) await stopTerminalRow(env, fresh, deps);
    return fresh === null || !isActive(fresh);
  } catch {
    return false;
  }
}

async function startWithTimeout(
  container: { startJob: (request: { jobId: string; profileId: JobProfileId }) => Promise<unknown> },
  request: { jobId: string; profileId: JobProfileId },
): Promise<{ accepted: true; generation: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('start RPC timed out')), START_RPC_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([Promise.resolve().then(() => container.startJob(request)), timeout]);
    if (typeof response !== 'object' || response === null || (response as Record<string, unknown>).accepted !== true) {
      throw new Error('start RPC did not accept the job');
    }
    const generation = (response as Record<string, unknown>).generation;
    return { accepted: true, generation: Number.isSafeInteger(generation) ? generation as number : 0 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
      retryMessage(message);
      continue;
    }

    const store = new JobStore(new D1RawDb(env.JOBS_DB));
    let job: JobRow | null;
    try {
      job = await store.jobById(jobId);
    } catch {
      retryMessage(message);
      continue;
    }
    if (!isActive(job)) {
      await stopTerminalRow(env, job, deps);
      message.ack();
      emit(deps, { event: 'job_queue_ack', jobId, profile: job?.profile_id ?? null, generation: null, reason: 'inactive' });
      continue;
    }

    emit(deps, { event: 'job_delivery_begin', jobId, profile: job.profile_id, queue: batch.queue, attempt: message.attempts });
    if (!isJobProfileId(job.profile_id)) {
      const saved = await failActiveJob(
        env, store, jobId, 'unknown_profile', 'The persisted job profile is not supported.', now, deps,
      );
      if (saved) {
        message.ack();
        emit(deps, { event: 'job_queue_ack', jobId, profile: job.profile_id, generation: null, reason: 'invalid-profile' });
      } else retryMessage(message);
      continue;
    }

    if (batch.queue !== JOB_PROFILES[job.profile_id].queueName) {
      const saved = await failActiveJob(
        env, store, jobId, 'queue_profile_mismatch',
        'The delivery queue does not match persisted profile "' + job.profile_id + '".', now, deps,
      );
      if (saved) {
        message.ack();
        emit(deps, { event: 'job_queue_ack', jobId, profile: job.profile_id, generation: null, reason: 'queue-profile-mismatch' });
      } else retryMessage(message);
      continue;
    }

    try {
      const container = getJobContainer(env, jobId, job.profile_id) as unknown as {
        startJob: (request: { jobId: string; profileId: JobProfileId }) => Promise<unknown>;
      };
      const accepted = await startWithTimeout(container, { jobId, profileId: job.profile_id });
      emit(deps, {
        event: 'job_start_accepted', jobId, profile: job.profile_id,
        generation: accepted.generation, queueAttempt: message.attempts,
      });
      message.ack();
      emit(deps, { event: 'job_queue_ack', jobId, profile: job.profile_id, generation: accepted.generation, reason: 'start-accepted' });
    } catch (error) {
      emit(deps, {
        event: 'job_start_retry', jobId, profile: job.profile_id,
        queueAttempt: message.attempts,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      // Queue retry exhaustion intentionally leaves this active job untouched;
      // Cloudflare sends the start message to the DLQ for the scheduled sweeper.
      retryMessage(message);
    }
  }
}

/** Cron recovery re-announces old active rows without changing their retry state. */
export async function requeueStaleJobs(
  env: Env,
  options: { now?: () => number; log?: JobContainerLog; limit?: number } = {},
): Promise<{ scanned: number; sent: number }> {
  const emitDeps: JobConsumerDeps = { log: options.log };
  if (!env.JOBS_DB) {
    emit(emitDeps, { event: 'job_recovery_scan_failed', reason: 'jobs_db_unavailable' });
    return { scanned: 0, sent: 0 };
  }
  const now = options.now ?? (() => Date.now());
  const scanTime = now();
  const staleBefore = new Date(scanTime - 15 * 60_000).toISOString();
  const recoveryAt = new Date(scanTime).toISOString();
  const store = new JobStore(new D1RawDb(env.JOBS_DB));
  let jobs: StaleActiveJobRow[];
  try {
    jobs = await store.staleActiveJobs(staleBefore, options.limit ?? 100);
  } catch {
    emit(emitDeps, { event: 'job_recovery_scan_failed', reason: 'd1_read_failed' });
    return { scanned: 0, sent: 0 };
  }
  let sent = 0;
  for (const job of jobs) {
    try {
      // Move the bounded scan forward before dispatching so a broken or
      // unavailable Queue binding cannot pin the first page forever.
      if (!await store.markRecoveryScanned(job, staleBefore, recoveryAt)) continue;
    } catch {
      emit(emitDeps, { event: 'job_recovery_scan_failed', jobId: job.job_id, reason: 'd1_write_failed' });
      continue;
    }
    if (!isJobProfileId(job.profile_id)) {
      emit(emitDeps, { event: 'job_recovery_skipped', jobId: job.job_id, profile: job.profile_id, reason: 'unknown_profile' });
      continue;
    }
    const queue = job.profile_id === 'free' ? env.JOBS_FREE_QUEUE : env.JOBS_PRECISION_QUEUE;
    if (!queue) {
      emit(emitDeps, { event: 'job_recovery_send_failed', jobId: job.job_id, profile: job.profile_id, reason: 'queue_unavailable' });
      continue;
    }
    try {
      await queue.send({ v: 1, jobId: job.job_id });
      sent += 1;
      emit(emitDeps, { event: 'job_recovery_requeued', jobId: job.job_id, profile: job.profile_id, updatedAt: job.updated_at });
    } catch {
      emit(emitDeps, { event: 'job_recovery_send_failed', jobId: job.job_id, profile: job.profile_id, reason: 'queue_send_failed' });
    }
  }
  return { scanned: jobs.length, sent };
}
