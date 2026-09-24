import { Position } from 'tsshogi';
import { ANALYSIS_CONTRACT_VERSION, isCloudAnalysisResultV3, isStrictShogiSfen, type CloudAnalysisResultV3 } from '../../src/cloud/analysis-contract';
import { analyzeWithServerProfile, type DriverClient, type WorkerEnv } from './handler';
import { JobCoordinator } from './job-coordinator';
import {
  ANALYSIS_PROFILES, COST_MODEL, classifyTerminal, decodeResultCursor, encodeResultCursor, estimateContainerCostUsd,
  estimateRuntimeCostUsd, executionIdentityComponents, profileFor, runtimeIdentityMatches,
  type AdmissionInput, type AnalysisProfile, type AnalysisProfileId,
  type AnalysisTerminal, type ClaimedPosition, type CostSnapshot, type JobChunk, type JobEnvironment,
  type JobIdentity, type JobStatus,
} from './job-types';
import { parseDriverProof, toStoredProof, type StoredProof } from './proof-contract';

const JOB_PATH = '/v1/jobs';
const PROFILES_PATH = '/v1/analysis-profiles';
const KILL_PATH = '/v1/internal/kill';
const FAULT_PATH = '/v1/internal/fault/arm';
const CLEAR_BLOCK_PATH = '/v1/internal/profiles/';
const GLOBAL_COORDINATOR_NAME = 'staging-global';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESULTS_PAGE = 100;
const CANCEL_GRACE_MS = 5_000;
const CANCEL_POLL_MS = 50;
const PROOF_BUDGET = 10_000;
const PROOF_PLIES = 3;
const MAX_JOB_POSITIONS = 512;

export type ProfileDriverRouter = (profile: AnalysisProfileId) => DriverClient;
type Principal = { id: string; token_sha256: string; precision_enabled: number; revoked: number };
type JobRow = {
  id: string; owner_id: string; status: JobStatus; profile_id: string; profile_version: number; engine_id: string;
  model_id: string; instance_type: string; label: string | null; position_count: number; epoch: number;
  cancel_requested: number; committed_count: number; failed_count: number; stop_reason: string | null;
  created_at: string; started_at: string | null; completed_at: string | null; execution_identity_hash: string;
  cost_estimate_usd: number; cost_reserved: number; engine_binary_digest_label: string; vcpu: number;
};
type JobPayload = { idempotencyKey: string; profile: AnalysisProfile; initialSfen: string; moves: string[]; positions: string[] };
type JobPayloadParse = { ok: true; payload: JobPayload } | { ok: false; error: 'invalid_request' | 'illegal_move'; moveIndex?: number };
type EngineFailure = { code: string; transient: boolean; fatalProtocol: boolean; uncertain: boolean };
type ProofEnvelope = StoredProof | null;
type ProofOutcome = { proof: ProofEnvelope; invalid: boolean; elapsedMs: number };

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function replayJobPayload(value: unknown): JobPayloadParse {
  if (!isRecord(value) || !hasExactKeys(value, ['idempotency_key', 'profile', 'initialSfen', 'moves'])) {
    return { ok: false, error: 'invalid_request' };
  }
  if (typeof value.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.idempotency_key)) return { ok: false, error: 'invalid_request' };
  const profile = profileFor(value.profile);
  if (!profile || !isStrictShogiSfen(value.initialSfen)) return { ok: false, error: 'invalid_request' };
  if (!Array.isArray(value.moves) || value.moves.length > 511 || !value.moves.every((move) => typeof move === 'string' && move.length <= 8)) {
    return { ok: false, error: 'invalid_request' };
  }
  const position = Position.newBySFEN(value.initialSfen);
  if (!position) return { ok: false, error: 'invalid_request' };
  const initialSfen = position.sfen;
  const positions = [initialSfen];
  const moves = value.moves as string[];
  for (let index = 0; index < moves.length; index += 1) {
    const move = position.createMoveByUSI(moves[index]);
    if (!move || !position.isValidMove(move) || !position.doMove(move)) return { ok: false, error: 'illegal_move', moveIndex: index };
    positions.push(position.sfen);
  }
  return { ok: true, payload: { idempotencyKey: value.idempotency_key, profile, initialSfen, moves: [...moves], positions } };
}
export function parseJobPayload(value: unknown): JobPayload | null {
  const parsed = replayJobPayload(value);
  return parsed.ok ? parsed.payload : null;
}

