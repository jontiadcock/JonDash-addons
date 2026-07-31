import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";

/**
 * Key minting, storage and verification.
 *
 * **Only a hash is ever stored.** The key is returned once from `mintKey` and never recoverable.
 * A stolen database yields nothing usable, which is the same position core takes on session
 * tokens.
 *
 * **Every failure path returns the same thing.** `verifyKey` answers with a single `null` for
 * missing, malformed, unknown, revoked, and bound-to-a-deleted-account. A caller cannot tell which,
 * so the endpoint cannot be used to enumerate valid key prefixes or discover which accounts exist.
 * The reason is recorded for the admin's refusal log, never returned to the caller.
 */

const T = {
  keys: () => helperTableName("mcp", "keys"),
  settings: () => helperTableName("mcp", "settings"),
};

/** Long enough that online guessing is hopeless even without the rate limiter. */
const KEY_BYTES = 32;
const PREFIX = "jd_mcp_";

/**
 * What a key is allowed to reach. Ordered: each mode includes everything below it.
 *
 * `admin` was added in 0.0.2 for tools that act on the SERVER — restart, shut down, update. The
 * line between `act` and `admin` is who has to be present to undo it: an `act` tool can be
 * reversed from the dashboard, an `admin` tool can take the dashboard away.
 * REFS helpers/mcp/lib/authorize.ts · helpers/mcp/lib/decide.ts ·
 *      helpers/mcp/tests/escalation.test.ts
 */
export type KeyMode = "read" | "act" | "admin";

/** REFS helpers/mcp/lib/admin.ts */
export type StoredKey = {
  id: string;
  hint: string;
  label: string;
  accountId: string;
  mode: KeyMode;
  createdAt: string;
  lastUsedAt: string | null;
};

/**
 * Why a call was refused. For the admin's log only — NEVER returned to the caller.
 * REFS helpers/mcp/lib/authorize.ts · helpers/mcp/lib/dispatch.ts · helpers/mcp/lib/transport.ts
 */
export type RefusalReason = "no-key" | "bad-key" | "revoked" | "account-gone" | "origin" | "host" | "blocked";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * A new key. Returned in full exactly once.
 *
 * The caller must show it and discard it; there is no way to recover it afterwards, and that is
 * the point rather than an inconvenience.
 * REFS helpers/mcp/helper.ts
 */
export async function mintKey(input: {
  label: string;
  accountId: string;
  mode: KeyMode;
  createdBy: string | null;
}): Promise<{ id: string; key: string; hint: string }> {
  const key = PREFIX + randomBytes(KEY_BYTES).toString("base64url");
  const id = randomUUID();
  // Enough to recognise a key in a list, far too little to reconstruct one.
  const hint = `${PREFIX}…${key.slice(-4)}`;

  await prisma.$executeRawUnsafe(
    `INSERT INTO ${T.keys()} (id, keyHash, hint, label, accountId, mode, createdAt, createdBy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    sha256(key),
    hint,
    input.label.trim() || hint,
    input.accountId,
    input.mode,
    new Date().toISOString(),
    input.createdBy,
  );

  return { id, key, hint };
}

/** REFS helpers/mcp/api.ts · helpers/mcp/helper.ts · helpers/mcp/lib/admin.ts */
export async function listKeys(): Promise<StoredKey[]> {
  return prisma.$queryRawUnsafe<StoredKey[]>(
    `SELECT id, hint, label, accountId, mode, createdAt, lastUsedAt
     FROM ${T.keys()} ORDER BY createdAt DESC`,
  );
}

/**
 * Revoking is a delete. There is no disabled state — a key that might come back is a key.
 * REFS helpers/mcp/helper.ts
 */
export async function revokeKey(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM ${T.keys()} WHERE id = ?`, id);
}

