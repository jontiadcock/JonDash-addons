-- What JONDASH installed. The whole reason this table exists is the uninstall rule:
-- clean up what you created, never what you found. Without a record written at install
-- time, "did we put this here?" is unanswerable afterwards, and the safe answer would have
-- to be "leave everything", which makes removal useless.
CREATE TABLE IF NOT EXISTS hlp_host_install_installed (
  id           TEXT PRIMARY KEY,
  packageId    TEXT NOT NULL UNIQUE,      -- e.g. Docker.DockerDesktop
  manager      TEXT NOT NULL DEFAULT 'winget',
  label        TEXT,                      -- what the admin saw it called
  installedAt  TEXT NOT NULL,
  installedBy  TEXT,                      -- user id, for the audit trail
  forModule    TEXT                       -- which module asked, so an orphan is traceable
);

-- Requests raised by modules. A request is INERT: it installs nothing and may never run.
-- Two gates stand between this row and software arriving: an administrator approving it in
-- JonDash, then Windows asking them again.
CREATE TABLE IF NOT EXISTS hlp_host_install_requests (
  id           TEXT PRIMARY KEY,
  moduleId     TEXT NOT NULL,
  packageId    TEXT NOT NULL,
  reason       TEXT NOT NULL,             -- why the module says it needs this
  action       TEXT NOT NULL,             -- install | uninstall
  state        TEXT NOT NULL,             -- pending | done | declined | cancelled-at-uac | failed | expired
  createdAt    TEXT NOT NULL,
  decidedAt    TEXT,
  decidedBy    TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS hlp_host_install_requests_module ON hlp_host_install_requests (moduleId, createdAt);
CREATE INDEX IF NOT EXISTS hlp_host_install_requests_state ON hlp_host_install_requests (state, createdAt);
