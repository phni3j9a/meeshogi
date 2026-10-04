import { Container, getContainer } from '@cloudflare/containers';
import { JOB_EXECUTION, JOB_PROFILES, type JobInstanceType, type JobProfileId } from './jobConfig';
import { runJobSlice, type JobRunOutcome } from './jobRunner';
import type { Env } from './index';
import { D1RawDb, JobStore, type JobRow } from './jobStore';

export const FREE_JOB_INSTANCE_TYPE = 'standard-2' as const;
export const PRECISION_JOB_INSTANCE_TYPE = 'standard-3' as const;

const TERMINATED_STORAGE_KEY = 'job:terminated';
const CONTROL_STORAGE_KEY = 'job:control';
const TERMINATED_RESPONSE_BODY = JSON.stringify({ status: 'terminated' });
const IN_FLIGHT_FETCH_SETTLE_TIMEOUT_MS = 5_000;
const STOP_TOTAL_TIMEOUT_MS = 6_000;
const STOP_CONFIRM_INTERVAL_MS = 100;
const RUN_CALLBACK = 'runScheduledSlice';
const RECOVERY_CALLBACK = 'recoverScheduledSlice';
const RECOVERY_DELAY_MS = JOB_EXECUTION.budgetMs + 20_000;

type ControlPhase = 'scheduled' | 'running' | 'terminal';

interface JobControl {
  schemaVersion: 1;
  jobId: string;
  profileId: JobProfileId;
  generation: number;
  attempt: number;
  notBefore: number;
  runId: string | null;
  taskId: string | null;
  phase: ControlPhase;
  recoveryTaskId: string | null;
  recoveryAt: number | null;
}

interface SchedulePayload {
  schemaVersion: 1;
  generation: number;
  runId: string;
}

interface ScheduleRecord<T> {
  taskId: string;
  callback: string;
  payload: T;
  time: number;
}

interface ScheduleApi {
  schedule<T>(when: number, callback: string, payload: T): Promise<ScheduleRecord<T>>;
}

type InFlightJobFetch = {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
  cancel: () => Promise<void>;
};

type BoundedResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

type StartJobResponse = { accepted: true; generation: number };

function logJob(entry: Record<string, unknown>): void {
  try { console.log(JSON.stringify(entry)); } catch { /* diagnostics never change job behavior */ }
}

function isProfileId(value: unknown): value is JobProfileId {
  return value === 'free' || value === 'precision';
}

function isActive(job: JobRow | null): job is JobRow & { status: 'queued' | 'running' } {
  return job !== null && (job.status === 'queued' || job.status === 'running');
}

function isTerminal(job: JobRow): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

function validPayload(value: unknown): value is SchedulePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.schemaVersion === 1
    && Number.isSafeInteger(payload.generation) && (payload.generation as number) > 0
    && typeof payload.runId === 'string' && payload.runId.length >= 16;
}

function newRunId(): string {
  return crypto.randomUUID();
}

/** The Containers SDK schedules at whole Unix seconds and floors its target. */
function alignToSdkSecond(time: number): number {
  return Math.ceil(time / 1000) * 1000;
}

function delayUntilSdkSecond(notBefore: number, now = Date.now()): number {
  const currentSecond = Math.floor(now / 1000);
  return Math.max(0, Math.ceil(notBefore / 1000) - currentSecond);
}