function adminSecret(env: JobEnvironment): string | undefined { return env.ANALYSIS_ADMIN_TOKEN ?? env.STAGING_ADMIN_TOKEN; }
function fixedTimeHexEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 64; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}
async function authenticate(request: Request, db: D1Database): Promise<Principal | null> {
  const authorization = request.headers.get('authorization');
  if (!authorization || authorization.length > 520) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match || match[1].length > 512) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
  const digestHex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const { results } = await db.prepare('SELECT id, token_sha256, precision_enabled, revoked FROM principals').all<Principal>();
  let found: Principal | null = null;
  let matches = 0;
  for (const principal of results) {
    if (fixedTimeHexEqual(digestHex, principal.token_sha256.toLowerCase())) { found = principal; matches += 1; }
  }
  return matches === 1 && found && found.revoked !== 1 ? found : null;
}
function constantTimeAdminMatch(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length, 1);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
function hasAdminAuth(request: Request, env: JobEnvironment): boolean {
  const expected = adminSecret(env);
  const authorization = request.headers.get('authorization');
  const match = authorization && authorization.length <= 520 ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
  return Boolean(expected && match && constantTimeAdminMatch(match[1], expected));
}
async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > limit) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function readJson(request: Request, limit: number): Promise<unknown | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) return null;
  const text = await readBoundedText(request, limit);
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
function sha256Hex(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
}
async function jobIdentity(env: JobEnvironment, profile: AnalysisProfile): Promise<JobIdentity | null> {
  const engineId = env.ANALYSIS_ENGINE_ID;
  const modelId = env.ANALYSIS_MODEL_ID;
  const engineBinaryDigestLabel = env.ANALYSIS_ENGINE_BINARY_DIGEST_LABEL;
  const artifacts = {
    engineBinarySha256: engineBinaryDigestLabel?.startsWith('sha256:') ? engineBinaryDigestLabel.slice(7) : '',
    weightSha256: env.ANALYSIS_WEIGHT_SHA256 ?? '',
    engineOptionsSha256: env.ANALYSIS_ENGINE_OPTIONS_SHA256 ?? '',
    helperBinarySha256: env.ANALYSIS_HELPER_SHA256 ?? '',
    driverSha256: env.ANALYSIS_DRIVER_SHA256 ?? '',
  };
  if (!engineId || !modelId || !/^sha256:[0-9a-f]{64}$/.test(engineBinaryDigestLabel ?? '') ||
      Object.values(artifacts).some((digest) => !/^[0-9a-f]{64}$/.test(digest))) return null;
  const components = executionIdentityComponents(profile, engineId, modelId, engineBinaryDigestLabel, artifacts);
  return {
    profileId: profile.id, profileVersion: profile.version, engineId, engineBinaryDigestLabel, modelId,
    instanceType: profile.instanceType, vcpu: profile.vcpu, artifacts,
    executionIdentityHash: await sha256Hex(JSON.stringify(components)),
    executionIdentityComponents: components,
  };
}
export type DriverRuntimeCheck = 'ok' | 'unreachable' | 'mismatch';
export type DriverRuntimeResult = { status: DriverRuntimeCheck; elapsedMs: number; unknown: boolean; engineEpoch: string | null; restartCount: number | null };
export async function verifyDriverRuntime(driver: DriverClient, env: JobEnvironment, identity: JobIdentity): Promise<DriverRuntimeResult> {
  let elapsedMs = 0;
  for (let probe = 0; probe < 2; probe += 1) {
    const started = Date.now();
    let health: unknown;
    try {
      const response = await driver.fetch(new Request('http://container/health', { method: 'GET' }));
      elapsedMs += Math.max(0, Date.now() - started);
      if (!response.ok) { await new Promise((resolve) => setTimeout(resolve, 150)); continue; }
      health = await response.json();
    } catch { elapsedMs += Math.max(0, Date.now() - started); await new Promise((resolve) => setTimeout(resolve, 150)); continue; }
    const runtime = isRecord(health) ? health : null;
    return {
      status: runtimeIdentityMatches(identity, health, env.ANALYSIS_ENGINE_BINARY_DIGEST_LABEL) ? 'ok' : 'mismatch',
      elapsedMs, unknown: false,
      engineEpoch: typeof runtime?.engineEpoch === 'string' ? runtime.engineEpoch : null,
      restartCount: typeof runtime?.restartCount === 'number' && Number.isSafeInteger(runtime.restartCount) ? runtime.restartCount : null,
    };
  }
  return { status: 'unreachable', elapsedMs, unknown: true, engineEpoch: null, restartCount: null };
}
function operationStub(env: JobEnvironment): DurableObjectStub<JobCoordinator> {
  return env.JOB_COORDINATOR.getByName(GLOBAL_COORDINATOR_NAME);
}
async function verifyAndRecordRuntime(
  driver: DriverClient, env: JobEnvironment, position: ClaimedPosition, chunk: JobChunk, phase: 'pre' | 'post-analysis' | 'post-proof',
): Promise<DriverRuntimeResult> {
  const result = await verifyDriverRuntime(driver, env, position.identity);
  const chunkKey = `chunk:${chunk.start_idx}:${chunk.end_idx}`;
  await operationStub(env).recordCostObservation({
    jobId: position.jobId, epoch: position.epoch, partKey: chunkKey,
    eventKey: `observation:${position.jobId}:${position.epoch}:readiness:${position.index}:${position.deliveryCount}:${phase}`,
    phase: 'container_readiness', durationMs: result.unknown ? null : result.elapsedMs,
    evidence: {
      unknown: result.unknown, probePhase: phase, measuredElapsedMs: result.elapsedMs,
      attemptBoundMs: COST_MODEL.readinessReserveMs, engineEpoch: result.engineEpoch, restartCount: result.restartCount,
    },
    now: Date.now(),
  });
  if (result.engineEpoch && result.restartCount && result.restartCount > 0) {
    await operationStub(env).recordEngineRestart({
      jobId: position.jobId, epoch: position.epoch, profileId: position.identity.profileId,
      engineEpoch: result.engineEpoch, restartCount: result.restartCount,
      chunkStart: chunk.start_idx, chunkEnd: chunk.end_idx, now: Date.now(),
    });
  }
  return result;
}
function coordinatorFailure(): Response { return json({ error: 'coordinator_unavailable' }, 503); }
function retryResponse(retryAfter: number): Response {
  return json({ error: 'rate_limit' }, 429, { 'retry-after': String(Math.max(1, retryAfter)) });
}
function routeIdentity(path: string): { jobId: string; action: 'status' | 'results' | 'cancel' } | null {
  const match = /^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(results|cancel))?$/.exec(path);
  if (!match) return null;
  return { jobId: match[1], action: match[2] === 'results' ? 'results' : match[2] === 'cancel' ? 'cancel' : 'status' };
}
export function isJobApiPath(path: string): boolean {
  return path === JOB_PATH || path.startsWith(JOB_PATH + '/') || path === PROFILES_PATH ||
    path === KILL_PATH || path === FAULT_PATH || path.startsWith(CLEAR_BLOCK_PATH);
}

export async function handleJobsRequest(request: Request, env: JobEnvironment, drivers: ProfileDriverRouter): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === KILL_PATH || url.pathname === FAULT_PATH || url.pathname.startsWith(CLEAR_BLOCK_PATH)) return handleAdminRequest(request, env);
  if (url.pathname === JOB_PATH) return request.method === 'POST' ? createJob(request, env) : json({ error: 'not_found' }, 404);
  if (url.pathname === PROFILES_PATH) return request.method === 'GET' ? getProfiles(request, env) : json({ error: 'not_found' }, 404);
  const route = routeIdentity(url.pathname);
  if (!route) return json({ error: 'not_found' }, 404);
  if ((route.action === 'status' || route.action === 'results') && request.method !== 'GET') return json({ error: 'not_found' }, 404);
  if (route.action === 'cancel' && request.method !== 'POST') return json({ error: 'not_found' }, 404);
  let principal: Principal | null;
  try { principal = await authenticate(request, env.DB); } catch { return coordinatorFailure(); }
  if (!principal) return json({ error: 'unauthorized' }, 401);
  const owned = await env.DB.prepare('SELECT id FROM jobs WHERE id = ? AND owner_id = ?').bind(route.jobId, principal.id).first<{ id: string }>();
  if (!owned) return json({ error: 'not_found' }, 404);
  let rate;
  try { rate = await operationStub(env).recordOwnerOperation(principal.id, route.action === 'cancel' ? 'cancel' : 'get', Date.now()); }
  catch { return coordinatorFailure(); }
  if (!rate.allowed) return retryResponse(rate.retryAfter);
  if (route.action === 'cancel') return cancelJob(request, env, principal.id, route.jobId, drivers);
  if (route.action === 'results') return getJobResults(request, env, route.jobId);
  return getJobSummary(env, route.jobId);
}

async function getProfiles(request: Request, env: JobEnvironment): Promise<Response> {
  let principal: Principal | null;
  try { principal = await authenticate(request, env.DB); } catch { return coordinatorFailure(); }
  if (!principal) return json({ error: 'unauthorized' }, 401);
  const rate = await operationStub(env).recordOwnerOperation(principal.id, 'get', Date.now());
  if (!rate.allowed) return retryResponse(rate.retryAfter);
  const profiles = await Promise.all(Object.values(ANALYSIS_PROFILES).map(async (profile) => {
    const identity = await jobIdentity(env, profile);
    return {
      id: profile.id, version: profile.version,
      executionIdentityHash: identity?.executionIdentityHash ?? null,
      identityComponents: identity?.executionIdentityComponents ?? null,
      entitled: profile.id === 'free-v1' || principal.precision_enabled === 1,
      admissionBlocked: await operationStub(env).isProfileBlocked(profile.id),
    };
  }));
  return json({ profiles });
}

