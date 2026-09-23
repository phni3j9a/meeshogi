import { DurableObject } from 'cloudflare:workers';
import { ANALYSIS_PROFILES, estimateContainerCostUsd, finalJobStatus, quotaAllows } from './job-types';
import type {
  AdmissionInput,
  AdmissionOutcome,
  AdmissionResult,
  CacheEntry,
  ClaimedPosition,
  CostSnapshot,
  JobChunk,
  JobEnvironment,
  JobIdentity,
} from './job-types';

const CHUNK_SIZE = 8;
const LEASE_MS = 180_000;
type IdempotencyRow = { job_id: string; payload_sha256: string };
type QuotaRow = { jobs_reserved: number; positions_reserved: number };
type JobRow = {
  id: string;
  owner_id: string;
  status: string;
  profile_id: JobIdentity['profileId'];
  profile_version: number;
  engine_id: string;
  model_id: string;
  instance_type: JobIdentity['instanceType'];
  position_count: number;
  epoch: number;
  cancel_requested: number;
  committed_count: number;
  failed_count: number;
  consecutive_failures: number;
  stop_reason: string | null;
};
type PositionRow = { sfen: string; status: string; attempts: number; lease_expires_at: number | null };
type OutboxRow = { id: number; job_id: string; epoch: number; start_idx: number; end_idx: number };

type ClaimOutcome = { kind: 'claimed'; value: ClaimedPosition } | { kind: 'skip' | 'busy' | 'stopped' };

function iso(now: number): string {
  return new Date(now).toISOString();
}

