-- Adding a column in a LATER version of a module.
--
-- This is the pattern to copy when your module needs a schema change after it has
-- already been installed by someone. The rules:
--
--   * NEVER edit a migration that has shipped. 001 has already run on other people's
--     installs and will not run again — its file is recorded as applied. Add a new,
--     higher-numbered file instead.
--   * JonDash tracks applied files per module, so an existing install runs only this
--     one, and a brand-new install runs 001 and then 002 in order. Both end up with the
--     same schema.
--   * Give every added column a DEFAULT. Rows already exist, and without one SQLite has
--     nothing to put in them.
--   * Keep it forward-only. There is no "down" migration; if you get it wrong, ship a
--     003 that corrects it.

ALTER TABLE mod_template_items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