async function createJob(request: Request, env: JobEnvironment): Promise<Response> {
  let principal: Principal | null;
  try { principal = await authenticate(request, env.DB); } catch { return coordinatorFailure(); }
  if (!principal) return json({ error: 'unauthorized' }, 401);
  const parsed = replayJobPayload(await readJson(request, MAX_REQUEST_BYTES));
  if (!parsed.ok) return parsed.error === 'illegal_move'
    ? json({ error: parsed.error, moveIndex: parsed.moveIndex }, 400)
    : json({ error: parsed.error }, 400);
  const payload = parsed.payload;
  if (payload.profile.id === 'precision-v1' && principal.precision_enabled !== 1) return json({ error: 'precision_not_enabled' }, 403);
  if (payload.positions.length > MAX_JOB_POSITIONS) return json({ error: 'invalid_request' }, 400);
  const identity = await jobIdentity(env, payload.profile);
  if (!identity) return json({ error: 'service_not_configured' }, 503);
  const canonicalPayload = JSON.stringify({ initialSfen: payload.initialSfen, moves: payload.moves, profile: payload.profile.id });
  const admission: AdmissionInput = {
    ownerId: principal.id, idempotencyKey: payload.idempotencyKey, payloadSha256: await sha256Hex(canonicalPayload),
    profile: payload.profile.id, positions: payload.positions, label: null, identity, now: Date.now(),
  };
  let outcome: Awaited<ReturnType<DurableObjectStub<JobCoordinator>['admit']>>;
  try { outcome = await operationStub(env).admit(admission); } catch { return coordinatorFailure(); }
  if (!outcome.ok) return outcome.status === 429
    ? json({ error: outcome.error }, 429, { 'retry-after': String(Math.max(1, outcome.retryAfter ?? 60)) })
    : json({ error: outcome.error }, outcome.status);
  if (outcome.value.enqueuePending) return json({ error: 'queue_unavailable', jobId: outcome.value.jobId }, 503);
  let snapshot: CostSnapshot;
  let persisted: { status: JobStatus; profile_id: string; profile_version: number; position_count: number; execution_identity_hash: string; cost_estimate_usd: number } | null;
  try {
    snapshot = await operationStub(env).costSnapshot(Date.now());
    persisted = await env.DB.prepare('SELECT status, profile_id, profile_version, position_count, execution_identity_hash, cost_estimate_usd FROM jobs WHERE id = ?')
      .bind(outcome.value.jobId).first();
  } catch { return coordinatorFailure(); }
  if (!persisted) return coordinatorFailure();
  const status = outcome.value.duplicate ? 200 : 202;
  return json({
    jobId: outcome.value.jobId, status: persisted.status, duplicate: outcome.value.duplicate,
    profile: { id: persisted.profile_id, version: persisted.profile_version },
    executionIdentityHash: persisted.execution_identity_hash, positionCount: persisted.position_count,
    costEnvelopeVersion: 2,
    estimatedCostUsd: persisted.cost_estimate_usd, admissionEstimateUsd: persisted.cost_estimate_usd,
    costWarning: snapshot.costWarning,
  }, status, outcome.value.duplicate ? {} : { location: JOB_PATH + '/' + outcome.value.jobId });
}

async function getJobSummary(env: JobEnvironment, jobId: string): Promise<Response> {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<JobRow>();
  if (!job) return json({ error: 'not_found' }, 404);
  const counts = await env.DB.prepare(
    "SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running, " +
    "SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS processed, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, " +
    "SUM(CASE WHEN status = 'done' AND engine_terminal IN ('ok', 'mate') THEN 1 ELSE 0 END) AS succeeded, " +
    "SUM(CASE WHEN error_detail = 'incomplete' OR engine_terminal = 'resign' THEN 1 ELSE 0 END) AS incomplete_or_missing, " +
    "SUM(CASE WHEN status = 'failed' AND COALESCE(error_detail, '') NOT IN ('incomplete', 'evaluation_missing:resign') THEN 1 ELSE 0 END) AS failed_non_incomplete, " +
    "SUM(CASE WHEN status = 'done' AND engine_terminal IN ('no_legal_moves', 'none', 'win') THEN 1 ELSE 0 END) AS terminal, " +
    "SUM(CASE WHEN status = 'done' AND cached = 1 THEN 1 ELSE 0 END) AS cached FROM positions WHERE job_id = ?",
  ).bind(jobId).first<Record<string, number | null>>();
  const cost = await operationStub(env).costSnapshot(Date.now());
  const engineCost = await getJobEngineCost(env, jobId);
  const costBreakdown = await getJobCostBreakdown(env, job);
  const profile = profileFor(job.profile_id);
  const instanceType = job.instance_type === 'standard-2' || job.instance_type === 'standard-3' ? job.instance_type : null;
  const cachedPositionCount = Number(counts?.cached ?? 0);
  const estimatedCacheSavingsUsd = profile && instanceType
    ? cachedPositionCount * estimateContainerCostUsd(profile.movetimeMs, 1, instanceType, profile.movetimeMs)
    : 0;
  return json({
    jobId: job.id, status: job.status,
    counts: {
      pending: Number(counts?.pending ?? 0), running: Number(counts?.running ?? 0), processed: Number(counts?.processed ?? 0),
      succeeded: Number(counts?.succeeded ?? 0), incompleteOrMissing: Number(counts?.incomplete_or_missing ?? 0),
      failed: Number(counts?.failed_non_incomplete ?? 0), terminal: Number(counts?.terminal ?? 0),
    },
    committedCount: job.committed_count, cancelRequested: job.cancel_requested === 1, stopReason: job.stop_reason,
    profile: { id: job.profile_id, version: job.profile_version, engineId: job.engine_id, modelId: job.model_id, instanceType: job.instance_type, vcpu: job.vcpu },
    executionIdentityHash: job.execution_identity_hash, positionCount: job.position_count,
    cacheStats: { cachedPositionCount, estimatedSavingsUsd: estimatedCacheSavingsUsd },
    createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at,
    costEnvelopeVersion: 2,
    settledAttemptEstimateUsd: engineCost, estimatedCostUsd: job.cost_estimate_usd,
    costs: {
      ...costBreakdown,
      admissionEstimateUsd: job.cost_estimate_usd,
      settledAttemptEstimateUsd: engineCost,
      observedEngineCostUsd: null,
      invoice: false,
    },
    costWarning: cost.costWarning,
  });
}

