-- Preserve every admitted job and every legacy cache row. The jobs table is
-- rebuilt only because SQLite cannot widen its status CHECK constraint with
-- ALTER TABLE; all old values are copied before the old table is dropped.
CREATE TABLE jobs_v2 (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancelling', 'completed', 'partial', 'failed', 'cancelled')),
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  engine_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  instance_type TEXT NOT NULL,
  label TEXT,
  position_count INTEGER NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  committed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  execution_identity_hash TEXT NOT NULL DEFAULT '',
  cost_reserved REAL NOT NULL DEFAULT 0 CHECK (cost_reserved >= 0),
  cost_day_utc TEXT,
  result_seq_next INTEGER NOT NULL DEFAULT 0,
  engine_binary_digest_label TEXT NOT NULL DEFAULT '',
  vcpu INTEGER NOT NULL DEFAULT 1 CHECK (vcpu IN (1, 2)),
  cost_estimate_usd REAL NOT NULL DEFAULT 0 CHECK (cost_estimate_usd >= 0)
);

INSERT INTO jobs_v2 (
  id, owner_id, status, profile_id, profile_version, engine_id, model_id, instance_type,
  label, position_count, epoch, cancel_requested, committed_count, failed_count,
  consecutive_failures, stop_reason, created_at, started_at, completed_at, updated_at
)
SELECT
  id, owner_id, status, profile_id, profile_version, engine_id, model_id, instance_type,
  label, position_count, epoch, cancel_requested, committed_count, failed_count,
  consecutive_failures, stop_reason, created_at, started_at, completed_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v2 RENAME TO jobs;
CREATE INDEX jobs_owner_created ON jobs(owner_id, created_at DESC);
CREATE INDEX jobs_active_global ON jobs(status);
CREATE INDEX jobs_active_owner ON jobs(owner_id, status);

ALTER TABLE positions ADD COLUMN execution_identity_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE positions ADD COLUMN result_seq INTEGER;
ALTER TABLE positions ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN proof_json TEXT;
ALTER TABLE positions ADD COLUMN engine_terminal TEXT;
ALTER TABLE positions ADD COLUMN cost_reserved REAL NOT NULL DEFAULT 0 CHECK (cost_reserved >= 0);
UPDATE positions SET result_seq = position_index + 1 WHERE status IN ('done', 'failed');
UPDATE jobs SET result_seq_next = COALESCE((
  SELECT MAX(result_seq) FROM positions WHERE positions.job_id = jobs.id
), 0);

-- Legacy active jobs have no v2 execution identity. Retain their committed rows,
-- terminalize outstanding work, and ensure a pre-migration Queue delivery skips.
UPDATE positions SET status = 'failed', error_detail = 'pre_identity_migration', engine_terminal = 'failed',
  result_seq = (
    SELECT COALESCE(MAX(existing.result_seq), 0) + positions.position_index + 1
    FROM positions AS existing WHERE existing.job_id = positions.job_id AND existing.result_seq IS NOT NULL
  ), lease_id = NULL, lease_expires_at = NULL
WHERE status IN ('pending', 'running') AND job_id IN (SELECT id FROM jobs WHERE status IN ('queued', 'running'));
UPDATE jobs SET status = CASE WHEN EXISTS (
    SELECT 1 FROM positions WHERE positions.job_id = jobs.id AND positions.status = 'done'
  ) THEN 'partial' ELSE 'failed' END,
  stop_reason = 'pre_identity_migration', cancel_requested = 1,
  completed_at = COALESCE(completed_at, updated_at)
WHERE status IN ('queued', 'running');
UPDATE jobs SET result_seq_next = COALESCE((
  SELECT MAX(result_seq) FROM positions WHERE positions.job_id = jobs.id
), 0);

ALTER TABLE outbox ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN last_sent_at TEXT;
ALTER TABLE outbox ADD COLUMN completed_at TEXT;

-- Keep the old rows for audit, but make them unreadable by the active path.
-- Rebuilding the table adds identity to its uniqueness namespace.
ALTER TABLE result_cache RENAME TO result_cache_legacy;
CREATE TABLE result_cache (
  contract_version INTEGER NOT NULL,
  execution_identity_hash TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  sfen TEXT NOT NULL,
  result_json TEXT NOT NULL,
  stats_json TEXT,
  proof_json TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (contract_version, execution_identity_hash, engine_id, model_id, profile_id, profile_version, sfen)
);
INSERT INTO result_cache (
  contract_version, execution_identity_hash, engine_id, model_id, profile_id, profile_version,
  sfen, result_json, stats_json, quarantined, created_at, last_used_at
)
SELECT
  contract_version, '', engine_id, model_id, profile_id, profile_version,
  sfen, result_json, stats_json, 1, created_at, last_used_at
FROM result_cache_legacy;
DROP TABLE result_cache_legacy;
CREATE INDEX result_cache_sfen ON result_cache(sfen);
CREATE INDEX result_cache_retention ON result_cache(created_at, quarantined);

CREATE TABLE daily_cost (
  day_utc TEXT PRIMARY KEY,
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  reserved_usd REAL NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO daily_cost(day_utc, spent_usd, reserved_usd, updated_at)
SELECT substr(created_at, 1, 10), SUM(amount_usd), 0, MAX(created_at)
FROM cost_ledger GROUP BY substr(created_at, 1, 10);

CREATE TABLE cost_attempt_ledger (
  job_id TEXT NOT NULL,
  position_index INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2),
  day_utc TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  execution_identity_hash TEXT NOT NULL,
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  engine_ms INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, position_index, attempt)
);
CREATE INDEX cost_attempt_day ON cost_attempt_ledger(day_utc);
CREATE INDEX cost_attempt_created ON cost_attempt_ledger(created_at);

CREATE TABLE global_search_slot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  job_id TEXT,
  epoch INTEGER,
  position_index INTEGER,
  attempt INTEGER,
  lease_id TEXT,
  lease_expires_at INTEGER,
  profile_id TEXT,
  quarantine_required INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_required IN (0, 1)),
  updated_at TEXT NOT NULL
);
INSERT INTO global_search_slot(singleton, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z');

CREATE TABLE fault_arms (
  kind TEXT PRIMARY KEY CHECK (kind IN ('destroy', 'throw')),
  job_id TEXT NOT NULL,
  remaining INTEGER NOT NULL CHECK (remaining >= 0),
  armed_at TEXT NOT NULL
);