/** REFS helpers/mcp/helper.ts */
export async function setKeyMode(id: string, mode: KeyMode): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE ${T.keys()} SET mode = ? WHERE id = ?`, mode, id);
}

/**
 * Drop every key bound to an account that no longer exists, or was just deleted.
 * REFS helpers/mcp/helper.ts
 */
export async function revokeKeysForAccount(accountId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*) AS n FROM ${T.keys()} WHERE accountId = ?`,
    accountId,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM ${T.keys()} WHERE accountId = ?`, accountId);
  return Number(rows[0]?.n ?? 0);
}

export type VerifiedKey = { keyId: string; accountId: string; mode: KeyMode };

/**
 * Resolve a presented key, or `null`.
 *
 * ⚠ Constant-time comparison against every candidate — the lookup is by hash (already effectively
 * constant-time via the unique index), and `timingSafeEqual` guards against a future change making
 * it data-dependent.
 *
 * Returns `null` identically for no key, wrong shape, unknown, or revoked; `reason` is for the
 * caller's refusal log only and must never travel back to the client.
 * REFS helpers/mcp/lib/authorize.ts
 */
export async function verifyKey(
  presented: string | undefined,
  out?: { reason?: RefusalReason },
): Promise<VerifiedKey | null> {
  if (!presented) {
    if (out) out.reason = "no-key";
    return null;
  }

  // Shape-check before touching the database. A malformed key is refused identically to a wrong
  // one, but it costs nothing to not query for it.
  if (!presented.startsWith(PREFIX) || presented.length < PREFIX.length + 32) {
    if (out) out.reason = "bad-key";
    return null;
  }

  const hash = sha256(presented);
  const rows = await prisma.$queryRawUnsafe<{ id: string; keyHash: string; accountId: string; mode: string }[]>(
    `SELECT id, keyHash, accountId, mode FROM ${T.keys()} WHERE keyHash = ?`,
    hash,
  );

  const row = rows[0];
  if (!row) {
    if (out) out.reason = "bad-key";
    return null;
  }

  // Belt and braces: the index already matched, but compare the bytes explicitly so this stays
  // correct if the lookup ever becomes a scan.
  const a = Buffer.from(row.keyHash, "utf8");
  const b = Buffer.from(hash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    if (out) out.reason = "bad-key";
    return null;
  }

  return {
    keyId: row.id,
    accountId: row.accountId,
    // Anything unrecognised reads as the LEAST privileged mode, never the most. A corrupt or
    // hand-edited row must fail closed.
    mode: row.mode === "admin" ? "admin" : row.mode === "act" ? "act" : "read",
  };
}

/**
 * Recorded after a successful call, so an unused key and a suddenly-used one are both visible.
 * REFS helpers/mcp/lib/authorize.ts
 */
export async function touchKey(keyId: string, ip: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE ${T.keys()} SET lastUsedAt = ?, lastUsedIp = ? WHERE id = ?`,
    new Date().toISOString(),
    ip,
    keyId,
  );
}

/* ------------------------------------------------------------------ settings */

async function get(key: string): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM ${T.settings()} WHERE key = ?`,
      key,
    );
    return rows[0]?.value ?? null;
  } catch {
    // Table not migrated yet. Absent is the safe answer for every setting here.
    return null;
  }
}

async function set(key: string, value: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${T.settings()} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

/**
 * Absent means OFF. A missing row must never read as "listening".
 * REFS helpers/mcp/api.ts · helpers/mcp/lib/transport.ts · helpers/mcp/ui/settings-panel.tsx
 */
export const isEnabled = async () => (await get("enabled")) === "1";
/** REFS helpers/mcp/helper.ts */
export const setEnabled = (on: boolean) => set("enabled", on ? "1" : "0");

/**
 * Absent means loopback. A missing row must never read as "exposed to the network".
 * REFS helpers/mcp/api.ts · helpers/mcp/lib/transport.ts · helpers/mcp/ui/settings-panel.tsx
 */
export const isNetworkExposed = async () => (await get("exposed")) === "1";
/** REFS helpers/mcp/helper.ts */
export const setNetworkExposed = (on: boolean) => set("exposed", on ? "1" : "0");

/**
 * May an assistant shut the whole server down? ⚠ Absent means NO.
 *
 * Every other admin tool is recoverable — a restart returns by itself, a bad update rolls back, a
 * channel switch reverses in one call. This one needs somebody physically at the machine: core's
 * supervisor treats a shutdown as a clean stop, and the launcher window closes.
 *
 * So holding an `admin` key with `settings.manage` is not enough — an administrator must switch
 * this specific tool on, having read what it does: the one unrecoverable action an assistant
 * cannot reach by misreading a request.
 * REFS helpers/mcp/lib/tools-admin.ts · helpers/mcp/ui/settings-panel.tsx
 */
export const isShutdownAllowed = async () => (await get("shutdown-allowed")) === "1";
/** REFS helpers/mcp/helper.ts */
export const setShutdownAllowed = (on: boolean) => set("shutdown-allowed", on ? "1" : "0");

/** REFS helpers/mcp/ui/settings-panel.tsx */
export const ALLOWED_PORTS = [3030, 3031, 3032, 3040, 3050] as const;

/**
 * A dropdown rather than a free-text box: it keeps the choice clear of the ports JonDash and its
 * testbeds already use, and a typo'd port that silently binds nothing is worse than no choice.
 * REFS helpers/mcp/api.ts · helpers/mcp/lib/transport.ts · helpers/mcp/ui/settings-panel.tsx
 */
export async function getPort(): Promise<number> {
  const raw = Number(await get("port"));
  return (ALLOWED_PORTS as readonly number[]).includes(raw) ? raw : ALLOWED_PORTS[0];
}

/** REFS helpers/mcp/helper.ts */
export async function setPort(port: number): Promise<boolean> {
  if (!(ALLOWED_PORTS as readonly number[]).includes(port)) return false;
  await set("port", String(port));
  return true;
}
