import { DurableObject } from 'cloudflare:workers';
import {
  ANALYSIS_PROFILES,
  COST_MODEL,
  estimateChunkReservationParts,
  estimateChunkReservationUsd,
  estimateProfileIdleUsd,
  estimateRuntimeCostUsd,
  estimateWorstCaseAttemptCostUsd,
  estimateJobReferenceUsd,
  finalJobStatus,
  quotaAllows,
} from './job-types';
import type {
  AdmissionInput,
  AdmissionOutcome,
  CacheEntry,
  CancelOutcome,
  ClaimedPosition,
  ClaimOutcome,
  CostSnapshot,
  FaultArm,
  JobChunk,
  JobEnvironment,
  JobIdentity,
  JobStatus,
  RateDecision,
  SlotLease,
} from './job-types';

const CHUNK_SIZE = 8;
const LEASE_MS = 180_000;
const REDELIVERY_AFTER_MS = 120_000;
const RECOVERY_DEADLINE_MS = 10 * 60_000;
const MAX_WAITING_JOBS = 10;
const FAULT_ARM_TTL_MS = 10 * 60_000;
type IdempotencyRow = { job_id: string; payload_sha256: string };
type JobRow = {
  id: string; owner_id: string; status: JobStatus; profile_id: JobIdentity['profileId']; profile_version: number;
  engine_id: string; engine_binary_digest_label: string; model_id: string; instance_type: JobIdentity['instanceType'];
  vcpu: number; position_count: number; epoch: number; cancel_requested: number; committed_count: number;
  failed_count: number; consecutive_failures: number; stop_reason: string | null; created_at: string;
  started_at: string | null; completed_at: string | null; updated_at: string; execution_identity_hash: string;
  cost_reserved: number; cost_day_utc: string | null; result_seq_next: number;
  execution_identity_json: string; cost_finalized: number; runtime_budget_exceeded: number;
};
type PositionRow = { sfen: string; status: string; attempts: number; delivery_count: number; cost_reserved: number; lease_expires_at: number | null };
type OutboxRow = { id: number; job_id: string; epoch: number; start_idx: number; end_idx: number; sent_at: string | null; last_sent_at: string | null; completed_at: string | null };
type SlotRow = {
  job_id: string | null; epoch: number | null; position_index: number | null; attempt: number | null; lease_id: string | null;
  lease_expires_at: number | null; profile_id: string | null; quarantine_required: number;
};
type CostPartRow = {
  part_key: string; reservation_key: string; start_idx: number; end_idx: number; position_index: number | null;
  phase: string; cost_kind: 'resource' | 'service'; amount_usd: number; remaining_usd: number; reserved_day_utc: string;
};

function iso(now: number): string { return new Date(now).toISOString(); }
function dayUtc(now: number): string { return iso(now).slice(0, 10); }
function active(status: string): boolean { return status === 'queued' || status === 'running'; }

function manyInserts(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  batchSize = 10,
): D1PreparedStatement[] {
  const tuple = '(' + columns.map(() => '?').join(',') + ')';
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    statements.push(db.prepare('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES ' + batch.map(() => tuple).join(',')).bind(...batch.flat()));
  }
  return statements;
}

function manyGuardedInserts(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  reservationKey: string,
  batchSize = 5,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const selects = batch.map(() => `SELECT ${columns.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)`);
    const values: (string | number | null)[] = [];
    for (const row of batch) values.push(...row, reservationKey);
    statements.push(db.prepare(`INSERT INTO ${table} (${columns.join(',')}) ${selects.join(' UNION ALL ')}`).bind(...values));
  }
  return statements;
}

