import type { JobCoordinator } from './job-coordinator';
import type { WorkerEnv } from './handler';

export type AnalysisProfileId = 'free-v1' | 'precision-v1';
export type JobStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type PositionStatus = 'pending' | 'running' | 'done' | 'failed';

export type AnalysisProfile = Readonly<{
  id: AnalysisProfileId;
  version: 1;
  movetimeMs: number;
  requestedMultiPv: number;
  threads: number;
  hashMb: 256;
}>;

export const ANALYSIS_PROFILES: Readonly<Record<AnalysisProfileId, AnalysisProfile>> = Object.freeze({
  'free-v1': Object.freeze({ id: 'free-v1', version: 1, movetimeMs: 1000, requestedMultiPv: 2, threads: 1, hashMb: 256 }),
  'precision-v1': Object.freeze({ id: 'precision-v1', version: 1, movetimeMs: 2000, requestedMultiPv: 3, threads: 2, hashMb: 256 }),
});

export type JobChunk = { job_id: string; epoch: number; start_idx: number; end_idx: number };

export type JobEnvironment = WorkerEnv & {
  DB: D1Database;
  JOB_QUEUE: Queue<JobChunk>;
  JOB_COORDINATOR: DurableObjectNamespace<JobCoordinator>;
  /** Test-only service binding; absent from every staging configuration. */
  ANALYSIS_ENGINE?: Fetcher;
  ANALYSIS_ADMIN_TOKEN?: string;
  STAGING_ADMIN_TOKEN?: string;
  ANALYSIS_ENGINE_ID?: string;
  ANALYSIS_INSTANCE_TYPE?: 'standard-2' | 'standard-3';
  ANALYSIS_MODEL_ID?: string;
  ANALYSIS_PROFILE_ID?: string;
  ANALYSIS_PROFILE_VERSION?: string;
};

export type JobIdentity = {
  profileId: AnalysisProfileId;
  profileVersion: 1;
  engineId: string;
  modelId: string;
  instanceType: 'standard-2' | 'standard-3';
};

export type AdmissionInput = {
  ownerId: string;
  idempotencyKey: string;
  payloadSha256: string;
  profile: AnalysisProfileId;
  positions: string[];
  label: string | null;
  identity: JobIdentity;
  now: number;
};

export type AdmissionResult = {
  jobId: string;
  duplicate: boolean;
  enqueuePending: boolean;
};

export type AdmissionOutcome =
  | { ok: true; value: AdmissionResult }
  | { ok: false; status: number; error: string };

export type ClaimedPosition = {
  jobId: string;
  ownerId: string;
  epoch: number;
  index: number;
  sfen: string;
  attempts: number;
  leaseId: string;
  cancelRequested: boolean;
  identity: JobIdentity;
};

export type CacheEntry = { resultJson: string; statsJson: string | null };

export type CostSnapshot = { estimatedCostUsd: number; costWarning: boolean; costCapped: boolean };

export function quotaAllows(
  profileId: AnalysisProfileId,
  jobsReserved: number,
  positionsReserved: number,
  newPositions: number,
): boolean {
  const limits = profileId === 'free-v1' ? { jobs: 5, positions: 1024 } : { jobs: 2, positions: 512 };
  return jobsReserved + 1 <= limits.jobs && positionsReserved + newPositions <= limits.positions;
}

export function shouldStopAfterPositionFailure(consecutiveFailures: number, totalFailed: number): boolean {
  return consecutiveFailures >= 3 || totalFailed >= 5;
}

export function finalJobStatus(done: number, failed: number): 'completed' | 'partial' | 'failed' {
  if (failed === 0) return 'completed';
  return done > 0 ? 'partial' : 'failed';
}

export class AdmissionError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'AdmissionError';
  }
}

export function profileFor(value: unknown): AnalysisProfile | null {
  return typeof value === 'string' && Object.hasOwn(ANALYSIS_PROFILES, value)
    ? ANALYSIS_PROFILES[value as AnalysisProfileId]
    : null;
}

export function makeResultCacheKey(identity: JobIdentity, sfen: string): string {
  return JSON.stringify([3, identity.engineId, identity.modelId, identity.profileId, identity.profileVersion, sfen]);
}

export function estimateContainerCostUsd(
  elapsedMs: number,
  attempts: number,
  instanceType: 'standard-2' | 'standard-3',
  profileMovetimeMs = elapsedMs,
  allAttemptsFailed = false,
): number {
  const resources = instanceType === 'standard-3'
    ? { vcpu: 2, gib: 8, diskGb: 16 }
    : { vcpu: 1, gib: 6, diskGb: 12 };
  const dispatches = Math.max(attempts, 1);
  const successWallMs = Math.max(elapsedMs, profileMovetimeMs, 0) + 500;
  // Earlier unsuccessful dispatches use the driver's movetime + 5s deadline
  // bound plus measured request overhead; this keeps a timeout retry priced
  // above an ordinary successful call.
  const failedAttemptWallMs = Math.max(profileMovetimeMs, 0) + 5_500;
  const wallMs = allAttemptsFailed
    ? dispatches * failedAttemptWallMs
    : successWallMs + (dispatches - 1) * failedAttemptWallMs;
  const activeSeconds = wallMs / 1000;
  // The benchmark cost model adds the container's 30-second idle sleep window
  // to provisioned memory and disk. Applying it per position deliberately
  // overestimates a warm multi-position job and keeps admission conservative.
  const provisionedSeconds = activeSeconds + 30;
  const raw = activeSeconds * resources.vcpu * 0.00002 +
    provisionedSeconds * (resources.gib * 0.0000025 + resources.diskGb * 0.00000007);
  return Math.ceil(raw * 1_000_000) / 1_000_000;
}

export function encodeResultCursor(positionIndex: number): string {
  if (!Number.isSafeInteger(positionIndex) || positionIndex < -1) throw new TypeError('invalid_cursor');
  return btoa(`v1:${positionIndex}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeResultCursor(value: string | null): number {
  if (value === null || value === '') return -1;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new TypeError('invalid_cursor');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  let decoded: string;
  try {
    decoded = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  } catch {
    throw new TypeError('invalid_cursor');
  }
  const match = /^v1:(-1|0|[1-9]\d*)$/.exec(decoded);
  if (!match) throw new TypeError('invalid_cursor');
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index)) throw new TypeError('invalid_cursor');
  return index;
}
