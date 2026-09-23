import { applyD1Migrations, env, reset, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Position } from 'tsshogi';
import worker from '../src/index';
import type { JobChunk } from '../src/job-types';
import initMigration from '../migrations/0001_init.sql?raw';
import hardeningMigration from '../migrations/0002_async_jobs_hardening.sql?raw';
import { ANALYSIS_PROFILES, executionIdentityComponents, type AnalysisProfile, type JobIdentity } from '../src/job-types';

const OWNER_TOKEN = 'local-owner-token-a';
const OTHER_TOKEN = 'local-owner-token-b';
const REVOKED_TOKEN = 'local-owner-token-revoked';
const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const OPENING_MOVES = ['7g7f', '3c3d', '2g2f', '8c8d'];
const MIGRATIONS = [
  { name: '0001_init.sql', queries: initMigration.split(/;\s*(?:\r?\n|$)/).map((query) => query.trim()).filter(Boolean) },
  { name: '0002_async_jobs_hardening.sql', queries: hardeningMigration.split(/;\s*(?:\r?\n|$)/).map((query) => query.trim()).filter(Boolean) },
];

const FIXTURE_MOVES: Record<number, string[]> = {
  2: ['3g3f'], 15: ['8g8f'], 20: ['9g9f'], 30: ['5g5f'], 31: ['4g4f'], 47: ['8g8f'],
  77: ['2g2f'], 901: ['3g3f'], 902: ['7g7f'], 906: ['6g6f'], 908: ['9g9f'], 910: ['5g5f'],
  912: ['7g7f', '3c3d'], 913: ['7g7f', '8c8d'],
};

function sfenAfter(moves: string[]): string {
  const position = Position.newBySFEN(SFEN);
  if (!position) throw new Error('invalid_test_sfen');
  for (const usi of moves) {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move) || !position.doMove(move)) throw new Error(`illegal_test_move:${usi}`);
  }
  return position.sfen;
}

function sfenAt(marker: number): string {
  return sfenAfter(FIXTURE_MOVES[marker] ?? []);
}

async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedPrincipal(id: string, token: string, options: { precision?: boolean; revoked?: boolean } = {}): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO principals(id, token_sha256, label, precision_enabled, revoked, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    await tokenDigest(token),
    id,
    options.precision ? 1 : 0,
    options.revoked ? 1 : 0,
    new Date().toISOString(),
  ).run();
}

async function identity(profileId: 'free-v1' | 'precision-v1'): Promise<JobIdentity> {
  const profile = ANALYSIS_PROFILES[profileId];
  const engineId = 'YaneuraOu NNUE 9.70git 64AVX2';
  const modelId = 'local-test-model';
  const engineBinaryDigestLabel = 'sha256:test-engine-digest-label';
  const executionIdentityComponents = executionIdentityComponentsFor(profile, engineId, modelId, engineBinaryDigestLabel);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(executionIdentityComponents)));
  return {
    profileId, profileVersion: 2, engineId, modelId, engineBinaryDigestLabel,
    instanceType: profile.instanceType, vcpu: profile.vcpu,
    executionIdentityHash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    executionIdentityComponents,
  };
}

function executionIdentityComponentsFor(profile: AnalysisProfile, engineId: string, modelId: string, digest: string) {
  return executionIdentityComponents(profile, engineId, modelId, digest);
}

function request(path: string, token?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

async function createJob(
  positions: string | string[],
  options: { token?: string; key?: string; profile?: 'free-v1' | 'precision-v1'; extra?: Record<string, unknown>; moves?: string[] } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await SELF.fetch(request('/v1/jobs', options.token ?? OWNER_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      idempotency_key: options.key ?? crypto.randomUUID(),
      profile: options.profile ?? 'free-v1',
      initialSfen: typeof positions === 'string' ? positions : positions[0],
      moves: options.moves ?? (typeof positions === 'string' ? [] : OPENING_MOVES.slice(0, Math.max(0, positions.length - 1))),
      ...options.extra,
    }),
  }));
  return { response, body: await response.json() as Record<string, unknown> };
}