async function getJobResults(request: Request, env: JobEnvironment, jobId: string): Promise<Response> {
  const url = new URL(request.url);
  let afterSeq: number;
  try { afterSeq = decodeResultCursor(url.searchParams.get('cursor')); } catch { return json({ error: 'invalid_cursor' }, 400); }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS_PAGE) return json({ error: 'invalid_limit' }, 400);
  const { results } = await env.DB.prepare(
    "SELECT position_index, result_seq, status, attempts, delivery_count, result_json, stats_json, proof_json, cached, error_detail, " +
    "profile_id, profile_version, engine_id, model_id, execution_identity_hash FROM positions " +
    "WHERE job_id = ? AND result_seq > ? AND status IN ('done', 'failed') ORDER BY result_seq LIMIT ?",
  ).bind(jobId, afterSeq, limit + 1).all<{
    position_index: number; result_seq: number; status: 'done' | 'failed'; attempts: number; delivery_count: number;
    result_json: string | null; stats_json: string | null; proof_json: string | null; cached: number; error_detail: string | null;
    profile_id: string; profile_version: number; engine_id: string; model_id: string; execution_identity_hash: string;
  }>();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const nextSeq = page.length ? Math.max(...page.map((row) => row.result_seq)) : afterSeq;
  page.sort((left, right) => left.position_index - right.position_index);
  const identity = await env.DB.prepare('SELECT execution_identity_hash FROM jobs WHERE id = ?').bind(jobId).first<{ execution_identity_hash: string }>();
  const cost = await operationStub(env).costSnapshot(Date.now());
  return json({
    jobId, executionIdentityHash: identity?.execution_identity_hash ?? '',
    results: page.map((row) => ({
      positionIndex: row.position_index, resultSeq: row.result_seq, status: row.status,
      attempts: row.attempts, deliveryCount: row.delivery_count,
      result: row.result_json ? JSON.parse(row.result_json) as CloudAnalysisResultV3 : null,
      proof: row.proof_json ? JSON.parse(row.proof_json) as ProofEnvelope : null,
      stats: row.stats_json ? JSON.parse(row.stats_json) as Record<string, number> : null,
      cached: row.cached === 1, error: row.error_detail, executionIdentityHash: row.execution_identity_hash,
      profile: { id: row.profile_id, version: row.profile_version, engineId: row.engine_id, modelId: row.model_id },
    })),
    hasMore, resumeCursor: encodeResultCursor(nextSeq), nextCursor: hasMore ? encodeResultCursor(nextSeq) : null,
    limit, estimatedCostUsd: await getJobEstimate(env, jobId),
    admissionEstimateUsd: await getJobEstimate(env, jobId), costWarning: cost.costWarning,
  });
}
async function getJobEngineCost(env: JobEnvironment, jobId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT SUM(amount_usd) AS total FROM cost_attempt_ledger WHERE job_id = ?').bind(jobId).first<{ total: number | null }>();
  return Number(row?.total ?? 0);
}
async function getJobEstimate(env: JobEnvironment, jobId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT cost_estimate_usd FROM jobs WHERE id = ?').bind(jobId).first<{ cost_estimate_usd: number }>();
  return Number(row?.cost_estimate_usd ?? 0);
}

async function getJobCostBreakdown(env: JobEnvironment, job: JobRow): Promise<{
  fullJobReferenceEstimateUsd: number;
  currentOutstandingReservationUsd: number;
  settledResourceEstimateUsd: number;
  settledServiceEstimateUsd: number;
  unobtainedInvoiceUsd: null;
}> {
  const settled = await env.DB.prepare(
    "SELECT SUM(CASE WHEN cost_kind = 'resource' THEN amount_usd ELSE 0 END) AS resource_usd, " +
    "SUM(CASE WHEN cost_kind = 'service' THEN amount_usd ELSE 0 END) AS service_usd FROM cost_phase_ledger WHERE job_id = ?",
  ).bind(job.id).first<{ resource_usd: number | null; service_usd: number | null }>();
  return {
    fullJobReferenceEstimateUsd: Number(job.cost_estimate_usd),
    currentOutstandingReservationUsd: Number(job.cost_reserved),
    settledResourceEstimateUsd: Number(settled?.resource_usd ?? 0),
    settledServiceEstimateUsd: Number(settled?.service_usd ?? 0),
    unobtainedInvoiceUsd: null,
  };
}

async function cancelJob(request: Request, env: JobEnvironment, ownerId: string, jobId: string, drivers: ProfileDriverRouter): Promise<Response> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 512)) return json({ error: 'invalid_request' }, 400);
  const rawText = await readBoundedText(request, 512);
  if (rawText === null) return json({ error: 'invalid_request' }, 400);
  if (rawText.trim() !== '') {
    let value: unknown;
    try { value = JSON.parse(rawText) as unknown; } catch { return json({ error: 'invalid_request' }, 400); }
    if (!isRecord(value) || Object.keys(value).length !== 0) return json({ error: 'invalid_request' }, 400);
  }
  const coordinator = operationStub(env);
  const outcome = await coordinator.requestCancel(ownerId, jobId, Date.now());
  if (!outcome.found) return json({ error: 'not_found' }, 404);
  if (outcome.inFlight && outcome.jobId !== undefined && outcome.epoch !== undefined) {
    const driver = drivers(outcome.inFlight.profileId);
    try {
      const fence = `${jobId}:${outcome.epoch}:${outcome.inFlight.index}:${outcome.inFlight.attempt}:${outcome.inFlight.leaseId}`;
      const stopped = await driver.fetch(new Request('http://container/stop', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fence }),
      }));
      if (!stopped.ok) throw new Error('stop_request_failed');
    } catch { /* Keep the exact lease fenced; the grace path below destroys its profile container. */ }
    const deadline = Date.now() + CANCEL_GRACE_MS;
    while (Date.now() < deadline) {
      if (await coordinator.cancellationSettled(jobId, outcome.epoch, Date.now())) break;
      await new Promise((resolve) => setTimeout(resolve, CANCEL_POLL_MS));
    }
    if (!(await coordinator.cancellationSettled(jobId, outcome.epoch, Date.now()))) {
      const slot = await coordinator.getSlot(Date.now());
      if (slot?.jobId === jobId && slot.epoch === outcome.epoch && slot.leaseId === outcome.inFlight.leaseId && driver.destroy) {
        try {
          await driver.destroy();
          await coordinator.confirmContainerDestroyed(slot, Date.now());
        } catch { /* Keep the global slot held until recovery proves process death. */ }
      }
      await coordinator.cancellationSettled(jobId, outcome.epoch, Date.now());
    }
  }
  const job = await env.DB.prepare('SELECT status, execution_identity_hash FROM jobs WHERE id = ?').bind(jobId)
    .first<{ status: JobStatus; execution_identity_hash: string }>();
  return json({
    jobId, status: job?.status ?? outcome.status ?? 'cancelled',
    cancelRequested: job?.status === 'cancelling' || job?.status === 'cancelled',
    executionIdentityHash: job?.execution_identity_hash ?? '',
    estimatedCostUsd: await getJobEstimate(env, jobId),
    costWarning: (await coordinator.costSnapshot(Date.now())).costWarning,
  });
}

