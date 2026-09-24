-- Persist terminal-cost retries and per-job stop state for measured budget overruns.
ALTER TABLE jobs ADD COLUMN cost_finalized INTEGER NOT NULL DEFAULT 0 CHECK (cost_finalized IN (0, 1));
ALTER TABLE jobs ADD COLUMN runtime_budget_exceeded INTEGER NOT NULL DEFAULT 0 CHECK (runtime_budget_exceeded IN (0, 1));

-- Historical terminal rows have no rolling reservation parts to finalize.
UPDATE jobs SET cost_finalized = 1
WHERE status IN ('completed', 'partial', 'failed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM cost_reservation_parts p WHERE p.job_id = jobs.id);
