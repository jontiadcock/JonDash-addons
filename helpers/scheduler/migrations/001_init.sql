-- Remembers when each declared schedule last ran, so a restart doesn't lose the cadence
-- and a job due while the server was down runs promptly instead of waiting a full period.
CREATE TABLE IF NOT EXISTS hlp_scheduler_runs (
  id        TEXT PRIMARY KEY,   -- "<moduleId>:<key>"
  lastRunAt TEXT NOT NULL,
  lastOk    INTEGER NOT NULL DEFAULT 1,
  lastError TEXT
);
