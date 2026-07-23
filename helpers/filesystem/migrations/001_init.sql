-- Roots: the locations an administrator has approved. Stored on the HELPER, never on a
-- consuming module, so a module cannot widen its own reach.
CREATE TABLE IF NOT EXISTS hlp_filesystem_roots (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,     -- canonical, as validated by assertUsable
  label        TEXT NOT NULL,
  addedAt      TEXT NOT NULL,
  addedBy      TEXT                       -- user id, for the audit trail
);

-- Run history. Exists so an interrupted backup can never be mistaken for a finished one.
CREATE TABLE IF NOT EXISTS hlp_filesystem_runs (
  id           TEXT PRIMARY KEY,
  moduleId     TEXT NOT NULL,
  startedAt    TEXT NOT NULL,
  finishedAt   TEXT,
  state        TEXT NOT NULL,             -- running | done | failed | cancelled | interrupted
  destination  TEXT,
  filesCopied  INTEGER NOT NULL DEFAULT 0,
  bytesCopied  INTEGER NOT NULL DEFAULT 0,
  errorCount   INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS hlp_filesystem_runs_module ON hlp_filesystem_runs (moduleId, startedAt);
