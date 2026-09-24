import type { JobCoordinator } from './job-coordinator';
import type { WorkerEnv } from './handler';

export type AnalysisProfileId = 'free-v1' | 'precision-v1';
export type JobStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type PositionStatus = 'pending' | 'running' | 'done' | 'failed';
export type InstanceType = 'standard-2' | 'standard-3';

export type AnalysisProfile = Readonly<{
  id: AnalysisProfileId;
  version: 2;
  instanceType: InstanceType;
  vcpu: 1 | 2;
  movetimeMs: number;
  requestedMultiPv: number;
  threads: number;
  hashMb: 256;
}>;

export const ANALYSIS_PROFILES: Readonly<Record<AnalysisProfileId, AnalysisProfile>> = Object.freeze({
  'free-v1': Object.freeze({
    id: 'free-v1', version: 2, instanceType: 'standard-2', vcpu: 1,
    movetimeMs: 1000, requestedMultiPv: 2, threads: 1, hashMb: 256,
  }),
  'precision-v1': Object.freeze({
    id: 'precision-v1', version: 2, instanceType: 'standard-3', vcpu: 2,
    movetimeMs: 2000, requestedMultiPv: 3, threads: 2, hashMb: 256,
  }),
});

export const EXECUTION_REVISIONS = Object.freeze({
  parser: 'last-complete-multipv-publication-v2',
  helper: 'sekirei-core-7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac-mate-line-v2',
  proof: 'sekirei-proof-tree-usiv2',
  contract: 'analysis-contract-v3',
  history: 'usinewgame-tt-reset-v1',
  runtimeProvenance: 'container-artifact-provenance-v1',
});

export type ArtifactProvenance = Readonly<{
  engineBinarySha256: string;
  weightSha256: string;
  engineOptionsSha256: string;
  helperBinarySha256: string;
  driverSha256: string;
}>;

export type ExecutionIdentityComponents = Readonly<{
  profile: { id: AnalysisProfileId; version: 2 };
  instance: { type: InstanceType; vcpu: 1 | 2 };
  engine: { id: string; binaryDigestLabel: string; binarySha256: string };
  modelId: string;
  artifacts: ArtifactProvenance;
  options: {
    movetimeMs: number;
    requestedMultiPv: number;
    effectiveMultiPvRule: 'min(requestedMultiPv,rootLegalMoveCount)';
    threads: number;
    hashMb: number;
    generateAllLegalMoves: true;
    usiPonder: false;
    usiOwnBook: false;
    fvScale: 40;
  };
  revisions: typeof EXECUTION_REVISIONS;
}>;

export type JobIdentity = {
  profileId: AnalysisProfileId;
  profileVersion: 2;
  engineId: string;
  engineBinaryDigestLabel: string;
  modelId: string;
  instanceType: InstanceType;
  vcpu: 1 | 2;
  artifacts: ArtifactProvenance;
  executionIdentityHash: string;
  executionIdentityComponents: ExecutionIdentityComponents;
};

export function executionIdentityComponents(
  profile: AnalysisProfile,
  engineId: string,
  modelId: string,
  engineBinaryDigestLabel: string,
  artifacts: ArtifactProvenance,
): ExecutionIdentityComponents {
  return {
    profile: { id: profile.id, version: profile.version },
    instance: { type: profile.instanceType, vcpu: profile.vcpu },
    engine: { id: engineId, binaryDigestLabel: engineBinaryDigestLabel, binarySha256: artifacts.engineBinarySha256 },
    modelId,
    artifacts,
    options: {
      movetimeMs: profile.movetimeMs,
      requestedMultiPv: profile.requestedMultiPv,
      effectiveMultiPvRule: 'min(requestedMultiPv,rootLegalMoveCount)',
      threads: profile.threads,
      hashMb: profile.hashMb,
      generateAllLegalMoves: true,
      usiPonder: false,
      usiOwnBook: false,
      fvScale: 40,
    },
    revisions: EXECUTION_REVISIONS,
  };
}

export function runtimeIdentityMatches(
  identity: JobIdentity,
  health: unknown,
  configuredEngineDigestLabel: string,
): boolean {
  if (typeof health !== 'object' || health === null || Array.isArray(health)) return false;
  const value = health as Record<string, unknown>;
  const artifacts = value.artifactProvenance;
  if (value.ready !== true || value.engineId !== identity.engineId ||
      configuredEngineDigestLabel !== `sha256:${identity.artifacts.engineBinarySha256}` ||
      typeof artifacts !== 'object' || artifacts === null || Array.isArray(artifacts)) return false;
  const runtime = artifacts as Record<string, unknown>;
  return runtime.engineBinarySha256 === identity.artifacts.engineBinarySha256 &&
    runtime.weightSha256 === identity.artifacts.weightSha256 &&
    runtime.engineOptionsSha256 === identity.artifacts.engineOptionsSha256 &&
    runtime.helperBinarySha256 === identity.artifacts.helperBinarySha256 &&
    runtime.driverSha256 === identity.artifacts.driverSha256;
}

