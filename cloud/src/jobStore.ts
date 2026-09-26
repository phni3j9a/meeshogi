/**
 * Persistence layer for the Issue #21 job backend.
 *
 * All mutating statements that depend on job state are expressed as single
 * conditional statements (INSERT ... SELECT ... WHERE / guarded UPDATE) or run
 * inside one batch (a transaction on D1), so concurrent admissions cannot
 * exceed the configured limits and a cancelled job can never gain results.
 */

export type SqlParam = string | number | null;
export type SqlStatement = { sql: string; params: SqlParam[] };

export interface RawDb {
  run(sql: string, params?: SqlParam[]): Promise<number>;
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  batch(statements: SqlStatement[]): Promise<number[]>;
}

export class D1RawDb implements RawDb {
  constructor(private readonly db: D1Database) {}

  async run(sql: string, params: SqlParam[] = []): Promise<number> {
    const result = await this.db.prepare(sql).bind(...params).run();
    return result.meta.changes ?? 0;
  }

  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const result = await this.db.prepare(sql).bind(...params).all<T>();
    return result.results ?? [];
  }

  async batch(statements: SqlStatement[]): Promise<number[]> {
    const prepared = statements.map((statement) => this.db.prepare(statement.sql).bind(...statement.params));
    const results = await this.db.batch(prepared);
    return results.map((result) => result.meta.changes ?? 0);
  }
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running'];

export interface OwnerRow {
  owner_id: string;
  credential_hash: string;
  precision_allowed: number;
  created_at: string;
}

export interface JobRow {
  job_id: string;
  owner_id: string;
  idempotency_key: string;
  input_hash: string;
  profile_id: string;
  initial_sfen: string;
  moves_json: string;
  total_plies: number;
  status: JobStatus;
  next_ply: number;
  jst_day: string;
  created_ms: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
}

export interface PositionRow {
  job_id: string;
  ply: number;
  sfen: string;
  terminal: 'checkmate' | 'no-legal-moves' | null;
}

export interface ResultRow {
  job_id: string;
  ply: number;
  sfen: string;
  status: 'success' | 'incomplete' | 'terminal' | 'failure';
  engine_launch: number | null;
  result_json: string;
  created_at: string;
}

const JOB_COLUMNS = `job_id, owner_id, idempotency_key, input_hash, profile_id, initial_sfen,
  moves_json, total_plies, status, next_ply, jst_day, created_ms, created_at, updated_at,
  finished_at, failure_code, failure_message`;

export interface AdmitJobParams {
  jobId: string;
  ownerId: string;
  idempotencyKey: string;
  inputHash: string;
  profileId: string;
  initialSfen: string;
  movesJson: string;
  totalPlies: number;
  createdMs: number;
  jstDay: string;
  isoNow: string;
  positions: { ply: number; sfen: string; terminal: 'checkmate' | 'no-legal-moves' | null }[];
  maxActiveJobs: number;
  freeDailyJobs: number;
  freeRateMaxJobs: number;
  freeRateWindowMs: number;
}

export class JobStore {
  constructor(private readonly db: RawDb) {}

  async createOwner(ownerId: string, credentialHash: string, isoNow: string): Promise<void> {
    await this.db.run(
      `INSERT INTO owners (owner_id, credential_hash, precision_allowed, created_at) VALUES (?, ?, 0, ?)`,
      [ownerId, credentialHash, isoNow],
    );
  }

  async ownerByCredentialHash(credentialHash: string): Promise<OwnerRow | null> {
    const rows = await this.db.all<OwnerRow>(
      `SELECT owner_id, credential_hash, precision_allowed, created_at FROM owners WHERE credential_hash = ?`,
      [credentialHash],
    );
    return rows[0] ?? null;
  }

  async ownerById(ownerId: string): Promise<OwnerRow | null> {
    const rows = await this.db.all<OwnerRow>(
      `SELECT owner_id, credential_hash, precision_allowed, created_at FROM owners WHERE owner_id = ?`,
      [ownerId],
    );
    return rows[0] ?? null;
  }

