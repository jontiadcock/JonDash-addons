import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { randomUUID } from "node:crypto";

/**
 * The two things this helper remembers: what JonDash installed, and what modules have asked
 * for. Everything else is read live from the machine.
 */

const T = {
  installed: () => helperTableName("host-install", "installed"),
  requests: () => helperTableName("host-install", "requests"),
};

export type InstalledRecord = {
  id: string;
  packageId: string;
  manager: string;
  label: string | null;
  installedAt: string;
  installedBy: string | null;
  forModule: string | null;
};

export type RequestAction = "install" | "uninstall";
export type RequestState = "pending" | "done" | "declined" | "cancelled-at-uac" | "failed" | "expired";

export type RequestRow = {
  id: string;
  moduleId: string;
  packageId: string;
  reason: string;
  action: string;
  state: string;
  createdAt: string;
  decidedAt: string | null;
  detail: string | null;
};

/** A pending request nobody acts on becomes noise, and stale noise gets approved by accident. */
export const EXPIRY_DAYS = 7;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/* ------------------------------------------------------------------ what we installed */

export async function listInstalled(): Promise<InstalledRecord[]> {
  return prisma.$queryRawUnsafe<InstalledRecord[]>(`SELECT * FROM ${T.installed()} ORDER BY installedAt DESC`);
}

/**
 * Did JONDASH install this? The question the uninstall rule turns on.
 *
 * Answered from our own record rather than from the machine, and that is the entire point: the
 * machine can tell you a package is present, but only this table can tell you whether we are
 * the reason. Software the admin installed themselves must never be offered for removal by us.
 */
export async function weInstalled(packageId: string): Promise<InstalledRecord | null> {
  const rows = await prisma.$queryRawUnsafe<InstalledRecord[]>(
    `SELECT * FROM ${T.installed()} WHERE packageId = ? COLLATE NOCASE LIMIT 1`,
    packageId,
  );
  return rows[0] ?? null;
}

export async function recordInstalled(input: {
  packageId: string;
  manager: string;
  label?: string | null;
  installedBy?: string | null;
  forModule?: string | null;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT OR REPLACE INTO ${T.installed()} (id, packageId, manager, label, installedAt, installedBy, forModule)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    input.packageId,
    input.manager,
    input.label ?? null,
    new Date().toISOString(),
    input.installedBy ?? null,
    input.forModule ?? null,
  );
}

export async function forgetInstalled(packageId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM ${T.installed()} WHERE packageId = ? COLLATE NOCASE`, packageId);
}

/* ------------------------------------------------------------------ requests */

export async function createRequest(input: {
  moduleId: string;
  packageId: string;
  reason: string;
  action: RequestAction;
}): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${T.requests()} (id, moduleId, packageId, reason, action, state, createdAt)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    id,
    input.moduleId,
    input.packageId,
    input.reason.trim().slice(0, 500),
    input.action,
    new Date().toISOString(),
  );
  return id;
}

/** Scoped to the asking module — one module must not read another's outcome. */
export async function getRequest(moduleId: string, requestId: string): Promise<RequestRow | null> {
  const rows = await prisma.$queryRawUnsafe<RequestRow[]>(
    `SELECT * FROM ${T.requests()} WHERE id = ? AND moduleId = ? LIMIT 1`,
    requestId,
    moduleId,
  );
  return rows[0] ?? null;
}

export async function getRequestAnyModule(requestId: string): Promise<RequestRow | null> {
  const rows = await prisma.$queryRawUnsafe<RequestRow[]>(
    `SELECT * FROM ${T.requests()} WHERE id = ? LIMIT 1`,
    requestId,
  );
  return rows[0] ?? null;
}

export async function pendingRequests(): Promise<RequestRow[]> {
  return prisma.$queryRawUnsafe<RequestRow[]>(
    `SELECT * FROM ${T.requests()} WHERE state = 'pending' AND createdAt >= ? ORDER BY createdAt`,
    daysAgo(EXPIRY_DAYS),
  );
}

/**
 * A module may have ONE open request at a time. The risk here is habituation rather than
 * anything technical — a module that asks repeatedly trains the admin to click yes, and the
 * thing being clicked installs software as administrator.
 */
export async function hasOpenRequest(moduleId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM ${T.requests()} WHERE moduleId = ? AND state = 'pending' AND createdAt >= ? LIMIT 1`,
    moduleId,
    daysAgo(EXPIRY_DAYS),
  );
  return rows.length > 0;
}

export async function settleRequest(
  id: string,
  state: RequestState,
  decidedBy: string | null,
  detail = "",
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE ${T.requests()} SET state = ?, decidedAt = ?, decidedBy = ?, detail = ? WHERE id = ? AND state = 'pending'`,
    state,
    new Date().toISOString(),
    decidedBy,
    detail,
    id,
  );
}

/** Expiry is evaluated on read rather than by a sweeper — a helper must not need a timer to
 *  tell the truth, and a request that aged out while nothing ran is still expired. */
export function isExpired(r: RequestRow): boolean {
  return r.state === "pending" && r.createdAt < daysAgo(EXPIRY_DAYS);
}
