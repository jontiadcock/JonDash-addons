-- Helper-owned settings. One row per key; currently only the unbounded-read switch.
--
-- Separate from the entries table because "see every service" is not a member of the
-- allowlist — it is a statement that the allowlist does not bound reading. Storing it as a
-- magic entry row would make `list()` lie about what has been approved.
CREATE TABLE IF NOT EXISTS hlp_host_services_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
