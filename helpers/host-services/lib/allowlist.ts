import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { randomUUID } from "node:crypto";
import { allocateBase, VERBS } from "./names";
import { createGrants, removeGrants, resolveTaskBase, type GrantOutcome } from "./grant";
import { assessRisk, type Risk } from "./risk";

/**
 * The allowlist — the complete set of services any module can ever touch.
 *
 * > A module can name a service. It can never add one.
 *
 * Entries live in the HELPER's own table, edited only by an administrator on JonDash's own
 * settings screen. That is the same shape as the `filesystem` helper's approved roots,
 * which has held up: the dangerous surface is *configuration the admin owns*, not an
 * argument the caller supplies. It is also what lets the consent line say "the services you
 * listed" and mean it literally.
 *
 * **Being on this list is what grants the privilege.** Adding a row is the moment elevation
 * is requested, and what the grant covers is fixed at that instant.
 */

const T = {
  entries: () => helperTableName("host-services", "entries"),
  suggestions: () => helperTableName("host-services", "suggestions"),
};

export type Entry = {
  id: string;
  serviceName: string;
  label: string;
  taskBase: string;
  canControl: boolean;
  /** false = ask the admin in JonDash each time (default); true = the module may act directly. */
  unattended: boolean;
  grantState: "none" | "granted" | "partial" | "error";
  addedAt: string;
  addedBy: string | null;
};

type Row = {
  id: string;
  serviceName: string;
  label: string;
  taskBase: string;
  canControl: number;
  unattended: number;
  grantState: string;
  addedAt: string;
  addedBy: string | null;
};

function toEntry(r: Row): Entry {
  return {
    id: r.id,
    serviceName: r.serviceName,
    label: r.label || r.serviceName,
    taskBase: r.taskBase,
    canControl: r.canControl === 1,
    unattended: r.unattended === 1,
    grantState: (["none", "granted", "partial", "error"] as const).includes(r.grantState as never)
      ? (r.grantState as Entry["grantState"])
      : "none",
    addedAt: r.addedAt,
    addedBy: r.addedBy,
  };
}

export async function listEntries(): Promise<Entry[]> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(`SELECT * FROM ${T.entries()} ORDER BY label`);
  return rows.map(toEntry);
}

/** Resolve an entry by the id a module supplied. Returns null rather than throwing — a
 *  module asking about something not on the list gets "not in the list", never an error
 *  that would reveal whether the service exists on this machine. */
export async function findEntry(id: string): Promise<Entry | null> {
  if (!id) return null;
  const rows = await prisma.$queryRawUnsafe<Row[]>(`SELECT * FROM ${T.entries()} WHERE id = ? LIMIT 1`, id);
  return rows[0] ? toEntry(rows[0]) : null;
}

export type AddResult =
  | { ok: true; entry: Entry; risk: Risk }
  | { ok: false; reason: "duplicate" | "unusable-name" | "name-clash"; detail?: string }
  | { ok: false; reason: "grant-refused"; outcome: GrantOutcome };

/**
 * Add a service to the allowlist — the one action that requests elevation.
 *
 * Ordering is deliberate and worth stating, because getting it backwards is how the system
 * ends up with a live OS grant that no JonDash row accounts for: the grant is created
 * FIRST, and only a successful grant writes the row. A failed or declined elevation leaves
 * nothing behind. The reverse order would leave an entry claiming a privilege it never got,
 * which is worse than failing.
 */