function manyInserts(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  batchSize = 10,
): D1PreparedStatement[] {
  const tuple = `(${columns.map(() => '?').join(',')})`;
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${batch.map(() => tuple).join(',')}`;
    statements.push(db.prepare(sql).bind(...batch.flat()));
  }
  return statements;
}

function isActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}

export class JobCoordinator extends DurableObject<JobEnvironment> {
  private tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: JobEnvironment) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rate_windows (
        scope TEXT NOT NULL,
        minute INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (scope, minute)
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS global_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async first<T>(statement: D1PreparedStatement): Promise<T | null> {
    return await statement.first<T>();
  }

  private rateCount(scope: string, now: number): number {
    const minute = Math.floor(now / 60_000);
    const row = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT count FROM rate_windows WHERE scope = ? AND minute = ?', scope, minute)
      .toArray()[0];
    return row?.count ?? 0;
  }

  private consumeRate(scope: string, now: number, maximum: number): boolean {
    const minute = Math.floor(now / 60_000);
    if (this.rateCount(scope, now) >= maximum) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_windows(scope, minute, count) VALUES (?, ?, 1)
       ON CONFLICT(scope, minute) DO UPDATE SET count = count + 1`,
      scope,
      minute,
    );
    this.ctx.storage.sql.exec('DELETE FROM rate_windows WHERE minute < ?', minute - 2);
    return true;
  }

  private async currentKillMode(): Promise<'admission' | 'all' | null> {
    const row = await this.first<{ value: string }>(
      this.env.DB.prepare("SELECT value FROM flags WHERE key = 'kill_mode'"),
    );
    return row?.value === 'admission' || row?.value === 'all' ? row.value : null;
  }

  private async globalCost(): Promise<number> {
    const row = await this.first<{ total: number | null }>(
      this.env.DB.prepare('SELECT SUM(amount_usd) AS total FROM cost_ledger'),
    );
    const total = Number(row?.total ?? 0);
    this.ctx.storage.sql.exec(
      `INSERT INTO global_state(key, value, updated_at) VALUES ('estimated_cost_usd', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      String(total),
      new Date().toISOString(),
    );
    return total;
  }

  private async flushOutbox(jobId: string, now: number): Promise<boolean> {
    const { results } = await this.env.DB.prepare(
      'SELECT id, job_id, epoch, start_idx, end_idx FROM outbox WHERE job_id = ? AND sent_at IS NULL ORDER BY id',
    ).bind(jobId).all<OutboxRow>();
    if (results.length === 0) return false;
    const messages: JobChunk[] = results.map((row) => ({
      job_id: row.job_id,
      epoch: row.epoch,
      start_idx: row.start_idx,
      end_idx: row.end_idx,
    }));
    try {
      await this.env.JOB_QUEUE.sendBatch(messages.map((body) => ({ body })));
      const placeholders = results.map(() => '?').join(',');
      await this.env.DB.prepare(
        `UPDATE outbox SET sent_at = ? WHERE sent_at IS NULL AND id IN (${placeholders})`,
      ).bind(iso(now), ...results.map((row) => row.id)).run();
      return false;
    } catch {
      return true;
    }
  }

  async admit(input: AdmissionInput): Promise<AdmissionOutcome> {
    return this.serialized(async () => {
      const existing = await this.first<IdempotencyRow>(this.env.DB.prepare(
        'SELECT job_id, payload_sha256 FROM idempotency WHERE owner_id = ? AND idempotency_key = ?',
      ).bind(input.ownerId, input.idempotencyKey));
      if (existing) {
        if (existing.payload_sha256 !== input.payloadSha256) return { ok: false, status: 409, error: 'idempotency_conflict' };
        const enqueuePending = await this.flushOutbox(existing.job_id, input.now);
        return { ok: true, value: { jobId: existing.job_id, duplicate: true, enqueuePending } };
      }

      if (!this.consumeRate('new-posts', input.now, 6)) return { ok: false, status: 429, error: 'rate_limit' };
      const killMode = await this.currentKillMode();
      if (killMode) return { ok: false, status: 503, error: 'admission_disabled' };
      if (await this.globalCost() >= 1) return { ok: false, status: 503, error: 'cost_cap' };

      const globalActive = await this.first<{ id: string }>(this.env.DB.prepare(
        "SELECT id FROM jobs WHERE status IN ('queued', 'running') LIMIT 1",
      ));
      if (globalActive) return { ok: false, status: 429, error: 'global_active_job_limit' };
      const ownerActive = await this.first<{ id: string }>(this.env.DB.prepare(
        "SELECT id FROM jobs WHERE owner_id = ? AND status IN ('queued', 'running') LIMIT 1",
      ).bind(input.ownerId));
      if (ownerActive) return { ok: false, status: 429, error: 'active_job_limit' };

      const day = new Date(input.now).toISOString().slice(0, 10);
      const quota = await this.first<QuotaRow>(this.env.DB.prepare(
        'SELECT jobs_reserved, positions_reserved FROM quota_usage WHERE owner_id = ? AND day_utc = ? AND profile_id = ?',
      ).bind(input.ownerId, day, input.profile));
      if (!quotaAllows(input.profile, quota?.jobs_reserved ?? 0, quota?.positions_reserved ?? 0, input.positions.length)) {
        return { ok: false, status: 429, error: 'daily_quota_exceeded' };
      }

      const jobId = crypto.randomUUID();
      const createdAt = iso(input.now);
      const positionRows = input.positions.map((sfen, index) => [
        jobId, index, sfen, input.profile, input.identity.profileVersion, input.identity.engineId, input.identity.modelId, createdAt,
      ] as const);
      const outboxRows: (string | number | null)[][] = [];
      for (let start = 0; start < input.positions.length; start += CHUNK_SIZE) {
        outboxRows.push([jobId, 1, start, Math.min(start + CHUNK_SIZE, input.positions.length), createdAt, null]);
      }
      const statements: D1PreparedStatement[] = [
        this.env.DB.prepare(`
          INSERT INTO jobs (
            id, owner_id, status, profile_id, profile_version, engine_id, model_id, instance_type,
            label, position_count, epoch, created_at, updated_at
          ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).bind(
          jobId, input.ownerId, input.identity.profileId, input.identity.profileVersion,
          input.identity.engineId, input.identity.modelId, input.identity.instanceType,
          input.label, input.positions.length, createdAt, createdAt,
        ),
        this.env.DB.prepare(
          'INSERT INTO idempotency(owner_id, idempotency_key, job_id, payload_sha256, created_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(input.ownerId, input.idempotencyKey, jobId, input.payloadSha256, createdAt),
        this.env.DB.prepare(`
          INSERT INTO quota_usage(owner_id, day_utc, profile_id, jobs_reserved, positions_reserved, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(owner_id, day_utc, profile_id) DO UPDATE SET
            jobs_reserved = jobs_reserved + 1,
            positions_reserved = positions_reserved + excluded.positions_reserved,
            updated_at = excluded.updated_at
        `).bind(input.ownerId, day, input.identity.profileId, input.positions.length, createdAt),
        ...manyInserts(this.env.DB, 'positions', [
          'job_id', 'position_index', 'sfen', 'profile_id', 'profile_version', 'engine_id', 'model_id', 'updated_at',
        ], positionRows),
        ...manyInserts(this.env.DB, 'outbox', [
          'job_id', 'epoch', 'start_idx', 'end_idx', 'created_at', 'sent_at',
        ], outboxRows),
      ];
      await this.env.DB.batch(statements);
      const enqueuePending = await this.flushOutbox(jobId, input.now);
      return { ok: true, value: { jobId, duplicate: false, enqueuePending } };
    });
  }

  async recordOwnerOperation(ownerId: string, now: number): Promise<boolean> {
    return this.serialized(async () => this.consumeRate(`owner:${ownerId}`, now, 10));
  }

  async costSnapshot(now: number): Promise<CostSnapshot> {
    return this.serialized(async () => {
      const estimatedCostUsd = await this.globalCost();
      return { estimatedCostUsd, costWarning: estimatedCostUsd >= 0.5, costCapped: estimatedCostUsd >= 1 };
    });
  }

  async setKillMode(mode: 'admission' | 'all' | null, now: number): Promise<'admission' | 'all' | null> {
    return this.serialized(async () => {
      if (mode === null) {
        await this.env.DB.prepare("DELETE FROM flags WHERE key = 'kill_mode'").run();
      } else {
        await this.env.DB.prepare(`
          INSERT INTO flags(key, value, updated_at) VALUES ('kill_mode', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).bind(mode, iso(now)).run();
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO global_state(key, value, updated_at) VALUES ('kill_mode', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        mode ?? '',
        iso(now),
      );
      return mode;
    });
  }

  async requestCancel(ownerId: string, jobId: string, now: number): Promise<{ found: boolean; cancelRequested: boolean }> {
    return this.serialized(async () => {
      const job = await this.first<{ status: string; cancel_requested: number }>(this.env.DB.prepare(
        'SELECT status, cancel_requested FROM jobs WHERE id = ? AND owner_id = ?',
      ).bind(jobId, ownerId));
      if (!job) return { found: false, cancelRequested: false };
      if (isActive(job.status)) {
        await this.env.DB.prepare(`
          UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND owner_id = ?
        `).bind(iso(now), jobId, ownerId).run();
        return { found: true, cancelRequested: true };
      }
      return { found: true, cancelRequested: job.cancel_requested === 1 };
    });
  }

  async findCached(identity: JobIdentity, sfen: string): Promise<CacheEntry | null> {
    return this.serialized(async () => {
      const row = await this.first<{ result_json: string; stats_json: string | null }>(this.env.DB.prepare(`
        SELECT result_json, stats_json FROM result_cache
        WHERE contract_version = 3 AND engine_id = ? AND model_id = ? AND profile_id = ? AND profile_version = ? AND sfen = ?
      `).bind(identity.engineId, identity.modelId, identity.profileId, identity.profileVersion, sfen));
      if (!row) return null;
      await this.env.DB.prepare(`
        UPDATE result_cache SET last_used_at = ?
        WHERE contract_version = 3 AND engine_id = ? AND model_id = ? AND profile_id = ? AND profile_version = ? AND sfen = ?
      `).bind(new Date().toISOString(), identity.engineId, identity.modelId, identity.profileId, identity.profileVersion, sfen).run();
      return { resultJson: row.result_json, statsJson: row.stats_json };
    });
  }

  async acquirePosition(jobId: string, index: number, epoch: number, leaseId: string, now: number): Promise<ClaimOutcome> {
    return this.serialized(async () => {
      const job = await this.first<JobRow>(this.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId));
      if (!job || job.epoch !== epoch || !isActive(job.status)) return { kind: 'skip' };
      if (job.cancel_requested === 1) {
        await this.stopJob(jobId, 'cancelled', now);
        return { kind: 'stopped' };
      }
      const killMode = await this.currentKillMode();
      const estimatedCostUsd = await this.globalCost();
      if (killMode === 'all' || estimatedCostUsd >= 1) {
        await this.stopJob(jobId, estimatedCostUsd >= 1 ? 'cost_cap' : 'admin_kill', now);
        return { kind: 'stopped' };
      }

      const position = await this.first<PositionRow>(this.env.DB.prepare(`
        SELECT sfen, status, attempts, lease_expires_at FROM positions WHERE job_id = ? AND position_index = ?
      `).bind(jobId, index));
      if (!position || position.status === 'done' || position.status === 'failed') return { kind: 'skip' };
      if (position.status === 'running' && (position.lease_expires_at ?? 0) > now) return { kind: 'busy' };
      const nextLeaseExpiry = now + LEASE_MS;
      const update = await this.env.DB.prepare(`
        UPDATE positions SET status = 'running', lease_id = ?, lease_expires_at = ?, error_detail = NULL, updated_at = ?
        WHERE job_id = ? AND position_index = ? AND status IN ('pending', 'running')
          AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).bind(leaseId, nextLeaseExpiry, iso(now), jobId, index, now).run();
      if (update.meta.changes === 0) return { kind: 'busy' };
      await this.env.DB.prepare(`
        UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
      `).bind(iso(now), iso(now), jobId).run();
      return {
        kind: 'claimed',
        value: {
          jobId, ownerId: job.owner_id, epoch, index, sfen: position.sfen,
          attempts: position.attempts, leaseId, cancelRequested: false,
          identity: {
            profileId: job.profile_id, profileVersion: job.profile_version as 1,
            engineId: job.engine_id, modelId: job.model_id, instanceType: job.instance_type,
          },
        },
      };
    });
  }

  async markDispatched(jobId: string, index: number, leaseId: string, now: number): Promise<number | null> {
    return this.serialized(async () => {
      const row = await this.first<{ attempts: number }>(this.env.DB.prepare(`
        SELECT attempts FROM positions WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?
      `).bind(jobId, index, leaseId));
      if (!row || row.attempts >= 2) return null;
      await this.env.DB.prepare(`
        UPDATE positions SET attempts = attempts + 1, updated_at = ?
        WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?
      `).bind(iso(now), jobId, index, leaseId).run();
      return row.attempts + 1;
    });
  }

  async releaseForRetry(jobId: string, index: number, leaseId: string, detail: string, now: number): Promise<void> {
    await this.serialized(async () => {
      await this.env.DB.prepare(`
        UPDATE positions SET status = 'pending', lease_id = NULL, lease_expires_at = NULL, error_detail = ?, updated_at = ?
        WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?
      `).bind(detail.slice(0, 120), iso(now), jobId, index, leaseId).run();
    });
  }

  async commitPosition(
    position: ClaimedPosition,
    resultJson: string,
    statsJson: string | null,
    cached: boolean,
    amountUsd: number,
    engineMs: number,
    now: number,
  ): Promise<boolean> {
    return this.serialized(async () => {
      const createdAt = iso(now);
      await this.env.DB.batch([
        this.env.DB.prepare(`
          UPDATE positions SET status = 'done', result_json = ?, stats_json = ?, cached = ?, error_detail = NULL,
            lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?
        `).bind(resultJson, statsJson, cached ? 1 : 0, createdAt, position.jobId, position.index, position.leaseId),
        this.env.DB.prepare(`
          INSERT OR IGNORE INTO result_cache (
            contract_version, engine_id, model_id, profile_id, profile_version, sfen,
            result_json, stats_json, created_at, last_used_at
          ) SELECT 3, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = 'done' AND lease_id = ?
          )
        `).bind(
          position.identity.engineId, position.identity.modelId, position.identity.profileId,
          position.identity.profileVersion, position.sfen, resultJson, statsJson, createdAt, createdAt,
          position.jobId, position.index, position.leaseId,
        ),
        this.env.DB.prepare(`
          INSERT OR IGNORE INTO cost_ledger(job_id, position_index, owner_id, profile_id, amount_usd, attempts, cached, engine_ms, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = 'done' AND lease_id = ?
          )
        `).bind(
          position.jobId, position.index, position.ownerId, position.identity.profileId, cached ? 0 : amountUsd,
          position.attempts, cached ? 1 : 0, engineMs, createdAt,
          position.jobId, position.index, position.leaseId,
        ),
        this.env.DB.prepare(`
          UPDATE jobs SET
            committed_count = (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'done'),
            failed_count = (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'failed'),
            consecutive_failures = 0,
            status = CASE
              WHEN cancel_requested = 1 THEN 'cancelled'
              WHEN NOT EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status IN ('pending', 'running'))
                THEN CASE WHEN EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status = 'failed')
                  THEN CASE WHEN EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status = 'done') THEN 'partial' ELSE 'failed' END
                  ELSE 'completed' END
              ELSE 'running' END,
            stop_reason = CASE
              WHEN cancel_requested = 1 THEN COALESCE(stop_reason, 'cancelled')
              WHEN NOT EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status IN ('pending', 'running'))
                AND EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status = 'failed')
                THEN COALESCE(stop_reason, 'position_failures')
              ELSE stop_reason END,
            completed_at = CASE
              WHEN cancel_requested = 1 OR NOT EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status IN ('pending', 'running'))
                THEN COALESCE(completed_at, ?) ELSE completed_at END,
            updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `).bind(
          position.jobId, // committed_count
          position.jobId, // failed_count
          position.jobId, // status: pending/running
          position.jobId, // status: failed
          position.jobId, // status: done
          position.jobId, // stop_reason: pending/running
          position.jobId, // stop_reason: failed
          position.jobId, // completed_at: pending/running
          createdAt,
          createdAt,
          position.jobId,
        ),
      ]);
      const row = await this.first<{ status: string; lease_id: string | null }>(this.env.DB.prepare(
        'SELECT status, lease_id FROM positions WHERE job_id = ? AND position_index = ?',
      ).bind(position.jobId, position.index));
      await this.globalCost();
      return row?.status === 'done' && row.lease_id === position.leaseId;
    });
  }

  async failPosition(position: ClaimedPosition, detail: string, now: number): Promise<void> {
    await this.serialized(async () => {
      const job = await this.first<{ cancel_requested: number }>(this.env.DB.prepare(
        'SELECT cancel_requested FROM jobs WHERE id = ?',
      ).bind(position.jobId));
      if (job?.cancel_requested === 1) {
        await this.env.DB.prepare(`
          UPDATE positions SET status = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?
        `).bind(iso(now), position.jobId, position.index, position.leaseId).run();
        await this.stopJob(position.jobId, 'cancelled', now);
        return;
      }
      const completedAt = iso(now);
      const profile = ANALYSIS_PROFILES[position.identity.profileId];
      const amountUsd = estimateContainerCostUsd(
        profile.movetimeMs,
        position.attempts,
        position.identity.instanceType,
        profile.movetimeMs,
        true,
      );
      await this.env.DB.batch([
        this.env.DB.prepare(`
          UPDATE positions SET status = 'failed', error_detail = ?, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?
        `).bind(detail.slice(0, 120), completedAt, position.jobId, position.index, position.leaseId),
        this.env.DB.prepare(`
          INSERT OR IGNORE INTO cost_ledger(
            job_id, position_index, owner_id, profile_id, amount_usd, attempts, cached, engine_ms, created_at
          ) SELECT ?, ?, ?, ?, ?, ?, 0, NULL, ?
          WHERE EXISTS (
            SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = 'failed' AND lease_id = ?
          )
        `).bind(
          position.jobId, position.index, position.ownerId, position.identity.profileId, amountUsd,
          position.attempts, completedAt, position.jobId, position.index, position.leaseId,
        ),
        this.env.DB.prepare(`
          UPDATE jobs SET
            committed_count = (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'done'),
            failed_count = (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'failed'),
            consecutive_failures = consecutive_failures + 1,
            status = CASE
              WHEN cancel_requested = 1 THEN 'cancelled'
              WHEN consecutive_failures + 1 >= 3 OR (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'failed') >= 5
                THEN CASE WHEN EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status = 'done') THEN 'partial' ELSE 'failed' END
              ELSE 'running' END,
            stop_reason = CASE
              WHEN cancel_requested = 1 THEN COALESCE(stop_reason, 'cancelled')
              WHEN consecutive_failures + 1 >= 3 OR (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'failed') >= 5
                THEN 'failure_threshold' ELSE stop_reason END,
            completed_at = CASE
              WHEN cancel_requested = 1 OR consecutive_failures + 1 >= 3
                OR (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'failed') >= 5
                THEN COALESCE(completed_at, ?) ELSE completed_at END,
            updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')
        `).bind(
          position.jobId, position.jobId, position.jobId, position.jobId,
          position.jobId, position.jobId, completedAt, completedAt, position.jobId,
        ),
      ]);
      await this.globalCost();
    });
  }

  async finishJob(jobId: string, epoch: number, now: number): Promise<void> {
    await this.serialized(async () => {
      const job = await this.first<JobRow>(this.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId));
      if (!job || job.epoch !== epoch || !isActive(job.status)) return;
      if (job.cancel_requested === 1) {
        await this.stopJob(jobId, 'cancelled', now);
        return;
      }
      const counts = await this.first<{ done: number; failed: number; pending: number; running: number }>(this.env.DB.prepare(`
        SELECT
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
        FROM positions WHERE job_id = ?
      `).bind(jobId));
      if (!counts) return;
      const remaining = Number(counts.pending ?? 0) + Number(counts.running ?? 0);
      const killMode = await this.currentKillMode();
      const costCapped = await this.globalCost() >= 1;
      if (remaining > 0 && (killMode === 'all' || costCapped)) {
        await this.stopJob(jobId, costCapped ? 'cost_cap' : 'admin_kill', now);
        return;
      }
      if (remaining > 0) return;
      const done = Number(counts.done ?? 0);
      const failed = Number(counts.failed ?? 0);
      const status = finalJobStatus(done, failed);
      await this.env.DB.prepare(`
        UPDATE jobs SET status = ?, committed_count = ?, failed_count = ?,
          stop_reason = CASE WHEN ? > 0 THEN COALESCE(stop_reason, 'position_failures') ELSE stop_reason END,
          completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).bind(status, done, failed, failed, iso(now), iso(now), jobId).run();
    });
  }

  private async stopJob(jobId: string, reason: string, now: number): Promise<void> {
    const status = await this.first<{ committed_count: number }>(this.env.DB.prepare(
      'SELECT committed_count FROM jobs WHERE id = ?',
    ).bind(jobId));
    if (!status) return;
    const terminal = reason === 'cancelled' ? 'cancelled' : status.committed_count > 0 ? 'partial' : 'failed';
    await this.env.DB.prepare(`
      UPDATE jobs SET status = ?, stop_reason = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).bind(terminal, reason, iso(now), iso(now), jobId).run();
  }
}
