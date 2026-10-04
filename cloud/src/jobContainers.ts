import { Container, getContainer } from '@cloudflare/containers';
import { JOB_PROFILES, type JobProfileId } from './jobConfig';
import type { Env } from './index';

export const FREE_JOB_INSTANCE_TYPE = 'standard-2' as const;
export const PRECISION_JOB_INSTANCE_TYPE = 'standard-3' as const;

export class FreeJobContainer extends Container<Env> {
  defaultPort = 8080;
  // The longest configured Queue retry delay is 30s; 1m retains the driver
  // process across redelivery while bounding idle capacity after a lost message.
  sleepAfter = '1m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = { ANALYSIS_EXPECTED_INSTANCE_TYPE: FREE_JOB_INSTANCE_TYPE };
  }
}

export class PrecisionJobContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '1m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = { ANALYSIS_EXPECTED_INSTANCE_TYPE: PRECISION_JOB_INSTANCE_TYPE };
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

const STOP_CONFIRM_TIMEOUT_MS = 5_000;
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

async function readStateBeforeDeadline(
  container: JobContainer,
  timeoutMs: number,
): Promise<JobContainerState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      container.getState() as unknown as Promise<JobContainerState>,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(timeoutMs, 1));
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
  let state: JobContainerState | null = null;
  let pollCount = 0;
  try {
    const container = getJobContainer(env, jobId, profileId);
    try {
      state = await readStateBeforeDeadline(container, 1_000);
    } catch {
      // An unstarted DO may have no readable state yet; still attempt destroy.
    }
    if (!state || !isStopped(state)) {
      await container.destroy();
      const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
      while (true) {
        state = await readStateBeforeDeadline(container, deadline - Date.now());
        pollCount += 1;
        if (state && isStopped(state)) break;
        const remaining = deadline - Date.now();
        if (!state || remaining <= 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(STOP_CONFIRM_INTERVAL_MS, remaining)));
      }
    }
    const stopped = state !== null && isStopped(state);
    try {
      log({
        event: 'job_container_stop_result', jobId, profile: profileId, stopped,
        containerState: state?.status ?? null, pollCount, durationMs: Date.now() - startedAt,
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
