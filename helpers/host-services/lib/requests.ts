import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { randomUUID } from "node:crypto";
import { runGrant } from "./grant";
import { findEntry } from "./allowlist";
import type { Verb } from "./names";

/**
 * Requests and suggestions — everything a module is allowed to initiate.
 *
 * Both are INERT by construction. A request queues a row; a suggestion queues a row.
 * Neither elevates anything, and neither can promote itself into the allowlist. The only
 * thing that turns a request into an action is an administrator, or an entry the
 * administrator has already marked unattended.
 */

const T = {
  requests: () => helperTableName("host-services", "requests"),
  suggestions: () => helperTableName("host-services", "suggestions"),
};

export type RequestState = "pending" | "approved" | "declined" | "cancelled-at-uac" | "expired" | "failed";

export type RequestOutcome =
  | { status: "pending" }
  | { status: "approved"; ranAt: string; ok: boolean; detail: string }
  | { status: "declined"; at: string }
  | { status: "cancelled-at-uac"; at: string }
  | { status: "expired"; at: string }
  | { status: "failed"; at: string; detail: string };

type ReqRow = {
  id: string;
  moduleId: string;
  entryId: string;
  action: string;
  state: string;
  createdAt: string;
  decidedAt: string | null;
  ranAt: string | null;
  ok: number | null;
  detail: string | null;
};

/** A pending request that nobody acts on becomes noise, and stale noise gets approved by
 *  accident. Seven days is long enough for a weekend away and short enough that the queue
 *  reflects what someone actually still wants. */
export const EXPIRY_DAYS = 7;

/** A module may have ONE open suggestion at a time, and a declined one cannot be re-raised
 *  for this long. The real risk with suggestions is not technical — it is a module that
 *  asks repeatedly until the admin clicks yes to stop being asked. */
