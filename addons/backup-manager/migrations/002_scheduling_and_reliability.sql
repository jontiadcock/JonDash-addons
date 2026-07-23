-- 0.0.2 — real scheduling, retries, and a concurrency limit.
--
-- 001 shipped to the stable channel, so it is frozen: every change from here is a new
-- numbered file, and every statement must be safe against a table that already holds an
-- admin's jobs. Defaults are chosen so an existing job keeps behaving exactly as it did.

-- How the schedule is expressed.
--   'interval' — every N hours from a start time. What every 0.0.1 job does, so it is the
--                default and nothing changes for them.
--   'daily'    — at a time of day, on chosen days of the week. What people actually mean
--                by "back up every weeknight".
ALTER TABLE mod_backup_manager_jobs ADD COLUMN scheduleKind TEXT NOT NULL DEFAULT 'interval';

-- Days for 'daily', as CSV of 0-6 with 0 = Sunday, matching Date#getDay(). Empty means
-- every day. Stored as text rather than a bitmask so it is legible in the database — this
-- is a self-hosted app and people do look.
ALTER TABLE mod_backup_manager_jobs ADD COLUMN daysCsv TEXT NOT NULL DEFAULT '';

-- Retries. 0 keeps 0.0.1 behaviour: a failure waits for the next scheduled slot.
ALTER TABLE mod_backup_manager_jobs ADD COLUMN maxRetries INTEGER NOT NULL DEFAULT 0;
-- Drives the backoff, and is cleared on any success. Also the honest answer to "how long
-- has this been broken?".
ALTER TABLE mod_backup_manager_jobs ADD COLUMN consecutiveFailures INTEGER NOT NULL DEFAULT 0;

-- Which attempt a run was, so a retry is distinguishable from a fresh scheduled run in the
-- history rather than looking like the job ran twice for no reason.
ALTER TABLE mod_backup_manager_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;

-- Module-wide settings. One row per key; the only one today is the concurrency limit,
-- which is a property of the machine's disk rather than of any single job.
CREATE TABLE IF NOT EXISTS mod_backup_manager_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
