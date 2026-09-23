import { applyD1Migrations, env, reset, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { JobChunk } from '../src/job-types';
import initMigration from '../migrations/0001_init.sql?raw';

const OWNER_TOKEN = 'local-owner-token-a';
const OTHER_TOKEN = 'local-owner-token-b';
const REVOKED_TOKEN = 'local-owner-token-revoked';
const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const MIGRATIONS = [{
  name: '0001_init.sql',
  queries: initMigration.split(/;\s*(?:\r?\n|$)/).map((query) => query.trim()).filter(Boolean),
}];

function sfenAt(moveNumber: number): string {
  return SFEN.replace(/ \d+$/, ` ${moveNumber}`);
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

function request(path: string, token?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

async function createJob(
  positions: string[],
  options: { token?: string; key?: string; profile?: 'free-v1' | 'precision-v1'; extra?: Record<string, unknown> } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await SELF.fetch(request('/v1/jobs', options.token ?? OWNER_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      idempotency_key: options.key ?? crypto.randomUUID(),
      profile: options.profile ?? 'free-v1',
      positions,
      ...options.extra,
    }),
  }));
  return { response, body: await response.json() as Record<string, unknown> };
}

async function waitForJob(jobId: string, statuses: string[], timeoutMs = 20_000): Promise<Record<string, unknown>> {
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
  throw new Error(`job ${jobId} did not reach ${statuses.join('|')}; database=${JSON.stringify(row)}`);
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
  await env.DB.prepare(`
    INSERT INTO cost_ledger(job_id, position_index, owner_id, profile_id, amount_usd, attempts, cached, engine_ms, created_at)
    VALUES (?, 0, 'cost-seed', 'free-v1', ?, 1, 0, 0, ?)
  `).bind(jobId, amountUsd, new Date().toISOString()).run();
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, MIGRATIONS);
  await seedPrincipal('owner-a', OWNER_TOKEN);
  await seedPrincipal('owner-b', OTHER_TOKEN, { precision: true });
  await seedPrincipal('owner-revoked', REVOKED_TOKEN, { revoked: true });
});