export type JobChunk = { job_id: string; epoch: number; start_idx: number; end_idx: number };

export type FaultArmKind = 'destroy' | 'destroy-during' | 'throw' | 'sigstop';
export type FaultArm = {
  kind: FaultArmKind;
  jobId: string;
  ownerId: string;
  epoch: number;
  positionIndex: number;
  attempt: number;
  remaining: number;
};

export type JobEnvironment = WorkerEnv & {
  DB: D1Database;
  JOB_QUEUE: Queue<JobChunk>;
  JOB_COORDINATOR: DurableObjectNamespace<JobCoordinator>;
  /** Per-profile local workerd service-binding seams; never used in staging. */
  ANALYSIS_ENGINE?: Fetcher;
  ANALYSIS_ENGINE_PRECISION?: Fetcher;
  ANALYSIS_ADMIN_TOKEN?: string;
  STAGING_ADMIN_TOKEN?: string;
  ANALYSIS_ENGINE_ID: string;
  ANALYSIS_ENGINE_BINARY_DIGEST_LABEL: string;
  ANALYSIS_MODEL_ID: string;
  ANALYSIS_WEIGHT_SHA256?: string;
  ANALYSIS_ENGINE_OPTIONS_SHA256?: string;
  ANALYSIS_HELPER_SHA256?: string;
  ANALYSIS_DRIVER_SHA256?: string;
  ANALYSIS_FAULT_FIXTURES_ENABLED?: string;
  ANALYSIS_FAULT_TEST_PRINCIPAL_ID?: string;
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

export type AdmissionResult = { jobId: string; duplicate: boolean; enqueuePending: boolean };
export type AdmissionOutcome =
  | { ok: true; value: AdmissionResult }
  | { ok: false; status: number; error: string; retryAfter?: number };

export type ClaimOutcome = { kind: 'claimed'; value: ClaimedPosition } | { kind: 'skip' | 'busy' | 'stopped' | 'quarantine_required' };

export type ClaimedPosition = {
  jobId: string;
  ownerId: string;
  epoch: number;
  index: number;
  sfen: string;
  attempts: number;
  deliveryCount: number;
  leaseId: string;
  cancelRequested: boolean;
  identity: JobIdentity;
};

export type CacheEntry = { resultJson: string; statsJson: string | null; proofJson: string | null };
export type CostSnapshot = { estimatedCostUsd: number; costWarning: boolean; costCapped: boolean; dayUtc: string };
export type RateDecision = { allowed: boolean; retryAfter: number };
export type CancelOutcome = {
  found: boolean;
  status: JobStatus | null;
  jobId?: string;
  epoch?: number;
  inFlight?: { profileId: AnalysisProfileId; leaseId: string; index: number; attempt: number } | null;
};
export type SlotLease = {
  jobId: string;
  epoch: number;
  index: number;
  attempt: number;
  leaseId: string;
  leaseExpiresAt: number;
  profileId: AnalysisProfileId;
  quarantineRequired: boolean;
};
export type PositionDisposition = {
  terminal: string;
  processed: boolean;
  evaluationSuccess: boolean;
  cacheEligible: boolean;
  evaluationMissing: boolean;
  failed: boolean;
};

export type AnalysisTerminal =
  | 'ok' | 'mate' | 'incomplete' | 'position_failed:engine_timeout' | 'position_failed:engine_exit'
  | 'position_failed:engine_restart_failed' | 'position_failed:protocol_error'
  | 'win' | 'resign' | 'none' | 'no_legal_moves' | 'cancelled' | 'failed';

export function classifyTerminal(terminal: AnalysisTerminal): PositionDisposition {
  if (terminal === 'ok' || terminal === 'mate') {
    return { terminal, processed: true, evaluationSuccess: true, cacheEligible: true, evaluationMissing: false, failed: false };
  }
  if (terminal === 'no_legal_moves' || terminal === 'none' || terminal === 'win') {
    return { terminal, processed: true, evaluationSuccess: false, cacheEligible: false, evaluationMissing: false, failed: false };
  }
  if (terminal === 'incomplete' || terminal === 'resign') {
    return { terminal, processed: false, evaluationSuccess: false, cacheEligible: false, evaluationMissing: true, failed: false };
  }
  return { terminal, processed: false, evaluationSuccess: false, cacheEligible: false, evaluationMissing: false, failed: true };
}

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
  return JSON.stringify([
    3, identity.profileId, identity.profileVersion, identity.executionIdentityHash,
    identity.engineId, identity.modelId, sfen,
  ]);
}

