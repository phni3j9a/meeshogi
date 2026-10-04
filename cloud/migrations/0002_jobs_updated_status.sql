-- Issue #49: keep the bounded stale-active recovery scan efficient.
CREATE INDEX IF NOT EXISTS jobs_status_updated ON jobs (status, updated_at, job_id);
