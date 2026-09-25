-- Preserve persisted jobs while binding their execution identity to the full
-- runtime artifact manifest used for dispatch, result commit, and cache lookup.
ALTER TABLE jobs ADD COLUMN execution_identity_json TEXT NOT NULL DEFAULT '{}';
UPDATE jobs SET stop_reason = 'cancel_in_progress'
WHERE status = 'cancelling' AND stop_reason IS NULL;

-- Old arms had no owner, epoch, attempt, expiry, or position scope. Preserve
-- them as inert audit rows; they cannot match a real job after this migration.
ALTER TABLE fault_arms RENAME TO fault_arms_legacy;
CREATE TABLE fault_arms (
  kind TEXT PRIMARY KEY CHECK (kind IN ('destroy', 'destroy-during', 'throw', 'sigstop')),
  job_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  position_index INTEGER NOT NULL CHECK (position_index >= 0),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 2),
  remaining INTEGER NOT NULL CHECK (remaining >= 0),
  armed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO fault_arms(kind, job_id, owner_id, epoch, position_index, attempt, remaining, armed_at, expires_at)
SELECT kind, job_id, '', 0, 0, 0, remaining, armed_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', armed_at, '+10 minutes')
FROM fault_arms_legacy;
DROP TABLE fault_arms_legacy;
CREATE INDEX fault_arms_expiry ON fault_arms(expires_at);