export const SUGGEST_COOLDOWN_DAYS = 7;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** Queue a request. Grants nothing; may never run. */
export async function createRequest(moduleId: string, entryId: string, action: Verb): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${T.requests()} (id, moduleId, entryId, action, state, createdAt) VALUES (?, ?, ?, ?, 'pending', ?)`,
    id,
    moduleId,
    entryId,
    action,
    new Date().toISOString(),
  );
  return id;
}

/**
 * Status of a request, scoped to the module that raised it.
 *
 * `moduleId` is checked here rather than trusted: a module must not be able to read the
 * outcome of another module's request, and this is the one place that could leak it.
 */
export async function requestStatus(moduleId: string, requestId: string): Promise<RequestOutcome | null> {
  const rows = await prisma.$queryRawUnsafe<ReqRow[]>(
    `SELECT * FROM ${T.requests()} WHERE id = ? AND moduleId = ? LIMIT 1`,
    requestId,
    moduleId,
  );
  const r = rows[0];
  if (!r) return null;

  // Expiry is evaluated on read rather than by a sweeper. A helper must not need a timer to
  // tell the truth, and a request that aged out while nothing was running is still expired.
  if (r.state === "pending" && r.createdAt < daysAgo(EXPIRY_DAYS)) {
    await prisma.$executeRawUnsafe(
      `UPDATE ${T.requests()} SET state = 'expired', decidedAt = ? WHERE id = ? AND state = 'pending'`,
      new Date().toISOString(),
      r.id,
    );
    return { status: "expired", at: new Date().toISOString() };
  }

  switch (r.state) {
    case "pending":
      return { status: "pending" };
    case "approved":
      return { status: "approved", ranAt: r.ranAt ?? r.decidedAt ?? "", ok: r.ok === 1, detail: r.detail ?? "" };
    case "declined":
      return { status: "declined", at: r.decidedAt ?? "" };
    case "cancelled-at-uac":
      return { status: "cancelled-at-uac", at: r.decidedAt ?? "" };
    case "failed":
      return { status: "failed", at: r.decidedAt ?? "", detail: r.detail ?? "" };
    default:
      return { status: "expired", at: r.decidedAt ?? "" };
  }
}

/** Open suggestions, for the settings screen's prefilled-form flow. */
export async function openSuggestions(): Promise<
  { id: string; moduleId: string; serviceName: string; reason: string; createdAt: string }[]
> {
  return prisma.$queryRawUnsafe(
    `SELECT id, moduleId, serviceName, reason, createdAt FROM ${T.suggestions()} WHERE state = 'open' ORDER BY createdAt`,
  );
}

/** Requests awaiting an administrator. The settings screen's queue. */
export async function pendingRequests(): Promise<ReqRow[]> {
  return prisma.$queryRawUnsafe<ReqRow[]>(
    `SELECT * FROM ${T.requests()} WHERE state = 'pending' AND createdAt >= ? ORDER BY createdAt`,
    daysAgo(EXPIRY_DAYS),
  );
}

/**
 * Execute a request — the only path from "a module asked" to "something happened".
 *
 * Called either by an administrator approving it, or directly for an entry the
 * administrator marked unattended. A module can never call this: it is not exported through
 * `api.ts`, which is the boundary that makes the distinction real rather than documented.
 */
export async function execute(requestId: string, decidedBy: string | null): Promise<RequestOutcome> {
  const rows = await prisma.$queryRawUnsafe<ReqRow[]>(`SELECT * FROM ${T.requests()} WHERE id = ? LIMIT 1`, requestId);
  const r = rows[0];
  if (!r) return { status: "expired", at: new Date().toISOString() };

  const entry = await findEntry(r.entryId);
  const now = new Date().toISOString();

  if (!entry || !entry.canControl) {
    await settle(requestId, "failed", decidedBy, false, "the service is no longer controllable");
    return { status: "failed", at: now, detail: "the service is no longer controllable" };
  }

  const outcome = await runGrant(entry.taskBase, r.action as Verb);

  if (outcome.status === "ok") {
    await settle(requestId, "approved", decidedBy, true, `${r.action} ${entry.serviceName}`);
    return { status: "approved", ranAt: now, ok: true, detail: `${r.action} ${entry.serviceName}` };
  }
  if (outcome.status === "cancelled-at-uac") {
    await settle(requestId, "cancelled-at-uac", decidedBy, false, "");
    return { status: "cancelled-at-uac", at: now };
  }
  const detail = outcome.status === "unavailable" ? `no grant: ${outcome.reason}` : outcome.detail;
  await settle(requestId, "failed", decidedBy, false, detail);
  return { status: "failed", at: now, detail };
}

/** An administrator refusing a request. Terminal — a module must not be able to re-raise
 *  the same ask and wear them down. */
export async function decline(requestId: string, decidedBy: string | null): Promise<void> {
  await settle(requestId, "declined", decidedBy, null, "");
}

async function settle(
  id: string,
  state: RequestState,
  decidedBy: string | null,
  ok: boolean | null,
  detail: string,
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `UPDATE ${T.requests()} SET state = ?, decidedAt = ?, decidedBy = ?, ranAt = ?, ok = ?, detail = ?
     WHERE id = ? AND state = 'pending'`,
    state,
    now,
    decidedBy,
    state === "approved" || state === "failed" ? now : null,
    ok === null ? null : ok ? 1 : 0,
    detail,
    id,
  );
}

/* ------------------------------------------------------------------ suggestions */

export type SuggestResult =
  | { ok: true; id: string }
  | { ok: false; reason: "already-open" | "cooling-down" | "already-listed" | "unusable-name" };

/**
 * A module asking the admin to allowlist a service. Writes a row and nothing else.
 *
 * The limits here are the whole safety story, and they are social rather than technical:
 * one open suggestion per module, and a declined one cannot come back for a week. A module
 * that keeps asking becomes visibly annoying on the settings screen, which is the correct
 * outcome — it makes pestering legible instead of effective.
 */
export async function suggest(moduleId: string, serviceName: string, reason: string): Promise<SuggestResult> {
  const name = serviceName.trim();
  if (!name || !reason.trim()) return { ok: false, reason: "unusable-name" };

  const open = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM ${T.suggestions()} WHERE moduleId = ? AND state = 'open' LIMIT 1`,
    moduleId,
  );
  if (open.length > 0) return { ok: false, reason: "already-open" };

  const recentlyDeclined = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM ${T.suggestions()}
     WHERE moduleId = ? AND serviceName = ? AND state = 'declined' AND decidedAt >= ? LIMIT 1`,
    moduleId,
    name,
    daysAgo(SUGGEST_COOLDOWN_DAYS),
  );
  if (recentlyDeclined.length > 0) return { ok: false, reason: "cooling-down" };

  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${T.suggestions()} (id, moduleId, serviceName, reason, state, createdAt)
     VALUES (?, ?, ?, ?, 'open', ?)`,
    id,
    moduleId,
    name,
    reason.trim().slice(0, 500),
    new Date().toISOString(),
  );
  return { ok: true, id };
}
