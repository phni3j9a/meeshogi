import { Container, getContainer } from '@cloudflare/containers';
import { JOB_PROFILES, type JobProfileId } from './jobConfig';
import type { Env } from './index';

export const FREE_JOB_INSTANCE_TYPE = 'standard-2' as const;
export const PRECISION_JOB_INSTANCE_TYPE = 'standard-3' as const;

const TERMINATED_STORAGE_KEY = 'job:terminated';
const TERMINATED_RESPONSE_BODY = JSON.stringify({ status: 'terminated' });
const IN_FLIGHT_FETCH_SETTLE_TIMEOUT_MS = 5_000;

type InFlightJobFetch = {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

abstract class JobContainerBase extends Container<Env> {
  defaultPort = 8080;
  // The longest configured Queue retry delay is 30s; 1m retains the driver
  // process across redelivery while bounding idle capacity after a lost message.
  sleepAfter = '1m';
  private terminationRequested = false;
  private terminationPromise: Promise<void> | undefined;
  private readonly inFlightFetches = new Set<InFlightJobFetch>();

  protected constructor(ctx: DurableObjectState<{}>, env: Env, expectedInstanceType: string) {
    super(ctx, env);
    this.envVars = { ANALYSIS_EXPECTED_INSTANCE_TYPE: expectedInstanceType };
  }

  /** Persist the terminal fence before destroying the Container. Safe to retry. */
  async terminateJob(): Promise<void> {
    this.terminationRequested = true;
    if (!this.terminationPromise) {
      this.terminationPromise = this.persistAbortAndDestroy();
    }
    const pending = this.terminationPromise;
    try {
      await pending;
    } catch (error) {
      if (this.terminationPromise === pending) this.terminationPromise = undefined;
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.terminationRequested) return this.terminatedResponse();
    const controller = new AbortController();
    const propagateRequestAbort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) propagateRequestAbort();
    else request.signal.addEventListener('abort', propagateRequestAbort, { once: true });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const inFlight: InFlightJobFetch = { controller, settled, settle };
    this.inFlightFetches.add(inFlight);
    try {
      let terminated: boolean | undefined;
      try {
        terminated = await this.ctx.storage.get<boolean>(TERMINATED_STORAGE_KEY);
      } catch {
        // Fail closed: an unavailable DO storage read must never start a job
        // Container whose terminal status cannot be checked.
        return new Response(TERMINATED_RESPONSE_BODY, {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Check the in-memory latch again after the storage await so a concurrent
      // terminateJob RPC cannot let a late fetch reach the Container.
      if (terminated === true || this.terminationRequested) return this.terminatedResponse();
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
      }
      return await super.fetch(new Request(request, { signal: controller.signal }));
    } finally {
      request.signal.removeEventListener('abort', propagateRequestAbort);
      this.inFlightFetches.delete(inFlight);
      settle();
    }
  }

  private async persistAbortAndDestroy(): Promise<void> {
    await this.ctx.storage.put(TERMINATED_STORAGE_KEY, true);
    const activeFetches = [...this.inFlightFetches];
    for (const fetch of activeFetches) fetch.controller.abort();
    const settled = Promise.all(activeFetches.map((fetch) => fetch.settled)).then(() => undefined);
    await settleBeforeDeadline(settled, IN_FLIGHT_FETCH_SETTLE_TIMEOUT_MS);
    await this.destroy();
  }

  private terminatedResponse(): Response {
    return new Response(TERMINATED_RESPONSE_BODY, {
      status: 410,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export class FreeJobContainer extends JobContainerBase {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, FREE_JOB_INSTANCE_TYPE);
  }
}

export class PrecisionJobContainer extends JobContainerBase {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, PRECISION_JOB_INSTANCE_TYPE);
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

const STOP_TOTAL_TIMEOUT_MS = 6_000;
const STOP_CONFIRM_INTERVAL_MS = 100;

function structuredLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** Resolve the profile's dedicated class and always use jobId as its DO name. */
export function validateJobContainerProfile(profileId: JobProfileId): void {
  const profile = JOB_PROFILES[profileId];
  if (!profile) throw new Error(`Unknown job profile "${profileId}".`);
  if (profileId === 'free') {
    if (profile.instanceType !== FREE_JOB_INSTANCE_TYPE) {
      throw new Error(`Configuration error: FreeJobContainer expects ${FREE_JOB_INSTANCE_TYPE}, profile declares ${profile.instanceType}.`);
    }
    return;
  }
  if (profile.instanceType !== PRECISION_JOB_INSTANCE_TYPE) {
    throw new Error(`Configuration error: PrecisionJobContainer expects ${PRECISION_JOB_INSTANCE_TYPE}, profile declares ${profile.instanceType}.`);
  }
}

/** Resolve the profile's dedicated class and always use jobId as its DO name. */
export function getJobContainer(env: Env, jobId: string, profileId: JobProfileId): JobContainer {
  validateJobContainerProfile(profileId);
  if (profileId === 'free') return getContainer<FreeJobContainer>(env.JOB_FREE_CONTAINER, jobId);
  return getContainer<PrecisionJobContainer>(env.JOB_PRECISION_CONTAINER, jobId);
}

function isStopped(state: JobContainerState): boolean {
  return state.status === 'stopped' || state.status === 'stopped_with_code';
}

type BoundedResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

/** Observe both outcomes before racing the deadline so late rejections stay handled. */
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

/** Best-effort terminal stop. It never throws so stopping cannot change ack/retry behavior. */
export async function stopJobContainer(
  env: Env,
  jobId: string,
  profileId: JobProfileId,
  log: JobContainerLog = structuredLog,
): Promise<{ stopped: boolean; state: string | null; pollCount: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + STOP_TOTAL_TIMEOUT_MS;
  let state: JobContainerState | null = null;
  let pollCount = 0;
  let errorType: string | undefined;
  let timedOut = false;
  try {
    const container = getJobContainer(env, jobId, profileId);
    const termination = await settleBeforeDeadline(
      Promise.resolve().then(() => container.terminateJob()),
      deadline - Date.now(),
    );
    if (termination.kind === 'timeout') {
      timedOut = true;
    } else if (termination.kind === 'error') {
      errorType = termination.error instanceof Error ? termination.error.name : 'unknown';
    }

    while (!timedOut && Date.now() < deadline) {
      const stateResult = await settleBeforeDeadline(
        Promise.resolve().then(() => container.getState() as unknown as Promise<JobContainerState>),
        deadline - Date.now(),
      );
      pollCount += 1;
      if (stateResult.kind === 'timeout') {
        timedOut = true;
        break;
      }
      if (stateResult.kind === 'error') {
        errorType ??= stateResult.error instanceof Error ? stateResult.error.name : 'unknown';
        break;
      }
      state = stateResult.value;
      if (isStopped(state)) break;
      if (errorType) break;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(STOP_CONFIRM_INTERVAL_MS, remaining)));
      }
    }
    const stopped = state !== null && isStopped(state);
    try {
      log({
        event: 'job_container_stop_result', jobId, profile: profileId, stopped,
        containerState: state?.status ?? null, pollCount, durationMs: Date.now() - startedAt,
        timedOut, ...(errorType ? { errorType } : {}),
      });
    } catch {
      // Observability must not change stop outcome.
    }
    return { stopped, state: state?.status ?? null, pollCount };
  } catch (error) {
    const errorType = error instanceof Error ? error.name : 'unknown';
    try {
      log({
        event: 'job_container_stop_result', jobId, profile: profileId, stopped: false,
        containerState: state?.status ?? null, pollCount, durationMs: Date.now() - startedAt, errorType,
      });
    } catch {
      // Observability must not change delivery or cancellation behavior.
    }
    return { stopped: false, state: state?.status ?? null, pollCount };
  }
}