async function settleBeforeDeadline<T>(pending: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  if (timeoutMs <= 0) return { kind: 'timeout' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then<BoundedResult<T>, BoundedResult<T>>(
        (value) => ({ kind: 'value', value }),
        (error: unknown) => ({ kind: 'error', error }),
      ),
      new Promise<BoundedResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A per-job Container whose durable alarm callbacks own all execution progress. */
abstract class JobContainerBase extends Container<Env> {
  defaultPort = 8080;
  // DO-owned retry waits are at most 30 seconds; retain the engine while it retries.
  sleepAfter = '1m';
  protected readonly expectedInstanceType: JobInstanceType;
  protected readonly expectedProfileId: JobProfileId;
  private readonly doState: DurableObjectState<{}>;
  private readonly environment: Env;
  private readonly durableName: string | null;
  private terminationRequested = false;
  private terminationPromise: Promise<void> | undefined;
  private readonly inFlightFetches = new Set<InFlightJobFetch>();
  private activeRun: { generation: number; runId: string; controller: AbortController } | undefined;
  private startTail: Promise<void> = Promise.resolve();

  protected constructor(
    ctx: DurableObjectState<{}>, env: Env, profileId: JobProfileId, expectedInstanceType: JobInstanceType,
  ) {
    super(ctx, env);
    this.doState = ctx;
    this.environment = env;
    this.expectedProfileId = profileId;
    this.expectedInstanceType = expectedInstanceType;
    const objectId = (ctx as DurableObjectState<{}> & { id?: DurableObjectId & { name?: string } }).id;
    this.durableName = objectId?.name ?? null;
    this.envVars = { ANALYSIS_EXPECTED_INSTANCE_TYPE: expectedInstanceType };
  }

  /** Idempotent Queue RPC. Persist the intent and its SDK alarm before returning. */
  async startJob(input: { jobId: string; profileId: JobProfileId }): Promise<StartJobResponse> {
    return this.serializeStart(async () => {
      if (!input || input.jobId !== this.durableName || input.profileId !== this.expectedProfileId) {
        throw new Error('Job start does not match this Durable Object name and profile.');
      }
      const profile = JOB_PROFILES[input.profileId];
      if (profile.instanceType !== this.expectedInstanceType) throw new Error('Job profile instance type mismatch.');
      const store = this.jobStore();
      const job = await store.jobById(input.jobId);
      if (!job || job.profile_id !== input.profileId) throw new Error('Job start does not match its persisted profile.');
      let control = await this.readControl();
      if (isTerminal(job)) {
        await this.terminateJob().catch(() => undefined);
        return { accepted: true, generation: control?.generation ?? 0 };
      }
      if (!isActive(job)) throw new Error('Job is not active.');
      if (this.terminationRequested || await this.isDurablyTerminated()) {
        this.terminationRequested = true;
        return { accepted: true, generation: control?.generation ?? 0 };
      }
      if (!control) {
        control = {
          schemaVersion: 1,
          jobId: input.jobId,
          profileId: input.profileId,
          generation: 1,
          attempt: 1,
          notBefore: Date.now(),
          runId: newRunId(),
          taskId: null,
          phase: 'scheduled',
          recoveryTaskId: null,
          recoveryAt: null,
        };
        await this.doState.storage.put(CONTROL_STORAGE_KEY, control);
        if (this.terminationRequested) return { accepted: true, generation: control.generation };
      } else if (control.jobId !== input.jobId || control.profileId !== input.profileId) {
        throw new Error('Stored job control does not match this job.');
      }
      if (control.phase === 'terminal' || this.terminationRequested) {
        return { accepted: true, generation: control.generation };
      }
      if (control.phase === 'running' && this.activeRun?.runId === control.runId) {
        return { accepted: true, generation: control.generation };
      }
      const current = control;
      if (current.phase === 'scheduled') {
        await this.ensureReservation(current, RUN_CALLBACK, current.notBefore);
      } else {
        const recoveryAt = current.recoveryAt ?? Date.now() + RECOVERY_DELAY_MS;
        await this.ensureReservation(current, RECOVERY_CALLBACK, recoveryAt);
      }
      this.assertNotTerminated();
      this.emitControl('job_start_accepted', current, { state: current.phase });
      return { accepted: true, generation: current.generation };
    });
  }

  /** SDK callback; do not override alarm() or use Durable Object alarms directly. */
  async runScheduledSlice(payload: SchedulePayload, schedule?: ScheduleRecord<SchedulePayload>): Promise<void> {
    try {
      await this.executeScheduled(payload, schedule, false);
    } finally {
      if (this.activeRun?.runId === payload?.runId) this.activeRun = undefined;
    }
  }

  /** Recovery callback for an unexpected callback exit or instance eviction. */
  async recoverScheduledSlice(payload: SchedulePayload, schedule?: ScheduleRecord<SchedulePayload>): Promise<void> {
    await this.executeScheduled(payload, schedule, true);
  }

  /** Durable terminal fence, pending callback removal, stream abort, bounded wait, then destroy. */
  async terminateJob(): Promise<void> {
    this.terminationRequested = true;
    if (!this.terminationPromise) this.terminationPromise = this.persistAbortAndDestroy();
    const pending = this.terminationPromise;
    try {
      await pending;
    } catch (error) {
      if (this.terminationPromise === pending) this.terminationPromise = undefined;
      throw error;
    }
  }

  /** Container transport used by the runner; tracking lasts through EOF/cancel, not just headers. */
  override async fetch(request: Request): Promise<Response> {
    if (this.terminationRequested) return this.terminatedResponse();
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    let bodyCancel: () => Promise<void> = async () => undefined;
    const inFlight: InFlightJobFetch = {
      controller,
      settled,
      settle,
      cancel: async () => bodyCancel(),
    };
    this.inFlightFetches.add(inFlight);
    let handedOffBody = false;
    try {
      let terminated: boolean | undefined;
      try {
        terminated = await this.doState.storage.get<boolean>(TERMINATED_STORAGE_KEY);
      } catch {
        return new Response(TERMINATED_RESPONSE_BODY, { status: 503, headers: { 'content-type': 'application/json' } });
      }
      if (terminated === true || this.terminationRequested) return this.terminatedResponse();
      if (signal.aborted) throw signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
      const response = await super.fetch(new Request(request, { signal }));
      if (!response.body) return response;
      const reader = response.body.getReader();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.inFlightFetches.delete(inFlight);
        settle();
      };
      bodyCancel = async () => {
        controller.abort();
        try { await reader.cancel(); } catch { /* transport may already be closed */ }
        finish();
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = await reader.read();
            if (next.done) {
              stream.close();
              finish();
            } else stream.enqueue(next.value);
          } catch (error) {
            stream.error(error);
            finish();
          }
        },
        async cancel() {
          await bodyCancel();
        },
      });
      handedOffBody = true;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      if (!handedOffBody) {
        this.inFlightFetches.delete(inFlight);
        settle();
      }
    }
  }

  private async executeScheduled(
    payload: SchedulePayload,
    schedule: ScheduleRecord<SchedulePayload> | undefined,
    recovery: boolean,
  ): Promise<void> {
    if (!validPayload(payload) || this.terminationRequested) return;
    let control = await this.readControl();
    if (!control || control.phase === 'terminal' || control.generation !== payload.generation || control.runId !== payload.runId) return;
    this.emitControl('job_alarm_callback_begin', control, { recovery });
    if (this.terminationRequested || await this.isDurablyTerminated()) return;
    const store = this.jobStore();
    let job: JobRow | null;
    try {
      job = await store.jobById(control.jobId);
    } catch {
      await this.scheduleTransient(control, 'd1_read_failed');
      return;
    }
    if (!isActive(job)) {
      if (job && isTerminal(job)) await this.terminateJob().catch(() => undefined);
      return;
    }
    if (job.profile_id !== control.profileId) {
      await this.persistFailure(control, store, 'container_configuration', 'Persisted profile changed after job acceptance.');
      return;
    }

    if (recovery) {
      if (control.phase !== 'running') return;
      if (this.activeRun?.runId === control.runId) {
        const recoveryAt = alignToSdkSecond(Date.now() + RECOVERY_DELAY_MS);
        await this.ensureReservation(control, RECOVERY_CALLBACK, recoveryAt, schedule?.taskId);
        return;
      }
      await this.scheduleTransient(control, 'callback_recovery');
      return;
    }
    if (control.phase !== 'scheduled') return;
    if (Date.now() < control.notBefore) {
      // SDK 0.3.7 removes a fired schedule after its callback returns. Ignore
      // this in-flight reservation so an early callback replaces it before returning.
      await this.ensureReservation(control, RUN_CALLBACK, control.notBefore, schedule?.taskId);
      return;
    }

    const controller = new AbortController();
    this.activeRun = { generation: control.generation, runId: control.runId!, controller };
    control = {
      ...control,
      phase: 'running',
      taskId: schedule?.taskId ?? control.taskId,
      recoveryTaskId: null,
      recoveryAt: alignToSdkSecond(Date.now() + RECOVERY_DELAY_MS),
    };
    await this.doState.storage.put(CONTROL_STORAGE_KEY, control);
    if (this.terminationRequested || controller.signal.aborted) return;

    try {
      const recoveryTask = await this.schedulable().schedule(
        delayUntilSdkSecond(control.recoveryAt!, Date.now()),
        RECOVERY_CALLBACK,
        this.payload(control),
      );
      if (this.terminationRequested || controller.signal.aborted) {
        this.deleteSchedules(RECOVERY_CALLBACK);
        return;
      }
      const latest = await this.readControl();
      if (!latest || latest.generation !== control.generation || latest.runId !== control.runId || latest.phase !== 'running') return;
      control = { ...latest, recoveryTaskId: recoveryTask.taskId };
      await this.doState.storage.put(CONTROL_STORAGE_KEY, control);
      if (this.terminationRequested || controller.signal.aborted) return;
    } catch (error) {
      this.emitControl('job_retry_transient', control, { reason: 'recovery_reservation_failed', errorType: error instanceof Error ? error.name : 'unknown' });
      await this.scheduleTransient(control, 'recovery_reservation_failed');
      return;
    }

    const initialCursor = job.next_ply;
    let outcome: JobRunOutcome;
    this.emitControl('job_slice_begin', control, { cursor: initialCursor, attempt: control.attempt });
    try {
      outcome = await runJobSlice({
        store,
        jobId: control.jobId,
        transport: (request) => this.fetch(request),
        signal: controller.signal,
        budgetMs: JOB_EXECUTION.budgetMs,
        tailMarginMs: JOB_EXECUTION.tailMarginMs,
        instanceType: this.expectedInstanceType,
        now: () => Date.now(),
        onTerminal: () => this.terminateJob(),
        log: (entry) => this.emitControl(String(entry.event ?? 'job_runner'), control!, entry),
      });
    } catch (error) {
      outcome = { kind: 'retry' };
      this.emitControl('job_runner_exception', control, { errorType: error instanceof Error ? error.name : 'unknown' });
    }
    if (this.terminationRequested || controller.signal.aborted) return;
    const latest = await this.readControl();
    if (!latest || latest.generation !== control.generation || latest.runId !== control.runId || latest.phase !== control.phase) return;
    const fresh = await store.jobById(control.jobId);
    this.emitControl('job_slice_end', latest, {
      outcome: outcome.kind,
      cursor: fresh?.next_ply ?? null,
      attempt: latest.attempt,
    });
    if (fresh && isTerminal(fresh)) {
      await this.terminateJob().catch(() => undefined);
      return;
    }
    if (!isActive(fresh)) {
      await this.scheduleTransient(latest, 'job_row_missing');
      return;
    }
    if (outcome.kind === 'fail') {
      await this.persistFailure(latest, store, outcome.code, outcome.message);
      return;
    }
    if (outcome.kind === 'capacity') {
      const exponential = Math.min(30, 5 * (2 ** Math.min(latest.generation - 1, 3)));
      const delaySeconds = Math.min(30, exponential + Math.floor(Math.random() * 5));
      this.emitControl('job_retry_capacity', latest, { delaySeconds, message: outcome.message.slice(0, 256) });
      await this.scheduleFollowup(latest, latest.attempt, delaySeconds, 'capacity');
      return;
    }
    if (outcome.kind === 'continue' || outcome.kind === 'resume') {
      if (fresh.next_ply > initialCursor) {
        await this.scheduleFollowup(latest, 1, 0, 'progress');
      } else {
        await this.scheduleTransient(latest, 'deadline_without_progress');
      }
      return;
    }
    if (outcome.kind === 'done') {
      if (isTerminal(fresh)) await this.terminateJob().catch(() => undefined);
      else await this.scheduleTransient(latest, 'done_while_active');
      return;
    }
    await this.scheduleTransient(latest, 'driver_or_transport_failure');
  }

  private async persistFailure(control: JobControl, store: JobStore, code: string, message: string): Promise<void> {
    try {
      await store.markFailed(control.jobId, code, message, new Date().toISOString());
      const fresh = await store.jobById(control.jobId);
      if (fresh && isTerminal(fresh)) {
        await this.terminateJob().catch(() => undefined);
        return;
      }
      await this.scheduleTransient(control, 'failure_write_did_not_terminalize');
    } catch {
      // Keep the callback-entry recovery schedule if D1 cannot save its terminal state.
      await this.scheduleTransient(control, 'failure_write_failed').catch(() => undefined);
    }
  }

  private async scheduleTransient(control: JobControl, reason: string): Promise<void> {
    if (this.terminationRequested) return;
    if (control.attempt >= JOB_EXECUTION.maxRetries + 1) {
      const store = this.jobStore();
      try {
        await store.markFailed(control.jobId, 'retry_exhausted', 'Transient execution failed after four attempts: ' + reason + '.', new Date().toISOString());
        const fresh = await store.jobById(control.jobId);
        if (fresh && isTerminal(fresh)) {
          this.emitControl('job_retry_exhausted', control, { reason });
          await this.terminateJob().catch(() => undefined);
          return;
        }
      } catch {
        // A later recovery or stale-job scan retries this failed-state write.
      }
      await this.scheduleFollowup(
        control,
        control.attempt,
        JOB_EXECUTION.retryDelaySeconds * JOB_EXECUTION.maxRetries,
        reason,
      );
      return;
    }
    const delay = JOB_EXECUTION.retryDelaySeconds * control.attempt;
    this.emitControl('job_retry_transient', control, { reason, delaySeconds: delay, nextAttempt: control.attempt + 1 });
    await this.scheduleFollowup(control, control.attempt + 1, delay, reason);
  }

  private async scheduleFollowup(control: JobControl, attempt: number, delaySeconds: number, reason: string): Promise<void> {
    if (this.terminationRequested || await this.isDurablyTerminated()) return;
    const latest = await this.readControl();
    if (!latest || latest.generation !== control.generation || latest.runId !== control.runId || latest.phase !== control.phase || latest.phase === 'terminal') return;
    const next: JobControl = {
      ...latest,
      generation: latest.generation + 1,
      attempt,
      notBefore: alignToSdkSecond(Date.now() + Math.max(0, delaySeconds) * 1000),
      runId: newRunId(),
      taskId: null,
      phase: 'scheduled',
      recoveryTaskId: null,
      recoveryAt: null,
    };
    await this.doState.storage.put(CONTROL_STORAGE_KEY, next);
    if (this.terminationRequested) {
      this.deleteSchedules(RUN_CALLBACK);
      this.deleteSchedules(RECOVERY_CALLBACK);
      return;
    }
    const task = await this.schedulable().schedule(
      delayUntilSdkSecond(next.notBefore, Date.now()), RUN_CALLBACK, this.payload(next),
    );
    if (this.terminationRequested || await this.isDurablyTerminated()) {
      this.deleteSchedules(RUN_CALLBACK);
      this.deleteSchedules(RECOVERY_CALLBACK);
      return;
    }
    const afterSchedule = await this.readControl();
    if (!afterSchedule || afterSchedule.generation !== next.generation || afterSchedule.runId !== next.runId || afterSchedule.phase !== 'scheduled') return;
    await this.doState.storage.put(CONTROL_STORAGE_KEY, { ...afterSchedule, taskId: task.taskId });
    if (this.terminationRequested) {
      this.deleteSchedules(RUN_CALLBACK);
      this.deleteSchedules(RECOVERY_CALLBACK);
      return;
    }
    this.deleteSchedules(RECOVERY_CALLBACK);
    this.emitControl('job_followup_reserved', { ...afterSchedule, taskId: task.taskId }, { reason, delaySeconds, attempt });
  }

  private async ensureReservation(
    control: JobControl,
    callback: string,
    when: number,
    executingTaskId?: string,
  ): Promise<void> {
    if (this.terminationRequested) return;
    const matching = await this.findSchedule(callback, control, executingTaskId);
    if (matching) {
      if (callback === RUN_CALLBACK && control.phase === 'scheduled' && control.taskId !== matching.taskId) {
        const latest = await this.readControl();
        if (latest?.generation === control.generation && latest.runId === control.runId && latest.phase === 'scheduled') {
          await this.doState.storage.put(CONTROL_STORAGE_KEY, { ...latest, taskId: matching.taskId });
        }
      } else if (callback === RECOVERY_CALLBACK && control.phase === 'running' && control.recoveryTaskId !== matching.taskId) {
        const latest = await this.readControl();
        if (latest?.generation === control.generation && latest.runId === control.runId && latest.phase === 'running') {
          await this.doState.storage.put(CONTROL_STORAGE_KEY, { ...latest, recoveryTaskId: matching.taskId });
        }
      }
      return;
    }
    this.deleteSchedules(callback);
    const delaySeconds = delayUntilSdkSecond(when, Date.now());
    const schedule = await this.schedulable().schedule(delaySeconds, callback, this.payload(control));
    if (this.terminationRequested || await this.isDurablyTerminated()) {
      this.deleteSchedules(callback);
      return;
    }
    const latest = await this.readControl();
    if (!latest || latest.generation !== control.generation || latest.runId !== control.runId || latest.phase !== control.phase) {
      this.deleteSchedules(callback);
      return;
    }
    const updated = callback === RUN_CALLBACK ? { ...latest, taskId: schedule.taskId } : { ...latest, recoveryTaskId: schedule.taskId };
    await this.doState.storage.put(CONTROL_STORAGE_KEY, updated);
  }

  private async findSchedule(
    callback: string,
    control: JobControl,
    excludeTaskId?: string,
  ): Promise<ScheduleRecord<SchedulePayload> | null> {
    const schedules = await this.schedulable().listSchedules<SchedulePayload>(callback);
    return schedules.find((item) => item.taskId !== excludeTaskId && validPayload(item.payload)
      && item.payload.generation === control.generation && item.payload.runId === control.runId) ?? null;
  }

  private async persistAbortAndDestroy(): Promise<void> {
    let persistenceError: unknown;
    let control: JobControl | null = null;
    try {
      await this.doState.storage.put(TERMINATED_STORAGE_KEY, true);
    } catch (error) {
      persistenceError = error;
    }
    try {
      control = await this.readControl();
      if (control) {
        await this.doState.storage.put(CONTROL_STORAGE_KEY, {
          ...control,
          generation: control.generation + 1,
          phase: 'terminal',
          runId: null,
          taskId: null,
          recoveryTaskId: null,
          recoveryAt: null,
        } satisfies JobControl);
      }
    } catch (error) {
      persistenceError ??= error;
    }
    this.deleteSchedules(RUN_CALLBACK);
    this.deleteSchedules(RECOVERY_CALLBACK);
    this.activeRun?.controller.abort();
    const activeFetches = [...this.inFlightFetches];
    for (const fetch of activeFetches) {
      fetch.controller.abort();
      void fetch.cancel();
    }
    const settled = Promise.all(activeFetches.map((fetch) => fetch.settled)).then(() => undefined);
    await settleBeforeDeadline(settled, IN_FLIGHT_FETCH_SETTLE_TIMEOUT_MS);
    await this.destroy();
    this.emitControl('job_container_stop', control, { reason: 'terminal', inFlightFetches: activeFetches.length });
    if (persistenceError) throw persistenceError;
  }

  private async readControl(): Promise<JobControl | null> {
    const value = await this.doState.storage.get<JobControl>(CONTROL_STORAGE_KEY);
    if (value === undefined) return null;
    if (!value || value.schemaVersion !== 1 || !isProfileId(value.profileId)
      || typeof value.jobId !== 'string' || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !Number.isSafeInteger(value.attempt) || value.attempt < 1
      || !['scheduled', 'running', 'terminal'].includes(value.phase)
      || !(value.runId === null || typeof value.runId === 'string')) {
      throw new Error('Stored job control is malformed.');
    }
    return value;
  }

  private async isDurablyTerminated(): Promise<boolean> {
    try {
      const terminal = await this.doState.storage.get<boolean>(TERMINATED_STORAGE_KEY);
      if (terminal === true) this.terminationRequested = true;
      return terminal === true;
    } catch {
      throw new Error('Job terminal fence storage is unavailable.');
    }
  }

  private jobStore(): JobStore {
    if (!this.environment.JOBS_DB) throw new Error('Jobs D1 binding is unavailable.');
    return new JobStore(new D1RawDb(this.environment.JOBS_DB));
  }

  private payload(control: JobControl): SchedulePayload {
    if (!control.runId) throw new Error('Cannot schedule a terminal job control record.');
    return { schemaVersion: 1, generation: control.generation, runId: control.runId };
  }

  private schedulable(): ReturnType<() => ScheduleApi & { listSchedules<T>(callback: string): Promise<ScheduleRecord<T>[]> }> {
    return this as unknown as ScheduleApi & { listSchedules<T>(callback: string): Promise<ScheduleRecord<T>[]> };
  }

  private async serializeStart<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.startTail;
    let release!: () => void;
    this.startTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
  }

  private assertNotTerminated(): void {
    if (this.terminationRequested) throw new Error('Job has reached its terminal fence.');
  }

  private emitControl(event: string, control: JobControl | null, details: Record<string, unknown> = {}): void {
    logJob({
      event,
      jobId: control?.jobId ?? this.durableName,
      profile: control?.profileId ?? this.expectedProfileId,
      generation: control?.generation ?? null,
      ...details,
    });
  }

  private terminatedResponse(): Response {
    return new Response(TERMINATED_RESPONSE_BODY, { status: 410, headers: { 'content-type': 'application/json' } });
  }
}

