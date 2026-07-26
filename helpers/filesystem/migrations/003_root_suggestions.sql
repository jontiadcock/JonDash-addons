-- A module asking the admin to approve a folder. It can never approve one itself.
--
-- Mirrors hlp_host_services_suggestions deliberately: same columns, same states, same
-- habituation guard. Two helpers solving one problem two ways is how the admin ends up
-- with two mental models for "a module wants something".
--
-- One open suggestion per module per path, and declines are remembered rather than
-- deleted, because the real risk is habituation: a module that re-asks after every
-- refusal trains the admin to click yes without reading.
CREATE TABLE IF NOT EXISTS hlp_filesystem_suggestions (
  id         TEXT PRIMARY KEY,
  moduleId   TEXT NOT NULL,
  path       TEXT NOT NULL,               -- as the module typed it; canonicalised on accept
  reason     TEXT NOT NULL,
  state      TEXT NOT NULL,               -- open | accepted | declined
  createdAt  TEXT NOT NULL,
  decidedAt  TEXT
);

CREATE INDEX IF NOT EXISTS hlp_filesystem_suggestions_module ON hlp_filesystem_suggestions (moduleId, state);