export async function addEntry(input: {
  serviceName: string;
  label?: string;
  addedBy?: string | null;
  canControl?: boolean;
  unattended?: boolean;
}): Promise<AddResult> {
  const serviceName = input.serviceName.trim();
  if (!serviceName) return { ok: false, reason: "unusable-name" };

  const existing = await listEntries();
  if (existing.some((e) => e.serviceName.toLowerCase() === serviceName.toLowerCase())) {
    return { ok: false, reason: "duplicate" };
  }

  // Cheap local check first: if nothing survives sanitising there is no name to be had, and
  // that answer needs no subprocess.
  if (!allocateBase(serviceName, [])) return { ok: false, reason: "unusable-name" };

  /**
   * THE BINARY DECIDES THE NAME, AND A CLASH IS REFUSED RATHER THAN SUFFIXED.
   *
   * Our sanitiser and the binary's disagree — we turn a space into `-`, it deletes the
   * character — so "My Service" and "MyService" are two names to us and **one task name to
   * Windows**. Checking collisions on our own answer let two entries point at a single
   * Scheduled Task, where removing either silently revoked the other. Measured, not imagined.
   *
   * The first fix was to suffix the binary's answer. Core then found the deeper problem and
   * changed its own behaviour: a suffixed grant has **ambiguous removal**, which is what
   * caused the accumulation in the first place. So suffixing is gone. Two different services
   * that reduce to the same task name are now refused, with wording that tells the admin
   * what to do — the same call core made, for the same reason.
   *
   * Refusing is worse UX than a silent suffix and better behaviour: the alternative is a
   * permission whose removal cannot be reasoned about.
   */
  const canonical = (await resolveTaskBase(serviceName)) ?? allocateBase(serviceName, [])!;
  const clash = existing.find((e) => e.taskBase.toLowerCase() === canonical.toLowerCase());
  if (clash) return { ok: false, reason: "name-clash", detail: clash.serviceName };
  const taskBase = canonical;

  const verbs = input.canControl === false ? [] : VERBS;

  if (verbs.length > 0) {
    const outcome = await createGrants(serviceName, taskBase, verbs, {
      label: input.addedBy ?? undefined,
      userId: input.addedBy ?? null,
    });
    if (outcome.status !== "ok") return { ok: false, reason: "grant-refused", outcome };
  }
  const finalBase = taskBase;

  const entry: Entry = {
    id: randomUUID(),
    serviceName,
    label: (input.label ?? serviceName).trim() || serviceName,
    taskBase: finalBase,
    canControl: input.canControl !== false,
    unattended: input.unattended === true,
    grantState: verbs.length > 0 ? "granted" : "none",
    addedAt: new Date().toISOString(),
    addedBy: input.addedBy ?? null,
  };

  await prisma.$executeRawUnsafe(
    `INSERT INTO ${T.entries()} (id, serviceName, label, taskBase, canControl, unattended, grantState, addedAt, addedBy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entry.id,
    entry.serviceName,
    entry.label,
    entry.taskBase,
    entry.canControl ? 1 : 0,
    entry.unattended ? 1 : 0,
    entry.grantState,
    entry.addedAt,
    entry.addedBy,
  );

  return { ok: true, entry, risk: assessRisk(serviceName) };
}

/**
 * Remove an entry AND its grants, in one action.
 *
 * If the grant removal fails the row stays, deliberately. A row with a stale grant is
 * visible and fixable; a removed row with a live grant is an orphan nobody will ever audit,
 * because nothing in JonDash still refers to it.
 */
export async function removeEntry(id: string): Promise<{ ok: boolean; outcome?: GrantOutcome }> {
  const entry = await findEntry(id);
  if (!entry) return { ok: true }; // idempotent: already gone is success

  if (entry.grantState !== "none") {
    const outcome = await removeGrants(entry.taskBase);
    if (outcome.status !== "ok") return { ok: false, outcome };
  }

  await prisma.$executeRawUnsafe(`DELETE FROM ${T.entries()} WHERE id = ?`, id);
  return { ok: true };
}

/** Change whether a module may act on this entry without an admin click. Admin-only, and
 *  never reachable from a module — see api.ts, which exposes no setter at all. */
export async function setUnattended(id: string, unattended: boolean): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE ${T.entries()} SET unattended = ? WHERE id = ?`,
    unattended ? 1 : 0,
    id,
  );
}

/**
 * What consent screens may know about this helper's configuration.
 *
 * Only the labels of allowlisted services — not who added them, not the request history,
 * not the task names. The one question a consent screen answers is "which services would
 * this let a module touch?", so that is the only thing that travels.
 */
export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ label: string; serviceName: string }[]>(
      `SELECT label, serviceName FROM ${T.entries()} ORDER BY label`,
    );
    return { services: rows.map((r) => r.label || r.serviceName) };
  } catch {
    // Falling back to generic wording is strictly better than a consent screen that does
    // not render. Core bounds and swallows this too; not relying on that is cheap.
    return {};
  }
}

/** Service names for the consent sentence. */
export function listServiceLabels(config: Record<string, unknown>): string[] {
  const raw = config?.services;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}
