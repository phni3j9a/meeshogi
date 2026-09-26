import type {
  CloudAttempt,
  CloudAttemptStatus,
  CloudProfileId,
  CloudResultRow,
} from '../cloud/contract';
import type { Database } from './repository';

const ATTEMPT_STATUSES: CloudAttemptStatus[] = [
  'requesting',
  'queued',
  'running',
  'cancel-requested',
  'completed',
  'failed',
  'cancelled',
  'error',
];
const RESULT_STATUSES = ['success', 'incomplete', 'terminal'];
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(`Cloud保存データが壊れています: ${message}`);
}

type AttemptColumns = {
  jobId: 'job_id';
  status: 'status';
  receiveAfterPly: 'receive_after_ply';
  serverNextPly: 'server_next_ply';
  resultCounts: 'result_counts';
  receivedCount: 'received_count';
  validCount: 'valid_count';
  failureCode: 'failure_code';
  failureMessage: 'failure_message';
  lastError: 'last_error';
  updatedAt: 'updated_at';
  finishedAt: 'finished_at';
};
export type CloudAttemptPatch = Partial<Pick<CloudAttempt, keyof AttemptColumns>>;
const ATTEMPT_COLUMNS: AttemptColumns = {
  jobId: 'job_id',
  status: 'status',
  receiveAfterPly: 'receive_after_ply',
  serverNextPly: 'server_next_ply',
  resultCounts: 'result_counts',
  receivedCount: 'received_count',
  validCount: 'valid_count',
  failureCode: 'failure_code',
  failureMessage: 'failure_message',
  lastError: 'last_error',
  updatedAt: 'updated_at',
  finishedAt: 'finished_at',
};

function columnValue(field: keyof AttemptColumns, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (field === 'resultCounts') return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number') return value;
  return fail(`${field} の値が不正です`);
}

function decodeAttempt(row: Record<string, unknown>): CloudAttempt {
  const status = row.status;
  if (
    typeof row.attempt_id !== 'string' ||
    typeof row.game_id !== 'string' ||
    typeof row.game_identity !== 'string' ||
    (row.profile_id !== 'free' && row.profile_id !== 'precision') ||
    typeof row.endpoint !== 'string' ||
    typeof row.install_id !== 'string' ||
    typeof row.owner_id !== 'string' ||
    typeof row.idempotency_key !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(row.idempotency_key) ||
    typeof row.initial_sfen !== 'string' ||
    typeof row.moves_json !== 'string' ||
    typeof row.total_plies !== 'number' ||
    !(row.job_id === null || typeof row.job_id === 'string') ||
    !ATTEMPT_STATUSES.includes(status as CloudAttemptStatus) ||
    typeof row.receive_after_ply !== 'number' ||
    typeof row.server_next_ply !== 'number' ||
    typeof row.received_count !== 'number' ||
    typeof row.valid_count !== 'number' ||
    typeof row.created_at !== 'string' ||
    typeof row.updated_at !== 'string'
  ) {
    fail(`attempt ${String(row.attempt_id)}`);
  }
  const moves = JSON.parse(row.moves_json as string) as unknown;
  if (!Array.isArray(moves) || !moves.every((m) => typeof m === 'string')) {
    fail(`attempt ${row.attempt_id} のmoves`);
  }
  const counts = row.result_counts === null ? null : JSON.parse(row.result_counts as string);
  return {
    attemptId: row.attempt_id as string,
    gameId: row.game_id as string,
    gameIdentity: row.game_identity as string,
    profileId: row.profile_id as CloudProfileId,
    endpoint: row.endpoint as string,
    installId: row.install_id as string,
    ownerId: row.owner_id as string,
    idempotencyKey: row.idempotency_key as string,
    initialSfen: row.initial_sfen as string,
    moves: moves as string[],
    totalPlies: row.total_plies as number,
    jobId: row.job_id as string | null,
    status: status as CloudAttemptStatus,
    receiveAfterPly: row.receive_after_ply as number,
    serverNextPly: row.server_next_ply as number,
    resultCounts:
      counts && object(counts)
        ? {
            success: typeof counts.success === 'number' ? counts.success : 0,
            incomplete: typeof counts.incomplete === 'number' ? counts.incomplete : 0,
            terminal: typeof counts.terminal === 'number' ? counts.terminal : 0,
          }
        : null,
    receivedCount: row.received_count as number,
    validCount: row.valid_count as number,
    failureCode: typeof row.failure_code === 'string' ? row.failure_code : null,
    failureMessage: typeof row.failure_message === 'string' ? row.failure_message : null,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  };
}

export interface PersistedCloudResult {
  ply: number;
  sfen: string;
  status: 'success' | 'incomplete' | 'terminal';
  engineLaunch: number | null;
  result: unknown;
}

/**
 * Cloud attempts and results live in their own tables so Sekirei's
 * GameRecord.analysis contract is untouched and the two engines' identities
 * can never merge. user_version stays 1: the tables are additive and old app
 * versions can still open the same database file.
 */
export class CloudRepository {
  constructor(private readonly db: Database) {}

  async initialize() {
    await this.db.execAsync(`CREATE TABLE IF NOT EXISTS cloud_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        game_identity TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        install_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        initial_sfen TEXT NOT NULL,
        moves_json TEXT NOT NULL,
        total_plies INTEGER NOT NULL,
        job_id TEXT,
        status TEXT NOT NULL,
        receive_after_ply INTEGER NOT NULL,
        server_next_ply INTEGER NOT NULL,
        result_counts TEXT,
        received_count INTEGER NOT NULL,
        valid_count INTEGER NOT NULL,
        failure_code TEXT,
        failure_message TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cloud_attempts_idempotency
        ON cloud_attempts(endpoint, owner_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS cloud_attempts_game ON cloud_attempts(game_id, created_at);
      CREATE TABLE IF NOT EXISTS cloud_results (
        attempt_id TEXT NOT NULL REFERENCES cloud_attempts(attempt_id) ON DELETE CASCADE,
        ply INTEGER NOT NULL,
        sfen TEXT NOT NULL,
        status TEXT NOT NULL,
        engine_launch INTEGER,
        result TEXT NOT NULL,
        PRIMARY KEY (attempt_id, ply)
      );`);
  }