async function handleAdminRequest(request: Request, env: JobEnvironment): Promise<Response> {
  if (!adminSecret(env)) return json({ error: 'service_not_configured' }, 503);
  if (!hasAdminAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const coordinator = operationStub(env);
  const path = new URL(request.url).pathname;
  if (path === KILL_PATH) {
    let mode: 'admission' | 'all' | null;
    if (request.method === 'DELETE') mode = null;
    else if (request.method === 'POST') {
      const value = await readJson(request, 512);
      if (!isRecord(value) || !hasExactKeys(value, ['mode']) || (value.mode !== 'admission' && value.mode !== 'all')) return json({ error: 'invalid_request' }, 400);
      mode = value.mode;
    } else return json({ error: 'not_found' }, 404);
    try { await coordinator.setKillMode(mode, Date.now()); return json({ mode }); } catch { return coordinatorFailure(); }
  }
  if (path === FAULT_PATH) {
    if (request.method === 'DELETE') {
      await coordinator.clearFaultArms(Date.now());
      return json({ cleared: true });
    }
    if (request.method !== 'POST' || env.ANALYSIS_FAULT_FIXTURES_ENABLED !== '1') return json({ error: 'not_found' }, 404);
    const value = await readJson(request, 512);
    if (!isRecord(value) || !['destroy', 'destroy-during', 'throw', 'sigstop'].includes(String(value.kind)) ||
        typeof value.job_id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.job_id) ||
        !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1 ||
        !Number.isSafeInteger(value.position_index) || (value.position_index as number) < 0 || (value.position_index as number) >= MAX_JOB_POSITIONS ||
        !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 0 || (value.attempt as number) > 2) {
      return json({ error: 'invalid_request' }, 400);
    }
    const kind = value.kind as 'destroy' | 'destroy-during' | 'throw' | 'sigstop';
    if ((kind === 'throw' && value.attempt !== 0) || (kind !== 'throw' && value.attempt === 0)) return json({ error: 'invalid_request' }, 400);
    if (kind === 'throw' && (!hasExactKeys(value, ['kind', 'job_id', 'epoch', 'position_index', 'attempt', 'times']) || !Number.isSafeInteger(value.times) || (value.times as number) < 1 || (value.times as number) > 4)) {
      return json({ error: 'invalid_request' }, 400);
    }
    if (kind !== 'throw' && !hasExactKeys(value, ['kind', 'job_id', 'epoch', 'position_index', 'attempt'])) return json({ error: 'invalid_request' }, 400);
    const target = await env.DB.prepare('SELECT owner_id FROM jobs WHERE id = ? AND epoch = ?')
      .bind(value.job_id as string, value.epoch as number).first<{ owner_id: string }>();
    if (!target || !env.ANALYSIS_FAULT_TEST_PRINCIPAL_ID || target.owner_id !== env.ANALYSIS_FAULT_TEST_PRINCIPAL_ID) return json({ error: 'invalid_request' }, 400);
    const arm = {
      kind, jobId: value.job_id, ownerId: target.owner_id,
      epoch: value.epoch as number, positionIndex: value.position_index as number, attempt: value.attempt as number,
      remaining: kind === 'throw' ? value.times as number : 1,
    } as const;
    if (!await coordinator.armFault(arm, Date.now())) return json({ error: 'invalid_request' }, 400);
    return json({ armed: true, kind: arm.kind, jobId: arm.jobId, epoch: arm.epoch, positionIndex: arm.positionIndex, attempt: arm.attempt, remaining: arm.remaining }, 201);
  }
  const clearMatch = /^\/v1\/internal\/profiles\/(free-v1|precision-v1)\/clear-block$/.exec(path);
  if (clearMatch) {
    if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
    const value = await readJson(request, 512);
    if (value !== null && (!isRecord(value) || Object.keys(value).length !== 0)) return json({ error: 'invalid_request' }, 400);
    await coordinator.clearProfileBlock(clearMatch[1], Date.now());
    return json({ profile: clearMatch[1], admissionBlocked: false });
  }
  return json({ error: 'not_found' }, 404);
}

function engineFailure(responseStatus: number, payload: unknown): EngineFailure {
  const record = isRecord(payload) ? payload : {};
  const reason = typeof record.reason === 'string' ? record.reason.toLowerCase() : '';
  const terminal = typeof record.terminal === 'string' ? record.terminal : '';
  const uncertain = responseStatus === 409 || responseStatus === 503 || reason.includes('driver_transport_uncertain') || reason.includes('container_unreachable');
  if (terminal === 'position_failed:engine_timeout' || reason.includes('timeout')) return { code: 'position_failed:engine_timeout', transient: true, fatalProtocol: false, uncertain };
  if (terminal === 'position_failed:engine_exit' || terminal === 'position_failed:engine_restart_failed' || reason.includes('restart_failed') || reason.includes('engine_exit')) {
    return { code: terminal || 'position_failed:engine_exit', transient: true, fatalProtocol: false, uncertain };
  }
  if (responseStatus === 409 || responseStatus === 503 || reason.includes('container_unreachable') || reason.includes('container_not_ready')) {
    return { code: terminal === 'position_failed:engine_restart_failed' ? terminal : 'position_failed:engine_exit', transient: true, fatalProtocol: false, uncertain: true };
  }
  // A 5xx without a driver-reported reason is transport loss (e.g. the container
  // died mid-request or was destroyed by a fault arm): execution state is
  // unknown, so it must take the quarantine path rather than fail closed as a
  // protocol violation. Real protocol failures always arrive with a reason
  // (driver 502 + ProtocolError.reason) or as an invalid 200 contract body.
  if (responseStatus >= 500 && !reason) {
    return { code: 'position_failed:driver_unreachable', transient: false, fatalProtocol: false, uncertain: true };
  }
  return { code: 'position_failed:protocol_error', transient: false, fatalProtocol: true, uncertain: false };
}
function resultWithJobIdentity(value: unknown, identity: JobIdentity, sfen: string, requestedMultiPv: number): {
  result: CloudAnalysisResultV3; statsJson: string | null;
} | null {
  if (!isRecord(value)) return null;
  const { stats, ...result } = value;
  if (
    result.sfen !== sfen || result.requestedMultiPv !== requestedMultiPv || result.engineId !== identity.engineId ||
    result.analysisProfileId !== identity.profileId || result.profileVersion !== identity.profileVersion ||
    result.modelId !== identity.modelId || result.contractVersion !== ANALYSIS_CONTRACT_VERSION || !isCloudAnalysisResultV3(result)
  ) return null;
  return { result, statsJson: isRecord(stats) ? JSON.stringify(stats) : null };
}
async function proveMate(driver: DriverClient, sfen: string): Promise<ProofOutcome> {
  const started = Date.now();
  try {
    const response = await driver.fetch(new Request('http://container/prove', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sfen, plies: PROOF_PLIES, budget: PROOF_BUDGET }),
    }));
    if (!response.ok) return { proof: null, invalid: false, elapsedMs: Math.max(0, Date.now() - started) };
    const value: unknown = await response.json();
    const parsed = parseDriverProof(value, PROOF_PLIES as 1 | 3, PROOF_BUDGET);
    if (!parsed) return { proof: null, invalid: true, elapsedMs: Math.max(0, Date.now() - started) };
    return { proof: toStoredProof(parsed), invalid: false, elapsedMs: Math.max(0, Date.now() - started) };
  } catch { return { proof: null, invalid: false, elapsedMs: Math.max(0, Date.now() - started) }; }
}
async function recordAttemptCostOrThrow(
  env: JobEnvironment, position: ClaimedPosition, attempt: number, amountUsd: number, engineMs: number | null, durationMs: number | null = null,
): Promise<void> {
  if (!await operationStub(env).recordAttemptCost(position, attempt, amountUsd, engineMs, Date.now(), durationMs)) {
    throw new Error('attempt_cost_settlement_failed');
  }
}

