import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { assertUsableAsSource } from "./paths";
import { assessRoot, riskSummary } from "./risk";
import { DEFAULT_RETENTION, pruneLogs, type RetentionPolicy } from "./logfile";

/**
 * Everything that CHANGES what this helper allows — and therefore nothing a module may call.
 * `api.ts` is the only path a module has, the verifier refuses any deeper import, and
 * nothing here is re-exported from it: a module cannot approve a folder, forget one, or
 * shorten log retention, even by mistake.
 *
 * ⚠ This is the boundary HELPERS-DESIGN rule 8 exists for — these operations must never move
 * back onto the module-facing API. See the note on `api.ts › suggestRoot()` for why.
 *
 * REFS helpers/filesystem/helper.ts › onSettingsSubmit — the only caller, reached from
 *      Admin → Permissions where `ctx.user` is resolved from the session
 */

const ROOTS = helperTableName("filesystem", "roots");
const SETTINGS = helperTableName("filesystem", "settings");
const SUGGESTIONS = helperTableName("filesystem", "suggestions");
const ROOT_COLS = "id, path, label, riskLevel, riskNote";

export type AdminRoot = {
  id: string;
  path: string;
  label: string;
  riskLevel: string;
  riskNote: string | null;
};

export type PendingSuggestion = {
  id: string;
  moduleId: string;
  path: string;
  reason: string;
  createdAt: string;
};

/** REFS helpers/filesystem/lib/scopes.ts · helpers/filesystem/ui/settings-panel.tsx */
export async function listRoots(): Promise<AdminRoot[]> {
  return prisma.$queryRawUnsafe<AdminRoot[]>(`SELECT ${ROOT_COLS} FROM ${ROOTS} ORDER BY label`);
}

/** REFS helpers/filesystem/ui/settings-panel.tsx */
export async function openSuggestions(): Promise<PendingSuggestion[]> {
  return prisma.$queryRawUnsafe<PendingSuggestion[]>(
    `SELECT id, moduleId, path, reason, createdAt FROM ${SUGGESTIONS}
     WHERE state = 'open' ORDER BY createdAt`,
  );
}

export type AddOutcome =
  | { ok: true; root: AdminRoot; risk: string | null }
  | { ok: false; reason: string };

/**
 * Approve a folder. Breadth is warned about, never blocked: `C:\` is a legitimate thing to
 * back up, and the protection that matters lives on the files themselves — every entry is
 * checked against the secret registry by identity before it is read. Refusing broad roots
 * would be security theatre that also breaks the real use case.
 *
 * REFS helpers/filesystem/helper.ts · helpers/filesystem/lib/scopes.ts
 */
export async function addRoot(input: { path: string; label: string; addedBy?: string | null }): Promise<AddOutcome> {
  const verdict = assertUsableAsSource(input.path);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const existing = await prisma.$queryRawUnsafe<AdminRoot[]>(
    `SELECT ${ROOT_COLS} FROM ${ROOTS} WHERE path = ?`,
    verdict.path,
  );
  if (existing[0]) return { ok: true, root: existing[0], risk: null };

  const risk = assessRoot(verdict.path);
  const note = riskSummary(risk) || null;
  const root: AdminRoot = {
    id: randomUUID(),
    path: verdict.path,
    label: input.label.trim() || verdict.path,
    riskLevel: risk.level,
    riskNote: note,
  };
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${ROOTS} (id, path, label, addedAt, addedBy, riskLevel, riskNote) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    root.id, root.path, root.label, new Date().toISOString(), input.addedBy ?? null, root.riskLevel, root.riskNote,
  );
  return { ok: true, root, risk: risk.level === "none" ? null : note };
}

/**
 * Forget a folder. Touches no files — only this helper's permission to reach them.
 * REFS helpers/filesystem/helper.ts · helpers/filesystem/lib/scopes.ts
 */
export async function removeRoot(rootId: string): Promise<AdminRoot | null> {
  const rows = await prisma.$queryRawUnsafe<AdminRoot[]>(`SELECT ${ROOT_COLS} FROM ${ROOTS} WHERE id = ?`, rootId);
  await prisma.$executeRawUnsafe(`DELETE FROM ${ROOTS} WHERE id = ?`, rootId);
  return rows[0] ?? null;
}

/**
 * Approve what a module asked for. The admin's canonicalised path wins, not the module's
 * string. REFS helpers/filesystem/helper.ts
 */
