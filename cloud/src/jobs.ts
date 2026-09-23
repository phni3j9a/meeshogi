import { ANALYSIS_CONTRACT_VERSION, isCloudAnalysisResultV3, isStrictShogiSfen, type CloudAnalysisResultV3 } from '../../src/cloud/analysis-contract';
import { analyzeWithServerProfile, type DriverClient, type WorkerEnv } from './handler';
import { JobCoordinator } from './job-coordinator';
import {
  ANALYSIS_PROFILES,
  decodeResultCursor,
  encodeResultCursor,
  estimateContainerCostUsd,
  profileFor,
  type AdmissionInput,
  type AnalysisProfile,
  type CostSnapshot,
  type ClaimedPosition,
  type JobChunk,
  type JobEnvironment,
  type JobIdentity,
  type JobStatus,
} from './job-types';

const JOB_PATH = '/v1/jobs';
const KILL_PATH = '/v1/internal/kill';
const GLOBAL_COORDINATOR_NAME = 'staging-global';
const MAX_REQUEST_BYTES = 150_000;
const MAX_RESULTS_PAGE = 100;
const FAILURE_TERMINALS = new Set([
  'position_failed:engine_timeout',
  'position_failed:engine_exit',
  'position_failed:engine_restart_failed',
  'position_failed:protocol_error',
]);

type Principal = { id: string; token_sha256: string; precision_enabled: number; revoked: number };
type JobRow = {
  id: string;
  status: JobStatus;
  profile_id: string;
  profile_version: number;
  engine_id: string;
  model_id: string;
  instance_type: string;
  label: string | null;
  position_count: number;
  epoch: number;
  cancel_requested: number;
  committed_count: number;
  failed_count: number;
  stop_reason: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};
type JobPayload = { idempotencyKey: string; profile: AnalysisProfile; positions: string[]; label: string | null };
type EngineFailure = { code: string; redeliver: boolean };

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

export function parseJobPayload(value: unknown): JobPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, ['idempotency_key', 'profile', 'positions', ...(Object.hasOwn(value, 'label') ? ['label'] : [])])) {
    return null;
  }
  if (typeof value.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.idempotency_key)) return null;
  const profile = profileFor(value.profile);
  if (!profile) return null;
  if (!Array.isArray(value.positions) || value.positions.length < 1 || value.positions.length > 512) return null;
  if (!value.positions.every((sfen) => isStrictShogiSfen(sfen))) return null;
  let label: string | null = null;
  if (Object.hasOwn(value, 'label')) {
    if (typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 80 || value.label.trim() !== value.label || /[\u0000-\u001f\u007f]/.test(value.label)) {
      return null;
    }
    label = value.label;
  }
  return { idempotencyKey: value.idempotency_key, profile, positions: value.positions, label };
}

function adminSecret(env: JobEnvironment): string | undefined {
  return env.ANALYSIS_ADMIN_TOKEN ?? env.STAGING_ADMIN_TOKEN;
}

function fixedTimeHexEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 64; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
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
    if (fixedTimeHexEqual(digestHex, principal.token_sha256.toLowerCase())) {
      found = principal;
      matches += 1;
    }
  }
  if (matches !== 1 || !found || found.revoked === 1) return null;
  return found;
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

async function readJson(request: Request, limit: number): Promise<unknown | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) return null;
  const text = await readBoundedText(request, limit);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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
    if (totalBytes > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function sha256Hex(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
}

function jobIdentity(env: JobEnvironment, profile: AnalysisProfile): JobIdentity | null {
  const engineId = env.ANALYSIS_ENGINE_ID;
  const modelId = env.ANALYSIS_MODEL_ID;
  const instanceType = env.ANALYSIS_INSTANCE_TYPE;
  if (!engineId || !modelId || (instanceType !== 'standard-2' && instanceType !== 'standard-3')) return null;
  return { profileId: profile.id, profileVersion: profile.version, engineId, modelId, instanceType };
}

function operationStub(env: JobEnvironment): DurableObjectStub<JobCoordinator> {
  return env.JOB_COORDINATOR.getByName(GLOBAL_COORDINATOR_NAME);
}

function coordinatorFailure(): Response {
  return json({ error: 'coordinator_unavailable' }, 503);
}

function routeIdentity(path: string): { jobId: string; action: 'status' | 'results' | 'cancel' } | null {
  const match = /^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(results|cancel))?$/.exec(path);
  if (!match) return null;
  return { jobId: match[1], action: match[2] === 'results' ? 'results' : match[2] === 'cancel' ? 'cancel' : 'status' };
}

