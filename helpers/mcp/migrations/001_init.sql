-- Keys an AI agent authenticates with, and the helper's own settings.
--
-- ONLY A HASH IS STORED. The key itself is shown once at mint time and never again — not in
-- this table, not in the audit log, not in a JonDash log line. A stolen database therefore
-- yields no working key, which is the same reasoning core applies to session tokens.
CREATE TABLE IF NOT EXISTS hlp_mcp_keys (
  id          TEXT PRIMARY KEY,
  -- SHA-256 of the key. Unique so a duplicate mint is impossible rather than merely unlikely.
  keyHash     TEXT NOT NULL UNIQUE,
  -- Shown in the UI so a key is identifiable without revealing it: "jd_mcp_…4f2a".
  hint        TEXT NOT NULL,
  label       TEXT NOT NULL,
  -- The SERVICE ACCOUNT this key acts as. Never a person's account — see HELPER.md.
  -- Not a foreign key: core owns the User table and a helper must not constrain it. The
  -- account is re-resolved on every call, so a deleted one fails closed rather than dangling.
  accountId   TEXT NOT NULL,
  -- 'read' or 'act'. Intersects with the account's RBAC; it can only ever NARROW, never widen.
  mode        TEXT NOT NULL DEFAULT 'read',
  createdAt   TEXT NOT NULL,
  createdBy   TEXT,
  -- Written on use so an admin can see a key nobody uses, and spot one suddenly in use.
  lastUsedAt  TEXT,
  lastUsedIp  TEXT
);

CREATE INDEX IF NOT EXISTS hlp_mcp_keys_account ON hlp_mcp_keys (accountId);

-- Refused connections. The tripwire: an endpoint nobody should be probing, being probed.
--
-- Deliberately records no key material and no hash — a failed attempt must not leave a
-- partial credential behind, and "someone tried" is the whole signal.
CREATE TABLE IF NOT EXISTS hlp_mcp_refusals (
  id        TEXT PRIMARY KEY,
  at        TEXT NOT NULL,
  ip        TEXT NOT NULL,
  -- 'no-key' | 'bad-key' | 'revoked' | 'account-gone' | 'origin' | 'host' | 'blocked'
  reason    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hlp_mcp_refusals_at ON hlp_mcp_refusals (at);
CREATE INDEX IF NOT EXISTS hlp_mcp_refusals_ip ON hlp_mcp_refusals (ip, at);

-- Helper settings: whether the listener is on, where it binds, which port.
-- Absent means OFF and 127.0.0.1 — a missing row must never read as "expose it".
CREATE TABLE IF NOT EXISTS hlp_mcp_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
