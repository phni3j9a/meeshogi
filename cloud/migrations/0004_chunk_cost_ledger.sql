-- Replace full-game upfront cost holds with one dispatchable chunk reservation
-- and idempotent phase settlements. Historical jobs and ledgers remain intact.
ALTER TABLE outbox ADD COLUMN dispatchable INTEGER NOT NULL DEFAULT 0 CHECK (dispatchable IN (0, 1));

CREATE TABLE cost_reservation_batches (
  reservation_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  start_idx INTEGER NOT NULL,
  end_idx INTEGER NOT NULL,
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  reserved_day_utc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX cost_reservation_job ON cost_reservation_batches(job_id, epoch, start_idx);

CREATE TABLE cost_reservation_parts (
  part_key TEXT NOT NULL,
  reservation_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  start_idx INTEGER NOT NULL,
  end_idx INTEGER NOT NULL,
  position_index INTEGER,
  phase TEXT NOT NULL,
  cost_kind TEXT NOT NULL CHECK (cost_kind IN ('resource', 'service')),
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  remaining_usd REAL NOT NULL CHECK (remaining_usd >= 0 AND remaining_usd <= amount_usd),
  settled_event_key TEXT,
  reserved_day_utc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, epoch, part_key)
);
CREATE INDEX cost_reservation_parts_job ON cost_reservation_parts(job_id, start_idx, end_idx);
CREATE INDEX cost_reservation_parts_day ON cost_reservation_parts(reserved_day_utc, remaining_usd);

CREATE TABLE cost_phase_ledger (
  event_key TEXT PRIMARY KEY,
  job_id TEXT,
  epoch INTEGER,
  reservation_key TEXT,
  part_key TEXT,
  phase TEXT NOT NULL,
  cost_kind TEXT NOT NULL CHECK (cost_kind IN ('resource', 'service')),
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  duration_ms INTEGER,
  engine_ms INTEGER,
  day_utc TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX cost_phase_job ON cost_phase_ledger(job_id, cost_kind, created_at);
CREATE INDEX cost_phase_day ON cost_phase_ledger(day_utc, cost_kind);

CREATE TABLE container_lifecycle_events (
  profile_id TEXT NOT NULL CHECK (profile_id IN ('free-v1', 'precision-v1')),
  lifecycle_key TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('first_contact', 'sleep_timer_elapsed', 'sleep_confirmed', 'stop_confirmed', 'stop_failed')),
  observed_at TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (profile_id, lifecycle_key, event)
);

CREATE TABLE engine_restart_events (
  profile_id TEXT NOT NULL CHECK (profile_id IN ('free-v1', 'precision-v1')),
  engine_epoch TEXT NOT NULL,
  restart_count INTEGER NOT NULL CHECK (restart_count > 0),
  job_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, engine_epoch, restart_count)
);
