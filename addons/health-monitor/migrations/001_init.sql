-- Health monitoring — the module's own tables.
-- Every table is namespaced mod_health_monitor_* (the framework sanitises the module
-- id "health-monitor" to "health_monitor") and is dropped on uninstall.
-- The migration runner strips whole-line comments and splits on ";" at end of line, so
-- each statement ends with a semicolon on its own line and there are no inline comments.

CREATE TABLE IF NOT EXISTS mod_health_monitor_monitors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target        TEXT NOT NULL,
  port          INTEGER,
  configJson    TEXT NOT NULL DEFAULT '{}',
  intervalSec   INTEGER,
  timeoutMs     INTEGER,
  retries       INTEGER,
  degradedMs    INTEGER,
  parentId      TEXT,
  runbook       TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sortOrder     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'unknown',
  lastCheckAt   TEXT,
  nextCheckAt   TEXT,
  lastLatencyMs INTEGER,
  lastMessage   TEXT,
  failStreak    INTEGER NOT NULL DEFAULT 0,
  okStreak      INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hm_monitors_due ON mod_health_monitor_monitors (enabled, nextCheckAt);

CREATE TABLE IF NOT EXISTS mod_health_monitor_results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitorId  TEXT NOT NULL,
  ts         TEXT NOT NULL,
  state      TEXT NOT NULL,
  latencyMs  INTEGER,
  code       TEXT,
  message    TEXT,
  phasesJson TEXT
);

CREATE INDEX IF NOT EXISTS idx_hm_results_monitor_ts ON mod_health_monitor_results (monitorId, ts);

CREATE TABLE IF NOT EXISTS mod_health_monitor_rollups (
  monitorId TEXT NOT NULL,
  hourStart TEXT NOT NULL,
  checks    INTEGER NOT NULL,
  failures  INTEGER NOT NULL,
  degraded  INTEGER NOT NULL,
  avgMs     INTEGER,
  p95Ms     INTEGER,
  maxMs     INTEGER,
  PRIMARY KEY (monitorId, hourStart)
);

CREATE TABLE IF NOT EXISTS mod_health_monitor_incidents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  monitorId      TEXT NOT NULL,
  state          TEXT NOT NULL,
  startedAt      TEXT NOT NULL,
  endedAt        TEXT,
  durationSec    INTEGER,
  reason         TEXT,
  lastNotifiedAt TEXT,
  notifyCount    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hm_incidents_monitor ON mod_health_monitor_incidents (monitorId, startedAt);

CREATE TABLE IF NOT EXISTS mod_health_monitor_channels (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  configEnc TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mod_health_monitor_routes (
  monitorId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  PRIMARY KEY (monitorId, channelId)
);

CREATE TABLE IF NOT EXISTS mod_health_monitor_notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitorId  TEXT NOT NULL,
  channelId  TEXT NOT NULL,
  incidentId INTEGER,
  event      TEXT NOT NULL,
  sentAt     TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_hm_notifications_sent ON mod_health_monitor_notifications (sentAt);

CREATE TABLE IF NOT EXISTS mod_health_monitor_maintenance (
  id          TEXT PRIMARY KEY,
  monitorId   TEXT,
  label       TEXT,
  kind        TEXT NOT NULL,
  startsAt    TEXT,
  endsAt      TEXT,
  daysMask    INTEGER,
  startMin    INTEGER,
  durationMin INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1
);
