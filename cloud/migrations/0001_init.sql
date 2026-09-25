CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  label TEXT NOT NULL,
  precision_enabled INTEGER NOT NULL DEFAULT 0 CHECK (precision_enabled IN (0, 1)),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_active_global ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_active_owner ON jobs(owner_id, status);

CREATE TABLE IF NOT EXISTS positions (
  job_id TEXT NOT NULL,
  position_index INTEGER NOT NULL,
  sfen TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  stats_json TEXT,
  cached INTEGER NOT NULL DEFAULT 0 CHECK (cached IN (0, 1)),
  error_detail TEXT,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  engine_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, position_index)
);

CREATE INDEX IF NOT EXISTS positions_job_status_index ON positions(job_id, status, position_index);

CREATE TABLE IF NOT EXISTS idempotency (
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_job ON idempotency(job_id);

CREATE TABLE IF NOT EXISTS quota_usage (
  owner_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  jobs_reserved INTEGER NOT NULL DEFAULT 0,
  positions_reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, day_utc, profile_id)
);

CREATE INDEX IF NOT EXISTS quota_day_owner ON quota_usage(owner_id, day_utc);

CREATE TABLE IF NOT EXISTS result_cache (
  contract_version INTEGER NOT NULL,
  engine_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  sfen TEXT NOT NULL,
  result_json TEXT NOT NULL,
  stats_json TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (contract_version, engine_id, model_id, profile_id, profile_version, sfen)
);

CREATE INDEX IF NOT EXISTS result_cache_sfen ON result_cache(sfen);

CREATE TABLE IF NOT EXISTS cost_ledger (
  job_id TEXT NOT NULL,
  position_index INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  attempts INTEGER NOT NULL,
  cached INTEGER NOT NULL CHECK (cached IN (0, 1)),
  engine_ms INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, position_index)
);

CREATE INDEX IF NOT EXISTS cost_ledger_created ON cost_ledger(created_at);

CREATE TABLE IF NOT EXISTS flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  start_idx INTEGER NOT NULL,
  end_idx INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (job_id, epoch, start_idx, end_idx)
);

CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(job_id, sent_at);