afterEach(async () => {
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
      profile: { id: 'free-v1', version: 1, engineId: 'YaneuraOu NNUE 9.70git 64AVX2', modelId: 'local-test-model' },
      counts: { pending: 0, running: 0, done: 1, failed: 0 },
      costWarning: false,
    });
    expect(typeof statusBody.estimatedCostUsd).toBe('number');
    const resultsResponse = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=1`, OWNER_TOKEN));
    const resultsBody = await resultsResponse.json() as { results: Array<Record<string, unknown>>; costWarning: boolean };
    expect(resultsResponse.status).toBe(200);
    expect(resultsBody.results).toHaveLength(1);
    const result = resultsBody.results[0].result as Record<string, unknown>;
    expect(result.contractVersion).toBe(3);
    expect(result.analysisProfileId).toBe('free-v1');
    expect(result.profileVersion).toBe(1);
    expect(result.modelId).toBe('local-test-model');
    expect(result.engineBestmove).toBe('7g7f');
    expect(resultsBody.results[0].positionIndex).toBe(0);
    expect(resultsBody.results[0].attempts).toBe(1);
    expect(resultsBody.results[0].status).toBe('done');
    expect(resultsBody.costWarning).toBe(false);
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

  it('allows only one global active job for concurrent create requests', async () => {
    const attempts = await Promise.all([
      createJob([sfenAt(902)], { key: 'concurrent-a' }),
      createJob([sfenAt(902)], { key: 'concurrent-b', token: OTHER_TOKEN }),
    ]);
    expect(attempts.map((item) => item.response.status).sort()).toEqual([202, 429]);
    const accepted = attempts.find((item) => item.response.status === 202);
    expect(accepted).toBeDefined();
    await waitForJob(String(accepted?.body.jobId), ['completed']);
  });

  it('cancels between positions, preserves committed results and leaves later rows pending', async () => {
    const created = await createJob([sfenAt(1), sfenAt(902), sfenAt(3)]);
    const jobId = String(created.body.jobId);
    await waitForPosition(jobId, 0, 'done');
    await waitForPosition(jobId, 1, 'running');
    const cancel = await SELF.fetch(request(`/v1/jobs/${jobId}/cancel`, OWNER_TOKEN, { method: 'POST' }));
    expect(cancel.status).toBe(200);
    const finished = await waitForJob(jobId, ['cancelled']);
    expect(finished.counts).toEqual({ pending: 1, running: 0, done: 2, failed: 0 });
    const rows = await env.DB.prepare('SELECT position_index, status FROM positions WHERE job_id = ? ORDER BY position_index')
      .bind(jobId).all<{ position_index: number; status: string }>();
    expect(rows.results).toEqual([
      { position_index: 0, status: 'done' },
      { position_index: 1, status: 'done' },
      { position_index: 2, status: 'pending' },
    ]);
  });

  it('retries engine timeouts once and stops after three consecutive failed positions', async () => {
    const created = await createJob([sfenAt(77)]);
    const jobId = String(created.body.jobId);
    const failed = await waitForJob(jobId, ['failed']);
    expect(failed.stopReason).toBe('position_failures');
    const row = await env.DB.prepare('SELECT status, attempts, error_detail FROM positions WHERE job_id = ? AND position_index = 0')
      .bind(jobId).first<{ status: string; attempts: number; error_detail: string }>();
    expect(row).toEqual({ status: 'failed', attempts: 2, error_detail: 'position_failed:engine_timeout' });
    const failedLedger = await env.DB.prepare('SELECT amount_usd, attempts, engine_ms FROM cost_ledger WHERE job_id = ? AND position_index = 0')
      .bind(jobId).first<{ amount_usd: number; attempts: number; engine_ms: number | null }>();
    expect(failedLedger?.amount_usd).toBeGreaterThan(0);
    expect(failedLedger).toMatchObject({ attempts: 2, engine_ms: null });

    const threshold = await createJob([sfenAt(900), sfenAt(900), sfenAt(900), sfenAt(4)]);
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
    const created = await createJob([sfenAt(10), sfenAt(901), sfenAt(11)]);
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
      method: 'POST', body: JSON.stringify({ idempotency_key: 'missing-auth', profile: 'free-v1', positions: [SFEN] }),
    }));
    expect(unauthorized.status).toBe(401);
    const oversized = await SELF.fetch(request('/v1/jobs', OWNER_TOKEN, {
      method: 'POST',
      body: `${JSON.stringify({ idempotency_key: 'oversized', profile: 'free-v1', positions: [SFEN] })}${' '.repeat(150_001)}`,
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
      profileVersion: 1,
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
    const admission = (key: string, now: number) => coordinator.admit({
      ownerId: 'owner-b',
      idempotencyKey: key,
      payloadSha256: key.padEnd(64, '0').slice(0, 64),
      profile: 'free-v1',
      positions: [sfenAt(31)],
      label: null,
      identity: {
        profileId: 'free-v1', profileVersion: 1, engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
        modelId: 'local-test-model', instanceType: 'standard-2',
      },
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
    expect(capped.body.error).toBe('cost_cap');

    await env.DB.prepare('DELETE FROM cost_ledger').run();
    await seedCost(0.9985);
    const created = await createJob([sfenAt(40), sfenAt(902), sfenAt(41)]);
    expect(created.response.status).toBe(202);
    const jobId = String(created.body.jobId);
    await waitForPosition(jobId, 0, 'done');
    await waitForPosition(jobId, 1, 'running');
    await seedCost(0.01);
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
      profileVersion: 1,
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
        position_count, epoch, committed_count, failed_count, created_at, started_at, completed_at, updated_at
      ) VALUES (?, 'owner-a', 'partial', 'free-v1', 1, 'YaneuraOu NNUE 9.70git 64AVX2', 'local-test-model',
        'standard-2', 101, 1, 100, 1, ?, ?, ?, ?)
    `).bind(jobId, now, now, now, now).run();
    const statements = Array.from({ length: 101 }, (_, index) => {
      const failed = index === 76;
      return env.DB.prepare(`
        INSERT INTO positions(
          job_id, position_index, sfen, status, attempts, result_json, stats_json, cached, error_detail,
          profile_id, profile_version, engine_id, model_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, 'free-v1', 1, 'YaneuraOu NNUE 9.70git 64AVX2', 'local-test-model', ?)
      `).bind(
        jobId, index, sfenAt(index + 1), failed ? 'failed' : 'done', failed ? 2 : 1,
        failed ? null : result, failed ? 'position_failed:engine_timeout' : null, now,
      );
    });
    await env.DB.batch(statements.slice(0, 50));
    await env.DB.batch(statements.slice(50));
    const first = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=100`, OWNER_TOKEN));
    const pageOne = await first.json() as { results: Array<{ positionIndex: number; status: string }>; nextCursor: string | null };
    expect(pageOne.results).toHaveLength(100);
    expect(pageOne.results[76]).toMatchObject({ positionIndex: 76, status: 'failed' });
    expect(pageOne.nextCursor).not.toBeNull();
    const second = await SELF.fetch(request(`/v1/jobs/${jobId}/results?limit=100&cursor=${pageOne.nextCursor}`, OWNER_TOKEN));
    const pageTwo = await second.json() as { results: Array<{ positionIndex: number }>; nextCursor: string | null };
    expect(pageTwo.results).toMatchObject([{ positionIndex: 100 }]);
    expect(pageTwo.nextCursor).toBeNull();
  });
});