export function isJobApiPath(path: string): boolean {
  return path === JOB_PATH || path.startsWith(`${JOB_PATH}/`) || path === KILL_PATH;
}

export async function handleJobsRequest(request: Request, env: JobEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === KILL_PATH) return handleKillRequest(request, env);
  if (url.pathname === JOB_PATH) return request.method === 'POST' ? createJob(request, env) : json({ error: 'not_found' }, 404);
  const route = routeIdentity(url.pathname);
  if (!route) return json({ error: 'not_found' }, 404);
  if ((route.action === 'status' || route.action === 'results') && request.method !== 'GET') return json({ error: 'not_found' }, 404);
  if (route.action === 'cancel' && request.method !== 'POST') return json({ error: 'not_found' }, 404);

  let principal: Principal | null;
  try {
    principal = await authenticate(request, env.DB);
  } catch {
    return coordinatorFailure();
  }
  if (!principal) return json({ error: 'unauthorized' }, 401);

  const owned = await env.DB.prepare('SELECT id FROM jobs WHERE id = ? AND owner_id = ?')
    .bind(route.jobId, principal.id).first<{ id: string }>();
  if (!owned) return json({ error: 'not_found' }, 404);

  let allowed: boolean;
  try {
    allowed = await operationStub(env).recordOwnerOperation(principal.id, Date.now());
  } catch {
    return coordinatorFailure();
  }
  if (!allowed) return json({ error: 'rate_limit' }, 429);

  if (route.action === 'cancel') return cancelJob(request, env, principal.id, route.jobId);
  if (route.action === 'results') return getJobResults(request, env, route.jobId);
  return getJobSummary(env, route.jobId);
}

async function createJob(request: Request, env: JobEnvironment): Promise<Response> {
  let principal: Principal | null;
  try {
    principal = await authenticate(request, env.DB);
  } catch {
    return coordinatorFailure();
  }
  if (!principal) return json({ error: 'unauthorized' }, 401);

  const raw = await readJson(request, MAX_REQUEST_BYTES);
  const payload = parseJobPayload(raw);
  if (!payload) return json({ error: 'invalid_request' }, 400);
  if (payload.profile.id === 'precision-v1' && principal.precision_enabled !== 1) {
    return json({ error: 'precision_not_enabled' }, 403);
  }
  const identity = jobIdentity(env, payload.profile);
  if (!identity) return json({ error: 'service_not_configured' }, 503);
  const canonicalPayload = JSON.stringify({ profile: payload.profile.id, positions: payload.positions, label: payload.label });
  const admission: AdmissionInput = {
    ownerId: principal.id,
    idempotencyKey: payload.idempotencyKey,
    payloadSha256: await sha256Hex(canonicalPayload),
    profile: payload.profile.id,
    positions: payload.positions,
    label: payload.label,
    identity,
    now: Date.now(),
  };

  let outcome: Awaited<ReturnType<DurableObjectStub<JobCoordinator>['admit']>>;
  try {
    outcome = await operationStub(env).admit(admission);
  } catch {
    return coordinatorFailure();
  }
  if (!outcome.ok) return json({ error: outcome.error }, outcome.status);
  if (outcome.value.enqueuePending) {
    return json({ error: 'queue_unavailable', jobId: outcome.value.jobId }, 503);
  }
  let cost: CostSnapshot;
  let persisted: { status: JobStatus; profile_id: string; profile_version: number; position_count: number } | null;
  let jobCost: { total: number | null } | null;
  try {
    cost = await operationStub(env).costSnapshot(Date.now());
    persisted = await env.DB.prepare(
      'SELECT status, profile_id, profile_version, position_count FROM jobs WHERE id = ?',
    ).bind(outcome.value.jobId).first();
    jobCost = await env.DB.prepare('SELECT SUM(amount_usd) AS total FROM cost_ledger WHERE job_id = ?')
      .bind(outcome.value.jobId).first();
  } catch {
    return coordinatorFailure();
  }
  if (!persisted) return coordinatorFailure();
  const status = outcome.value.duplicate ? 200 : 202;
  return json({
    jobId: outcome.value.jobId,
    status: persisted.status,
    duplicate: outcome.value.duplicate,
    profile: { id: persisted.profile_id, version: persisted.profile_version },
    positionCount: persisted.position_count,
    estimatedCostUsd: Number(jobCost?.total ?? 0),
    costWarning: cost.costWarning,
  }, status, outcome.value.duplicate ? {} : { location: `${JOB_PATH}/${outcome.value.jobId}` });
}

