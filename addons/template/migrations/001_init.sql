-- Your module's own table.
--
-- The name MUST start with mod_<id>_ — JonDash sanitises your module id (dashes become
-- underscores) and drops every table with that prefix when the module is uninstalled.
-- For the id "template" the prefix is mod_template_.
--
-- Two things about how these files are run:
--   * whole-line comments are stripped and statements are split on ";" at the end of a
--     line, so keep one statement per statement and don't put comments after code;
--   * SQLite has no boolean or date type — use INTEGER 0/1 and ISO-8601 TEXT, which
--     sorts correctly.
--
-- To add a column later, add 002_whatever.sql; applied files are recorded, so an
-- existing install only runs the new one. Never edit a migration that has shipped.

CREATE TABLE IF NOT EXISTS mod_template_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  text      TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mod_template_items_created ON mod_template_items (createdAt);