export class JobCoordinator extends DurableObject<JobEnvironment> {
  private tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: JobEnvironment) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rate_windows (scope TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (scope, minute))');
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS global_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async first<T>(statement: D1PreparedStatement): Promise<T | null> { return await statement.first<T>(); }

  private consumeRate(scope: string, now: number, maximum: number): RateDecision {
    const minute = Math.floor(now / 60_000);
    const row = this.ctx.storage.sql.exec<{ count: number }>('SELECT count FROM rate_windows WHERE scope = ? AND minute = ?', scope, minute).toArray()[0];
    if ((row?.count ?? 0) >= maximum) return { allowed: false, retryAfter: Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)) };
    this.ctx.storage.sql.exec(
      'INSERT INTO rate_windows(scope, minute, count) VALUES (?, ?, 1) ON CONFLICT(scope, minute) DO UPDATE SET count = count + 1',
      scope, minute,
    );
    this.ctx.storage.sql.exec('DELETE FROM rate_windows WHERE minute < ?', minute - 2);
    return { allowed: true, retryAfter: 0 };
  }

  private async currentKillMode(): Promise<'admission' | 'all' | null> {
    const row = await this.first<{ value: string }>(this.env.DB.prepare("SELECT value FROM flags WHERE key = 'kill_mode'"));
    return row?.value === 'admission' || row?.value === 'all' ? row.value : null;
  }

  private dailyCostCapUsd(): number {
    const raw = Number(this.env.ANALYSIS_DAILY_COST_CAP_USD ?? '1');
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  }

  private async dailyCost(day: string): Promise<{ spent: number; reserved: number }> {
    await this.ensureDailyServiceAllowance(day, Date.parse(`${day}T00:00:00.000Z`));
    const [daily, outstanding] = await Promise.all([
      this.first<{ spent_usd: number }>(this.env.DB.prepare('SELECT spent_usd FROM daily_cost WHERE day_utc = ?').bind(day)),
      this.first<{ reserved: number }>(this.env.DB.prepare('SELECT COALESCE(SUM(cost_reserved), 0) AS reserved FROM jobs')),
    ]);
    return { spent: Number(daily?.spent_usd ?? 0), reserved: Number(outstanding?.reserved ?? 0) };
  }

  private async ensureDailyServiceAllowance(day: string, now: number): Promise<void> {
    const eventKey = `daily-service:${day}`;
    const createdAt = iso(now);
    await this.env.DB.batch([
      this.env.DB.prepare('INSERT INTO daily_cost(day_utc, spent_usd, reserved_usd, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT(day_utc) DO NOTHING')
        .bind(day, createdAt),
      this.env.DB.prepare('UPDATE daily_cost SET spent_usd = spent_usd + ?, updated_at = ? WHERE day_utc = ? AND NOT EXISTS (SELECT 1 FROM cost_phase_ledger WHERE event_key = ?)')
        .bind(COST_MODEL.dailyServiceUsd, createdAt, day, eventKey),
      this.env.DB.prepare('INSERT OR IGNORE INTO cost_phase_ledger(event_key, job_id, epoch, reservation_key, part_key, phase, cost_kind, amount_usd, duration_ms, engine_ms, day_utc, evidence, created_at) VALUES (?, NULL, NULL, NULL, NULL, ?, \'service\', ?, NULL, NULL, ?, ?, ?)')
        .bind(eventKey, 'daily_cron_api_allowance', COST_MODEL.dailyServiceUsd, day, JSON.stringify({ assumption: 'daily_cron_api_v1' }), createdAt),
    ]);
  }

  private async flushHeadOutbox(jobId: string, now: number, force = false): Promise<boolean> {
    for (let guard = 0; guard < 70; guard += 1) {
      const row = await this.first<OutboxRow>(this.env.DB.prepare(
        'SELECT id, job_id, epoch, start_idx, end_idx, sent_at, last_sent_at, completed_at FROM outbox WHERE job_id = ? AND completed_at IS NULL AND dispatchable = 1 ORDER BY start_idx LIMIT 1',
      ).bind(jobId));
      if (!row) return false;
      const job = await this.first<{ status: string; epoch: number; runtime_budget_exceeded: number }>(this.env.DB.prepare('SELECT status, epoch, runtime_budget_exceeded FROM jobs WHERE id = ?').bind(jobId));
      if (!job || !active(job.status) || job.epoch !== row.epoch) return false;
      if (job.runtime_budget_exceeded === 1) {
        await this.finishRuntimeBudgetExceededInternal(jobId, row.epoch, now);
        return false;
      }
      const pending = await this.first<{ count: number }>(this.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM positions WHERE job_id = ? AND position_index >= ? AND position_index < ? AND status IN ('pending', 'running')",
      ).bind(jobId, row.start_idx, row.end_idx));
      const reserved = await this.first<{ count: number }>(this.env.DB.prepare(
        'SELECT COUNT(*) AS count FROM cost_reservation_batches WHERE job_id = ? AND epoch = ? AND start_idx = ? AND end_idx = ?',
      ).bind(jobId, row.epoch, row.start_idx, row.end_idx));
      if (Number(reserved?.count ?? 0) !== 1) return false;
      if (Number(pending?.count ?? 0) === 0) {
        await this.finishChunkInternal(jobId, row.epoch, now);
        continue;
      }
      const lastSent = row.last_sent_at ? Date.parse(row.last_sent_at) : 0;
      if (!force && row.sent_at && now - lastSent < REDELIVERY_AFTER_MS) return false;
      // Persist a delivery intent before sending. A crash in either direction is
      // repaired by the next scheduled scan; attempts remains engine-only.
      try {
        await this.env.DB.batch([
          this.env.DB.prepare('UPDATE outbox SET delivery_count = delivery_count + 1, last_sent_at = ? WHERE id = ?').bind(iso(now), row.id),
          this.env.DB.prepare('UPDATE positions SET delivery_count = delivery_count + 1 WHERE job_id = ? AND position_index >= ? AND position_index < ?')
            .bind(jobId, row.start_idx, row.end_idx),
        ]);
      } catch { return true; }
      const body: JobChunk = { job_id: row.job_id, epoch: row.epoch, start_idx: row.start_idx, end_idx: row.end_idx };
      try {
        await this.env.JOB_QUEUE.send(body);
        await this.env.DB.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?').bind(iso(now), row.id).run();
        return false;
      } catch {
        return true;
      }
    }
    return false;
  }

  async admit(input: AdmissionInput): Promise<AdmissionOutcome> {
    return this.serialized(async () => {
      const existing = await this.first<IdempotencyRow>(this.env.DB.prepare(
        'SELECT job_id, payload_sha256 FROM idempotency WHERE owner_id = ? AND idempotency_key = ?',
      ).bind(input.ownerId, input.idempotencyKey));
      if (existing) {
        if (existing.payload_sha256 !== input.payloadSha256) return { ok: false, status: 409, error: 'idempotency_conflict' };
        const enqueuePending = await this.flushHeadOutbox(existing.job_id, input.now, true);
        return { ok: true, value: { jobId: existing.job_id, duplicate: true, enqueuePending } };
      }

      const rate = this.consumeRate('post:' + input.ownerId, input.now, 6);
      if (!rate.allowed) return { ok: false, status: 429, error: 'rate_limit', retryAfter: rate.retryAfter };
      const profile = ANALYSIS_PROFILES[input.profile];
      const killMode = await this.currentKillMode();
      if (killMode) return { ok: false, status: 503, error: 'admission_disabled' };
      const blocked = await this.isProfileBlocked(input.profile);
      if (blocked) return { ok: false, status: 503, error: 'profile_admission_blocked' };
      const day = dayUtc(input.now);
      const currentCost = await this.dailyCost(day);
      const headEnd = Math.min(CHUNK_SIZE, input.positions.length);
      const headParts = estimateChunkReservationParts(profile, 0, headEnd, true);
      const reservation = headParts.reduce((sum, part) => sum + part.amountUsd, 0);
      if (currentCost.spent + currentCost.reserved + reservation > this.dailyCostCapUsd()) return { ok: false, status: 503, error: 'daily_cost_cap' };

      const activeJobs = await this.first<{ count: number }>(this.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running', 'cancelling')",
      ));
      if (Number(activeJobs?.count ?? 0) >= MAX_WAITING_JOBS) return { ok: false, status: 429, error: 'global_waiting_job_limit', retryAfter: 60 };
      const ownerActive = await this.first<{ id: string }>(this.env.DB.prepare(
        "SELECT id FROM jobs WHERE owner_id = ? AND status IN ('queued', 'running', 'cancelling') LIMIT 1",
      ).bind(input.ownerId));
      if (ownerActive) return { ok: false, status: 429, error: 'active_job_limit', retryAfter: 60 };

      const quota = await this.first<{ jobs_reserved: number; positions_reserved: number }>(this.env.DB.prepare(
        'SELECT jobs_reserved, positions_reserved FROM quota_usage WHERE owner_id = ? AND day_utc = ? AND profile_id = ?',
      ).bind(input.ownerId, day, input.profile));
      if (!quotaAllows(input.profile, quota?.jobs_reserved ?? 0, quota?.positions_reserved ?? 0, input.positions.length)) {
        return { ok: false, status: 429, error: 'daily_quota_exceeded', retryAfter: 60 };
      }

      const jobId = crypto.randomUUID();
      const createdAt = iso(input.now);
      const reservationKey = `job:${jobId}:1:0:${headEnd}`;
      const positionRows = input.positions.map((sfen, index) => {
        const positionReservation = headParts.filter((part) => part.positionIndex === index).reduce((sum, part) => sum + part.amountUsd, 0);
        return [
        jobId, index, sfen, input.profile, input.identity.profileVersion, input.identity.engineId, input.identity.modelId,
        createdAt, input.identity.executionIdentityHash, positionReservation,
      ] as const;
      });
      const outboxRows: (string | number | null)[][] = [];
      for (let start = 0; start < input.positions.length; start += CHUNK_SIZE) {
        outboxRows.push([jobId, 1, start, Math.min(start + CHUNK_SIZE, input.positions.length), createdAt, null, start === 0 ? 1 : 0]);
      }
      const partRows = headParts.map((part) => [
        part.partKey, reservationKey, jobId, 1, 0, headEnd, part.positionIndex, part.phase, part.costKind,
        part.amountUsd, part.amountUsd, day, createdAt,
      ] as const);
      const referenceEstimate = estimateJobReferenceUsd(profile, input.positions.length);
      const statements: D1PreparedStatement[] = [
        this.env.DB.prepare(
          'INSERT INTO cost_reservation_batches(reservation_key, job_id, epoch, start_idx, end_idx, amount_usd, reserved_day_utc, created_at) ' +
          'SELECT ?, ?, 1, 0, ?, ?, ?, ? WHERE ' +
          '(SELECT COALESCE(spent_usd, 0) FROM daily_cost WHERE day_utc = ?) + ' +
          '(SELECT COALESCE(SUM(cost_reserved), 0) FROM jobs) + ? <= ?',
        ).bind(reservationKey, jobId, headEnd, reservation, day, createdAt, day, reservation, this.dailyCostCapUsd()),
        this.env.DB.prepare(
          'INSERT INTO jobs (id, owner_id, status, profile_id, profile_version, engine_id, model_id, instance_type, label, position_count, epoch, created_at, updated_at, execution_identity_hash, cost_reserved, cost_day_utc, result_seq_next, engine_binary_digest_label, vcpu, cost_estimate_usd, execution_identity_json) ' +
          "SELECT ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)",
        ).bind(
          jobId, input.ownerId, input.identity.profileId, input.identity.profileVersion, input.identity.engineId, input.identity.modelId,
          input.identity.instanceType, input.label, input.positions.length, createdAt, createdAt, input.identity.executionIdentityHash,
          reservation, day, input.identity.engineBinaryDigestLabel, input.identity.vcpu, referenceEstimate,
          JSON.stringify(input.identity), reservationKey,
        ),
        this.env.DB.prepare('INSERT INTO idempotency(owner_id, idempotency_key, job_id, payload_sha256, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)')
          .bind(input.ownerId, input.idempotencyKey, jobId, input.payloadSha256, createdAt, reservationKey),
        this.env.DB.prepare(
          'INSERT INTO quota_usage(owner_id, day_utc, profile_id, jobs_reserved, positions_reserved, updated_at) ' +
          'SELECT ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?) ' +
          'ON CONFLICT(owner_id, day_utc, profile_id) DO UPDATE SET jobs_reserved = jobs_reserved + 1, positions_reserved = positions_reserved + excluded.positions_reserved, updated_at = excluded.updated_at',
        ).bind(input.ownerId, day, input.identity.profileId, input.positions.length, createdAt, reservationKey),
        this.env.DB.prepare(
          'UPDATE daily_cost SET reserved_usd = reserved_usd + ?, updated_at = ? WHERE day_utc = ? AND EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)',
        ).bind(reservation, createdAt, day, reservationKey),
        ...manyGuardedInserts(this.env.DB, 'positions', [
          'job_id', 'position_index', 'sfen', 'profile_id', 'profile_version', 'engine_id', 'model_id', 'updated_at',
          'execution_identity_hash', 'cost_reserved',
        ], positionRows, reservationKey),
        ...manyGuardedInserts(this.env.DB, 'outbox', ['job_id', 'epoch', 'start_idx', 'end_idx', 'created_at', 'sent_at', 'dispatchable'], outboxRows, reservationKey),
        ...manyGuardedInserts(this.env.DB, 'cost_reservation_parts', [
          'part_key', 'reservation_key', 'job_id', 'epoch', 'start_idx', 'end_idx', 'position_index', 'phase', 'cost_kind',
          'amount_usd', 'remaining_usd', 'reserved_day_utc', 'created_at',
        ], partRows, reservationKey),
      ];
      await this.env.DB.batch(statements);
      const reserved = await this.first<{ reservation_key: string }>(this.env.DB.prepare(
        'SELECT reservation_key FROM cost_reservation_batches WHERE reservation_key = ?',
      ).bind(reservationKey));
      if (!reserved) return { ok: false, status: 503, error: 'daily_cost_cap' };
      const enqueuePending = await this.flushHeadOutbox(jobId, input.now, true);
      return { ok: true, value: { jobId, duplicate: false, enqueuePending } };
    });
  }

  async recordOwnerOperation(ownerId: string, action: 'get' | 'cancel', now: number): Promise<RateDecision> {
    return this.serialized(async () => this.consumeRate(action + ':' + ownerId, now, action === 'get' ? 120 : 30));
  }

  async clearLocalTestRateWindows(): Promise<void> {
    if (this.env.ANALYSIS_FAULT_FIXTURES_ENABLED !== '1') throw new Error('test_fixture_disabled');
    this.ctx.storage.sql.exec('DELETE FROM rate_windows');
  }

  async seedLocalTestRateWindow(ownerId: string, action: 'post' | 'get' | 'cancel', now: number, count: number): Promise<void> {
    if (this.env.ANALYSIS_FAULT_FIXTURES_ENABLED !== '1') throw new Error('test_fixture_disabled');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId) || !Number.isSafeInteger(now) || !Number.isSafeInteger(count) || count < 0 || count > 120) {
      throw new TypeError('invalid_test_rate_window');
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO rate_windows(scope, minute, count) VALUES (?, ?, ?) ON CONFLICT(scope, minute) DO UPDATE SET count = excluded.count',
      `${action}:${ownerId}`, Math.floor(now / 60_000), count,
    );
  }

  async costSnapshot(now: number): Promise<CostSnapshot> {
    return this.serialized(async () => {
      const day = dayUtc(now);
      const cost = await this.dailyCost(day);
      const estimatedCostUsd = cost.spent + cost.reserved;
      const cap = this.dailyCostCapUsd();
      return { estimatedCostUsd, costWarning: estimatedCostUsd >= cap / 2, costCapped: estimatedCostUsd >= cap, dayUtc: day };
    });
  }

  async setKillMode(mode: 'admission' | 'all' | null, now: number): Promise<'admission' | 'all' | null> {
    return this.serialized(async () => {
      if (mode === null) await this.env.DB.prepare("DELETE FROM flags WHERE key = 'kill_mode'").run();
      else await this.env.DB.prepare(
        "INSERT INTO flags(key, value, updated_at) VALUES ('kill_mode', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).bind(mode, iso(now)).run();
      this.ctx.storage.sql.exec(
        "INSERT INTO global_state(key, value, updated_at) VALUES ('kill_mode', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        mode ?? '', iso(now),
      );
      return mode;
    });
  }

  async isProfileBlocked(profileId: string): Promise<boolean> {
    const row = await this.first<{ value: string }>(this.env.DB.prepare('SELECT value FROM flags WHERE key = ?').bind('profile_blocked:' + profileId));
    return row?.value === '1';
  }

  async clearProfileBlock(profileId: string, now: number): Promise<void> {
    await this.serialized(async () => {
      await this.env.DB.prepare('DELETE FROM flags WHERE key = ?').bind('profile_blocked:' + profileId).run();
      await this.env.DB.prepare('INSERT INTO flags(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind('profile_blocked:' + profileId, '0', iso(now)).run();
    });
  }

  async requestCancel(ownerId: string, jobId: string, now: number): Promise<CancelOutcome> {
    return this.serialized(async () => {
      const job = await this.first<{ status: JobStatus; epoch: number; stop_reason: string | null }>(this.env.DB.prepare(
        'SELECT status, epoch, stop_reason FROM jobs WHERE id = ? AND owner_id = ?',
      ).bind(jobId, ownerId));
      if (!job) return { found: false, status: null };
      if (job.status === 'cancelling' && job.stop_reason === 'dead_letter_in_progress') return { found: true, status: 'cancelling' };
      if (!active(job.status) && job.status !== 'cancelling') return { found: true, status: job.status };
      await this.env.DB.prepare("UPDATE jobs SET status = 'cancelling', cancel_requested = 1, stop_reason = 'cancel_in_progress', updated_at = ? WHERE id = ? AND status IN ('queued', 'running', 'cancelling')")
        .bind(iso(now), jobId).run();
      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      const ownsSlot = slot?.job_id === jobId && slot.epoch === job.epoch && slot.lease_id !== null;
      if (!ownsSlot) {
        await this.finishCancellation(jobId, job.epoch, now);
        const finalized = await this.first<{ status: JobStatus; cost_finalized: number }>(this.env.DB.prepare(
          'SELECT status, cost_finalized FROM jobs WHERE id = ? AND epoch = ?',
        ).bind(jobId, job.epoch));
        return { found: true, status: finalized?.status === 'cancelled' && finalized.cost_finalized === 1 ? 'cancelled' : 'cancelling', jobId, epoch: job.epoch, inFlight: null };
      }
      return {
        found: true, status: 'cancelling', jobId, epoch: job.epoch,
        inFlight: {
          profileId: slot.profile_id as JobIdentity['profileId'], leaseId: slot.lease_id as string,
          index: slot.position_index as number, attempt: slot.attempt ?? 0,
        },
      };
    });
  }

  private async finishCancellation(jobId: string, epoch: number, now: number): Promise<void> {
    const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
    if (slot?.job_id === jobId && slot.epoch === epoch && slot.lease_id) return;
    const job = await this.first<{ status: string; stop_reason: string | null }>(this.env.DB.prepare('SELECT status, stop_reason FROM jobs WHERE id = ? AND epoch = ?').bind(jobId, epoch));
    if (job?.status !== 'cancelling' || job.stop_reason === 'dead_letter_in_progress') return;
    await this.env.DB.prepare(
      "UPDATE jobs SET status = 'cancelled', cancel_requested = 1, stop_reason = 'cancelled', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND epoch = ? AND status = 'cancelling' AND COALESCE(stop_reason, '') <> 'dead_letter_in_progress'",
    ).bind(iso(now), iso(now), jobId, epoch).run();
    await this.finalizeTerminalCostsInternal(jobId, epoch, now);
  }

  async cancellationSettled(jobId: string, epoch: number, now: number): Promise<boolean> {
    return this.serialized(async () => {
      await this.finishCancellation(jobId, epoch, now);
      const row = await this.first<{ status: string; cost_finalized: number }>(this.env.DB.prepare('SELECT status, cost_finalized FROM jobs WHERE id = ? AND epoch = ?').bind(jobId, epoch));
      return row?.status === 'cancelled' && row.cost_finalized === 1;
    });
  }

  async findCached(identity: JobIdentity, sfen: string): Promise<CacheEntry | null> {
    return this.serialized(async () => {
      const row = await this.first<{ result_json: string; stats_json: string | null; proof_json: string | null }>(this.env.DB.prepare(
        'SELECT result_json, stats_json, proof_json FROM result_cache WHERE contract_version = 3 AND execution_identity_hash = ? AND engine_id = ? AND model_id = ? AND profile_id = ? AND profile_version = ? AND sfen = ? AND quarantined = 0',
      ).bind(identity.executionIdentityHash, identity.engineId, identity.modelId, identity.profileId, identity.profileVersion, sfen));
      if (!row) return null;
      await this.env.DB.prepare(
        'UPDATE result_cache SET last_used_at = ? WHERE contract_version = 3 AND execution_identity_hash = ? AND engine_id = ? AND model_id = ? AND profile_id = ? AND profile_version = ? AND sfen = ? AND quarantined = 0',
      ).bind(new Date().toISOString(), identity.executionIdentityHash, identity.engineId, identity.modelId, identity.profileId, identity.profileVersion, sfen).run();
      return { resultJson: row.result_json, statsJson: row.stats_json, proofJson: row.proof_json };
    });
  }

  async getSlot(now: number): Promise<SlotLease | null> {
    return this.serialized(async () => {
      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      if (!slot?.job_id || !slot.lease_id || slot.epoch === null || slot.position_index === null || slot.attempt === null || slot.lease_expires_at === null || !slot.profile_id) return null;
      const expired = slot.lease_expires_at <= now;
      if (expired && slot.quarantine_required !== 1) {
        await this.env.DB.prepare('UPDATE global_search_slot SET quarantine_required = 1, updated_at = ? WHERE singleton = 1 AND lease_id = ?')
          .bind(iso(now), slot.lease_id).run();
      }
      return {
        jobId: slot.job_id, epoch: slot.epoch, index: slot.position_index, attempt: slot.attempt,
        leaseId: slot.lease_id, leaseExpiresAt: slot.lease_expires_at, profileId: slot.profile_id as JobIdentity['profileId'],
        quarantineRequired: expired || slot.quarantine_required === 1,
      };
    });
  }

  async confirmContainerDestroyed(lease: SlotLease, now: number): Promise<boolean> {
    return this.serialized(async () => {
      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      if (!slot || slot.lease_id !== lease.leaseId || slot.job_id !== lease.jobId || slot.epoch !== lease.epoch || slot.position_index !== lease.index) return false;
      if ((slot.attempt ?? 0) > 0 && !await this.recordUnknownSlotCost(slot, now)) return false;
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE positions SET status = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?")
          .bind(iso(now), lease.jobId, lease.index, lease.leaseId),
        this.env.DB.prepare("UPDATE global_search_slot SET job_id = NULL, epoch = NULL, position_index = NULL, attempt = NULL, lease_id = NULL, lease_expires_at = NULL, profile_id = NULL, quarantine_required = 0, updated_at = ? WHERE singleton = 1 AND lease_id = ?")
          .bind(iso(now), lease.leaseId),
        this.env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ? AND epoch = ?').bind(iso(now), lease.jobId, lease.epoch),
      ]);
      const job = await this.first<{ status: string; stop_reason: string | null }>(this.env.DB.prepare('SELECT status, stop_reason FROM jobs WHERE id = ?').bind(lease.jobId));
      if (job?.status === 'cancelling' && job.stop_reason !== 'dead_letter_in_progress') await this.finishCancellation(lease.jobId, lease.epoch, now);
      return true;
    });
  }

  async acquirePosition(jobId: string, index: number, epoch: number, leaseId: string, now: number): Promise<ClaimOutcome> {
    return this.serialized(async () => {
      const job = await this.first<JobRow>(this.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId));
      if (!job || job.epoch !== epoch || !active(job.status)) return { kind: 'skip' };
      if (job.runtime_budget_exceeded === 1) {
        const activeSlot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
        if (activeSlot?.job_id === jobId && activeSlot.epoch === epoch && activeSlot.lease_id) return { kind: 'busy' };
        await this.finishRuntimeBudgetExceededInternal(jobId, epoch, now);
        return { kind: 'stopped' };
      }
      const killMode = await this.currentKillMode();
      if (killMode === 'all') {
        await this.stopJob(jobId, epoch, 'admin_kill', now);
        return { kind: 'stopped' };
      }
      const outbox = await this.first<{ start_idx: number; end_idx: number; dispatchable: number }>(this.env.DB.prepare(
        'SELECT start_idx, end_idx, dispatchable FROM outbox WHERE job_id = ? AND epoch = ? AND completed_at IS NULL ORDER BY start_idx LIMIT 1',
      ).bind(jobId, epoch));
      if (!outbox || outbox.dispatchable !== 1 || index < outbox.start_idx || index >= outbox.end_idx) return { kind: 'busy' };
      const chunkReservation = await this.first<{ reservation_key: string }>(this.env.DB.prepare(
        'SELECT reservation_key FROM cost_reservation_batches WHERE job_id = ? AND epoch = ? AND start_idx = ? AND end_idx = ?',
      ).bind(jobId, epoch, outbox.start_idx, outbox.end_idx));
      if (!chunkReservation) return { kind: 'busy' };
      const position = await this.first<PositionRow>(this.env.DB.prepare(
        'SELECT sfen, status, attempts, delivery_count, cost_reserved, lease_expires_at FROM positions WHERE job_id = ? AND position_index = ?',
      ).bind(jobId, index));
      if (!position || position.status === 'done' || position.status === 'failed') return { kind: 'skip' };
      if (position.status === 'running' && (position.lease_expires_at ?? 0) > now) return { kind: 'busy' };

      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      if (slot?.lease_id) {
        if ((slot.lease_expires_at ?? 0) <= now) {
          if (slot.quarantine_required !== 1) await this.env.DB.prepare('UPDATE global_search_slot SET quarantine_required = 1, updated_at = ? WHERE singleton = 1 AND lease_id = ?').bind(iso(now), slot.lease_id).run();
          return { kind: 'quarantine_required' };
        }
        return { kind: 'busy' };
      }
      const restartUse = await this.first<{ duration_ms: number }>(this.env.DB.prepare(
        'SELECT COALESCE(SUM(duration_ms), 0) AS duration_ms FROM cost_phase_ledger WHERE job_id = ? AND epoch = ? AND part_key = ? AND phase = \'container_restart\'',
      ).bind(jobId, epoch, `chunk:${outbox.start_idx}:${outbox.end_idx}`));
      if (Number(restartUse?.duration_ms ?? 0) >= COST_MODEL.restartReserveMs) {
        await this.env.DB.prepare('UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ?')
          .bind(iso(now), jobId, epoch).run();
        await this.finishRuntimeBudgetExceededInternal(jobId, epoch, now);
        return { kind: 'stopped' };
      }
      if (position.status === 'running' && (position.lease_expires_at ?? 0) <= now) return { kind: 'quarantine_required' };
      let identity: JobIdentity;
      try { identity = JSON.parse(job.execution_identity_json) as JobIdentity; } catch { return { kind: 'stopped' }; }
      if (!identity || identity.executionIdentityHash !== job.execution_identity_hash || identity.profileId !== job.profile_id ||
          identity.profileVersion !== job.profile_version || identity.engineId !== job.engine_id || identity.modelId !== job.model_id ||
          identity.engineBinaryDigestLabel !== job.engine_binary_digest_label) {
        await this.stopJob(jobId, epoch, 'execution_identity_missing_or_invalid', now);
        return { kind: 'stopped' };
      }
      const leaseExpiresAt = now + LEASE_MS;
      let acquired: D1Result[];
      try {
        acquired = await this.env.DB.batch([
        this.env.DB.prepare(
          'UPDATE global_search_slot SET job_id = ?, epoch = ?, position_index = ?, attempt = ?, lease_id = ?, lease_expires_at = ?, profile_id = ?, quarantine_required = 0, updated_at = ? WHERE singleton = 1 AND lease_id IS NULL AND EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status IN (\'pending\', \'running\') AND (status = \'pending\' OR lease_expires_at IS NULL OR lease_expires_at <= ?)) AND EXISTS (SELECT 1 FROM outbox o JOIN cost_reservation_batches r ON r.job_id = o.job_id AND r.epoch = o.epoch AND r.start_idx = o.start_idx AND r.end_idx = o.end_idx WHERE o.job_id = ? AND o.epoch = ? AND o.dispatchable = 1 AND o.completed_at IS NULL AND o.start_idx <= ? AND o.end_idx > ?)',
        ).bind(jobId, epoch, index, position.attempts, leaseId, leaseExpiresAt, job.profile_id, iso(now), jobId, index, now, jobId, epoch, index, index),
        this.env.DB.prepare(
          "UPDATE positions SET status = 'running', lease_id = ?, lease_expires_at = ?, updated_at = ? WHERE job_id = ? AND position_index = ? AND status IN ('pending', 'running') AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= ?) AND EXISTS (SELECT 1 FROM global_search_slot WHERE singleton = 1 AND lease_id = ? AND job_id = ? AND epoch = ? AND position_index = ?) AND EXISTS (SELECT 1 FROM outbox o JOIN cost_reservation_batches r ON r.job_id = o.job_id AND r.epoch = o.epoch AND r.start_idx = o.start_idx AND r.end_idx = o.end_idx WHERE o.job_id = ? AND o.epoch = ? AND o.dispatchable = 1 AND o.completed_at IS NULL AND o.start_idx <= ? AND o.end_idx > ?)",
        ).bind(leaseId, leaseExpiresAt, iso(now), jobId, index, now, leaseId, jobId, epoch, index, jobId, epoch, index, index),
        this.env.DB.prepare("UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND epoch = ? AND status IN ('queued', 'running') AND EXISTS (SELECT 1 FROM global_search_slot WHERE singleton = 1 AND lease_id = ?) AND EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?)")
          .bind(iso(now), iso(now), jobId, epoch, leaseId, jobId, index, leaseId),
        this.env.DB.prepare("UPDATE global_search_slot SET job_id = NULL, epoch = NULL, position_index = NULL, attempt = NULL, lease_id = NULL, lease_expires_at = NULL, profile_id = NULL, quarantine_required = 0, updated_at = ? WHERE singleton = 1 AND lease_id = ? AND NOT EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?)")
          .bind(iso(now), leaseId, jobId, index, leaseId),
        ]);
      } catch {
        return { kind: 'busy' };
      }
      if (acquired[0]?.meta.changes !== 1 || acquired[1]?.meta.changes !== 1) return { kind: 'busy' };
      return { kind: 'claimed', value: {
        jobId, ownerId: job.owner_id, epoch, index, sfen: position.sfen, attempts: position.attempts,
        deliveryCount: position.delivery_count, leaseId, cancelRequested: false, identity,
      } };
    });
  }

  async deferBusyDelivery(jobId: string, epoch: number, startIndex: number, now: number): Promise<void> {
    await this.serialized(async () => {
      const job = await this.first<{ status: JobStatus; epoch: number }>(this.env.DB.prepare('SELECT status, epoch FROM jobs WHERE id = ?').bind(jobId));
      if (!job || job.epoch !== epoch || !active(job.status)) return;
      const outbox = await this.first<OutboxRow>(this.env.DB.prepare(
        'SELECT id, job_id, epoch, start_idx, end_idx, sent_at, last_sent_at, completed_at FROM outbox WHERE job_id = ? AND epoch = ? AND completed_at IS NULL ORDER BY start_idx LIMIT 1',
      ).bind(jobId, epoch));
      if (!outbox || outbox.start_idx !== startIndex) return;
      // Persist that the head needs another delivery before the current queue message is acked.
      // The scheduled recovery path sees this overdue outbox timestamp and republishes it.
      await this.env.DB.prepare('UPDATE outbox SET last_sent_at = ? WHERE id = ? AND completed_at IS NULL')
        .bind(iso(now - REDELIVERY_AFTER_MS), outbox.id).run();
    });
  }

  async markDispatched(position: ClaimedPosition, now: number): Promise<number | null> {
    return this.serialized(async () => {
      const row = await this.first<{ attempts: number }>(this.env.DB.prepare(
        "SELECT attempts FROM positions WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?",
      ).bind(position.jobId, position.index, position.leaseId));
      const job = await this.first<{ epoch: number; status: string; execution_identity_hash: string; runtime_budget_exceeded: number }>(this.env.DB.prepare('SELECT epoch, status, execution_identity_hash, runtime_budget_exceeded FROM jobs WHERE id = ?').bind(position.jobId));
      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      if (!row || !job || job.epoch !== position.epoch || job.status !== 'running' || job.runtime_budget_exceeded === 1 || job.execution_identity_hash !== position.identity.executionIdentityHash || slot?.lease_id !== position.leaseId || slot.job_id !== position.jobId || slot.epoch !== position.epoch) return null;
      if (row.attempts >= 2) return null;
      const attempts = row.attempts + 1;
      const attemptPart = await this.first<{ remaining_usd: number }>(this.env.DB.prepare(
        'SELECT remaining_usd FROM cost_reservation_parts WHERE job_id = ? AND part_key = ?',
      ).bind(position.jobId, `attempt:${position.index}:${attempts}`));
      if (!attemptPart || Number(attemptPart.remaining_usd) <= 0) return null;
      const applied = await this.env.DB.batch([
        this.env.DB.prepare('UPDATE positions SET attempts = ?, updated_at = ? WHERE job_id = ? AND position_index = ? AND status = \'running\' AND lease_id = ? AND EXISTS (SELECT 1 FROM cost_reservation_parts WHERE job_id = ? AND part_key = ? AND remaining_usd > 0)')
          .bind(attempts, iso(now), position.jobId, position.index, position.leaseId, position.jobId, `attempt:${position.index}:${attempts}`),
        this.env.DB.prepare('UPDATE global_search_slot SET attempt = ?, updated_at = ? WHERE singleton = 1 AND lease_id = ? AND EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND attempts = ? AND lease_id = ?)')
          .bind(attempts, iso(now), position.leaseId, position.jobId, position.index, attempts, position.leaseId),
      ]);
      if (applied[0]?.meta.changes !== 1 || applied[1]?.meta.changes !== 1) return null;
      return attempts;
    });
  }

  async recordAttemptCost(position: ClaimedPosition, attempt: number, amountUsd: number, engineMs: number | null, now: number, durationMs: number | null = null): Promise<boolean> {
    return this.serialized(async () => {
      return this.settleReservationPart({
        jobId: position.jobId, epoch: position.epoch, partKey: `attempt:${position.index}:${attempt}`,
        eventKey: `attempt:${position.jobId}:${position.epoch}:${position.index}:${attempt}`,
        phase: 'engine_attempt', costKind: 'resource', amountUsd, durationMs, engineMs,
        now, evidence: { attempt }, allowOverrun: true,
        budgetCapMs: ANALYSIS_PROFILES[position.identity.profileId].movetimeMs + COST_MODEL.searchDeadlineMs + COST_MODEL.processCleanupMs + 500,
        attemptLedger: { index: position.index, attempt, ownerId: position.ownerId, profileId: position.identity.profileId,
          identityHash: position.identity.executionIdentityHash },
      });
    });
  }

  async settleReservedPhase(input: {
    jobId: string; epoch: number; partKey: string; eventKey: string; phase: string;
    costKind: 'resource' | 'service'; amountUsd: number; durationMs?: number | null; engineMs?: number | null;
    evidence?: Record<string, unknown>; now: number; allowOverrun?: boolean; budgetCapMs?: number;
  }): Promise<boolean> {
    return this.serialized(async () => this.settleReservationPart(input));
  }

  async beginRuntimeBudgetUnit(input: {
    jobId: string; epoch: number; partKey: string; eventKey: string; phase: 'container_readiness' | 'container_restart' | 'mate_proof';
    maximumDurationMs: number; requiredDurationMs?: number; now: number;
  }): Promise<number | null> {
    return this.serialized(async () => {
      if (!Number.isSafeInteger(input.maximumDurationMs) || input.maximumDurationMs <= 0) return null;
      const phaseCap = input.phase === 'container_readiness' ? COST_MODEL.readinessReserveMs
        : input.phase === 'container_restart' ? COST_MODEL.restartReserveMs : COST_MODEL.maxProofRuntimeMs;
      const existing = await this.first<{ phase: string; duration_ms: number | null }>(this.env.DB.prepare(
        'SELECT phase, duration_ms FROM cost_phase_ledger WHERE event_key = ?',
      ).bind(input.eventKey));
      if (existing) return existing.phase === `${input.phase}_intent` ? Number(existing.duration_ms ?? 0) || null : null;
      const job = await this.first<{ status: string; runtime_budget_exceeded: number }>(this.env.DB.prepare(
        'SELECT status, runtime_budget_exceeded FROM jobs WHERE id = ? AND epoch = ?',
      ).bind(input.jobId, input.epoch));
      if (!job || !active(job.status) || job.runtime_budget_exceeded === 1) return null;
      const used = await this.first<{ duration_ms: number }>(this.env.DB.prepare(
        'SELECT COALESCE(SUM(duration_ms), 0) AS duration_ms FROM cost_phase_ledger WHERE job_id = ? AND epoch = ? AND part_key = ? AND phase IN (?, ?)',
      ).bind(input.jobId, input.epoch, input.partKey, input.phase, `${input.phase}_intent`));
      const remainingMs = Math.max(0, phaseCap - Number(used?.duration_ms ?? 0));
      if (remainingMs <= 0 || (input.requiredDurationMs !== undefined && remainingMs < input.requiredDurationMs)) {
        await this.env.DB.prepare('UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ?')
          .bind(iso(input.now), input.jobId, input.epoch).run();
        return null;
      }
      const allowedMs = Math.min(input.maximumDurationMs, remainingMs);
      const reservationPartKey = input.phase === 'container_readiness' ? `readiness:${input.partKey}`
        : input.phase === 'container_restart' ? `restart:${input.partKey}` : input.partKey;
      await this.env.DB.prepare(
        'INSERT INTO cost_phase_ledger(event_key, job_id, epoch, reservation_key, part_key, phase, cost_kind, amount_usd, duration_ms, engine_ms, day_utc, evidence, created_at) ' +
        'SELECT ?, ?, ?, reservation_key, ?, ?, \'resource\', 0, ?, NULL, ?, ?, ? FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND part_key = ? AND remaining_usd > 0',
      ).bind(input.eventKey, input.jobId, input.epoch, input.partKey, `${input.phase}_intent`, allowedMs, dayUtc(input.now),
        JSON.stringify({ intent: true, maximumDurationMs: allowedMs, budgetMs: phaseCap }), iso(input.now), input.jobId, input.epoch, reservationPartKey).run();
      const persisted = await this.first<{ phase: string; duration_ms: number | null }>(this.env.DB.prepare(
        'SELECT phase, duration_ms FROM cost_phase_ledger WHERE event_key = ?',
      ).bind(input.eventKey));
      return persisted?.phase === `${input.phase}_intent` ? Number(persisted.duration_ms ?? 0) || null : null;
    });
  }

  async completeRuntimeBudgetUnit(input: {
    jobId: string; epoch: number; partKey: string; eventKey: string; phase: 'container_readiness' | 'container_restart' | 'mate_proof';
    durationMs: number; unknown: boolean; evidence?: Record<string, unknown>; now: number;
  }): Promise<boolean> {
    return this.serialized(async () => {
      if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return true;
      const cap = input.phase === 'container_readiness' ? COST_MODEL.readinessReserveMs
        : input.phase === 'container_restart' ? COST_MODEL.restartReserveMs : COST_MODEL.maxProofRuntimeMs;
      const reachedCap = input.phase === 'container_restart' ? '>=' : '>';
      const intent = await this.first<{ phase: string; duration_ms: number | null }>(this.env.DB.prepare(
        'SELECT phase, duration_ms FROM cost_phase_ledger WHERE event_key = ? AND job_id = ? AND epoch = ? AND part_key = ?',
      ).bind(input.eventKey, input.jobId, input.epoch, input.partKey));
      const perUnitOverrun = intent?.phase === `${input.phase}_intent` && intent.duration_ms !== null &&
        input.durationMs > Number(intent.duration_ms);
      const statements: D1PreparedStatement[] = [
        this.env.DB.prepare(
          'UPDATE cost_phase_ledger SET phase = ?, duration_ms = ?, evidence = ? WHERE event_key = ? AND job_id = ? AND epoch = ? AND part_key = ? AND phase = ?',
        ).bind(input.phase, Math.ceil(input.durationMs), JSON.stringify({ ...input.evidence, unknown: input.unknown, budgetMs: cap, observedDurationMs: input.durationMs }),
          input.eventKey, input.jobId, input.epoch, input.partKey, `${input.phase}_intent`),
        this.env.DB.prepare(
          'UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ? AND EXISTS (' +
          'SELECT 1 FROM cost_phase_ledger WHERE job_id = ? AND epoch = ? AND part_key = ? AND phase = ? AND ' +
          '(SELECT COALESCE(SUM(duration_ms), 0) FROM cost_phase_ledger WHERE job_id = ? AND epoch = ? AND part_key = ? AND phase IN (?, ?)) ' + reachedCap + ' ?)',
        ).bind(iso(input.now), input.jobId, input.epoch, input.jobId, input.epoch, input.partKey, input.phase,
          input.jobId, input.epoch, input.partKey, input.phase, `${input.phase}_intent`, cap),
      ];
      if (perUnitOverrun) statements.push(this.env.DB.prepare(
        'UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ?',
      ).bind(iso(input.now), input.jobId, input.epoch));
      await this.env.DB.batch(statements);
      const state = await this.first<{ runtime_budget_exceeded: number }>(this.env.DB.prepare(
        'SELECT runtime_budget_exceeded FROM jobs WHERE id = ? AND epoch = ?',
      ).bind(input.jobId, input.epoch));
      return state?.runtime_budget_exceeded === 1;
    });
  }

  private async settleReservationPart(input: {
    jobId: string; epoch: number; partKey: string; eventKey: string; phase: string;
    costKind: 'resource' | 'service'; amountUsd: number; durationMs?: number | null; engineMs?: number | null;
    evidence?: Record<string, unknown>; now: number; allowOverrun?: boolean; budgetCapMs?: number;
    attemptLedger?: { index: number; attempt: number; ownerId: string; profileId: JobIdentity['profileId']; identityHash: string };
  }): Promise<boolean> {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) return false;
    const duplicate = await this.first<{ event_key: string }>(this.env.DB.prepare('SELECT event_key FROM cost_phase_ledger WHERE event_key = ?').bind(input.eventKey));
    if (duplicate) return true;
    const part = await this.first<CostPartRow>(this.env.DB.prepare(
      'SELECT part_key, reservation_key, start_idx, end_idx, position_index, phase, cost_kind, amount_usd, remaining_usd, reserved_day_utc ' +
      'FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND part_key = ? AND settled_event_key IS NULL',
    ).bind(input.jobId, input.epoch, input.partKey));
    if (!part || part.phase !== input.phase || part.cost_kind !== input.costKind ||
        (!input.allowOverrun && input.amountUsd > Number(part.remaining_usd) + 0.000000001)) return false;
    const day = dayUtc(input.now);
    const createdAt = iso(input.now);
    const amount = input.amountUsd;
    const reservedConsumed = Math.min(amount, Number(part.remaining_usd));
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare('INSERT INTO daily_cost(day_utc, spent_usd, reserved_usd, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT(day_utc) DO NOTHING')
        .bind(day, createdAt),
      this.env.DB.prepare(
        'UPDATE daily_cost SET spent_usd = ROUND(spent_usd + ?, 6), updated_at = ? WHERE day_utc = ? AND EXISTS (' +
        'SELECT 1 FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND part_key = ? AND remaining_usd >= ? AND settled_event_key IS NULL) AND NOT EXISTS (' +
        'SELECT 1 FROM cost_phase_ledger WHERE event_key = ?)',
      ).bind(amount, createdAt, day, input.jobId, input.epoch, input.partKey, reservedConsumed, input.eventKey),
      this.env.DB.prepare(
        'INSERT OR IGNORE INTO cost_phase_ledger(event_key, job_id, epoch, reservation_key, part_key, phase, cost_kind, amount_usd, duration_ms, engine_ms, day_utc, evidence, created_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (' +
        'SELECT 1 FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND part_key = ? AND remaining_usd >= ? AND settled_event_key IS NULL)',
      ).bind(input.eventKey, input.jobId, input.epoch, part.reservation_key, input.partKey, input.phase, input.costKind, amount,
         input.durationMs ?? null, input.engineMs ?? null, day, JSON.stringify(input.evidence ?? {}), createdAt, input.jobId, input.epoch, input.partKey, reservedConsumed),
      this.env.DB.prepare('UPDATE cost_reservation_parts SET remaining_usd = 0, settled_event_key = ? WHERE job_id = ? AND epoch = ? AND part_key = ? AND settled_event_key IS NULL AND remaining_usd >= ? AND EXISTS (SELECT 1 FROM cost_phase_ledger WHERE event_key = ?)')
        .bind(input.eventKey, input.jobId, input.epoch, input.partKey, reservedConsumed, input.eventKey),
      this.env.DB.prepare('UPDATE daily_cost SET reserved_usd = MAX(0, ROUND(reserved_usd - ?, 6)), updated_at = ? WHERE day_utc = ? AND EXISTS (SELECT 1 FROM cost_phase_ledger WHERE event_key = ?)')
        .bind(Number(part.remaining_usd), createdAt, part.reserved_day_utc, input.eventKey),
      this.env.DB.prepare('UPDATE jobs SET cost_reserved = MAX(0, ROUND(cost_reserved - ?, 6)), updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM cost_phase_ledger WHERE event_key = ?)')
        .bind(Number(part.remaining_usd), createdAt, input.jobId, input.eventKey),
    ];
    if (part.position_index !== null) {
      statements.push(this.env.DB.prepare('UPDATE positions SET cost_reserved = MAX(0, ROUND(cost_reserved - ?, 6)), updated_at = ? WHERE job_id = ? AND position_index = ? AND EXISTS (SELECT 1 FROM cost_phase_ledger WHERE event_key = ?)')
        .bind(Number(part.remaining_usd), createdAt, input.jobId, part.position_index, input.eventKey));
    }
    if (input.attemptLedger) {
      const ledger = input.attemptLedger;
      statements.push(this.env.DB.prepare(
        'INSERT OR IGNORE INTO cost_attempt_ledger(job_id, position_index, attempt, day_utc, owner_id, profile_id, execution_identity_hash, amount_usd, engine_ms, created_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cost_phase_ledger WHERE event_key = ?)',
      ).bind(input.jobId, ledger.index, ledger.attempt, day, ledger.ownerId, ledger.profileId, ledger.identityHash, amount,
        input.engineMs ?? null, createdAt, input.eventKey));
    }
    if (input.allowOverrun && amount > Number(part.remaining_usd) + 0.000000001) {
      statements.push(this.env.DB.prepare('UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ?')
        .bind(createdAt, input.jobId, input.epoch));
    }
    if (input.budgetCapMs !== undefined && input.durationMs !== null && input.durationMs !== undefined && input.durationMs > input.budgetCapMs) {
      statements.push(this.env.DB.prepare('UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ?')
        .bind(createdAt, input.jobId, input.epoch));
    }
    try {
      await this.env.DB.batch(statements);
      const settled = await this.first<{ settled_event_key: string | null }>(this.env.DB.prepare(
        'SELECT settled_event_key FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND part_key = ?',
      ).bind(input.jobId, input.epoch, input.partKey));
      return settled?.settled_event_key === input.eventKey;
    } catch { return false; }
  }

  async recordCostObservation(input: {
    jobId: string; epoch: number; eventKey: string; partKey?: string; phase: string; durationMs: number | null;
    evidence?: Record<string, unknown>; now: number;
  }): Promise<void> {
    await this.serialized(async () => {
      const createdAt = iso(input.now);
      await this.env.DB.prepare(
        'INSERT OR IGNORE INTO cost_phase_ledger(event_key, job_id, epoch, reservation_key, part_key, phase, cost_kind, amount_usd, duration_ms, engine_ms, day_utc, evidence, created_at) ' +
        'VALUES (?, ?, ?, NULL, ?, ?, \'resource\', 0, ?, NULL, ?, ?, ?)',
      ).bind(input.eventKey, input.jobId, input.epoch, input.partKey ?? null, input.phase, input.durationMs, dayUtc(input.now), JSON.stringify(input.evidence ?? {}), createdAt).run();
      if (input.partKey && (input.phase === 'container_readiness' || input.phase === 'container_restart')) {
        const cap = input.phase === 'container_readiness' ? COST_MODEL.readinessReserveMs : COST_MODEL.restartReserveMs;
        await this.env.DB.prepare(
          'UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ? AND ' +
          '(SELECT COALESCE(SUM(duration_ms), 0) FROM cost_phase_ledger WHERE job_id = ? AND epoch = ? AND part_key = ? AND phase IN (?, ?)) > ?',
        ).bind(createdAt, input.jobId, input.epoch, input.jobId, input.epoch, input.partKey, input.phase, `${input.phase}_intent`, cap).run();
      }
    });
  }

  async recordEngineRestart(input: {
    jobId: string; epoch: number; profileId: JobIdentity['profileId']; engineEpoch: string; restartCount: number;
    chunkStart: number; chunkEnd: number; now: number; budgetEventKey?: string;
  }): Promise<number> {
    if (!input.engineEpoch || input.engineEpoch.length > 128 || !Number.isSafeInteger(input.restartCount) || input.restartCount < 1 || input.restartCount > 32) return 0;
    return this.serialized(async () => {
      const createdAt = iso(input.now);
      const chunkKey = `chunk:${input.chunkStart}:${input.chunkEnd}`;
      let newlyObserved = 0;
      for (let count = 1; count <= input.restartCount; count += 1) {
        const eventKey = `engine-restart:${input.profileId}:${input.engineEpoch}:${count}`;
        const eventInsert = this.env.DB.prepare('INSERT OR IGNORE INTO engine_restart_events(profile_id, engine_epoch, restart_count, job_id, event_key, observed_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(input.profileId, input.engineEpoch, count, input.jobId, eventKey, createdAt);
        if (input.budgetEventKey) {
          const inserted = await eventInsert.run();
          if (inserted.meta.changes === 1) newlyObserved += 1;
          continue;
        }
        const ledgerInsert = this.env.DB.prepare(
            'INSERT OR IGNORE INTO cost_phase_ledger(event_key, job_id, epoch, reservation_key, part_key, phase, cost_kind, amount_usd, duration_ms, engine_ms, day_utc, evidence, created_at) ' +
            'SELECT ?, ?, ?, NULL, ?, \'container_restart\', \'resource\', 0, ?, NULL, ?, ?, ? WHERE EXISTS (' +
            'SELECT 1 FROM engine_restart_events WHERE event_key = ? AND job_id = ?)',
          ).bind(eventKey, input.jobId, input.epoch, chunkKey, COST_MODEL.readinessCallTimeoutMs, dayUtc(input.now),
            JSON.stringify({ restartCount: count, conservativeRestartBoundMs: COST_MODEL.readinessCallTimeoutMs, source: 'observed_engine_restart_count' }),
            createdAt, eventKey, input.jobId);
        const result = await this.env.DB.batch([eventInsert, ledgerInsert]);
        if (result[1]?.meta.changes === 1) newlyObserved += 1;
      }
      await this.env.DB.prepare(
        'UPDATE jobs SET runtime_budget_exceeded = 1, updated_at = ? WHERE id = ? AND epoch = ? AND ' +
        '(SELECT COALESCE(SUM(duration_ms), 0) FROM cost_phase_ledger WHERE job_id = ? AND epoch = ? AND part_key = ? AND phase = \'container_restart\') > ?',
      ).bind(createdAt, input.jobId, input.epoch, input.jobId, input.epoch, chunkKey, COST_MODEL.restartReserveMs).run();
      return newlyObserved;
    });
  }

  async recordContainerLifecycleEvent(input: {
    profileId: JobIdentity['profileId']; lifecycleKey: string; event: 'first_contact' | 'sleep_timer_elapsed' | 'sleep_confirmed' | 'stop_confirmed' | 'stop_failed';
    details?: Record<string, unknown>; now: number;
  }): Promise<void> {
    if (!input.lifecycleKey || input.lifecycleKey.length > 128) return;
    await this.serialized(async () => {
      await this.env.DB.prepare('INSERT OR IGNORE INTO container_lifecycle_events(profile_id, lifecycle_key, event, observed_at, details) VALUES (?, ?, ?, ?, ?)')
        .bind(input.profileId, input.lifecycleKey, input.event, iso(input.now), JSON.stringify(input.details ?? {})).run();
    });
  }

  private async settlePositionCostParts(jobId: string, epoch: number, index: number, now: number): Promise<boolean> {
    const position = await this.first<{ attempts: number; profile_id: JobIdentity['profileId'] }>(this.env.DB.prepare(
      'SELECT p.attempts, j.profile_id FROM positions p JOIN jobs j ON j.id = p.job_id WHERE p.job_id = ? AND p.position_index = ? AND j.epoch = ?',
    ).bind(jobId, index, epoch));
    if (!position) return false;
    const parts = await this.env.DB.prepare(
      'SELECT part_key, reservation_key, start_idx, end_idx, position_index, phase, cost_kind, amount_usd, remaining_usd, reserved_day_utc ' +
      'FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND position_index = ? AND settled_event_key IS NULL ORDER BY phase, part_key',
    ).bind(jobId, epoch, index).all<CostPartRow>();
    for (const part of parts.results) {
      let amount = 0;
      let durationMs: number | null = 0;
      let evidence: Record<string, unknown> = { unused: true, reason: 'phase_not_started' };
      let allowOverrun = false;
      if (part.phase === 'engine_attempt') {
        const match = part.part_key.match(/^attempt:\d+:(\d+)$/);
        const attempt = Number(match?.[1] ?? 0);
        if (attempt > 0 && attempt <= position.attempts) {
          const profile = ANALYSIS_PROFILES[position.profile_id];
          amount = estimateWorstCaseAttemptCostUsd(profile);
          durationMs = null;
          evidence = { unknown: true, reason: 'durable_dispatch_intent_without_cost_observation', attempt };
          allowOverrun = true;
        }
      } else if (part.phase === 'mate_proof') {
        const intent = await this.first<{ duration_ms: number | null; phase: string }>(this.env.DB.prepare(
          'SELECT duration_ms, phase FROM cost_phase_ledger WHERE event_key = ?',
        ).bind(`proof-intent:${jobId}:${epoch}:${index}`));
        if (intent) {
          const profile = ANALYSIS_PROFILES[position.profile_id];
          durationMs = intent.phase === 'mate_proof_intent' ? null : Number(intent.duration_ms ?? COST_MODEL.maxProofRuntimeMs);
          amount = estimateRuntimeCostUsd(durationMs ?? COST_MODEL.maxProofRuntimeMs, profile.instanceType);
          evidence = { unknown: intent.phase === 'mate_proof_intent', reason: 'proof_intent_without_cost_settlement', reservedBudgetMs: COST_MODEL.maxProofRuntimeMs };
          allowOverrun = true;
        }
      }
      const settled = await this.settleReservationPart({
        jobId, epoch, partKey: part.part_key, eventKey: `position-final:${jobId}:${epoch}:${part.part_key}`,
        phase: part.phase, costKind: part.cost_kind, amountUsd: amount, durationMs, now, evidence, allowOverrun,
      });
      if (!settled) return false;
    }
    return true;
  }

  private async settleChunkLifecycle(jobId: string, epoch: number, start: number, end: number, now: number): Promise<boolean> {
    const job = await this.first<{ profile_id: JobIdentity['profileId']; instance_type: JobIdentity['instanceType'] }>(this.env.DB.prepare(
      'SELECT profile_id, instance_type FROM jobs WHERE id = ? AND epoch = ?',
    ).bind(jobId, epoch));
    if (!job) return false;
    const chunkKey = `chunk:${start}:${end}`;
    const parts = await this.env.DB.prepare(
      'SELECT part_key, reservation_key, start_idx, end_idx, position_index, phase, cost_kind, amount_usd, remaining_usd, reserved_day_utc ' +
      'FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND start_idx = ? AND end_idx = ? AND settled_event_key IS NULL',
    ).bind(jobId, epoch, start, end).all<CostPartRow>();
    if (parts.results.length === 0) return true;
    const observations = await this.env.DB.prepare(
      'SELECT phase, duration_ms, evidence FROM cost_phase_ledger WHERE job_id = ? AND epoch = ? AND part_key = ? ' +
      'AND phase IN (\'container_readiness\', \'container_readiness_intent\', \'container_restart\', \'container_restart_intent\')',
    ).bind(jobId, epoch, chunkKey).all<{ phase: string; duration_ms: number | null; evidence: string }>();
    const readinessRows = observations.results.filter((row) => row.phase === 'container_readiness' || row.phase === 'container_readiness_intent');
    const restartRows = observations.results.filter((row) => row.phase === 'container_restart' || row.phase === 'container_restart_intent');
    const hasRuntimeContact = readinessRows.length > 0 || restartRows.length > 0;
    const unknownReadiness = readinessRows.some((row) => {
      try { const evidence = JSON.parse(row.evidence) as { unknown?: boolean; intent?: boolean }; return evidence.unknown === true || evidence.intent === true; } catch { return true; }
    });
    const unknownRestart = restartRows.some((row) => {
      try { const evidence = JSON.parse(row.evidence) as { unknown?: boolean; intent?: boolean }; return evidence.unknown === true || evidence.intent === true; } catch { return true; }
    });
    const readinessObservedMs = readinessRows.reduce((sum, row) => sum + Math.max(0, Number(row.duration_ms ?? 0)), 0);
    const unmeasuredReadiness = readinessRows.some((row) => {
      if (row.duration_ms !== null) return false;
      try { return (JSON.parse(row.evidence) as { unknown?: boolean }).unknown === true; } catch { return true; }
    });
    const readinessMs = unmeasuredReadiness ? Math.max(readinessObservedMs, COST_MODEL.readinessReserveMs) : readinessObservedMs;
    const restartMs = restartRows.reduce((sum, row) => sum + Math.max(0, Number(row.duration_ms ?? 0)), 0);
    const profileType = job.instance_type;
    const measurements: Array<{ phase: string; amount: number; durationMs: number | null; evidence: Record<string, unknown> }> = [
      { phase: 'container_readiness', amount: estimateRuntimeCostUsd(readinessMs, profileType), durationMs: readinessMs, evidence: { unknown: unknownReadiness, observations: readinessRows.length, budgetMs: COST_MODEL.readinessReserveMs, overrunMs: Math.max(0, readinessMs - COST_MODEL.readinessReserveMs) } },
      { phase: 'container_restart', amount: estimateRuntimeCostUsd(restartMs, profileType), durationMs: restartMs, evidence: { unknown: unknownRestart, observations: restartRows.length, budgetMs: COST_MODEL.restartReserveMs, overrunMs: Math.max(0, restartMs - COST_MODEL.restartReserveMs) } },
    ];
    for (const phase of ['container_readiness', 'container_restart']) {
      const part = parts.results.find((row) => row.phase === phase);
      const measurement = measurements.find((row) => row.phase === phase);
      if (part && measurement && !await this.settleReservationPart({
        jobId, epoch, partKey: part.part_key, eventKey: `settlement:${jobId}:${epoch}:${chunkKey}:${phase}`,
        phase, costKind: 'resource', amountUsd: measurement.amount,
        durationMs: measurement.durationMs, now, evidence: measurement.evidence, allowOverrun: true,
      })) return false;
    }
    for (const part of parts.results.filter((row) => row.phase === 'inter_position_runtime')) {
      const match = /^interposition:(\d+)$/.exec(part.part_key);
      const previousIndex = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(previousIndex)) return false;
      const [previous, next] = await Promise.all([
        this.first<{ updated_at: string }>(this.env.DB.prepare(
          'SELECT updated_at FROM positions WHERE job_id = ? AND position_index = ?',
        ).bind(jobId, previousIndex)),
        this.first<{ status: string; attempts: number; lease_id: string | null; updated_at: string }>(this.env.DB.prepare(
          'SELECT status, attempts, lease_id, updated_at FROM positions WHERE job_id = ? AND position_index = ?',
        ).bind(jobId, previousIndex + 1)),
      ]);
      if (!previous || !next) return false;
      const previousAt = Date.parse(previous.updated_at);
      const nextAt = Date.parse(next.updated_at);
      const started = next.status !== 'pending' || next.attempts > 0 || next.lease_id !== null || nextAt > previousAt;
      const knownInterval = Number.isFinite(previousAt) && Number.isFinite(nextAt);
      const durationMs = !started ? 0 : knownInterval ? Math.max(0, nextAt - previousAt) : COST_MODEL.interPositionMaxMs;
      if (!await this.settleReservationPart({
        jobId, epoch, partKey: part.part_key,
        eventKey: `settlement:${jobId}:${epoch}:${chunkKey}:interposition:${previousIndex}`,
        phase: part.phase, costKind: part.cost_kind,
        amountUsd: estimateRuntimeCostUsd(durationMs, profileType), durationMs, now,
        evidence: { unknown: started && !knownInterval, measuredElapsedMs: knownInterval ? durationMs : null,
          budgetMs: COST_MODEL.interPositionMaxMs, overrunMs: Math.max(0, durationMs - COST_MODEL.interPositionMaxMs), fromPosition: previousIndex, toPosition: previousIndex + 1 },
        allowOverrun: true, budgetCapMs: COST_MODEL.interPositionMaxMs,
      })) return false;
    }
    const started = hasRuntimeContact;
    for (const phase of ['final_idle_to_sleep', 'dual_container_idle_overlap', 'bounded_service_allowance']) {
      const part = parts.results.find((row) => row.phase === phase);
      if (!part) continue;
      const shouldSettle = phase === 'bounded_service_allowance' || started;
      if (!await this.settleReservationPart({
        jobId, epoch, partKey: part.part_key, eventKey: `settlement:${jobId}:${epoch}:${chunkKey}:${phase}`,
        phase, costKind: part.cost_kind, amountUsd: shouldSettle ? Number(part.remaining_usd) : 0,
        durationMs: phase === 'final_idle_to_sleep' || phase === 'dual_container_idle_overlap' ? COST_MODEL.containerSleepAfterSeconds * 1000 : null,
        now, evidence: phase === 'bounded_service_allowance'
          ? { formula: '0.0015_per_chunk_plus_0.0005_per_position_plus_0.003_per_job', fixedAllowance: true }
          : { conservativeIdleSeconds: COST_MODEL.containerSleepAfterSeconds, sleepConfirmedBy: 'sleepAfter/onActivityExpired', stopFailureSettledAtCap: true },
      })) return false;
    }
    return true;
  }

  private async settleChunkReservations(jobId: string, epoch: number, start: number, end: number, now: number): Promise<boolean> {
    for (let index = start; index < end; index += 1) {
      if (!await this.settlePositionCostParts(jobId, epoch, index, now)) return false;
    }
    if (!await this.settleChunkLifecycle(jobId, epoch, start, end, now)) return false;
    const unsettled = await this.first<{ count: number }>(this.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND start_idx = ? AND end_idx = ? AND (settled_event_key IS NULL OR remaining_usd > 0)',
    ).bind(jobId, epoch, start, end));
    return Number(unsettled?.count ?? 0) === 0;
  }

  private async finalizeTerminalCostsInternal(jobId: string, epoch: number, now: number): Promise<boolean> {
    const job = await this.first<{ status: string; cost_finalized: number; cost_reserved: number }>(this.env.DB.prepare(
      'SELECT status, cost_finalized, cost_reserved FROM jobs WHERE id = ? AND epoch = ?',
    ).bind(jobId, epoch));
    if (!job) return false;
    if (job.cost_finalized === 1) return true;
    if (active(job.status) || job.status === 'cancelling') return false;
    const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
    if (slot?.job_id === jobId && slot.epoch === epoch && slot.lease_id) return false;
    const batches = await this.env.DB.prepare(
      'SELECT start_idx, end_idx FROM cost_reservation_batches WHERE job_id = ? AND epoch = ? ORDER BY start_idx',
    ).bind(jobId, epoch).all<{ start_idx: number; end_idx: number }>();
    for (const chunk of batches.results) {
      if (!await this.settleChunkReservations(jobId, epoch, chunk.start_idx, chunk.end_idx, now)) return false;
    }
    const unsettled = await this.first<{ count: number; amount: number }>(this.env.DB.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(remaining_usd), 0) AS amount FROM cost_reservation_parts WHERE job_id = ? AND epoch = ? AND (settled_event_key IS NULL OR remaining_usd > 0)',
    ).bind(jobId, epoch));
    if (Number(unsettled?.count ?? 0) > 0 || Number(unsettled?.amount ?? 0) > 0.000001) return false;
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE outbox SET completed_at = COALESCE(completed_at, ?), dispatchable = 0 WHERE job_id = ? AND epoch = ?')
        .bind(iso(now), jobId, epoch),
      this.env.DB.prepare('UPDATE jobs SET cost_finalized = 1, updated_at = ? WHERE id = ? AND epoch = ? AND status IN (\'completed\', \'partial\', \'failed\', \'cancelled\')')
        .bind(iso(now), jobId, epoch),
    ]);
    const finalized = await this.first<{ cost_finalized: number; cost_reserved: number }>(this.env.DB.prepare(
      'SELECT cost_finalized, cost_reserved FROM jobs WHERE id = ? AND epoch = ?',
    ).bind(jobId, epoch));
    return finalized?.cost_finalized === 1 && Number(finalized.cost_reserved) <= 0.000001;
  }

  private async recordUnknownSlotCost(slot: SlotRow, now: number): Promise<boolean> {
    if (!slot.job_id || slot.position_index === null || slot.attempt === null || slot.attempt < 1) return true;
    const job = await this.first<{ owner_id: string; profile_id: JobIdentity['profileId']; execution_identity_hash: string }>(
      this.env.DB.prepare('SELECT owner_id, profile_id, execution_identity_hash FROM jobs WHERE id = ?').bind(slot.job_id),
    );
    if (!job) return true;
    return this.settleReservationPart({
      jobId: slot.job_id, epoch: slot.epoch ?? 0, partKey: `attempt:${slot.position_index}:${slot.attempt}`,
      eventKey: `attempt:${slot.job_id}:${slot.epoch ?? 0}:${slot.position_index}:${slot.attempt}`,
      phase: 'engine_attempt', costKind: 'resource', amountUsd: estimateWorstCaseAttemptCostUsd(ANALYSIS_PROFILES[job.profile_id]),
      durationMs: null, engineMs: null, now, evidence: { reason: 'unknown_execution_destroy_confirmed', conservativeDeadline: true },
      attemptLedger: { index: slot.position_index, attempt: slot.attempt, ownerId: job.owner_id, profileId: job.profile_id,
        identityHash: job.execution_identity_hash },
    });
  }

  async releaseForRetry(position: ClaimedPosition, detail: string, now: number): Promise<boolean> {
    return this.serialized(async () => {
      const row = await this.env.DB.prepare(
        "UPDATE positions SET status = 'pending', lease_id = NULL, lease_expires_at = NULL, error_detail = ?, updated_at = ? WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ?",
      ).bind(detail.slice(0, 120), iso(now), position.jobId, position.index, position.leaseId).run();
      if (row.meta.changes === 0) return false;
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE global_search_slot SET job_id = NULL, epoch = NULL, position_index = NULL, attempt = NULL, lease_id = NULL, lease_expires_at = NULL, profile_id = NULL, quarantine_required = 0, updated_at = ? WHERE singleton = 1 AND job_id = ? AND epoch = ? AND lease_id = ?')
          .bind(iso(now), position.jobId, position.epoch, position.leaseId),
        this.env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ? AND epoch = ?').bind(iso(now), position.jobId, position.epoch),
      ]);
      return true;
    });
  }

  private async nextResultSeq(jobId: string, epoch: number): Promise<number | null> {
    const row = await this.first<{ result_seq_next: number }>(this.env.DB.prepare(
      "UPDATE jobs SET result_seq_next = result_seq_next + 1 WHERE id = ? AND epoch = ? AND status = 'running' RETURNING result_seq_next",
    ).bind(jobId, epoch));
    return row?.result_seq_next ?? null;
  }

  async commitPosition(
    position: ClaimedPosition,
    resultJson: string,
    statsJson: string | null,
    proofJson: string | null,
    cacheEligible: boolean,
    cached: boolean,
    amountUsd: number,
    engineMs: number,
    now: number,
  ): Promise<number | null> {
    return this.serialized(async () => {
      const job = await this.first<{ status: string; epoch: number; execution_identity_hash: string }>(this.env.DB.prepare('SELECT status, epoch, execution_identity_hash FROM jobs WHERE id = ?').bind(position.jobId));
      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      const current = await this.first<{ status: string; lease_id: string | null; cost_reserved: number }>(this.env.DB.prepare('SELECT status, lease_id, cost_reserved FROM positions WHERE job_id = ? AND position_index = ?').bind(position.jobId, position.index));
      if (!job || job.status !== 'running' || job.epoch !== position.epoch || job.execution_identity_hash !== position.identity.executionIdentityHash || current?.status !== 'running' || current.lease_id !== position.leaseId || slot?.lease_id !== position.leaseId || slot.job_id !== position.jobId || slot.epoch !== position.epoch) return null;
      const seq = await this.nextResultSeq(position.jobId, position.epoch);
      if (seq === null) return null;
      const createdAt = iso(now);
      const statements: D1PreparedStatement[] = [
        this.env.DB.prepare(
          "UPDATE positions SET status = 'done', result_json = ?, stats_json = ?, proof_json = ?, engine_terminal = json_extract(?, '$.terminal'), result_seq = ?, cached = ?, error_detail = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND position_index = ? AND status = 'running' AND lease_id = ? AND execution_identity_hash = ?",
        ).bind(resultJson, statsJson, proofJson, resultJson, seq, cached ? 1 : 0, createdAt, position.jobId, position.index, position.leaseId, position.identity.executionIdentityHash),
        this.env.DB.prepare(
          'INSERT OR IGNORE INTO result_cache (contract_version, execution_identity_hash, engine_id, model_id, profile_id, profile_version, sfen, result_json, stats_json, proof_json, quarantined, created_at, last_used_at) ' +
          'SELECT 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE ? = 1 AND EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = \'done\' AND result_seq = ?)',
        ).bind(position.identity.executionIdentityHash, position.identity.engineId, position.identity.modelId, position.identity.profileId,
          position.identity.profileVersion, position.sfen, resultJson, statsJson, proofJson, createdAt, createdAt,
          cacheEligible ? 1 : 0, position.jobId, position.index, seq),
        this.env.DB.prepare(
          'INSERT OR IGNORE INTO cost_ledger(job_id, position_index, owner_id, profile_id, amount_usd, attempts, cached, engine_ms, created_at) ' +
          'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = \'done\' AND result_seq = ?)',
        ).bind(position.jobId, position.index, position.ownerId, position.identity.profileId, cached ? 0 : amountUsd,
          position.attempts, cached ? 1 : 0, engineMs, createdAt, position.jobId, position.index, seq),
        this.env.DB.prepare("UPDATE global_search_slot SET job_id = NULL, epoch = NULL, position_index = NULL, attempt = NULL, lease_id = NULL, lease_expires_at = NULL, profile_id = NULL, quarantine_required = 0, updated_at = ? WHERE singleton = 1 AND job_id = ? AND epoch = ? AND lease_id = ? AND EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = 'done' AND result_seq = ?)")
          .bind(createdAt, position.jobId, position.epoch, position.leaseId, position.jobId, position.index, seq),
        this.env.DB.prepare(
          "UPDATE jobs SET committed_count = (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'done'), consecutive_failures = 0, updated_at = ? WHERE id = ? AND epoch = ? AND status = 'running' AND EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND position_index = ? AND status = 'done' AND result_seq = ?)",
        ).bind(position.jobId, createdAt, position.jobId, position.epoch, position.jobId, position.index, seq),
      ];
      await this.env.DB.batch(statements);
      const applied = await this.first<{ result_seq: number | null; status: string }>(this.env.DB.prepare(
        'SELECT result_seq, status FROM positions WHERE job_id = ? AND position_index = ?',
      ).bind(position.jobId, position.index));
      if (applied?.status !== 'done' || applied.result_seq !== seq) return null;
      if (!await this.settlePositionCostParts(position.jobId, position.epoch, position.index, now)) throw new Error('position_cost_finalization_pending');
      return seq;
    });
  }

  async failPosition(
    position: ClaimedPosition,
    detail: string,
    now: number,
    options: { fatalProtocol?: boolean; evaluationMissing?: boolean; resultJson?: string | null; statsJson?: string | null } = {},
  ): Promise<number | null> {
    return this.serialized(async () => {
      const job = await this.first<{ status: string; epoch: number; committed_count: number }>(this.env.DB.prepare('SELECT status, epoch, committed_count FROM jobs WHERE id = ?').bind(position.jobId));
      if (!job || job.epoch !== position.epoch || job.status === 'cancelled' || job.status === 'cancelling') {
        const current = await this.first<{ lease_id: string | null }>(this.env.DB.prepare('SELECT lease_id FROM positions WHERE job_id = ? AND position_index = ?').bind(position.jobId, position.index));
        if (current?.lease_id === position.leaseId) {
          await this.env.DB.batch([
            this.env.DB.prepare("UPDATE positions SET status = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND position_index = ? AND lease_id = ?")
              .bind(iso(now), position.jobId, position.index, position.leaseId),
            this.env.DB.prepare('UPDATE global_search_slot SET job_id = NULL, epoch = NULL, position_index = NULL, attempt = NULL, lease_id = NULL, lease_expires_at = NULL, profile_id = NULL, quarantine_required = 0, updated_at = ? WHERE singleton = 1 AND job_id = ? AND epoch = ? AND lease_id = ?')
              .bind(iso(now), position.jobId, position.epoch, position.leaseId),
          ]);
        }
        await this.finishCancellation(position.jobId, position.epoch, now);
        return null;
      }
      const current = await this.first<{ status: string; lease_id: string | null; attempts: number }>(this.env.DB.prepare('SELECT status, lease_id, attempts FROM positions WHERE job_id = ? AND position_index = ?').bind(position.jobId, position.index));
      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      const ownsRunningSlot = current?.status === 'running' && current.lease_id === position.leaseId && slot?.lease_id === position.leaseId && slot.job_id === position.jobId && slot.epoch === position.epoch;
      const confirmedDeathAfterLastAttempt = current?.status === 'pending' && current.lease_id === null &&
        current.attempts >= 2 && position.attempts >= 2 && slot?.lease_id !== position.leaseId;
      if (!ownsRunningSlot && !confirmedDeathAfterLastAttempt) return null;
      const seq = await this.nextResultSeq(position.jobId, position.epoch);
      if (seq === null) return null;
      const completedAt = iso(now);
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE positions SET status = 'failed', result_json = ?, stats_json = ?, engine_terminal = COALESCE(json_extract(?, '$.terminal'), ?), result_seq = ?, error_detail = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND position_index = ? AND ((status = 'running' AND lease_id = ?) OR (status = 'pending' AND lease_id IS NULL AND attempts >= 2))",
        ).bind(options.resultJson ?? null, options.statsJson ?? null, options.resultJson ?? null, detail, seq, detail.slice(0, 120), completedAt, position.jobId, position.index, position.leaseId),
        this.env.DB.prepare('UPDATE global_search_slot SET job_id = NULL, epoch = NULL, position_index = NULL, attempt = NULL, lease_id = NULL, lease_expires_at = NULL, profile_id = NULL, quarantine_required = 0, updated_at = ? WHERE singleton = 1 AND job_id = ? AND epoch = ? AND lease_id = ?')
          .bind(completedAt, position.jobId, position.epoch, position.leaseId),
      ]);
      if (!await this.settlePositionCostParts(position.jobId, position.epoch, position.index, now)) throw new Error('position_cost_finalization_pending');
      const counts = await this.first<{ failed: number; missing: number; done: number }>(this.env.DB.prepare(
        "SELECT SUM(CASE WHEN status = 'failed' AND COALESCE(error_detail, '') NOT IN ('incomplete', 'evaluation_missing:resign') THEN 1 ELSE 0 END) AS failed, " +
        "SUM(CASE WHEN status = 'failed' AND COALESCE(error_detail, '') IN ('incomplete', 'evaluation_missing:resign') THEN 1 ELSE 0 END) AS missing, " +
        "SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM positions WHERE job_id = ?",
      ).bind(position.jobId));
      const failed = Number(counts?.failed ?? 0);
      const missing = Number(counts?.missing ?? 0);
      const done = Number(counts?.done ?? 0);
      const fatal = options.fatalProtocol === true;
      const threshold = !options.evaluationMissing && (failed >= 5 || await this.failureStreakReached(position.jobId, 3));
      const terminal = fatal || threshold;
      const nextStatus = fatal ? 'failed' : terminal ? (done > 0 || missing > 0 ? 'partial' : 'failed') : 'running';
      await this.env.DB.prepare(
        'UPDATE jobs SET failed_count = ?, committed_count = ?, consecutive_failures = CASE WHEN ? THEN consecutive_failures WHEN ? THEN consecutive_failures + 1 ELSE consecutive_failures END, status = ?, stop_reason = CASE WHEN ? THEN ? WHEN ? THEN \'failure_threshold\' ELSE stop_reason END, completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END, updated_at = ? WHERE id = ? AND epoch = ? AND status IN (\'queued\', \'running\')',
      ).bind(failed, done, options.evaluationMissing ? 1 : 0, options.evaluationMissing ? 0 : 1, nextStatus,
        fatal ? 1 : 0, detail.slice(0, 120), threshold ? 1 : 0, terminal ? 1 : 0, completedAt, completedAt, position.jobId, position.epoch).run();
      if (fatal) {
        await this.env.DB.prepare('INSERT INTO flags(key, value, updated_at) VALUES (?, \'1\', ?) ON CONFLICT(key) DO UPDATE SET value = \'1\', updated_at = excluded.updated_at')
          .bind('profile_blocked:' + position.identity.profileId, completedAt).run();
      }
      if (terminal) await this.finalizeTerminalCostsInternal(position.jobId, position.epoch, now);
      return seq;
    });
  }

  private async failureStreakReached(jobId: string, threshold: number): Promise<boolean> {
    const row = await this.first<{ consecutive_failures: number }>(this.env.DB.prepare('SELECT consecutive_failures FROM jobs WHERE id = ?').bind(jobId));
    return Number(row?.consecutive_failures ?? 0) + 1 >= threshold;
  }

  private async stopJob(jobId: string, epoch: number, reason: string, now: number): Promise<void> {
    const counts = await this.first<{ done: number }>(this.env.DB.prepare(
      "SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM positions WHERE job_id = ?",
    ).bind(jobId));
    const done = Number(counts?.done ?? 0);
    const terminal = done > 0 ? 'partial' : 'failed';
    await this.env.DB.prepare(
      'UPDATE jobs SET status = ?, stop_reason = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND epoch = ? AND status IN (\'queued\', \'running\')',
    ).bind(terminal, reason, iso(now), iso(now), jobId, epoch).run();
    await this.finalizeTerminalCostsInternal(jobId, epoch, now);
  }

  private async finishRuntimeBudgetExceededInternal(jobId: string, epoch: number, now: number): Promise<void> {
    const job = await this.first<{ status: string; runtime_budget_exceeded: number }>(this.env.DB.prepare(
      'SELECT status, runtime_budget_exceeded FROM jobs WHERE id = ? AND epoch = ?',
    ).bind(jobId, epoch));
    if (!job || job.runtime_budget_exceeded !== 1) return;
    const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
    if (slot?.job_id === jobId && slot.epoch === epoch && slot.lease_id) return;
    if (active(job.status)) {
      const counts = await this.first<{ done: number }>(this.env.DB.prepare(
        "SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM positions WHERE job_id = ?",
      ).bind(jobId));
      const status = Number(counts?.done ?? 0) > 0 ? 'partial' : 'failed';
      await this.env.DB.prepare(
        "UPDATE jobs SET status = ?, stop_reason = 'runtime_budget_exceeded', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND epoch = ? AND status IN ('queued', 'running')",
      ).bind(status, iso(now), iso(now), jobId, epoch).run();
    }
    await this.finalizeTerminalCostsInternal(jobId, epoch, now);
  }

  async finishRuntimeBudgetExceeded(jobId: string, epoch: number, now: number): Promise<boolean> {
    return this.serialized(async () => {
      await this.finishRuntimeBudgetExceededInternal(jobId, epoch, now);
      const row = await this.first<{ status: string; cost_finalized: number; runtime_budget_exceeded: number }>(this.env.DB.prepare(
        'SELECT status, cost_finalized, runtime_budget_exceeded FROM jobs WHERE id = ? AND epoch = ?',
      ).bind(jobId, epoch));
      return row?.runtime_budget_exceeded === 1 && !active(row.status) && row.cost_finalized === 1;
    });
  }

  async runtimeBudgetExceeded(jobId: string, epoch: number): Promise<boolean> {
    return this.serialized(async () => {
      const row = await this.first<{ runtime_budget_exceeded: number }>(this.env.DB.prepare(
        'SELECT runtime_budget_exceeded FROM jobs WHERE id = ? AND epoch = ?',
      ).bind(jobId, epoch));
      return row?.runtime_budget_exceeded === 1;
    });
  }

  async finishChunk(jobId: string, epoch: number, now: number): Promise<void> {
    await this.serialized(async () => this.finishChunkInternal(jobId, epoch, now));
  }

  private async finishChunkInternal(jobId: string, epoch: number, now: number): Promise<void> {
      const current = await this.first<OutboxRow>(this.env.DB.prepare(
        'SELECT id, job_id, epoch, start_idx, end_idx, sent_at, last_sent_at, completed_at FROM outbox ' +
        'WHERE job_id = ? AND epoch = ? AND dispatchable = 1 AND completed_at IS NULL ORDER BY start_idx LIMIT 1',
      ).bind(jobId, epoch));
      if (!current) { await this.finishJobInternal(jobId, epoch, now); return; }
      const remaining = await this.first<{ count: number }>(this.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM positions WHERE job_id = ? AND position_index >= ? AND position_index < ? AND status IN ('pending', 'running')",
      ).bind(jobId, current.start_idx, current.end_idx));
      if (Number(remaining?.count ?? 0) > 0) return;

      const job = await this.first<{ status: JobStatus; profile_id: JobIdentity['profileId']; position_count: number; runtime_budget_exceeded: number }>(this.env.DB.prepare(
        'SELECT status, profile_id, position_count, runtime_budget_exceeded FROM jobs WHERE id = ? AND epoch = ?',
      ).bind(jobId, epoch));
      if (!job) return;
      if (job.runtime_budget_exceeded === 1 && active(job.status)) {
        await this.stopJob(jobId, epoch, 'runtime_budget_exceeded', now);
        return;
      }
      if (!await this.settleChunkReservations(jobId, epoch, current.start_idx, current.end_idx, now)) return;

      const next = await this.first<{ id: number; start_idx: number; end_idx: number }>(this.env.DB.prepare(
        'SELECT id, start_idx, end_idx FROM outbox WHERE job_id = ? AND epoch = ? AND completed_at IS NULL AND start_idx > ? ORDER BY start_idx LIMIT 1',
      ).bind(jobId, epoch, current.start_idx));
      if (!active(job.status)) {
        await this.finalizeTerminalCostsInternal(jobId, epoch, now);
        return;
      }

      if (next) {
        const reservationKey = `job:${jobId}:${epoch}:${next.start_idx}:${next.end_idx}`;
        const parts = estimateChunkReservationParts(ANALYSIS_PROFILES[job.profile_id], next.start_idx, next.end_idx, false);
        const reservation = parts.reduce((sum, part) => sum + part.amountUsd, 0);
        const day = dayUtc(now);
        await this.dailyCost(day);
        const createdAt = iso(now);
        const partRows = parts.map((part) => [
          part.partKey, reservationKey, jobId, epoch, next.start_idx, next.end_idx, part.positionIndex, part.phase, part.costKind,
          part.amountUsd, part.amountUsd, day, createdAt,
        ] as const);
        const positionCostRows = Array.from({ length: next.end_idx - next.start_idx }, (_, offset) => {
          const index = next.start_idx + offset;
          return [index, parts.filter((part) => part.positionIndex === index).reduce((sum, part) => sum + part.amountUsd, 0)] as const;
        });
        const statements: D1PreparedStatement[] = [
          this.env.DB.prepare('UPDATE outbox SET completed_at = COALESCE(completed_at, ?), dispatchable = 0 WHERE id = ? AND completed_at IS NULL')
            .bind(createdAt, current.id),
          this.env.DB.prepare(
            'INSERT INTO cost_reservation_batches(reservation_key, job_id, epoch, start_idx, end_idx, amount_usd, reserved_day_utc, created_at) ' +
            'SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ' +
            '(SELECT COALESCE(spent_usd, 0) FROM daily_cost WHERE day_utc = ?) + ' +
            '(SELECT COALESCE(SUM(cost_reserved), 0) FROM jobs) + ? <= ?',
          ).bind(reservationKey, jobId, epoch, next.start_idx, next.end_idx, reservation, day, createdAt, day, reservation, this.dailyCostCapUsd()),
          ...manyGuardedInserts(this.env.DB, 'cost_reservation_parts', [
            'part_key', 'reservation_key', 'job_id', 'epoch', 'start_idx', 'end_idx', 'position_index', 'phase', 'cost_kind',
            'amount_usd', 'remaining_usd', 'reserved_day_utc', 'created_at',
          ], partRows, reservationKey),
          this.env.DB.prepare('UPDATE daily_cost SET reserved_usd = reserved_usd + ?, updated_at = ? WHERE day_utc = ? AND EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)')
            .bind(reservation, createdAt, day, reservationKey),
          this.env.DB.prepare('UPDATE jobs SET cost_reserved = cost_reserved + ?, updated_at = ? WHERE id = ? AND epoch = ? AND EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)')
            .bind(reservation, createdAt, jobId, epoch, reservationKey),
          ...positionCostRows.map(([index, amount]) => this.env.DB.prepare('UPDATE positions SET cost_reserved = ?, updated_at = ? WHERE job_id = ? AND position_index = ? AND EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)')
            .bind(amount, createdAt, jobId, index, reservationKey)),
          this.env.DB.prepare('UPDATE outbox SET dispatchable = 1 WHERE id = ? AND completed_at IS NULL AND EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)')
            .bind(next.id, reservationKey),
          this.env.DB.prepare(
            "UPDATE positions SET status = 'failed', error_detail = 'cost_cap', engine_terminal = 'failed', result_seq = position_index + 1, lease_id = NULL, lease_expires_at = NULL, cost_reserved = 0, updated_at = ? " +
            'WHERE job_id = ? AND position_index >= ? AND status = \'pending\' AND NOT EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)',
          ).bind(createdAt, jobId, next.start_idx, reservationKey),
          this.env.DB.prepare(
            "UPDATE jobs SET status = CASE WHEN EXISTS (SELECT 1 FROM positions WHERE job_id = ? AND status = 'done') THEN 'partial' ELSE 'failed' END, " +
            "committed_count = (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'done'), " +
            "failed_count = (SELECT COUNT(*) FROM positions WHERE job_id = ? AND status = 'failed' AND COALESCE(error_detail, '') NOT IN ('incomplete', 'evaluation_missing:resign')), " +
            "stop_reason = 'cost_cap', completed_at = COALESCE(completed_at, ?), updated_at = ?, result_seq_next = MAX(result_seq_next, (SELECT COALESCE(MAX(result_seq), 0) FROM positions WHERE job_id = ?)) " +
            "WHERE id = ? AND epoch = ? AND status IN ('queued', 'running') AND NOT EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)",
          ).bind(jobId, jobId, jobId, createdAt, createdAt, jobId, jobId, epoch, reservationKey),
          this.env.DB.prepare('UPDATE outbox SET completed_at = COALESCE(completed_at, ?), dispatchable = 0 WHERE job_id = ? AND epoch = ? AND start_idx >= ? AND NOT EXISTS (SELECT 1 FROM cost_reservation_batches WHERE reservation_key = ?)')
            .bind(createdAt, jobId, epoch, next.start_idx, reservationKey),
        ];
        try { await this.env.DB.batch(statements); } catch { return; }
        const reserved = await this.first<{ reservation_key: string }>(this.env.DB.prepare('SELECT reservation_key FROM cost_reservation_batches WHERE reservation_key = ?').bind(reservationKey));
        if (reserved) await this.flushHeadOutbox(jobId, now, true);
        else await this.finalizeTerminalCostsInternal(jobId, epoch, now);
        return;
      }

      const counts = await this.first<{ done: number; failed: number; missing: number; pending: number; running: number }>(this.env.DB.prepare(
        "SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done, " +
        "SUM(CASE WHEN status = 'failed' AND COALESCE(error_detail, '') NOT IN ('incomplete', 'evaluation_missing:resign') THEN 1 ELSE 0 END) AS failed, " +
        "SUM(CASE WHEN status = 'failed' AND COALESCE(error_detail, '') IN ('incomplete', 'evaluation_missing:resign') THEN 1 ELSE 0 END) AS missing, " +
        "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM positions WHERE job_id = ?",
      ).bind(jobId));
      if (!counts || Number(counts.pending ?? 0) + Number(counts.running ?? 0) > 0) return;
      const done = Number(counts.done ?? 0);
      const failed = Number(counts.failed ?? 0);
      const missing = Number(counts.missing ?? 0);
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE outbox SET completed_at = COALESCE(completed_at, ?), dispatchable = 0 WHERE job_id = ? AND epoch = ?')
          .bind(iso(now), jobId, epoch),
        this.env.DB.prepare(
          'UPDATE jobs SET status = ?, committed_count = ?, failed_count = ?, stop_reason = CASE WHEN ? > 0 THEN COALESCE(stop_reason, \'position_failures\') ELSE stop_reason END, completed_at = COALESCE(completed_at, ?), updated_at = ? ' +
          "WHERE id = ? AND epoch = ? AND status IN ('queued', 'running')",
        ).bind(finalJobStatus(done, failed + missing), done, failed, failed, iso(now), iso(now), jobId, epoch),
      ]);
      await this.finalizeTerminalCostsInternal(jobId, epoch, now);
  }

  private async finishJobInternal(jobId: string, epoch: number, now: number): Promise<void> {
    const job = await this.first<{ status: string; cancel_requested: number; committed_count: number; cost_finalized: number; runtime_budget_exceeded: number }>(this.env.DB.prepare('SELECT status, cancel_requested, committed_count, cost_finalized, runtime_budget_exceeded FROM jobs WHERE id = ? AND epoch = ?').bind(jobId, epoch));
    if (!job) return;
    if (!active(job.status) && job.status !== 'cancelling') {
      await this.finalizeTerminalCostsInternal(jobId, epoch, now);
      return;
    }
    if (job.status === 'cancelling' || job.cancel_requested === 1) {
      await this.finishCancellation(jobId, epoch, now);
      return;
    }
    if (!active(job.status)) return;
    if (job.runtime_budget_exceeded === 1) {
      await this.finishRuntimeBudgetExceededInternal(jobId, epoch, now);
      return;
    }
    const counts = await this.first<{ done: number; failed: number; missing: number; pending: number; running: number }>(this.env.DB.prepare(
      "SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done, " +
      "SUM(CASE WHEN status = 'failed' AND COALESCE(error_detail, '') NOT IN ('incomplete', 'evaluation_missing:resign') THEN 1 ELSE 0 END) AS failed, " +
      "SUM(CASE WHEN status = 'failed' AND COALESCE(error_detail, '') IN ('incomplete', 'evaluation_missing:resign') THEN 1 ELSE 0 END) AS missing, " +
      "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM positions WHERE job_id = ?",
    ).bind(jobId));
    if (!counts || Number(counts.pending ?? 0) + Number(counts.running ?? 0) > 0) return;
    const done = Number(counts.done ?? 0);
    const failed = Number(counts.failed ?? 0);
    const missing = Number(counts.missing ?? 0);
    await this.env.DB.prepare(
      'UPDATE jobs SET status = ?, committed_count = ?, failed_count = ?, stop_reason = CASE WHEN ? > 0 THEN COALESCE(stop_reason, \'position_failures\') ELSE stop_reason END, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND epoch = ? AND status IN (\'queued\', \'running\')',
    ).bind(finalJobStatus(done, failed + missing), done, failed, failed, iso(now), iso(now), jobId, epoch).run();
    await this.finalizeTerminalCostsInternal(jobId, epoch, now);
  }

  async finishJob(jobId: string, epoch: number, now: number): Promise<void> {
    await this.serialized(async () => this.finishJobInternal(jobId, epoch, now));
  }

  async beginDeadLetter(jobId: string, epoch: number, now: number): Promise<{ current: boolean; slot: SlotLease | null }> {
    return this.serialized(async () => {
      const job = await this.first<{ status: string; epoch: number; stop_reason: string | null }>(this.env.DB.prepare('SELECT status, epoch, stop_reason FROM jobs WHERE id = ?').bind(jobId));
      if (!job || job.epoch !== epoch) return { current: false, slot: null };
      if (job.status === 'cancelling' && job.stop_reason !== 'dead_letter_in_progress') return { current: false, slot: null };
      if (active(job.status)) {
        await this.env.DB.prepare("UPDATE jobs SET status = 'cancelling', cancel_requested = 1, stop_reason = 'dead_letter_in_progress', updated_at = ? WHERE id = ? AND epoch = ? AND status IN ('queued', 'running')")
          .bind(iso(now), jobId, epoch).run();
      } else if (job.status !== 'cancelling' || job.stop_reason !== 'dead_letter_in_progress') return { current: false, slot: null };
      const lease = await this.getSlotInternal(now);
      return { current: true, slot: lease?.jobId === jobId && lease.epoch === epoch ? lease : null };
    });
  }

  private async getSlotInternal(now: number): Promise<SlotLease | null> {
    const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
    if (!slot?.job_id || !slot.lease_id || slot.epoch === null || slot.position_index === null || slot.attempt === null || slot.lease_expires_at === null || !slot.profile_id) return null;
    if (slot.lease_expires_at <= now && slot.quarantine_required !== 1) await this.env.DB.prepare('UPDATE global_search_slot SET quarantine_required = 1, updated_at = ? WHERE singleton = 1 AND lease_id = ?').bind(iso(now), slot.lease_id).run();
    return {
      jobId: slot.job_id, epoch: slot.epoch, index: slot.position_index, attempt: slot.attempt,
      leaseId: slot.lease_id, leaseExpiresAt: slot.lease_expires_at, profileId: slot.profile_id as JobIdentity['profileId'],
      quarantineRequired: slot.lease_expires_at <= now || slot.quarantine_required === 1,
    };
  }

  async finishDeadLetter(jobId: string, epoch: number, reason: string, now: number): Promise<void> {
    await this.serialized(async () => {
      const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
      if (slot?.job_id === jobId && slot.epoch === epoch && slot.lease_id) return;
      const job = await this.first<{ status: string; stop_reason: string | null }>(this.env.DB.prepare('SELECT status, stop_reason FROM jobs WHERE id = ? AND epoch = ?').bind(jobId, epoch));
      if (job?.status !== 'cancelling' || job.stop_reason !== 'dead_letter_in_progress') return;
      const counts = await this.first<{ done: number }>(this.env.DB.prepare("SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM positions WHERE job_id = ?").bind(jobId));
      const status = Number(counts?.done ?? 0) > 0 ? 'partial' : 'failed';
      await this.env.DB.prepare(
        "UPDATE jobs SET status = ?, stop_reason = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND epoch = ? AND status = 'cancelling' AND stop_reason = 'dead_letter_in_progress'",
      ).bind(status, reason.slice(0, 80), iso(now), iso(now), jobId, epoch).run();
      await this.finalizeTerminalCostsInternal(jobId, epoch, now);
    });
  }

  async armFault(arm: FaultArm, now: number): Promise<boolean> {
    return this.serialized(async () => {
      if (this.env.ANALYSIS_FAULT_FIXTURES_ENABLED !== '1') return false;
      const job = await this.first<{ owner_id: string; epoch: number; status: string }>(this.env.DB.prepare('SELECT owner_id, epoch, status FROM jobs WHERE id = ?').bind(arm.jobId));
      const position = await this.first<{ attempts: number; status: string }>(this.env.DB.prepare(
        'SELECT attempts, status FROM positions WHERE job_id = ? AND position_index = ?',
      ).bind(arm.jobId, arm.positionIndex));
      if (!job || job.owner_id !== arm.ownerId || job.epoch !== arm.epoch || !active(job.status) || !position ||
          position.status !== 'pending' || arm.remaining < 1 ||
          (arm.kind === 'throw' ? arm.attempt !== 0 || position.attempts !== 0 : arm.attempt !== position.attempts + 1 || arm.attempt > 2)) {
        return false;
      }
      await this.env.DB.prepare(
        'INSERT INTO fault_arms(kind, job_id, owner_id, epoch, position_index, attempt, remaining, armed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(kind) DO UPDATE SET job_id = excluded.job_id, owner_id = excluded.owner_id, epoch = excluded.epoch, position_index = excluded.position_index, attempt = excluded.attempt, remaining = excluded.remaining, armed_at = excluded.armed_at, expires_at = excluded.expires_at',
      ).bind(arm.kind, arm.jobId, arm.ownerId, arm.epoch, arm.positionIndex, arm.attempt, arm.remaining, iso(now), iso(now + FAULT_ARM_TTL_MS)).run();
      return true;
    });
  }

  async clearFaultArms(now: number): Promise<void> {
    await this.serialized(async () => {
      await this.env.DB.prepare('DELETE FROM fault_arms').run();
      await this.env.DB.prepare('UPDATE global_state SET updated_at = ? WHERE key = \'fault_arms\'').bind(iso(now)).run();
    });
  }

  async faultArmed(jobId: string, epoch: number, index: number, attempt: number, kind: FaultArm['kind'], now: number): Promise<boolean> {
    return this.serialized(async () => {
      if (this.env.ANALYSIS_FAULT_FIXTURES_ENABLED !== '1') return false;
      const row = await this.first<{ remaining: number }>(this.env.DB.prepare(
        'SELECT remaining FROM fault_arms WHERE kind = ? AND job_id = ? AND epoch = ? AND position_index = ? AND attempt = ? AND expires_at > ?',
      ).bind(kind, jobId, epoch, index, attempt, iso(now)));
      if (!row || row.remaining <= 0) return false;
      if (kind !== 'throw') {
        const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
        if (slot?.job_id !== jobId || slot.epoch !== epoch || slot.position_index !== index || slot.attempt !== attempt ||
            !slot.lease_id || (slot.lease_expires_at ?? 0) <= now) return false;
      }
      return true;
    });
  }

  async consumeFault(jobId: string, epoch: number, index: number, attempt: number, kind: FaultArm['kind'], now: number): Promise<boolean> {
    return this.serialized(async () => {
      if (this.env.ANALYSIS_FAULT_FIXTURES_ENABLED !== '1') return false;
      const row = await this.first<{ remaining: number }>(this.env.DB.prepare(
        'SELECT remaining FROM fault_arms WHERE kind = ? AND job_id = ? AND epoch = ? AND position_index = ? AND attempt = ? AND expires_at > ?',
      ).bind(kind, jobId, epoch, index, attempt, iso(now)));
      if (!row || row.remaining <= 0) return false;
      if (kind !== 'throw') {
        const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
        if (slot?.job_id !== jobId || slot.epoch !== epoch || slot.position_index !== index || slot.attempt !== attempt ||
            !slot.lease_id || (slot.lease_expires_at ?? 0) <= now) return false;
      }
      if (row.remaining === 1) await this.env.DB.prepare('DELETE FROM fault_arms WHERE kind = ? AND job_id = ?').bind(kind, jobId).run();
      else await this.env.DB.prepare('UPDATE fault_arms SET remaining = remaining - 1 WHERE kind = ? AND job_id = ?').bind(kind, jobId).run();
      await this.env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind(iso(now), jobId).run();
      return true;
    });
  }

  async recover(now: number): Promise<{
    expiredSlot: SlotLease | null;
    activeJobIds: string[];
    deadLetterJobs: Array<{ id: string; epoch: number }>;
    cancellationJobs: Array<{ id: string; epoch: number }>;
  }> {
    return this.serialized(async () => {
      await this.env.DB.prepare('DELETE FROM fault_arms WHERE expires_at <= ?').bind(iso(now)).run();
      const expiredSlot = await this.getSlotInternal(now);
      const terminalPending = await this.env.DB.prepare(
        "SELECT id, epoch FROM jobs WHERE status IN ('completed', 'partial', 'failed', 'cancelled') AND cost_finalized = 0 ORDER BY updated_at LIMIT 100",
      ).all<{ id: string; epoch: number }>();
      for (const job of terminalPending.results) await this.finalizeTerminalCostsInternal(job.id, job.epoch, now);
      const activeJobs = await this.env.DB.prepare("SELECT id, epoch, created_at, updated_at, runtime_budget_exceeded FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 100")
        .all<{ id: string; epoch: number; created_at: string; updated_at: string; runtime_budget_exceeded: number }>();
      const activeJobIds: string[] = [];
      for (const job of activeJobs.results) {
        if (job.runtime_budget_exceeded === 1) {
          await this.finishRuntimeBudgetExceededInternal(job.id, job.epoch, now);
          continue;
        }
        if (now - Date.parse(job.updated_at) >= RECOVERY_DEADLINE_MS) {
          const slot = await this.first<SlotRow>(this.env.DB.prepare('SELECT * FROM global_search_slot WHERE singleton = 1'));
          if (slot?.job_id === job.id && slot.epoch === job.epoch) continue;
          const counts = await this.first<{ done: number }>(this.env.DB.prepare("SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM positions WHERE job_id = ?").bind(job.id));
          const status = Number(counts?.done ?? 0) > 0 ? 'partial' : 'failed';
          await this.env.DB.prepare("UPDATE jobs SET status = ?, stop_reason = 'recovery_deadline', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND epoch = ? AND status IN ('queued', 'running')")
            .bind(status, iso(now), iso(now), job.id, job.epoch).run();
          await this.finalizeTerminalCostsInternal(job.id, job.epoch, now);
          continue;
        }
        activeJobIds.push(job.id);
        await this.flushHeadOutbox(job.id, now, false);
      }
      const deadLetters = await this.env.DB.prepare(
        "SELECT id, epoch FROM jobs WHERE status = 'cancelling' AND stop_reason = 'dead_letter_in_progress' ORDER BY updated_at LIMIT 100",
      ).all<{ id: string; epoch: number }>();
      const cancellations = await this.env.DB.prepare(
        "SELECT id, epoch FROM jobs WHERE status = 'cancelling' AND COALESCE(stop_reason, '') <> 'dead_letter_in_progress' ORDER BY updated_at LIMIT 100",
      ).all<{ id: string; epoch: number }>();
      return {
        expiredSlot: expiredSlot?.quarantineRequired ? expiredSlot : null,
        activeJobIds,
        deadLetterJobs: deadLetters.results,
        cancellationJobs: cancellations.results,
      };
    });
  }

  async cleanup(now: number): Promise<void> {
    await this.serialized(async () => {
      const jobsCutoff = iso(now - 7 * 24 * 60 * 60_000);
      const cacheCutoff = iso(now - 30 * 24 * 60 * 60_000);
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM positions WHERE job_id IN (SELECT id FROM jobs WHERE status IN (\'completed\', \'partial\', \'failed\', \'cancelled\') AND completed_at < ?)').bind(jobsCutoff),
        this.env.DB.prepare('DELETE FROM outbox WHERE job_id IN (SELECT id FROM jobs WHERE status IN (\'completed\', \'partial\', \'failed\', \'cancelled\') AND completed_at < ?)').bind(jobsCutoff),
        this.env.DB.prepare('DELETE FROM idempotency WHERE job_id IN (SELECT id FROM jobs WHERE status IN (\'completed\', \'partial\', \'failed\', \'cancelled\') AND completed_at < ?)').bind(jobsCutoff),
        this.env.DB.prepare('DELETE FROM jobs WHERE status IN (\'completed\', \'partial\', \'failed\', \'cancelled\') AND completed_at < ?').bind(jobsCutoff),
        this.env.DB.prepare('DELETE FROM result_cache WHERE created_at < ?').bind(cacheCutoff),
      ]);
    });
  }
}