async function getJobSummary(env: JobEnvironment, jobId: string): Promise<Response> {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<JobRow>();
  if (!job) return json({ error: 'not_found' }, 404);
  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'done' AND cached = 1 THEN 1 ELSE 0 END) AS cached
    FROM positions WHERE job_id = ?
  `).bind(jobId).first<{
    pending: number | null; running: number | null; done: number | null; failed: number | null; cached: number | null;
  }>();
  const jobCost = await env.DB.prepare('SELECT SUM(amount_usd) AS total FROM cost_ledger WHERE job_id = ?')
    .bind(jobId).first<{ total: number | null }>();
  const cost = await operationStub(env).costSnapshot(Date.now());
  const cachedPositionCount = Number(counts?.cached ?? 0);
  const profile = profileFor(job.profile_id);
  const instanceType = job.instance_type === 'standard-2' || job.instance_type === 'standard-3'
    ? job.instance_type
    : null;
  const estimatedCacheSavingsUsd = profile && instanceType
    ? cachedPositionCount * estimateContainerCostUsd(
      profile.movetimeMs, 1, instanceType, profile.movetimeMs,
    )
    : 0;
  return json({
    jobId: job.id,
    status: job.status,
    counts: {
      pending: Number(counts?.pending ?? 0),
      running: Number(counts?.running ?? 0),
      done: Number(counts?.done ?? 0),
      failed: Number(counts?.failed ?? 0),
    },
    committedCount: job.committed_count,
    cancelRequested: job.cancel_requested === 1,
    stopReason: job.stop_reason,
    profile: {
      id: job.profile_id,
      version: job.profile_version,
      engineId: job.engine_id,
      modelId: job.model_id,
      instanceType: job.instance_type,
    },
    positionCount: job.position_count,
    cacheStats: { cachedPositionCount, estimatedSavingsUsd: estimatedCacheSavingsUsd },
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    estimatedCostUsd: Number(jobCost?.total ?? 0),
    costWarning: cost.costWarning,
  });
}

async function getJobResults(request: Request, env: JobEnvironment, jobId: string): Promise<Response> {
  const url = new URL(request.url);
  let after: number;
  try {
    after = decodeResultCursor(url.searchParams.get('cursor'));
  } catch {
    return json({ error: 'invalid_cursor' }, 400);
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS_PAGE) return json({ error: 'invalid_limit' }, 400);
  const { results } = await env.DB.prepare(`
    SELECT position_index, status, attempts, result_json, stats_json, cached, error_detail,
      profile_id, profile_version, engine_id, model_id
    FROM positions WHERE job_id = ? AND position_index > ? AND status IN ('done', 'failed')
    ORDER BY position_index LIMIT ?
  `).bind(jobId, after, limit + 1).all<{
    position_index: number; status: 'done' | 'failed'; attempts: number; result_json: string | null;
    stats_json: string | null; cached: number; error_detail: string | null; profile_id: string;
    profile_version: number; engine_id: string; model_id: string;
  }>();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const lastIndex = page.at(-1)?.position_index;
  return json({
    jobId,
    results: page.map((row) => ({
      positionIndex: row.position_index,
      status: row.status,
      attempts: row.attempts,
      result: row.result_json ? JSON.parse(row.result_json) as CloudAnalysisResultV3 : null,
      stats: row.stats_json ? JSON.parse(row.stats_json) as Record<string, number> : null,
      cached: row.cached === 1,
      error: row.error_detail,
      profile: { id: row.profile_id, version: row.profile_version, engineId: row.engine_id, modelId: row.model_id },
    })),
    nextCursor: hasMore && lastIndex !== undefined ? encodeResultCursor(lastIndex) : null,
    limit,
    estimatedCostUsd: await getJobCost(env, jobId),
    costWarning: (await operationStub(env).costSnapshot(Date.now())).costWarning,
  });
}

async function getJobCost(env: JobEnvironment, jobId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT SUM(amount_usd) AS total FROM cost_ledger WHERE job_id = ?')
    .bind(jobId).first<{ total: number | null }>();
  return Number(row?.total ?? 0);
}

async function cancelJob(request: Request, env: JobEnvironment, ownerId: string, jobId: string): Promise<Response> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 512)) {
    return json({ error: 'invalid_request' }, 400);
  }
  const rawText = await readBoundedText(request, 512);
  if (rawText === null) return json({ error: 'invalid_request' }, 400);
  if (rawText.trim() !== '') {
    let value: unknown;
    try { value = JSON.parse(rawText) as unknown; } catch { return json({ error: 'invalid_request' }, 400); }
    if (!isRecord(value) || Object.keys(value).length !== 0) return json({ error: 'invalid_request' }, 400);
  }
  const result = await operationStub(env).requestCancel(ownerId, jobId, Date.now());
  if (!result.found) return json({ error: 'not_found' }, 404);
  const job = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(jobId).first<{ status: JobStatus }>();
  const [estimatedCostUsd, cost] = await Promise.all([
    getJobCost(env, jobId),
    operationStub(env).costSnapshot(Date.now()),
  ]);
  return json({
    jobId,
    status: job?.status ?? 'cancelled',
    cancelRequested: result.cancelRequested,
    estimatedCostUsd,
    costWarning: cost.costWarning,
  });
}

async function handleKillRequest(request: Request, env: JobEnvironment): Promise<Response> {
  const expected = adminSecret(env);
  if (!expected) return json({ error: 'service_not_configured' }, 503);
  if (!hasAdminAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  let mode: 'admission' | 'all' | null;
  if (request.method === 'DELETE') {
    mode = null;
  } else if (request.method === 'POST') {
    const value = await readJson(request, 512);
    if (!isRecord(value) || !hasExactKeys(value, ['mode']) || (value.mode !== 'admission' && value.mode !== 'all')) {
      return json({ error: 'invalid_request' }, 400);
    }
    mode = value.mode;
  } else {
    return json({ error: 'not_found' }, 404);
  }
  try {
    await operationStub(env).setKillMode(mode, Date.now());
    return json({ mode });
  } catch {
    return coordinatorFailure();
  }
}

function engineFailure(responseStatus: number, payload: unknown): EngineFailure {
  const record = isRecord(payload) ? payload : {};
  const reason = typeof record.reason === 'string' ? record.reason.toLowerCase() : '';
  const terminal = typeof record.terminal === 'string' ? record.terminal : '';
  if (terminal === 'position_failed:engine_timeout' || reason.includes('timeout')) {
    return { code: 'position_failed:engine_timeout', redeliver: false };
  }
  if (terminal === 'position_failed:protocol_error' || responseStatus === 502 || reason.includes('protocol') || reason.includes('contract') || reason.includes('score_')) {
    return { code: 'position_failed:protocol_error', redeliver: false };
  }
  if (responseStatus === 503 && !reason) return { code: 'container_unreachable', redeliver: true };
  if (terminal === 'position_failed:engine_restart_failed' || reason.includes('restart_failed')) {
    return { code: 'position_failed:engine_exit', redeliver: false };
  }
  if (responseStatus === 409) return { code: 'container_busy', redeliver: true };
  return { code: 'position_failed:engine_exit', redeliver: false };
}

function resultWithJobIdentity(value: unknown, identity: JobIdentity, sfen: string, requestedMultiPv: number): {
  result: CloudAnalysisResultV3; statsJson: string | null;
} | null {
  if (!isRecord(value)) return null;
  const { stats, ...result } = value;
  if (
    result.sfen !== sfen || result.requestedMultiPv !== requestedMultiPv || result.engineId !== identity.engineId ||
    result.analysisProfileId !== identity.profileId || result.profileVersion !== identity.profileVersion ||
    result.modelId !== identity.modelId
  ) return null;
  if (result.contractVersion !== ANALYSIS_CONTRACT_VERSION || !isCloudAnalysisResultV3(result)) return null;
  const statsJson = isRecord(stats) ? JSON.stringify(stats) : null;
  return { result, statsJson };
}

async function processClaimedPosition(
  position: ClaimedPosition,
  env: JobEnvironment,
  driver: DriverClient,
): Promise<'done' | 'skipped' | 'redeliver'> {
  const profile = ANALYSIS_PROFILES[position.identity.profileId];
  const cache = await operationStub(env).findCached(position.identity, position.sfen);
  if (cache) {
    let cached: unknown;
    try { cached = JSON.parse(cache.resultJson) as unknown; } catch { cached = null; }
    if (
      isCloudAnalysisResultV3(cached) && cached.sfen === position.sfen &&
      cached.analysisProfileId === position.identity.profileId && cached.profileVersion === position.identity.profileVersion &&
      cached.engineId === position.identity.engineId && cached.modelId === position.identity.modelId &&
      cached.requestedMultiPv === profile.requestedMultiPv
    ) {
      const applied = await operationStub(env).commitPosition(
        position, JSON.stringify(cached), cache.statsJson, true, 0, cached.elapsedMs, Date.now(),
      );
      if (!applied) return 'skipped';
      return 'done';
    }
  }

  let current = position;
  while (true) {
    const attempts = await operationStub(env).markDispatched(current.jobId, current.index, current.leaseId, Date.now());
    if (attempts === null) {
      await operationStub(env).failPosition(current, 'engine_retry_exhausted', Date.now());
      return 'done';
    }
    current = { ...current, attempts };
    let response: Response;
    try {
      response = await analyzeWithServerProfile({
        sfen: current.sfen,
        movetimeMs: profile.movetimeMs,
        multipv: profile.requestedMultiPv,
        threads: profile.threads,
        hashMb: profile.hashMb,
      }, {
        ...(env as WorkerEnv),
        ANALYSIS_PROFILE_ID: current.identity.profileId,
        ANALYSIS_PROFILE_VERSION: String(current.identity.profileVersion),
        ANALYSIS_MODEL_ID: current.identity.modelId,
      }, driver);
    } catch {
      await operationStub(env).releaseForRetry(current.jobId, current.index, current.leaseId, 'container_unreachable', Date.now());
      return 'redeliver';
    }
    let value: unknown;
    try { value = await response.json() as unknown; } catch { value = null; }
    if (!response.ok) {
      const failure = engineFailure(response.status, value);
      if (failure.redeliver) {
        await operationStub(env).releaseForRetry(current.jobId, current.index, current.leaseId, failure.code, Date.now());
        return 'redeliver';
      }
      if (attempts < 2) {
        await operationStub(env).releaseForRetry(current.jobId, current.index, current.leaseId, failure.code, Date.now());
        const next = await operationStub(env).acquirePosition(
          current.jobId, current.index, current.epoch, crypto.randomUUID(), Date.now(),
        );
        if (next.kind !== 'claimed') return 'skipped';
        current = next.value;
        continue;
      }
      await operationStub(env).failPosition(current, failure.code, Date.now());
      return 'done';
    }

    const normalized = resultWithJobIdentity(value, current.identity, current.sfen, profile.requestedMultiPv);
    const failureTerminal = isRecord(value) && isRecord(value.result) ? value.result.terminal : isRecord(value) ? value.terminal : undefined;
    const contractFailure = !normalized;
    const positionFailure = typeof failureTerminal === 'string' && FAILURE_TERMINALS.has(failureTerminal);
    if (contractFailure || positionFailure) {
      const failure = positionFailure
        ? engineFailure(200, { terminal: failureTerminal })
        : { code: 'position_failed:protocol_error', redeliver: false };
      if (attempts < 2) {
        await operationStub(env).releaseForRetry(current.jobId, current.index, current.leaseId, failure.code, Date.now());
        const next = await operationStub(env).acquirePosition(
          current.jobId, current.index, current.epoch, crypto.randomUUID(), Date.now(),
        );
        if (next.kind !== 'claimed') return 'skipped';
        current = next.value;
        continue;
      }
      await operationStub(env).failPosition(current, failure.code, Date.now());
      return 'done';
    }

    const result = normalized.result;
    const amountUsd = estimateContainerCostUsd(
      result.elapsedMs, attempts, current.identity.instanceType, profile.movetimeMs,
    );
    try {
      const committed = await operationStub(env).commitPosition(
        current, JSON.stringify(result), normalized.statsJson, false, amountUsd, result.elapsedMs, Date.now(),
      );
      return committed ? 'done' : 'skipped';
    } catch {
      await operationStub(env).releaseForRetry(current.jobId, current.index, current.leaseId, 'commit_retry', Date.now());
      return 'redeliver';
    }
  }
}

async function processChunk(message: JobChunk, env: JobEnvironment, driver: DriverClient): Promise<void> {
  if (
    !isRecord(message) || typeof message.job_id !== 'string' || !Number.isSafeInteger(message.epoch) ||
    !Number.isSafeInteger(message.start_idx) || !Number.isSafeInteger(message.end_idx) ||
    message.start_idx < 0 || message.end_idx <= message.start_idx || message.end_idx > 512 ||
    message.end_idx - message.start_idx > 8
  ) throw new TypeError('invalid_queue_message');
  for (let index = message.start_idx; index < message.end_idx; index += 1) {
    const claim = await operationStub(env).acquirePosition(message.job_id, index, message.epoch, crypto.randomUUID(), Date.now());
    if (claim.kind !== 'claimed') continue;
    const result = await processClaimedPosition(claim.value, env, driver);
    if (result === 'redeliver') throw new Error('job_chunk_retry');
  }
  await operationStub(env).finishJob(message.job_id, message.epoch, Date.now());
}

export async function handleJobsQueue(batch: MessageBatch<JobChunk>, env: JobEnvironment, driver: DriverClient): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processChunk(message.body, env, driver);
      message.ack();
    } catch {
      message.retry();
    }
  }
}