export async function acceptSuggestion(id: string, label?: string): Promise<AddOutcome> {
  const rows = await prisma.$queryRawUnsafe<{ path: string; moduleId: string }[]>(
    `SELECT path, moduleId FROM ${SUGGESTIONS} WHERE id = ? AND state = 'open'`,
    id,
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "That request is no longer open." };

  const added = await addRoot({ path: row.path, label: label?.trim() || row.path });
  if (!added.ok) return added;

  await prisma.$executeRawUnsafe(
    `UPDATE ${SUGGESTIONS} SET state = 'accepted', decidedAt = ? WHERE id = ?`,
    new Date().toISOString(), id,
  );
  return added;
}

/**
 * Refuse it, and remember the refusal — see the habituation note in 003_root_suggestions.sql.
 * REFS helpers/filesystem/helper.ts
 */
export async function declineSuggestion(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE ${SUGGESTIONS} SET state = 'declined', decidedAt = ? WHERE id = ? AND state = 'open'`,
    new Date().toISOString(), id,
  );
}

/* --------------------------------------------------------------- the switches */

/**
 * "Everything" is per verb, not one switch for the helper — owner's rule: *"ensure with all
 * of it, there is a read only and full options."* A single switch would force read-anywhere
 * to imply delete-anywhere; three capabilities get three switches instead.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/scopes.ts
 */
export type Verb = "read" | "write" | "delete";
const UNBOUNDED = (v: Verb) => `roots.unbounded.${v}`;
/** Whether JonDash's own data stays protected while unbounded. Absent = protected. */
const PROTECT = "roots.protectJonDash";

async function flag(key: string, dflt: boolean): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM ${SETTINGS} WHERE key = ?`,
      key,
    );
    if (!rows[0]) return dflt;
    return rows[0].value === "1";
  } catch {
    return dflt;
  }
}

async function setFlagRow(key: string, on: boolean): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${SETTINGS} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    on ? "1" : "0",
  );
}

/** REFS helpers/filesystem/api.ts · helpers/filesystem/lib/scopes.ts */
export const isUnbounded = (v: Verb) => flag(UNBOUNDED(v), false);
/** REFS helpers/filesystem/lib/scopes.ts */
export const setUnbounded = (v: Verb, on: boolean) => setFlagRow(UNBOUNDED(v), on);

/**
 * Defaults to protected, and stays protected until an administrator says otherwise. The
 * second half of the owner's decision: "everything" is offered honestly, but the carve-out
 * is a switch of its own rather than a silent assumption either way.
 *
 * ⚠ Turning protection off is what exposes `.data/secrets.json` — the AES master key that
 * decrypts every TOTP secret and every backup — plus the database and the elevation
 * binaries. Absent means protected: a missing row must never read as consent. The warning
 * text an admin actually sees is `lib/scopes.ts`'s `option.warning`.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/scopes.ts
 */
export const jondashProtected = () => flag(PROTECT, true);
/** REFS helpers/filesystem/lib/scopes.ts */
export const setJondashProtected = (on: boolean) => setFlagRow(PROTECT, on);

/** REFS helpers/filesystem/ui/settings-panel.tsx */
export async function readRetention(): Promise<RetentionPolicy> {
  const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
    `SELECT key, value FROM ${SETTINGS} WHERE key IN ('log.keepDays', 'log.keepRuns')`,
  );
  // Absent-first: 0 is a legitimate stored value ("keep forever") and Number(null) is 0, so
  // coercing before checking would read "never configured" as "no retention at all".
  const get = (k: string, dflt: number) => {
    const raw = rows.find((r) => r.key === k)?.value;
    if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : dflt;
  };
  return {
    keepDays: get("log.keepDays", DEFAULT_RETENTION.keepDays),
    keepRuns: get("log.keepRuns", DEFAULT_RETENTION.keepRuns),
  };
}

/**
 * Change retention and apply it at once. Global, which is why no module may call it.
 * REFS helpers/filesystem/helper.ts
 */
export async function setRetention(policy: RetentionPolicy): Promise<{ policy: RetentionPolicy; removed: number }> {
  const clamp = (n: number, max: number) => (Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), max) : 0);
  const next: RetentionPolicy = {
    keepDays: clamp(policy.keepDays, 3650),
    keepRuns: clamp(policy.keepRuns, 10_000),
  };
  for (const [key, value] of [
    ["log.keepDays", String(next.keepDays)],
    ["log.keepRuns", String(next.keepRuns)],
  ] as const) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${SETTINGS} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, value,
    );
  }
  const { removed } = await pruneLogs(next);
  return { policy: next, removed };
}