async function waitForJob(jobId: string, statuses: string[], timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await env.DB.prepare('SELECT status, stop_reason, committed_count FROM jobs WHERE id = ?')
      .bind(jobId).first<{ status: string; stop_reason: string | null; committed_count: number }>();
    if (job && statuses.includes(job.status)) {
      const counts = await env.DB.prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM positions WHERE job_id = ?
      `).bind(jobId).first<{ pending: number | null; running: number | null; done: number | null; failed: number | null }>();
      return {
        status: job.status,
        stopReason: job.stop_reason,
        committedCount: job.committed_count,
        counts: {
          pending: Number(counts?.pending ?? 0),
          running: Number(counts?.running ?? 0),
          done: Number(counts?.done ?? 0),
          failed: Number(counts?.failed ?? 0),
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const row = await env.DB.prepare('SELECT status, stop_reason FROM jobs WHERE id = ?').bind(jobId)
    .first<{ status: string; stop_reason: string | null }>();
  const positions = await env.DB.prepare('SELECT position_index, status, attempts, delivery_count, error_detail, engine_terminal, lease_id, lease_expires_at FROM positions WHERE job_id = ? ORDER BY position_index')
    .bind(jobId).all<Record<string, unknown>>();
  const slot = await env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1').first<Record<string, unknown>>();
  const outboxes = await env.DB.prepare('SELECT * FROM outbox WHERE job_id = ?').bind(jobId).all<Record<string, unknown>>();
  const queueError = await env.DB.prepare("SELECT value FROM flags WHERE key = 'test_queue_error'").first<{ value: string }>();
  throw new Error(`job ${jobId} did not reach ${statuses.join('|')}; database=${JSON.stringify(row)}; positions=${JSON.stringify(positions.results)}; slot=${JSON.stringify(slot)}; outbox=${JSON.stringify(outboxes.results)}; queueError=${queueError?.value ?? 'none'}`);
}

async function waitForPosition(jobId: string, index: number, status: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare('SELECT status FROM positions WHERE job_id = ? AND position_index = ?')
      .bind(jobId, index).first<{ status: string }>();
    if (row?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = await env.DB.prepare('SELECT status, attempts FROM positions WHERE job_id = ? AND position_index = ?')
    .bind(jobId, index).first<{ status: string; attempts: number }>();
  throw new Error(`position ${jobId}/${index} did not reach ${status}; database=${JSON.stringify(row)}`);
}

async function seedCost(amountUsd: number, jobId = `cost-seed-${crypto.randomUUID()}`): Promise<void> {
  void jobId;
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO daily_cost(day_utc, spent_usd, reserved_usd, updated_at) VALUES (?, ?, 0, ?) ' +
    'ON CONFLICT(day_utc) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd, updated_at = excluded.updated_at',
  ).bind(now.slice(0, 10), amountUsd, now).run();
}

beforeEach(async () => {
  await env.JOB_COORDINATOR.getByName('staging-global').clearLocalTestRateWindows();
  await applyD1Migrations(env.DB, MIGRATIONS);
  await seedPrincipal('owner-a', OWNER_TOKEN);
  await seedPrincipal('owner-b', OTHER_TOKEN, { precision: true });
  await seedPrincipal('owner-revoked', REVOKED_TOKEN, { revoked: true });
});

afterEach(async () => {
  await env.JOB_COORDINATOR.getByName('staging-global').clearLocalTestRateWindows();
  // Let a terminal queue delivery finish its ack before reset() removes the test D1 schema.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await reset();
});

describe('async jobs running in local workerd with D1 and Queues', () => {
  it('admits, dispatches and commits contract-v3 results with profile identity', async () => {
    const created = await createJob([SFEN]);
    expect(created.response.status).toBe(202);
    const jobId = String(created.body.jobId);
    const job = await waitForJob(jobId, ['completed']);
    expect(job.counts).toEqual({ pending: 0, running: 0, done: 1, failed: 0 });
    const statusResponse = await SELF.fetch(request(`/v1/jobs/${jobId}`, OWNER_TOKEN));
    const statusBody = await statusResponse.json() as Record<string, unknown>;
    expect(statusResponse.status).toBe(200);
    expect(statusBody).toMatchObject({
      status: 'completed',
      committedCount: 1,
      profile: { id: 'free-v1', version: 2, engineId: 'YaneuraOu NNUE 9.70git 64AVX2', modelId: 'local-test-model', instanceType: 'standard-2', vcpu: 1 },
      counts: { pending: 0, running: 0, processed: 1, succeeded: 1, incompleteOrMissing: 0, failed: 0, terminal: 0 },
      costWarning: false,
    });
    expect(typeof statusBody.estimatedCostUsd).toBe('number');
    const resultsResponse = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=1`, OWNER_TOKEN));
    const resultsBody = await resultsResponse.json() as { results: Array<Record<string, unknown>>; costWarning: boolean; resumeCursor: string; hasMore: boolean };
    expect(resultsResponse.status).toBe(200);
    expect(resultsBody.results).toHaveLength(1);
    const result = resultsBody.results[0].result as Record<string, unknown>;
    expect(result.contractVersion).toBe(3);
    expect(result.analysisProfileId).toBe('free-v1');
    expect(result.profileVersion).toBe(2);
    expect(result.modelId).toBe('local-test-model');
    expect(result.engineBestmove).toBe('7g7f');
    expect(resultsBody.results[0].positionIndex).toBe(0);
    expect(resultsBody.results[0].attempts).toBe(1);
    expect(resultsBody.results[0].status).toBe('done');
    expect(resultsBody.costWarning).toBe(false);
    expect(resultsBody.hasMore).toBe(false);
    expect(resultsBody.resumeCursor).toBeTruthy();
  });

  it('replays public move input and routes each profile with an identity-scoped cache', async () => {
    const profilesResponse = await SELF.fetch(request('/v1/analysis-profiles', OWNER_TOKEN));
    const profilesBody = await profilesResponse.json() as { profiles: Array<Record<string, unknown>> };
    expect(profilesResponse.status).toBe(200);
    expect(profilesBody.profiles).toHaveLength(2);
    expect(profilesBody.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'free-v1', version: 2, entitled: true }),
      expect.objectContaining({ id: 'precision-v1', version: 2, entitled: false }),
    ]));
    expect(profilesBody.profiles[0].executionIdentityHash).not.toBe(profilesBody.profiles[1].executionIdentityHash);

    const illegal = await SELF.fetch(request('/v1/jobs', OWNER_TOKEN, {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(), profile: 'free-v1', initialSfen: SFEN, moves: ['7g7f', '7g7f'],
      }),
    }));
    expect(illegal.status).toBe(400);
    expect(await illegal.json()).toMatchObject({ error: 'illegal_move', moveIndex: 1 });

    const initialSfen = SFEN;
    const first = await createJob(initialSfen, { moves: ['7g7f'] });
    expect(first.response.status).toBe(202);
    expect(first.body.positionCount).toBe(2);
    await waitForJob(String(first.body.jobId), ['completed']);

    const sameIdentity = await createJob(initialSfen, { moves: ['7g7f'] });
    await waitForJob(String(sameIdentity.body.jobId), ['completed']);
    const freeCache = await env.DB.prepare('SELECT cached FROM positions WHERE job_id = ? ORDER BY position_index')
      .bind(String(sameIdentity.body.jobId)).all<{ cached: number }>();
    expect(freeCache.results).toEqual([{ cached: 1 }, { cached: 1 }]);

    const precision = await createJob(initialSfen, { token: OTHER_TOKEN, profile: 'precision-v1', moves: ['7g7f'] });
    expect(precision.response.status).toBe(202);
    await waitForJob(String(precision.body.jobId), ['completed']);
    const precisionRows = await env.DB.prepare('SELECT cached, stats_json, execution_identity_hash FROM positions WHERE job_id = ? ORDER BY position_index')
      .bind(String(precision.body.jobId)).all<{ cached: number; stats_json: string; execution_identity_hash: string }>();
    expect(precisionRows.results).toHaveLength(2);
    expect(precisionRows.results.every((row) => row.cached === 0 && row.execution_identity_hash === precision.body.executionIdentityHash)).toBe(true);
    expect(JSON.parse(precisionRows.results[0].stats_json).engineCpuMs).toBe(40);
  });

  it('records mate proof separately and stores incomplete results as failed without caching', async () => {
    const mate = await createJob(sfenAfter(['4g4f', '5c5d']));
    await waitForJob(String(mate.body.jobId), ['completed']);
    const proofRow = await env.DB.prepare('SELECT proof_json FROM positions WHERE job_id = ? AND position_index = 0')
      .bind(String(mate.body.jobId)).first<{ proof_json: string | null }>();
    expect(JSON.parse(proofRow?.proof_json ?? 'null')).toMatchObject({
      revision: 'sekirei-proof-ops-v1', result: 'not-mate', plies: 3, budget: 10_000, cost: 1,
    });

    const incompleteSfen = sfenAfter(['7g7f', '3c3d']);
    const incomplete = await createJob(incompleteSfen);
    const job = await waitForJob(String(incomplete.body.jobId), ['failed']);
    expect(job.counts).toEqual({ pending: 0, running: 0, done: 0, failed: 1 });
    const position = await env.DB.prepare('SELECT status, attempts, error_detail, engine_terminal FROM positions WHERE job_id = ?')
      .bind(String(incomplete.body.jobId)).first<{ status: string; attempts: number; error_detail: string; engine_terminal: string }>();
    expect(position).toEqual({ status: 'failed', attempts: 1, error_detail: 'incomplete', engine_terminal: 'incomplete' });
    const cache = await env.DB.prepare('SELECT COUNT(*) AS count FROM result_cache WHERE sfen = ? AND quarantined = 0')
      .bind(incompleteSfen).first<{ count: number }>();
    expect(cache?.count).toBe(0);
  });

  it('blocks profile admission on protocol faults until an admin clears the block', async () => {
    const created = await createJob(SFEN, { moves: ['7g7f', '8c8d'] });
    const job = await waitForJob(String(created.body.jobId), ['partial']);
    expect(job.stopReason).toBe('position_failed:protocol_error');
    const blocked = await createJob(SFEN, { key: 'blocked-profile-attempt' });
    expect(blocked.response.status).toBe(503);
    expect(blocked.body.error).toBe('profile_admission_blocked');
    const clear = await SELF.fetch(request('/v1/internal/profiles/free-v1/clear-block', 'local-analysis-admin-token', {
      method: 'POST', body: '{}',
    }));
    expect(clear.status).toBe(200);
    const profiles = await SELF.fetch(request('/v1/analysis-profiles', OWNER_TOKEN));
    const profileBody = await profiles.json() as { profiles: Array<{ id: string; admissionBlocked: boolean }> };
    expect(profileBody.profiles.find((profile) => profile.id === 'free-v1')?.admissionBlocked).toBe(false);
  });

  it('enforces new-key POST and GET rate windows with Retry-After', async () => {
    const first = await createJob(sfenAt(902), { key: 'rate-window-replay' });
    expect(first.response.status).toBe(202);
    await waitForJob(String(first.body.jobId), ['completed']);
    await env.JOB_COORDINATOR.getByName('staging-global').setKillMode('admission', Date.now());
    await env.JOB_COORDINATOR.getByName('staging-global').seedLocalTestRateWindow('owner-a', 'post', Date.now(), 5);
    const replay = await createJob(sfenAt(902), { key: 'rate-window-replay' });
    expect(replay.response.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    const allowedPost = await createJob(SFEN, { key: 'rate-window-new-allowed' });
    expect(allowedPost.body.error).toBe('admission_disabled');
    const limitedPost = await createJob(SFEN, { key: 'rate-window-new-limited' });
    expect(limitedPost.body.error).toBe('rate_limit');
    expect(limitedPost?.response.status).toBe(429);
    expect(limitedPost?.response.headers.get('retry-after')).toBeTruthy();

    await env.JOB_COORDINATOR.getByName('staging-global').seedLocalTestRateWindow('owner-a', 'get', Date.now(), 120);
    const limitedGet = await SELF.fetch(request('/v1/analysis-profiles', OWNER_TOKEN));
    expect(limitedGet.status).toBe(429);
    expect(limitedGet?.headers.get('retry-after')).toBeTruthy();
    await env.JOB_COORDINATOR.getByName('staging-global').setKillMode(null, Date.now());
  }, 45_000);

  it('keeps completed jobs unchanged on cancel and terminalizes current-epoch DLQ only', async () => {
    const completed = await createJob([SFEN]);
    const completedId = String(completed.body.jobId);
    await waitForJob(completedId, ['completed']);
    const lateCancel = await SELF.fetch(request(`/v1/jobs/${completedId}/cancel`, OWNER_TOKEN, { method: 'POST' }));
    expect((await lateCancel.json() as Record<string, unknown>).status).toBe('completed');

    const active = await createJob(sfenAt(902));
    const activeId = String(active.body.jobId);
    await waitForPosition(activeId, 0, 'running');
    let currentAck = false;
    let currentRetry = false;
    await worker.queue({
      queue: 'meeshogi-analysis-local-test-dlq',
      messages: [{ body: { job_id: activeId, epoch: 1, start_idx: 0, end_idx: 1 }, ack: () => { currentAck = true; }, retry: () => { currentRetry = true; } }],
    } as unknown as MessageBatch<JobChunk>, env);
    expect(currentAck).toBe(true);
    expect(currentRetry).toBe(false);
    const terminal = await env.DB.prepare('SELECT status, stop_reason, cost_reserved FROM jobs WHERE id = ?')
      .bind(activeId).first<{ status: string; stop_reason: string; cost_reserved: number }>();
    expect(terminal).toMatchObject({ status: 'failed', stop_reason: 'dead_lettered', cost_reserved: 0 });
    const slot = await env.DB.prepare('SELECT job_id FROM global_search_slot WHERE singleton = 1').first<{ job_id: string | null }>();
    expect(slot?.job_id).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));

    let staleAck = false;
    let staleRetry = false;
    await worker.queue({
      queue: 'meeshogi-analysis-local-test-dlq',
      messages: [{ body: { job_id: crypto.randomUUID(), epoch: 1, start_idx: 0, end_idx: 1 }, ack: () => { staleAck = true; }, retry: () => { staleRetry = true; } }],
    } as unknown as MessageBatch<JobChunk>, env);
    expect(staleAck).toBe(true);
    expect(staleRetry).toBe(false);
  });

  it('returns the original job on idempotent replay and rejects a payload conflict', async () => {
    const key = 'same-request-key';
    const first = await createJob([sfenAt(902)], { key });
    expect(first.response.status).toBe(202);
    const firstId = first.body.jobId;
    const replay = await createJob([sfenAt(902)], { key });
    expect(replay.response.status).toBe(200);
    expect(replay.body.jobId).toBe(firstId);
    expect(replay.body.duplicate).toBe(true);
    const conflict = await createJob([sfenAt(2)], { key });
    expect(conflict.response.status).toBe(409);
    await waitForJob(String(firstId), ['completed']);
    const reserved = await env.DB.prepare("SELECT jobs_reserved FROM quota_usage WHERE owner_id = 'owner-a'")
      .first<{ jobs_reserved: number }>();
    expect(reserved?.jobs_reserved).toBe(1);
  });

  it('allows a bounded waiting queue while the global real-search slot remains singular', async () => {
    const active = await createJob(sfenAfter(['8g8f']), { key: 'concurrent-a' });
    expect(active.response.status).toBe(202);
    const activeId = String(active.body.jobId);
    await waitForPosition(activeId, 0, 'running');

    const waiting = await createJob([sfenAt(902)], { key: 'concurrent-b', token: OTHER_TOKEN });
    expect(waiting.response.status).toBe(202);
    const waitingId = String(waiting.body.jobId);
    let acknowledged = false;
    let retried = false;
    await worker.queue({
      queue: 'meeshogi-analysis-local-test-jobs',
      messages: [{ body: { job_id: waitingId, epoch: 1, start_idx: 0, end_idx: 1 }, ack: () => { acknowledged = true; }, retry: () => { retried = true; } }],
    } as unknown as MessageBatch<JobChunk>, env);
    expect(acknowledged).toBe(true);
    expect(retried).toBe(false);
    const deferred = await env.DB.prepare('SELECT delivery_count, last_sent_at FROM outbox WHERE job_id = ?')
      .bind(waitingId).first<{ delivery_count: number; last_sent_at: string }>();
    expect(deferred?.delivery_count).toBe(1);
    expect(Date.parse(deferred?.last_sent_at ?? '')).toBeLessThan(Date.now() - 60_000);
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() } as ScheduledController, env);
    const recovered = await env.DB.prepare('SELECT delivery_count FROM outbox WHERE job_id = ?')
      .bind(waitingId).first<{ delivery_count: number }>();
    expect(recovered?.delivery_count).toBe(2);

    await waitForJob(activeId, ['completed']);
    await waitForJob(waitingId, ['completed']);
  });

  it('cancels between positions, preserves committed results and leaves later rows pending', async () => {
    const created = await createJob(sfenAt(910), { moves: ['4c4d', '3g3f'] });
    const jobId = String(created.body.jobId);
    await waitForPosition(jobId, 0, 'done');
    await waitForPosition(jobId, 1, 'running');
    const cancel = await SELF.fetch(request(`/v1/jobs/${jobId}/cancel`, OWNER_TOKEN, { method: 'POST' }));
    expect(cancel.status).toBe(200);
    const finished = await waitForJob(jobId, ['cancelled']);
    expect(finished.counts).toEqual({ pending: 2, running: 0, done: 1, failed: 0 });
    const rows = await env.DB.prepare('SELECT position_index, status FROM positions WHERE job_id = ? ORDER BY position_index')
      .bind(jobId).all<{ position_index: number; status: string }>();
    expect(rows.results).toEqual([
      { position_index: 0, status: 'done' },
      { position_index: 1, status: 'pending' },
      { position_index: 2, status: 'pending' },
    ]);
    const reservation = await env.DB.prepare('SELECT cost_reserved FROM jobs WHERE id = ?')
      .bind(jobId).first<{ cost_reserved: number }>();
    expect(reservation?.cost_reserved).toBe(0);
  });

  it('retries engine timeouts once and stops after three consecutive failed positions', async () => {
    const created = await createJob([sfenAt(77)]);
    const jobId = String(created.body.jobId);
    const failed = await waitForJob(jobId, ['failed']);
    expect(failed.stopReason).toBe('position_failures');
    const row = await env.DB.prepare('SELECT status, attempts, error_detail FROM positions WHERE job_id = ? AND position_index = 0')
      .bind(jobId).first<{ status: string; attempts: number; error_detail: string }>();
    expect(row).toEqual({ status: 'failed', attempts: 2, error_detail: 'position_failed:engine_timeout' });
    const failedLedger = await env.DB.prepare('SELECT SUM(amount_usd) AS amount_usd, COUNT(*) AS attempts FROM cost_attempt_ledger WHERE job_id = ? AND position_index = 0')
      .bind(jobId).first<{ amount_usd: number; attempts: number }>();
    expect(failedLedger?.amount_usd).toBeGreaterThan(0);
    expect(failedLedger?.attempts).toBe(2);

    const threshold = await createJob(sfenAt(906), { moves: ['3c3d', '2g2f', '8c8d'] });
    const stopped = await waitForJob(String(threshold.body.jobId), ['failed']);
    expect(stopped.stopReason).toBe('failure_threshold');
    const failures = await env.DB.prepare('SELECT status, attempts FROM positions WHERE job_id = ? ORDER BY position_index')
      .bind(String(threshold.body.jobId)).all<{ status: string; attempts: number }>();
    expect(failures.results.slice(0, 3)).toEqual([
      { status: 'failed', attempts: 2 },
      { status: 'failed', attempts: 2 },
      { status: 'failed', attempts: 2 },
    ]);
    expect(failures.results[3]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('resumes a transient chunk redelivery without repeating committed positions or resetting attempts', async () => {
    const created = await createJob(sfenAt(901), { moves: ['8c8d', '2g2f'] });
    const jobId = String(created.body.jobId);
    const finished = await waitForJob(jobId, ['completed']);
    expect(finished.counts).toEqual({ pending: 0, running: 0, done: 3, failed: 0 });
    const rows = await env.DB.prepare('SELECT position_index, status, attempts FROM positions WHERE job_id = ? ORDER BY position_index')
      .bind(jobId).all<{ position_index: number; status: string; attempts: number }>();
    expect(rows.results).toEqual([
      { position_index: 0, status: 'done', attempts: 1 },
      { position_index: 1, status: 'done', attempts: 2 },
      { position_index: 2, status: 'done', attempts: 1 },
    ]);
    const ledger = await env.DB.prepare('SELECT COUNT(*) AS count FROM cost_ledger WHERE job_id = ?')
      .bind(jobId).first<{ count: number }>();
    expect(ledger?.count).toBe(3);
  });

  it('skips duplicate queue deliveries without adding results or charges twice', async () => {
    const created = await createJob([sfenAt(15)]);
    const jobId = String(created.body.jobId);
    await waitForJob(jobId, ['completed']);
    const duplicate: JobChunk = { job_id: jobId, epoch: 1, start_idx: 0, end_idx: 1 };
    let acknowledged = false;
    let retried = false;
    await worker.queue({
      queue: 'meeshogi-analysis-local-test-jobs',
      messages: [{ body: duplicate, ack: () => { acknowledged = true; }, retry: () => { retried = true; } }],
    } as unknown as MessageBatch<JobChunk>, env);
    expect(acknowledged).toBe(true);
    expect(retried).toBe(false);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS count FROM cost_ledger WHERE job_id = ?')
      .bind(jobId).first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it('serves exact-match cached results at zero engine cost', async () => {
    const first = await createJob([sfenAt(20)]);
    await waitForJob(String(first.body.jobId), ['completed']);
    const second = await createJob([sfenAt(20)]);
    await waitForJob(String(second.body.jobId), ['completed']);
    const row = await env.DB.prepare('SELECT status, attempts, cached FROM positions WHERE job_id = ? AND position_index = 0')
      .bind(String(second.body.jobId)).first<{ status: string; attempts: number; cached: number }>();
    expect(row).toEqual({ status: 'done', attempts: 0, cached: 1 });
    const ledger = await env.DB.prepare('SELECT amount_usd, cached FROM cost_ledger WHERE job_id = ?')
      .bind(String(second.body.jobId)).first<{ amount_usd: number; cached: number }>();
    expect(ledger).toEqual({ amount_usd: 0, cached: 1 });
    const status = await SELF.fetch(request(`/v1/jobs/${second.body.jobId}`, OWNER_TOKEN));
    const statusBody = await status.json() as { cacheStats: { cachedPositionCount: number; estimatedSavingsUsd: number } };
    expect(statusBody.cacheStats.cachedPositionCount).toBe(1);
    expect(statusBody.cacheStats.estimatedSavingsUsd).toBeGreaterThan(0);
  });

  it('enforces authentication, revocation, profile entitlement, and cross-owner 404s', async () => {
    const unauthorized = await SELF.fetch(request('/v1/jobs', undefined, {
      method: 'POST', body: JSON.stringify({ idempotency_key: 'missing-auth', profile: 'free-v1', initialSfen: SFEN, moves: [] }),
    }));
    expect(unauthorized.status).toBe(401);
    const oversized = await SELF.fetch(request('/v1/jobs', OWNER_TOKEN, {
      method: 'POST',
      body: `${JSON.stringify({ idempotency_key: 'oversized', profile: 'free-v1', initialSfen: SFEN, moves: [] })}${' '.repeat(150_001)}`,
    }));
    expect(oversized.status).toBe(400);
    const revoked = await createJob([SFEN], { token: REVOKED_TOKEN });
    expect(revoked.response.status).toBe(401);
    const precision = await createJob([SFEN], { token: OWNER_TOKEN, profile: 'precision-v1' });
    expect(precision.response.status).toBe(403);
    const enabledPrecision = await createJob([sfenAt(47)], { token: OTHER_TOKEN, profile: 'precision-v1' });
    expect(enabledPrecision.response.status).toBe(202);
    const precisionJob = await waitForJob(String(enabledPrecision.body.jobId), ['completed']);
    expect(precisionJob.counts).toEqual({ pending: 0, running: 0, done: 1, failed: 0 });
    const precisionResult = await env.DB.prepare('SELECT result_json FROM positions WHERE job_id = ? AND position_index = 0')
      .bind(String(enabledPrecision.body.jobId)).first<{ result_json: string }>();
    expect(JSON.parse(precisionResult?.result_json ?? '{}')).toMatchObject({
      analysisProfileId: 'precision-v1',
      profileVersion: 2,
      requestedMultiPv: 3,
      modelId: 'local-test-model',
    });

    const created = await createJob([SFEN]);
    const jobId = String(created.body.jobId);
    const foreignGet = await SELF.fetch(request(`/v1/jobs/${jobId}`, OTHER_TOKEN));
    const foreignCancel = await SELF.fetch(request(`/v1/jobs/${jobId}/cancel`, OTHER_TOKEN, { method: 'POST' }));
    expect(foreignGet.status).toBe(404);
    expect(foreignCancel.status).toBe(404);
    await waitForJob(jobId, ['completed']);
  });

  it('returns 429 when the UTC-day quota is exhausted and resets on the next day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(`
      INSERT INTO quota_usage(owner_id, day_utc, profile_id, jobs_reserved, positions_reserved, updated_at)
      VALUES ('owner-a', ?, 'free-v1', 5, 20, ?)
    `).bind(today, new Date().toISOString()).run();
    const exhausted = await createJob([sfenAt(30)]);
    expect(exhausted.response.status).toBe(429);
    expect(exhausted.body.error).toBe('daily_quota_exceeded');

    const dayOne = Date.parse('2026-09-20T23:59:00.000Z');
    const coordinator = env.JOB_COORDINATOR.getByName('staging-global');
    const freeIdentity = await identity('free-v1');
    const admission = (key: string, now: number) => coordinator.admit({
      ownerId: 'owner-b',
      idempotencyKey: key,
      payloadSha256: key.padEnd(64, '0').slice(0, 64),
      profile: 'free-v1',
      positions: [sfenAt(31)],
      label: null,
      identity: freeIdentity,
      now,
    });
    const previousDay = await admission('direct-day-one', dayOne);
    expect(previousDay.ok).toBe(true);
    if (!previousDay.ok) return;
    await waitForJob(previousDay.value.jobId, ['completed'], 20_000);
    const nextDay = await admission('direct-day-two', dayOne + 86_400_000);
    expect(nextDay.ok).toBe(true);
    if (nextDay.ok) await waitForJob(nextDay.value.jobId, ['completed'], 20_000);
    const quota = await env.DB.prepare("SELECT day_utc, jobs_reserved FROM quota_usage WHERE owner_id = 'owner-b' AND profile_id = 'free-v1' ORDER BY day_utc")
      .all<{ day_utc: string; jobs_reserved: number }>();
    expect(quota.results).toEqual([
      { day_utc: '2026-09-20', jobs_reserved: 1 },
      { day_utc: '2026-09-21', jobs_reserved: 1 },
    ]);
  });

  it('caps admissions at one dollar and stops an active job after its in-flight position', async () => {
    await seedCost(1);
    const capped = await createJob([SFEN]);
    expect(capped.response.status).toBe(503);
    expect(capped.body.error).toBe('daily_cost_cap');

    await env.DB.prepare('DELETE FROM daily_cost').run();
    await seedCost(0.95);
    const created = await createJob(sfenAt(908), { moves: ['1c1d', '2g2f'] });
    expect(created.response.status).toBe(202);
    const jobId = String(created.body.jobId);
    await waitForPosition(jobId, 0, 'done');
    await waitForPosition(jobId, 1, 'running');
    await seedCost(0.06);
    const finished = await waitForJob(jobId, ['partial']);
    expect(finished.stopReason).toBe('cost_cap');
    expect(finished.counts).toEqual({ pending: 1, running: 0, done: 2, failed: 0 });
  });

  it('pages more than 100 terminal rows in stable order including an interleaved failure', async () => {
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const result = JSON.stringify({
      contractVersion: 3,
      analysisProfileId: 'free-v1',
      profileVersion: 2,
      engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
      modelId: 'local-test-model',
      sfen: sfenAt(1),
      candidates: [],
      actualNodes: 0,
      completedDepth: 0,
      elapsedMs: 0,
      multipv: 0,
      requestedMultiPv: 2,
      effectiveMultiPv: 0,
      rootLegalMoveCount: 0,
      completedAt: now,
      terminal: 'incomplete',
      engineEpoch: 'synthetic-page-fixture',
      restartCount: 0,
      processId: 1,
      engineBestmove: '7g7f',
    });
    await env.DB.prepare(`
      INSERT INTO jobs(
        id, owner_id, status, profile_id, profile_version, engine_id, model_id, instance_type,
        position_count, epoch, committed_count, failed_count, created_at, started_at, completed_at, updated_at, execution_identity_hash
      ) VALUES (?, 'owner-a', 'partial', 'free-v1', 2, 'YaneuraOu NNUE 9.70git 64AVX2', 'local-test-model',
        'standard-2', 101, 1, 100, 1, ?, ?, ?, ?, 'identity-page')
    `).bind(jobId, now, now, now, now).run();
    const statements = Array.from({ length: 101 }, (_, index) => {
      const failed = index === 76;
      return env.DB.prepare(`
        INSERT INTO positions(
          job_id, position_index, sfen, status, attempts, result_json, stats_json, cached, error_detail,
          profile_id, profile_version, engine_id, model_id, updated_at, result_seq, execution_identity_hash
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, 'free-v1', 2, 'YaneuraOu NNUE 9.70git 64AVX2', 'local-test-model', ?, ?, 'identity-page')
      `).bind(
        jobId, index, sfenAt(index + 1), failed ? 'failed' : 'done', failed ? 2 : 1,
        failed ? null : result, failed ? 'position_failed:engine_timeout' : null, now,
        index === 0 ? 101 : index === 100 ? 1 : index + 1,
      );
    });
    await env.DB.batch(statements.slice(0, 50));
    await env.DB.batch(statements.slice(50));
    const first = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=100`, OWNER_TOKEN));
    const pageOne = await first.json() as { results: Array<{ positionIndex: number; status: string }>; nextCursor: string | null; resumeCursor: string };
    expect(pageOne.results).toHaveLength(100);
    expect(pageOne.results.find((row) => row.positionIndex === 76)).toMatchObject({ positionIndex: 76, status: 'failed' });
    expect(pageOne.nextCursor).not.toBeNull();
    const second = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=100&cursor=${pageOne.nextCursor}`, OWNER_TOKEN));
    const pageTwo = await second.json() as { results: Array<{ positionIndex: number }>; nextCursor: string | null; resumeCursor: string };
    expect(pageTwo.results).toMatchObject([{ positionIndex: 0 }]);
    expect(pageTwo.nextCursor).toBeNull();
    expect(pageTwo).toHaveProperty('resumeCursor');
    const empty = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=100&cursor=${pageTwo.resumeCursor}`, OWNER_TOKEN));
    const emptyBody = await empty.json() as { results: unknown[]; hasMore: boolean; resumeCursor: string };
    expect(emptyBody).toMatchObject({ results: [], hasMore: false, resumeCursor: pageTwo.resumeCursor });
    const stable = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=100`, OWNER_TOKEN));
    const stableBody = await stable.json() as { results: Array<{ positionIndex: number }> };
    expect(stableBody.results.map((row) => row.positionIndex)).toEqual(pageOne.results.map((row) => row.positionIndex));
  });
});
