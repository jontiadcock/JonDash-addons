-- Backup Manager — jobs, their runs, and how to shout when one fails.
--
-- Unpublished, so this is still the initial migration rather than a chain of ALTERs.
-- Once it ships, every change becomes a new numbered file.

-- One row per thing you back up.
CREATE TABLE IF NOT EXISTS mod_backup_manager_jobs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,

  sourceRootId  TEXT NOT NULL,
  sourceSubpath TEXT NOT NULL DEFAULT '',
  destRootId    TEXT NOT NULL,
  destSubpath   TEXT NOT NULL DEFAULT '',

  mode          TEXT NOT NULL DEFAULT 'sync',   -- sync | snapshot
  excludeCsv    TEXT NOT NULL DEFAULT '',

  -- Timing lives here rather than on the schedule, because the scheduler helper fixes
  -- `everyMs` when the module is DEFINED. A per-job nextRunAt is what actually makes
  -- "every night at 2am" possible, and lets an admin change it without a release.
  everyHours    INTEGER NOT NULL DEFAULT 24,
  atMinute      INTEGER NOT NULL DEFAULT 120,   -- minutes past midnight, local time
  enabled       INTEGER NOT NULL DEFAULT 1,
  nextRunAt     TEXT,

  -- Grandfather-father-son retention, snapshot mode only. All four zero still keeps the
  -- newest copy — the helper guarantees that and refuses a policy that would empty a
  -- destination.
  keepDaily     INTEGER NOT NULL DEFAULT 7,
  keepWeekly    INTEGER NOT NULL DEFAULT 4,
  keepMonthly   INTEGER NOT NULL DEFAULT 12,
  keepYearly    INTEGER NOT NULL DEFAULT 0,
  -- Off by default. Retention DELETES, so it is opted into per job rather than inherited
  -- from a default nobody read.
  pruneEnabled  INTEGER NOT NULL DEFAULT 0,

  -- Failure alerts, both opt-in.
  notifyEmail   TEXT NOT NULL DEFAULT '',       -- empty = don't email
  notifyWebhook TEXT NOT NULL DEFAULT '',       -- empty = don't post
  -- The alert that matters most: a job that stopped running altogether raises nothing,
  -- because nothing failed. 0 disables it.
  staleAfterHours INTEGER NOT NULL DEFAULT 0,
  lastNotifiedAt  TEXT,                         -- so a broken job doesn't mail every tick

  createdAt     TEXT NOT NULL
);

-- What each run actually did.
CREATE TABLE IF NOT EXISTS mod_backup_manager_runs (
  id           TEXT PRIMARY KEY,
  jobId        TEXT NOT NULL,
  -- The helper's own run id. Our record is reconciled FROM the helper's, which is the only
  -- one that survives both the run ending and a restart.
  helperRunId  TEXT,
  startedAt    TEXT NOT NULL,
  finishedAt   TEXT,
  state        TEXT NOT NULL,                   -- running | done | failed | cancelled | interrupted
  filesCopied  INTEGER NOT NULL DEFAULT 0,
  bytesCopied  INTEGER NOT NULL DEFAULT 0,
  skippedCount INTEGER NOT NULL DEFAULT 0,
  errorCount   INTEGER NOT NULL DEFAULT 0,
  -- Snapshots removed by retention on this run, so "what did last night take away" is
  -- answerable from the run list without opening a log.
  prunedCount  INTEGER NOT NULL DEFAULT 0,
  message      TEXT
);

CREATE INDEX IF NOT EXISTS mod_backup_manager_runs_job ON mod_backup_manager_runs (jobId, startedAt);
-- The reconcile tick asks "which runs are still going?" on every pass; without this it is a
-- full scan of every run ever recorded.
CREATE INDEX IF NOT EXISTS mod_backup_manager_runs_state ON mod_backup_manager_runs (state);