export class FreeJobContainer extends JobContainerBase {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, 'free', FREE_JOB_INSTANCE_TYPE);
  }
}

export class PrecisionJobContainer extends JobContainerBase {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, 'precision', PRECISION_JOB_INSTANCE_TYPE);
  }
}

export type JobContainer =
  | ReturnType<typeof getContainer<FreeJobContainer>>
  | ReturnType<typeof getContainer<PrecisionJobContainer>>;

export interface JobContainerState {
  status: string;
  [key: string]: unknown;
}

export type JobContainerLog = (entry: Record<string, unknown>) => void;

/** Resolve the profile's dedicated class and always use jobId as its DO name. */
export function validateJobContainerProfile(profileId: JobProfileId): void {
  const profile = JOB_PROFILES[profileId];
  if (!profile) throw new Error('Unknown job profile "' + profileId + '".');
  const expected = profileId === 'free' ? FREE_JOB_INSTANCE_TYPE : PRECISION_JOB_INSTANCE_TYPE;
  if (profile.instanceType !== expected) throw new Error('Configuration error: Job Container class does not match profile instance type.');
}

export function getJobContainer(env: Env, jobId: string, profileId: JobProfileId): JobContainer {
  validateJobContainerProfile(profileId);
  if (profileId === 'free') return getContainer<FreeJobContainer>(env.JOB_FREE_CONTAINER, jobId);
  return getContainer<PrecisionJobContainer>(env.JOB_PRECISION_CONTAINER, jobId);
}

