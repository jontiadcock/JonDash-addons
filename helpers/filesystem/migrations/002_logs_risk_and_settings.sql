-- 0.0.2 — run logs, root risk warnings, and the helper's own settings.
--
-- Runs on update as well as on a fresh install: core tracks `migratedVersion` per helper,
-- so an install already carrying 001 gets only this file. Every statement is therefore
-- additive and safe to apply to a table that already holds data.

-- Where the run's log file went, and how much it stepped over. Both nullable/defaulted so
-- rows written by 0.0.1 stay valid — an older run simply has no log.
ALTER TABLE hlp_filesystem_runs ADD COLUMN logPath TEXT;
ALTER TABLE hlp_filesystem_runs ADD COLUMN skippedCount INTEGER NOT NULL DEFAULT 0;

-- What the admin was warned about when this location was approved, kept so a log header
-- can repeat it months later. "none" matches what `assessRoot` returns for an ordinary
-- folder, so existing rows read correctly without a backfill.
ALTER TABLE hlp_filesystem_roots ADD COLUMN riskLevel TEXT NOT NULL DEFAULT 'none';
ALTER TABLE hlp_filesystem_roots ADD COLUMN riskNote TEXT;

-- Helper-owned settings. Helpers get no core settings store and no UI of their own, so
-- retention lives here and is set through the API by a consuming module's admin page.
CREATE TABLE IF NOT EXISTS hlp_filesystem_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