  /**
   * Atomically inserts the job row and its ply-indexed positions. The job row
   * is only inserted when the owner is below every applicable limit at the
   * moment the statement runs; position rows are inserted only if the job row
   * was created in the same batch.
   *
   * Returns 'inserted' when the job was created, 'skipped' when a limit denied
   * the insert. A UNIQUE(owner_id, idempotency_key) violation propagates as an
   * error and is handled by the caller as an idempotency replay.
   */
  async admitJob(params: AdmitJobParams): Promise<'inserted' | 'skipped'> {
    const windowStart = params.createdMs - params.freeRateWindowMs;
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO jobs (
                job_id, owner_id, idempotency_key, input_hash, profile_id, initial_sfen,
                moves_json, total_plies, status, next_ply, jst_day, created_ms, created_at, updated_at
              )
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?
              WHERE
                (SELECT COUNT(*) FROM jobs a WHERE a.owner_id = ? AND a.status IN ('queued', 'running')) < ?
                AND (? <> 'free' OR (
                  (SELECT COUNT(*) FROM jobs d WHERE d.owner_id = ? AND d.profile_id = 'free' AND d.jst_day = ?) < ?
                  AND (SELECT COUNT(*) FROM jobs r WHERE r.owner_id = ? AND r.profile_id = 'free' AND r.created_ms > ?) < ?
                ))`,
        params: [
          params.jobId, params.ownerId, params.idempotencyKey, params.inputHash,
          params.profileId, params.initialSfen, params.movesJson, params.totalPlies,
          params.jstDay, params.createdMs, params.isoNow, params.isoNow,
          params.ownerId, params.maxActiveJobs,
          params.profileId,
          params.ownerId, params.jstDay, params.freeDailyJobs,
          params.ownerId, windowStart, params.freeRateMaxJobs,
        ],
      },
      ...params.positions.map((position): SqlStatement => ({
        sql: `INSERT INTO job_positions (job_id, ply, sfen, terminal)
              SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE job_id = ?)`,
        params: [params.jobId, position.ply, position.sfen, position.terminal, params.jobId],
      })),
    ];
    const changes = await this.db.batch(statements);
    return changes[0] === 1 ? 'inserted' : 'skipped';
  }

  async jobById(jobId: string): Promise<JobRow | null> {
    const rows = await this.db.all<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = ?`, [jobId]);
    return rows[0] ?? null;
  }

  async jobByIdempotency(ownerId: string, idempotencyKey: string): Promise<JobRow | null> {
    const rows = await this.db.all<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE owner_id = ? AND idempotency_key = ?`,
      [ownerId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async jobForOwner(jobId: string, ownerId: string): Promise<JobRow | null> {
    const rows = await this.db.all<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = ? AND owner_id = ?`,
      [jobId, ownerId],
    );
    return rows[0] ?? null;
  }

  async positionAt(jobId: string, ply: number): Promise<PositionRow | null> {
    const rows = await this.db.all<PositionRow>(
      `SELECT job_id, ply, sfen, terminal FROM job_positions WHERE job_id = ? AND ply = ?`,
      [jobId, ply],
    );
    return rows[0] ?? null;
  }

  async positionsFrom(jobId: string, fromPly: number): Promise<PositionRow[]> {
    return this.db.all<PositionRow>(
      `SELECT job_id, ply, sfen, terminal FROM job_positions WHERE job_id = ? AND ply >= ? ORDER BY ply`,
      [jobId, fromPly],
    );
  }

  async resultsPage(jobId: string, afterPly: number, limit: number): Promise<ResultRow[]> {
    return this.db.all<ResultRow>(
      `SELECT job_id, ply, sfen, status, engine_launch, result_json, created_at
       FROM job_results WHERE job_id = ? AND ply > ? ORDER BY ply LIMIT ?`,
      [jobId, afterPly, limit],
    );
  }

  async resultCounts(jobId: string): Promise<Record<string, number>> {
    const rows = await this.db.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM job_results WHERE job_id = ? GROUP BY status`,
      [jobId],
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /**
   * Commits one validated result line. The INSERT only applies when the job is
   * still active AND its persisted cursor is exactly this ply; the cursor
   * update is guarded identically. A cancelled job or a stale/duplicate line
   * commits nothing.
   */
  async commitResult(
    jobId: string,
    ply: number,
    sfen: string,
    status: ResultRow['status'],
    engineLaunch: number | null,
    resultJson: string,
    isoNow: string,
  ): Promise<boolean> {
    const changes = await this.db.batch([
      {
        sql: `INSERT INTO job_results (job_id, ply, sfen, status, engine_launch, result_json, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM jobs WHERE job_id = ? AND status IN ('queued', 'running') AND next_ply = ?
              )`,
        params: [jobId, ply, sfen, status, engineLaunch, resultJson, isoNow, jobId, ply],
      },
      {
        sql: `UPDATE jobs SET next_ply = ?, updated_at = ?
              WHERE job_id = ? AND status IN ('queued', 'running') AND next_ply = ?`,
        params: [ply + 1, isoNow, jobId, ply],
      },
    ]);
    return changes[0] === 1 && changes[1] === 1;
  }

  async markRunning(jobId: string, isoNow: string): Promise<void> {
    await this.db.run(
      `UPDATE jobs SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'queued'`,
      [isoNow, jobId],
    );
  }

  async markCompleted(jobId: string, isoNow: string): Promise<boolean> {
    const changes = await this.db.run(
      `UPDATE jobs SET status = 'completed', finished_at = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('queued', 'running') AND next_ply = total_plies`,
      [isoNow, isoNow, jobId],
    );
    return changes === 1;
  }

  async markFailed(jobId: string, code: string, message: string, isoNow: string): Promise<void> {
    await this.db.run(
      `UPDATE jobs SET status = 'failed', failure_code = ?, failure_message = ?, finished_at = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('queued', 'running')`,
      [code, message.slice(0, 512), isoNow, isoNow, jobId],
    );
  }

  async cancelJob(jobId: string, ownerId: string, isoNow: string): Promise<boolean> {
    const changes = await this.db.run(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ?
       WHERE job_id = ? AND owner_id = ? AND status IN ('queued', 'running')`,
      [isoNow, isoNow, jobId, ownerId],
    );
    return changes === 1;
  }

  /** Diagnostic counters used only to classify an admission rejection. */
  async admissionCounts(ownerId: string, jstDay: string, windowStartMs: number): Promise<{
    active: number;
    freeToday: number;
    freeInWindow: number;
  }> {
    const rows = await this.db.all<{ active_n: number; daily_n: number; rate_n: number }>(
      `SELECT
         (SELECT COUNT(*) FROM jobs WHERE owner_id = ? AND status IN ('queued', 'running')) AS active_n,
         (SELECT COUNT(*) FROM jobs WHERE owner_id = ? AND profile_id = 'free' AND jst_day = ?) AS daily_n,
         (SELECT COUNT(*) FROM jobs WHERE owner_id = ? AND profile_id = 'free' AND created_ms > ?) AS rate_n`,
      [ownerId, ownerId, jstDay, ownerId, windowStartMs],
    );
    const row = rows[0];
    return {
      active: row?.active_n ?? 0,
      freeToday: row?.daily_n ?? 0,
      freeInWindow: row?.rate_n ?? 0,
    };
  }
}