function isStopped(state: JobContainerState): boolean {
  return state.status === 'stopped' || state.status === 'stopped_with_code';
}

/** Observe both outcomes before racing the deadline so late rejections stay handled. */
async function settleDeadline<T>(pending: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  if (timeoutMs <= 0) return { kind: 'timeout' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then<BoundedResult<T>, BoundedResult<T>>(
        (value) => ({ kind: 'value', value }),
        (error: unknown) => ({ kind: 'error', error }),
      ),
      new Promise<BoundedResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Best-effort terminal stop. Stop confirmation never changes queue ack behavior. */
export async function stopJobContainer(
  env: Env,
  jobId: string,
  profileId: JobProfileId,
  log: JobContainerLog = logJob,
): Promise<{ stopped: boolean; state: string | null; pollCount: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + STOP_TOTAL_TIMEOUT_MS;
  let state: JobContainerState | null = null;
  let pollCount = 0;
  let errorType: string | undefined;
  let timedOut = false;
  try {
    const container = getJobContainer(env, jobId, profileId) as unknown as {
      terminateJob(): Promise<void>;
      getState(): Promise<JobContainerState>;
    };
    const termination = await settleDeadline(Promise.resolve().then(() => container.terminateJob()), deadline - Date.now());
    if (termination.kind === 'timeout') timedOut = true;
    else if (termination.kind === 'error') errorType = termination.error instanceof Error ? termination.error.name : 'unknown';
    while (!timedOut && Date.now() < deadline) {
      const result = await settleDeadline(
        Promise.resolve().then(() => container.getState() as unknown as Promise<JobContainerState>),
        deadline - Date.now(),
      );
      pollCount += 1;
      if (result.kind === 'timeout') { timedOut = true; break; }
      if (result.kind === 'error') { errorType ??= result.error instanceof Error ? result.error.name : 'unknown'; break; }
      state = result.value;
      if (isStopped(state) || errorType) break;
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(STOP_CONFIRM_INTERVAL_MS, remaining)));
    }
    const stopped = state !== null && isStopped(state);
    try { log({ event: 'job_container_stop_result', jobId, profile: profileId, stopped, containerState: state?.status ?? null, pollCount, durationMs: Date.now() - startedAt, timedOut, ...(errorType ? { errorType } : {}) }); } catch { /* best effort */ }
    return { stopped, state: state?.status ?? null, pollCount };
  } catch (error) {
    errorType = error instanceof Error ? error.name : 'unknown';
    try { log({ event: 'job_container_stop_result', jobId, profile: profileId, stopped: false, containerState: state?.status ?? null, pollCount, durationMs: Date.now() - startedAt, errorType }); } catch { /* best effort */ }
    return { stopped: false, state: state?.status ?? null, pollCount };
  }
}
