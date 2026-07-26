import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { assertUsableAsSource } from "./paths";
import { assessRoot, riskSummary } from "./risk";
import { DEFAULT_RETENTION, pruneLogs, type RetentionPolicy } from "./logfile";

/**
 * Everything that CHANGES what this helper allows — and therefore nothing a module may call.
 *
 * This file exists to make that boundary physical rather than promised. `api.ts` is the only
 * path a module has, the verifier refuses any deeper import, and nothing here is re-exported
 * from it. So a module cannot approve a folder, forget one, or shorten log retention, even
 * by mistake.
 *
 * These functions previously lived on the module-facing API, which meant a module confined to
 * approved folders could approve its own — the consent wording held only until the module
 * decided otherwise. See HELPERS-DESIGN rule 8 and the same fix in `host-services` 0.0.2.
 *
 * Callers: `helper.ts`'s `onSettingsSubmit`, reached from Admin → Helpers, where `ctx.user`
 * is resolved from the session.
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

export async function listRoots(): Promise<AdminRoot[]> {
  return prisma.$queryRawUnsafe<AdminRoot[]>(`SELECT ${ROOT_COLS} FROM ${ROOTS} ORDER BY label`);
}

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
 * Approve a folder.
 *
 * Breadth is warned about, never blocked: `C:\` is a legitimate thing to back up, and the
 * protection that matters lives on the files themselves — every entry is checked against the
 * secret registry by identity before it is read. Refusing broad roots would be security
 * theatre that also breaks the real use case.
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

/** Forget a folder. Touches no files — only this helper's permission to reach them. */
export async function removeRoot(rootId: string): Promise<AdminRoot | null> {
  const rows = await prisma.$queryRawUnsafe<AdminRoot[]>(`SELECT ${ROOT_COLS} FROM ${ROOTS} WHERE id = ?`, rootId);
  await prisma.$executeRawUnsafe(`DELETE FROM ${ROOTS} WHERE id = ?`, rootId);
  return rows[0] ?? null;
}

/** Approve what a module asked for. The admin's canonicalised path wins, not the module's string. */
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

/** Refuse it, and remember the refusal — see the habituation note in 003_root_suggestions.sql. */
export async function declineSuggestion(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE ${SUGGESTIONS} SET state = 'declined', decidedAt = ? WHERE id = ? AND state = 'open'`,
    new Date().toISOString(), id,
  );
}

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

/** Change retention and apply it at once. Global, which is why no module may call it. */
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