export function estimateContainerCostUsd(
  elapsedMs: number,
  attempts: number,
  instanceType: InstanceType,
  profileMovetimeMs = elapsedMs,
  allAttemptsFailed = false,
): number {
  const resources = instanceType === 'standard-3'
    ? { vcpu: 2, gib: 8, diskGb: 16 }
    : { vcpu: 1, gib: 6, diskGb: 12 };
  const dispatches = Math.max(attempts, 1);
  const successWallMs = Math.max(elapsedMs, profileMovetimeMs, 0) + 500;
  const failedAttemptWallMs = Math.max(profileMovetimeMs, 0) + 5_500;
  const wallMs = allAttemptsFailed
    ? dispatches * failedAttemptWallMs
    : successWallMs + (dispatches - 1) * failedAttemptWallMs;
  const activeSeconds = wallMs / 1000;
  const provisionedSeconds = activeSeconds + 30;
  const raw = activeSeconds * resources.vcpu * 0.00002 +
    provisionedSeconds * (resources.gib * 0.0000025 + resources.diskGb * 0.00000007);
  return Math.ceil(raw * 1_000_000) / 1_000_000;
}

const MAX_SEARCH_ATTEMPTS = 2;
const MAX_SEARCH_DEADLINE_MS = 5_000;
const MAX_PROCESS_CLEANUP_MS = 5_000;
const MAX_READINESS_ATTEMPTS = 3;
const MAX_ENGINE_READY_MS = 120_000;
const MAX_USI_HANDSHAKE_MS = 20_000;
const MAX_PROOF_RUNTIME_MS = 3_000;
const CONTAINER_IDLE_SECONDS = 30;

function resourcesFor(instanceType: InstanceType): { vcpu: number; gib: number; diskGb: number } {
  return instanceType === 'standard-3'
    ? { vcpu: 2, gib: 8, diskGb: 16 }
    : { vcpu: 1, gib: 6, diskGb: 12 };
}

/** Engine/container estimate for one attempt, excluding the shared idle window. */
export function estimateAttemptCostUsd(elapsedMs: number, instanceType: InstanceType): number {
  const resources = resourcesFor(instanceType);
  const activeSeconds = Math.max(0, elapsedMs) / 1000;
  const raw = activeSeconds * resources.vcpu * 0.00002 +
    activeSeconds * (resources.gib * 0.0000025 + resources.diskGb * 0.00000007);
  return Math.ceil(raw * 1_000_000) / 1_000_000;
}

export function estimateWorstCaseAttemptCostUsd(profile: AnalysisProfile): number {
  const restartReadinessMs = MAX_READINESS_ATTEMPTS * (MAX_USI_HANDSHAKE_MS + MAX_ENGINE_READY_MS);
  const maxAttemptMs = restartReadinessMs + profile.movetimeMs + MAX_SEARCH_DEADLINE_MS + MAX_PROCESS_CLEANUP_MS;
  return estimateAttemptCostUsd(maxAttemptMs, profile.instanceType);
}

export function estimatePositionReservationUsd(profile: AnalysisProfile): number {
  return MAX_SEARCH_ATTEMPTS * estimateWorstCaseAttemptCostUsd(profile) +
    estimateAttemptCostUsd(MAX_PROOF_RUNTIME_MS, profile.instanceType);
}

export function estimateJobStartupAndIdleUsd(profile: AnalysisProfile): number {
  const restartReadinessMs = MAX_READINESS_ATTEMPTS * (MAX_USI_HANDSHAKE_MS + MAX_ENGINE_READY_MS);
  const coldReadiness = estimateAttemptCostUsd(restartReadinessMs, profile.instanceType);
  const resources = resourcesFor(profile.instanceType);
  const sharedIdle = CONTAINER_IDLE_SECONDS * (
    resources.vcpu * 0.00002 + resources.gib * 0.0000025 + resources.diskGb * 0.00000007
  );
  return coldReadiness + sharedIdle;
}

export function estimateJobReservationUsd(profile: AnalysisProfile, positions: number): number {
  const raw = positions * estimatePositionReservationUsd(profile) + estimateJobStartupAndIdleUsd(profile);
  return Math.ceil(raw * 1_000_000) / 1_000_000;
}

export function encodeResultCursor(resultSeq: number): string {
  if (!Number.isSafeInteger(resultSeq) || resultSeq < 0) throw new TypeError('invalid_cursor');
  return btoa(`v2:${resultSeq}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeResultCursor(value: string | null): number {
  if (value === null || value === '') return 0;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new TypeError('invalid_cursor');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  let decoded: string;
  try {
    decoded = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  } catch {
    throw new TypeError('invalid_cursor');
  }
  const match = /^v2:(0|[1-9]\d*)$/.exec(decoded);
  if (!match) throw new TypeError('invalid_cursor');
  const resultSeq = Number(match[1]);
  if (!Number.isSafeInteger(resultSeq)) throw new TypeError('invalid_cursor');
  return resultSeq;
}