async function recordProofCostOrThrow(env: JobEnvironment, position: ClaimedPosition, elapsedMs: number): Promise<number> {
  const boundedElapsedMs = Math.min(Math.max(0, elapsedMs), COST_MODEL.maxProofRuntimeMs);
  const amount = estimateRuntimeCostUsd(boundedElapsedMs, position.identity.instanceType);
  const settled = await operationStub(env).settleReservedPhase({
    jobId: position.jobId, epoch: position.epoch, partKey: `proof:${position.index}`,
    eventKey: `proof:${position.jobId}:${position.epoch}:${position.index}`,
    phase: 'mate_proof', costKind: 'resource', amountUsd: amount, durationMs: boundedElapsedMs,
    evidence: { measured: true, measuredElapsedMs: elapsedMs, boundedByMs: COST_MODEL.maxProofRuntimeMs }, now: Date.now(),
  });
  if (!settled) throw new Error('proof_cost_settlement_failed');
  return amount;
}

function fencingToken(position: ClaimedPosition, attempt: number): string {
  return `${position.jobId}:${position.epoch}:${position.index}:${attempt}:${position.leaseId}`;
}

async function tryDestroyDuringSearch(
  coordinator: DurableObjectStub<JobCoordinator>, driver: DriverClient, position: ClaimedPosition,
  attempt: number, fence: string, leaseDeadline: number, isSettled: () => boolean,
): Promise<void> {
  while (Date.now() < leaseDeadline && !isSettled()) {
    try {
      const response = await driver.fetch(new Request('http://container/health', { method: 'GET' }));
      const value: unknown = response.ok ? await response.json() : null;
      if (isRecord(value) && value.activeFence === fence && value.searchStarted === true) {
        if (await coordinator.consumeFault(position.jobId, position.epoch, position.index, attempt, 'destroy-during', Date.now())) {
          if (!driver.destroy) throw new Error('container_destroy_unavailable');
          await driver.destroy();
        }
        return;
      }
    } catch { /* The armed fault remains available until it expires or a matching go appears. */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function quarantineUnknownExecution(
  position: ClaimedPosition, env: JobEnvironment, driver: DriverClient,
  attempt: number, detail: string,
): Promise<'done' | 'redeliver'> {
  const coordinator = operationStub(env);
  try {
    if (!driver.destroy) throw new Error('container_destroy_unavailable');
    await driver.destroy();
  } catch {
    return 'redeliver';
  }
  const slot = await coordinator.getSlot(Date.now());
  if (!slot || slot.jobId !== position.jobId || slot.epoch !== position.epoch || slot.leaseId !== position.leaseId) return 'redeliver';
  if (!await coordinator.confirmContainerDestroyed(slot, Date.now())) return 'redeliver';
  if (attempt < 2) return 'redeliver';
  await coordinator.failPosition(position, detail, Date.now());
  return 'done';
}

async function processClaimedPosition(initial: ClaimedPosition, env: JobEnvironment, driver: DriverClient, chunk: JobChunk): Promise<'done' | 'skipped' | 'redeliver' | 'busy' | 'cancelled'> {
  const coordinator = operationStub(env);
  const profile = ANALYSIS_PROFILES[initial.identity.profileId];
  const preDispatchRuntime = await verifyAndRecordRuntime(driver, env, initial, chunk, 'pre');
  if (preDispatchRuntime.status === 'mismatch') {
    await coordinator.failPosition(initial, 'position_failed:protocol_error', Date.now(), { fatalProtocol: true });
    return 'done';
  }
  if (preDispatchRuntime.status === 'unreachable') {
    // Nothing was dispatched, so the position's engine work provably did not
    // run. Best effort: destroy the suspect container; fall back to releasing
    // the claim so the position can be redelivered without waiting for lease
    // expiry. The slot only fences real searches, and none exists here.
    try {
      if (!driver.destroy) throw new Error('container_destroy_unavailable');
      await driver.destroy();
      const slot = await coordinator.getSlot(Date.now());
      if (slot?.jobId === initial.jobId && slot.leaseId === initial.leaseId) await coordinator.confirmContainerDestroyed(slot, Date.now());
    } catch {
      await coordinator.releaseForRetry(initial, 'position_failed:driver_unreachable', Date.now());
    }
    return 'redeliver';
  }
  const cache = await coordinator.findCached(initial.identity, initial.sfen);
  if (cache) {
    let cached: unknown;
    try { cached = JSON.parse(cache.resultJson) as unknown; } catch { cached = null; }
    const normalized = resultWithJobIdentity(cached, initial.identity, initial.sfen, profile.requestedMultiPv);
    if (normalized && (normalized.result.terminal === 'ok' || normalized.result.terminal === 'mate')) {
      const seq = await coordinator.commitPosition(initial, JSON.stringify(normalized.result), cache.statsJson, cache.proofJson, true, true, 0, normalized.result.elapsedMs, Date.now());
      return seq === null ? 'skipped' : 'done';
    }
  }
  const attempt = await coordinator.markDispatched(initial, Date.now());
  if (attempt === null) {
    const job = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(initial.jobId).first<{ status: string }>();
    if (job?.status === 'cancelling') return 'cancelled';
    if (initial.attempts >= 2) {
      await coordinator.failPosition(initial, 'position_failed:engine_exit', Date.now());
      return 'done';
    }
    return 'redeliver';
  }
  const current = { ...initial, attempts: attempt };
  const fence = fencingToken(current, attempt);
  if (await coordinator.consumeFault(current.jobId, current.epoch, current.index, attempt, 'destroy', Date.now())) {
    try {
      if (!driver.destroy) throw new Error('container_destroy_unavailable');
      await driver.destroy();
    } catch {
      return 'redeliver';
    }
    const slot = await coordinator.getSlot(Date.now());
    if (slot?.jobId === current.jobId && slot.leaseId === current.leaseId) await coordinator.confirmContainerDestroyed(slot, Date.now());
    if (attempt >= 2) await coordinator.failPosition(current, 'position_failed:engine_exit', Date.now());
    return attempt < 2 ? 'redeliver' : 'done';
  }
  if (await coordinator.consumeFault(current.jobId, current.epoch, current.index, attempt, 'sigstop', Date.now())) {
    if (!driver.prepareSigstop) throw new Error('sigstop_container_restart_unavailable');
    await driver.prepareSigstop(fence);
  }

  const analysisStartedAt = Date.now();
  const responsePromise = analyzeWithServerProfile({
    sfen: current.sfen, movetimeMs: profile.movetimeMs, multipv: profile.requestedMultiPv,
    threads: profile.threads, hashMb: profile.hashMb, fenceToken: fence,
  }, {
    ...(env as WorkerEnv), ANALYSIS_PROFILE_ID: current.identity.profileId,
    ANALYSIS_PROFILE_VERSION: String(current.identity.profileVersion), ANALYSIS_MODEL_ID: current.identity.modelId,
  }, driver);
  let analysisSettled = false;
  void responsePromise.then(() => { analysisSettled = true; }, () => { analysisSettled = true; });
  const liveSlot = await coordinator.getSlot(Date.now());
  const activeFault = await coordinator.faultArmed(current.jobId, current.epoch, current.index, attempt, 'destroy-during', Date.now());
  const destroyTask = activeFault && liveSlot?.leaseId === current.leaseId
    ? tryDestroyDuringSearch(coordinator, driver, current, attempt, fence, liveSlot.leaseExpiresAt, () => analysisSettled).catch(() => undefined)
    : Promise.resolve();
  const response = await responsePromise;
  await destroyTask;
  let value: unknown;
  try { value = await response.json() as unknown; } catch { value = null; }
  const analysisWallMs = Math.max(0, Date.now() - analysisStartedAt);
  const maxAttemptWallMs = profile.movetimeMs + COST_MODEL.searchDeadlineMs + COST_MODEL.processCleanupMs + 500;
  const boundedAttemptWallMs = Math.min(analysisWallMs, maxAttemptWallMs);
  const measuredAttemptCost = estimateRuntimeCostUsd(boundedAttemptWallMs, current.identity.instanceType);
  if (!response.ok) {
    const failure = engineFailure(response.status, value);
    if (failure.uncertain) return quarantineUnknownExecution(current, env, driver, attempt, failure.code);
    await recordAttemptCostOrThrow(env, current, attempt, measuredAttemptCost, null, boundedAttemptWallMs);
    if (failure.transient && attempt < 2) {
      await coordinator.releaseForRetry(current, failure.code, Date.now());
      return 'redeliver';
    }
    await coordinator.failPosition(current, failure.code, Date.now(), { fatalProtocol: failure.fatalProtocol });
    return 'done';
  }
  const normalized = resultWithJobIdentity(value, current.identity, current.sfen, profile.requestedMultiPv);
  if (!normalized) {
    await recordAttemptCostOrThrow(env, current, attempt, measuredAttemptCost, null, boundedAttemptWallMs);
    await coordinator.failPosition(current, 'position_failed:protocol_error', Date.now(), { fatalProtocol: true });
    return 'done';
  }
  const result = normalized.result;
  const terminal = result.terminal as AnalysisTerminal;
  if (result.restartCount > 0) {
    await coordinator.recordEngineRestart({
      jobId: current.jobId, epoch: current.epoch, profileId: current.identity.profileId,
      engineEpoch: result.engineEpoch, restartCount: result.restartCount,
      chunkStart: chunk.start_idx, chunkEnd: chunk.end_idx, now: Date.now(),
    });
  }
  if (result.terminal === 'cancelled') {
    await recordAttemptCostOrThrow(env, current, attempt, measuredAttemptCost, result.elapsedMs, boundedAttemptWallMs);
    const job = await env.DB.prepare('SELECT status FROM jobs WHERE id = ? AND epoch = ?')
      .bind(current.jobId, current.epoch).first<{ status: string }>();
    if (job?.status === 'cancelling') {
      await coordinator.releaseForRetry(current, 'cancelled', Date.now());
      await coordinator.cancellationSettled(current.jobId, current.epoch, Date.now());
    } else {
      await coordinator.failPosition(current, 'cancelled', Date.now(), { resultJson: JSON.stringify(result), statsJson: normalized.statsJson });
    }
    return 'cancelled';
  }
  const disposition = classifyTerminal(terminal);
  if (disposition.evaluationMissing) {
    await recordAttemptCostOrThrow(env, current, attempt, measuredAttemptCost, result.elapsedMs, boundedAttemptWallMs);
    await coordinator.failPosition(current, terminal === 'resign' ? 'evaluation_missing:resign' : 'incomplete', Date.now(), {
      evaluationMissing: true, resultJson: JSON.stringify(result), statsJson: normalized.statsJson,
    });
    return 'done';
  }
  if (terminal.startsWith('position_failed:') || terminal === 'failed') {
    const transient = terminal === 'position_failed:engine_timeout' || terminal === 'position_failed:engine_exit' ||
      terminal === 'position_failed:engine_restart_failed';
    const fatalProtocol = !transient;
    await recordAttemptCostOrThrow(env, current, attempt, measuredAttemptCost, result.elapsedMs, boundedAttemptWallMs);
    if (transient && attempt < 2) {
      await coordinator.releaseForRetry(current, terminal, Date.now());
      return 'redeliver';
    }
    await coordinator.failPosition(current, terminal, Date.now(), {
      fatalProtocol, resultJson: JSON.stringify(result), statsJson: normalized.statsJson,
    });
    return 'done';
  }
  await recordAttemptCostOrThrow(env, current, attempt, measuredAttemptCost, result.elapsedMs, boundedAttemptWallMs);
  const postAnalysisRuntime = await verifyAndRecordRuntime(driver, env, current, chunk, 'post-analysis');
  if (postAnalysisRuntime.status !== 'ok') {
    if (postAnalysisRuntime.status === 'mismatch') {
      await coordinator.failPosition(current, 'position_failed:protocol_error', Date.now(), { fatalProtocol: true });
      return 'done';
    }
    return quarantineUnknownExecution(current, env, driver, attempt, 'position_failed:driver_unreachable');
  }
  const proofOutcome = terminal === 'ok' || terminal === 'mate'
    ? await proveMate(driver, current.sfen)
    : { proof: null, invalid: false, elapsedMs: 0 } satisfies ProofOutcome;
  const proofAmount = terminal === 'ok' || terminal === 'mate'
    ? await recordProofCostOrThrow(env, current, proofOutcome.elapsedMs)
    : 0;
  const postProofRuntime = await verifyAndRecordRuntime(driver, env, current, chunk, 'post-proof');
  if (proofOutcome.invalid || postProofRuntime.status === 'mismatch') {
    await coordinator.failPosition(current, 'position_failed:protocol_error', Date.now(), { fatalProtocol: true });
    return 'done';
  }
  if (postProofRuntime.status === 'unreachable') {
    return quarantineUnknownExecution(current, env, driver, attempt, 'position_failed:driver_unreachable');
  }
  const seq = await coordinator.commitPosition(
    current, JSON.stringify(result), normalized.statsJson, proofOutcome.proof ? JSON.stringify(proofOutcome.proof) : null,
    disposition.cacheEligible, false, measuredAttemptCost + proofAmount, result.elapsedMs, Date.now(),
  );
  return seq === null ? 'skipped' : 'done';
}

function validChunk(value: unknown): value is JobChunk {
  return isRecord(value) && Object.keys(value).length === 4 &&
    typeof value.job_id === 'string' && /^[0-9a-f-]{36}$/.test(value.job_id) &&
    typeof value.epoch === 'number' && typeof value.start_idx === 'number' && typeof value.end_idx === 'number' &&
    Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.start_idx) && Number.isSafeInteger(value.end_idx) &&
    value.start_idx >= 0 && value.end_idx > value.start_idx && value.end_idx <= MAX_JOB_POSITIONS && value.end_idx - value.start_idx <= 8;
}

async function settleInterPositionRuntime(position: ClaimedPosition, previousIndex: number, now: number, env: JobEnvironment): Promise<void> {
  const previous = await env.DB.prepare('SELECT updated_at FROM positions WHERE job_id = ? AND position_index = ?')
    .bind(position.jobId, previousIndex).first<{ updated_at: string }>();
  if (!previous) throw new Error('inter_position_previous_missing');
  const measuredElapsedMs = Math.max(0, now - Date.parse(previous.updated_at));
  if (!Number.isFinite(measuredElapsedMs)) throw new Error('inter_position_timestamp_invalid');
  const durationMs = Math.min(measuredElapsedMs, COST_MODEL.interPositionMaxMs);
  const settled = await operationStub(env).settleReservedPhase({
    jobId: position.jobId, epoch: position.epoch, partKey: `interposition:${previousIndex}`,
    eventKey: `interposition:${position.jobId}:${position.epoch}:${previousIndex}`,
    phase: 'inter_position_runtime', costKind: 'resource',
    amountUsd: estimateRuntimeCostUsd(durationMs, position.identity.instanceType), durationMs,
    evidence: { measuredElapsedMs, boundedByMs: COST_MODEL.interPositionMaxMs, fromPosition: previousIndex, toPosition: position.index }, now,
  });
  if (!settled) throw new Error('inter_position_cost_settlement_failed');
}

async function processChunk(message: JobChunk, env: JobEnvironment, drivers: ProfileDriverRouter): Promise<'ack' | 'retry'> {
  if (!validChunk(message)) throw new TypeError('invalid_queue_message');
  const coordinator = operationStub(env);
  if (await coordinator.consumeFault(message.job_id, message.epoch, message.start_idx, 0, 'throw', Date.now())) throw new Error('armed_pre_claim_failure');
  for (let index = message.start_idx; index < message.end_idx; index += 1) {
    const claim = await coordinator.acquirePosition(message.job_id, index, message.epoch, crypto.randomUUID(), Date.now());
    if (claim.kind === 'busy' || claim.kind === 'quarantine_required') {
      await coordinator.deferBusyDelivery(message.job_id, message.epoch, message.start_idx, Date.now());
      return 'ack';
    }
    if (claim.kind !== 'claimed') continue;
    if (index > message.start_idx) await settleInterPositionRuntime(claim.value, index - 1, Date.now(), env);
    const result = await processClaimedPosition(claim.value, env, drivers(claim.value.identity.profileId), message);
    if (result === 'redeliver' || result === 'busy') return 'retry';
    if (result === 'cancelled') return 'ack';
  }
  await coordinator.finishChunk(message.job_id, message.epoch, Date.now());
  return 'ack';
}
async function handleDeadLetter(batch: MessageBatch<JobChunk>, env: JobEnvironment, drivers: ProfileDriverRouter): Promise<void> {
  const coordinator = operationStub(env);
  for (const message of batch.messages) {
    const chunk = message.body;
    if (!validChunk(chunk)) { message.ack(); continue; }
    const begun = await coordinator.beginDeadLetter(chunk.job_id, chunk.epoch, Date.now());
    if (!begun.current) { message.ack(); continue; }
    if (begun.slot) {
      const driver = drivers(begun.slot.profileId);
      try {
        if (!driver.destroy) throw new Error('container_destroy_unavailable');
        await driver.destroy();
        await coordinator.confirmContainerDestroyed(begun.slot, Date.now());
      } catch {
        message.retry({ delaySeconds: 60 });
        continue;
      }
    }
    await coordinator.finishDeadLetter(chunk.job_id, chunk.epoch, 'dead_lettered', Date.now());
    message.ack();
  }
}
export async function handleJobsQueue(batch: MessageBatch<JobChunk>, env: JobEnvironment, drivers: ProfileDriverRouter): Promise<void> {
  if (batch.queue.endsWith('-dlq')) { await handleDeadLetter(batch, env, drivers); return; }
  if (!batch.queue.includes('-jobs')) { for (const message of batch.messages) message.ack(); return; }
  const coordinator = operationStub(env);
  for (const message of batch.messages) {
    try {
      const result = await processChunk(message.body, env, drivers);
      if (result === 'retry') message.retry({ delaySeconds: 1 });
      else message.ack();
    } catch {
      const chunk = message.body;
      if (validChunk(chunk)) {
      const slot = await coordinator.getSlot(Date.now());
      if (slot?.jobId === chunk.job_id && slot.epoch === chunk.epoch) {
        const driver = drivers(slot.profileId);
        try {
          if (!driver.destroy) throw new Error('container_destroy_unavailable');
          await driver.destroy();
          await coordinator.confirmContainerDestroyed(slot, Date.now());
          } catch {
            message.retry({ delaySeconds: 60 });
            continue;
          }
        }
      }
      message.retry({ delaySeconds: 1 });
    }
  }
}
export async function handleJobsScheduled(env: JobEnvironment, drivers: ProfileDriverRouter): Promise<void> {
  const coordinator = operationStub(env);
  let recovery = await coordinator.recover(Date.now());
  if (recovery.expiredSlot) {
    const driver = drivers(recovery.expiredSlot.profileId);
    try {
      if (!driver.destroy) throw new Error('container_destroy_unavailable');
      await driver.destroy();
      await coordinator.confirmContainerDestroyed(recovery.expiredSlot, Date.now());
    } catch { /* Expiry never releases the slot without confirmed process death. */ }
  }
  recovery = await coordinator.recover(Date.now());
  for (const cancellation of recovery.cancellationJobs) {
    const slot = await coordinator.getSlot(Date.now());
    if (slot?.jobId === cancellation.id && slot.epoch === cancellation.epoch) {
      const driver = drivers(slot.profileId);
      try {
        if (!driver.destroy) throw new Error('container_destroy_unavailable');
        await driver.destroy();
        await coordinator.confirmContainerDestroyed(slot, Date.now());
      } catch { continue; }
    }
    await coordinator.cancellationSettled(cancellation.id, cancellation.epoch, Date.now());
  }
  recovery = await coordinator.recover(Date.now());
  for (const deadLetter of recovery.deadLetterJobs) {
    const slot = await coordinator.getSlot(Date.now());
    if (slot?.jobId === deadLetter.id && slot.epoch === deadLetter.epoch) {
      const driver = drivers(slot.profileId);
      try {
        if (!driver.destroy) throw new Error('container_destroy_unavailable');
        await driver.destroy();
        await coordinator.confirmContainerDestroyed(slot, Date.now());
      } catch { continue; }
    }
    await coordinator.finishDeadLetter(deadLetter.id, deadLetter.epoch, 'dead_lettered', Date.now());
  }
  await coordinator.recover(Date.now());
  await coordinator.cleanup(Date.now());
}
