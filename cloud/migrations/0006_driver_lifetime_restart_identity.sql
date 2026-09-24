ALTER TABLE engine_restart_events RENAME TO engine_restart_events_legacy;

CREATE TABLE engine_restart_events (
  profile_id TEXT NOT NULL CHECK (profile_id IN ('free-v1', 'precision-v1')),
  driver_epoch TEXT NOT NULL,
  engine_epoch TEXT NOT NULL,
  restart_count INTEGER NOT NULL CHECK (restart_count > 0),
  job_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, driver_epoch, restart_count)
);

INSERT INTO engine_restart_events(profile_id, driver_epoch, engine_epoch, restart_count, job_id, event_key, observed_at)
SELECT profile_id, 'legacy:' || engine_epoch, engine_epoch, restart_count, job_id, event_key, observed_at
FROM engine_restart_events_legacy;

DROP TABLE engine_restart_events_legacy;
