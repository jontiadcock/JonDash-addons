-- Allowlist entries: the services an administrator has explicitly approved. Stored on the
-- HELPER, never on a consuming module, so a module can name an entry but never add one.
-- Being in this table IS the privilege — adding a row is what creates the OS grant.
CREATE TABLE IF NOT EXISTS hlp_host_services_entries (
  id           TEXT PRIMARY KEY,
  serviceName  TEXT NOT NULL UNIQUE,      -- the real Windows service / systemd unit name
  label        TEXT NOT NULL,             -- what the admin called it; never used in a task name
  taskBase     TEXT NOT NULL UNIQUE,      -- sanitised base; tasks are JonDash\<taskBase>-<verb>
  canControl   INTEGER NOT NULL DEFAULT 1,-- 0 = admin listed it read-only
  unattended   INTEGER NOT NULL DEFAULT 0,-- 0 = ask me each time (default), 1 = allow without asking
  grantState   TEXT NOT NULL DEFAULT 'none', -- none | granted | partial | error
  addedAt      TEXT NOT NULL,
  addedBy      TEXT                       -- user id, for the audit trail
);

-- Requests raised by modules. A request is INERT: it grants nothing and may never run.
CREATE TABLE IF NOT EXISTS hlp_host_services_requests (
  id           TEXT PRIMARY KEY,
  moduleId     TEXT NOT NULL,
  entryId      TEXT NOT NULL,
  action       TEXT NOT NULL,             -- start | stop | restart
  state        TEXT NOT NULL,             -- pending | approved | declined | cancelled-at-uac | expired | failed
  createdAt    TEXT NOT NULL,
  decidedAt    TEXT,
  decidedBy    TEXT,
  ranAt        TEXT,
  ok           INTEGER,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS hlp_host_services_requests_module ON hlp_host_services_requests (moduleId, createdAt);
CREATE INDEX IF NOT EXISTS hlp_host_services_requests_state ON hlp_host_services_requests (state, createdAt);

-- Suggestions: a module asking the admin to allowlist something. Never promotes itself.
-- One open per module and a cooldown on declines, because the real risk here is
-- habituation — a module that asks repeatedly trains the admin to click yes.
CREATE TABLE IF NOT EXISTS hlp_host_services_suggestions (
  id           TEXT PRIMARY KEY,
  moduleId     TEXT NOT NULL,
  serviceName  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  state        TEXT NOT NULL,             -- open | accepted | declined
  createdAt    TEXT NOT NULL,
  decidedAt    TEXT
);
CREATE INDEX IF NOT EXISTS hlp_host_services_suggestions_module ON hlp_host_services_suggestions (moduleId, state);