  async metaGet(key: string): Promise<string | null> {
    const rows = await this.db.getAllAsync<{ value: string }>(
      'SELECT value FROM cloud_meta WHERE key = ?',
      key,
    );
    return rows[0]?.value ?? null;
  }

  async metaSet(key: string, value: string) {
    await this.db.runAsync(
      'INSERT INTO cloud_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  /** Stable per-install id; created once and never rotated. */
  async installId(create: () => string): Promise<string> {
    const existing = await this.metaGet('install_id');
    if (existing) return existing;
    const created = create();
    await this.metaSet('install_id', created);
    return created;
  }

  async createAttempt(attempt: CloudAttempt) {
    await this.db.runAsync(
      `INSERT INTO cloud_attempts (
        attempt_id, game_id, game_identity, profile_id, endpoint, install_id, owner_id,
        idempotency_key, initial_sfen, moves_json, total_plies, job_id, status,
        receive_after_ply, server_next_ply, result_counts, received_count, valid_count,
        failure_code, failure_message, last_error, created_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attempt.attemptId,
      attempt.gameId,
      attempt.gameIdentity,
      attempt.profileId,
      attempt.endpoint,
      attempt.installId,
      attempt.ownerId,
      attempt.idempotencyKey,
      attempt.initialSfen,
      JSON.stringify(attempt.moves),
      attempt.totalPlies,
      attempt.jobId,
      attempt.status,
      attempt.receiveAfterPly,
      attempt.serverNextPly,
      attempt.resultCounts ? JSON.stringify(attempt.resultCounts) : null,
      attempt.receivedCount,
      attempt.validCount,
      attempt.failureCode,
      attempt.failureMessage,
      attempt.lastError,
      attempt.createdAt,
      attempt.updatedAt,
      attempt.finishedAt,
    );
  }

  async updateAttempt(attemptId: string, patch: CloudAttemptPatch) {
    const fields = Object.keys(patch) as (keyof AttemptColumns)[];
    if (fields.length === 0) return;
    const assignments = fields.map((field) => `${ATTEMPT_COLUMNS[field]} = ?`).join(', ');
    await this.db.runAsync(
      `UPDATE cloud_attempts SET ${assignments} WHERE attempt_id = ?`,
      ...fields.map((field) => columnValue(field, patch[field])),
      attemptId,
    );
  }

  async attempts(): Promise<CloudAttempt[]> {
    const rows = await this.db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM cloud_attempts ORDER BY created_at, attempt_id',
    );
    return rows.map(decodeAttempt);
  }

  /**
   * Insert result rows and advance the attempt's receive cursor in a single
   * transaction: a crash between the two never produces a skipped ply or a
   * cursor ahead of committed results. Counters are recomputed from the table
   * so retried pages cannot double-count.
   */
  async commitResults(
    attemptId: string,
    rows: CloudResultRow[],
    patch: CloudAttemptPatch,
  ): Promise<CloudAttempt> {
    await this.db.execAsync('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        if (!RESULT_STATUSES.includes(row.status)) fail(`status ${row.status}`);
        await this.db.runAsync(
          `INSERT OR IGNORE INTO cloud_results
             (attempt_id, ply, sfen, status, engine_launch, result) VALUES (?, ?, ?, ?, ?, ?)`,
          attemptId,
          row.ply,
          row.sfen,
          row.status,
          row.engineLaunch,
          JSON.stringify(row.result),
        );
      }
      await this.updateAttempt(attemptId, patch);
      await this.db.runAsync(
        `UPDATE cloud_attempts SET
           received_count = (SELECT COUNT(*) FROM cloud_results WHERE attempt_id = ?),
           valid_count = (SELECT COUNT(*) FROM cloud_results
             WHERE attempt_id = ? AND status IN ('success', 'terminal'))
         WHERE attempt_id = ?`,
        attemptId,
        attemptId,
        attemptId,
      );
      await this.db.execAsync('COMMIT');
    } catch (error) {
      await this.db.execAsync('ROLLBACK');
      throw error;
    }
    const rows2 = await this.db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM cloud_attempts WHERE attempt_id = ?',
      attemptId,
    );
    if (!rows2[0]) fail(`attempt ${attemptId}`);
    return decodeAttempt(rows2[0]);
  }

  async results(attemptId: string): Promise<PersistedCloudResult[]> {
    const rows = await this.db.getAllAsync<Record<string, unknown>>(
      'SELECT ply, sfen, status, engine_launch, result FROM cloud_results WHERE attempt_id = ? ORDER BY ply',
      attemptId,
    );
    return rows.map((row) => {
      if (
        typeof row.ply !== 'number' ||
        typeof row.sfen !== 'string' ||
        !RESULT_STATUSES.includes(String(row.status)) ||
        !(row.engine_launch === null || typeof row.engine_launch === 'number') ||
        typeof row.result !== 'string'
      ) {
        fail(`attempt ${attemptId} ply ${String(row.ply)}`);
      }
      return {
        ply: row.ply,
        sfen: row.sfen,
        status: row.status as PersistedCloudResult['status'],
        engineLaunch: row.engine_launch,
        result: JSON.parse(row.result) as unknown,
      };
    });
  }
}
