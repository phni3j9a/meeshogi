-- Issue #21 job backend: anonymous owners, persisted game-analysis jobs,
-- per-ply positions and validated per-position results.
CREATE TABLE IF NOT EXISTS owners (
  owner_id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  precision_allowed INTEGER NOT NULL DEFAULT 0 CHECK (precision_allowed IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (owner_id),
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (profile_id IN ('free', 'precision')),
  initial_sfen TEXT NOT NULL,
  moves_json TEXT NOT NULL,
  total_plies INTEGER NOT NULL CHECK (total_plies > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  next_ply INTEGER NOT NULL DEFAULT 0 CHECK (next_ply >= 0),
  jst_day TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS jobs_owner_status ON jobs (owner_id, status);
CREATE INDEX IF NOT EXISTS jobs_owner_daily ON jobs (owner_id, profile_id, jst_day);
CREATE INDEX IF NOT EXISTS jobs_owner_rate ON jobs (owner_id, profile_id, created_ms);

CREATE TABLE IF NOT EXISTS job_positions (
  job_id TEXT NOT NULL REFERENCES jobs (job_id),
  ply INTEGER NOT NULL CHECK (ply >= 0),
  sfen TEXT NOT NULL,
  terminal TEXT CHECK (terminal IS NULL OR terminal IN ('checkmate', 'no-legal-moves')),
  PRIMARY KEY (job_id, ply)
);

CREATE TABLE IF NOT EXISTS job_results (
  job_id TEXT NOT NULL REFERENCES jobs (job_id),
  ply INTEGER NOT NULL CHECK (ply >= 0),
  sfen TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'incomplete', 'terminal', 'failure')),
  engine_launch INTEGER,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, ply)
);
