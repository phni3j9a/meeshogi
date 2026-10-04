-- Issue #49: keep the bounded stale-active recovery scan fair and efficient.
ALTER TABLE jobs ADD COLUMN last_recovery_at TEXT;
CREATE INDEX IF NOT EXISTS jobs_status_recovery ON jobs (status, last_recovery_at, updated_at, job_id);
