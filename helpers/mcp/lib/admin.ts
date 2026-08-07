import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { resolveBindableAccount, type BindableAccount } from "@/lib/auth/service-accounts";
import { listKeys, type StoredKey } from "./keys";

/**
 * Everything the settings page reads, and nothing a module can reach.
 *
 * `api.ts` never imports this — the module-facing surface carries status only, per HELPERS-DESIGN
 * rule 8. Minting and revoking a credential is administrator work, done on JonDash's own screen
 * where `ctx.user` comes from the session.
 */

export type KeyRow = StoredKey & {
  /** Resolved at render time, never stored — so renaming an account is free. */
  accountName: string;
  /** True when the bound account has been deleted, disabled, or is no longer a service account. */
  orphaned: boolean;
};

/**
 * The key list, with each account resolved for display.
 *
 * **`orphaned` is shown rather than hidden.** A key whose account has gone still exists in the
 * table and still fails closed on every call — but an admin should see that it is there and revoke
 * it, not discover it later. Hiding it would make the list a comforting lie.
 * REFS helpers/mcp/ui/settings-panel.tsx
 */
export async function keyRows(): Promise<KeyRow[]> {
  const keys = await listKeys();
  const rows: KeyRow[] = [];
  for (const k of keys) {
    const account = await resolveBindableAccount(k.accountId);
    rows.push({
      ...k,
      accountName: account?.displayName ?? "(account no longer exists)",
      orphaned: account === null || account.status !== "ACTIVE",
    });
  }
  return rows;
}

/** Recent refusals — the tripwire an admin actually reads. */
export type Refusal = { at: string; ip: string; reason: string };

/** REFS helpers/mcp/ui/settings-panel.tsx */
export async function recentRefusals(limit = 20): Promise<Refusal[]> {
  try {
    return await prisma.$queryRawUnsafe<Refusal[]>(
      `SELECT at, ip, reason FROM ${helperTableName("mcp", "refusals")} ORDER BY at DESC LIMIT ?`,
      limit,
    );
  } catch {
    return [];
  }
}

/**
 * How a refusal reads to a person.
 *
 * The log is the one place the distinctions ARE shown — the caller got a single identical answer,
 * but an admin reading their own tripwire needs to tell "somebody is guessing keys" from "a key I
 * revoked is still being used" from "something in a browser reached this".
 * REFS helpers/mcp/ui/settings-panel.tsx
 */
export function explainRefusal(reason: string): string {
  switch (reason) {
    case "no-key":
      return "No key presented";
    case "bad-key":
      return "Key not recognised";
    case "revoked":
      return "Valid key, not permitted for that";
    case "account-gone":
      return "Key's account no longer exists";
    case "origin":
      return "Came from a web page — blocked";
    case "host":
      return "Wrong address — blocked";
    case "blocked":
      return "Too many attempts — temporarily blocked";
    default:
      return reason;
  }
}

/**
 * Accounts an admin may bind a new key to. Service accounts only — core guarantees that.
 * REFS helpers/mcp/ui/settings-panel.tsx
 */
export async function bindableAccounts(): Promise<BindableAccount[]> {
  const { listBindableAccounts } = await import("@/lib/auth/service-accounts");
  return listBindableAccounts();
}

/**
 * Is HTTPS configured on this install?
 *
 * The settings page needs this to warn *before* an admin opens the endpoint to the network, rather
 * than refusing afterwards. The refusal in `onSettingsSubmit` is still the real gate — this only
 * decides whether the page asks first, because a form is a suggestion and the server is the check.
 * REFS helpers/mcp/ui/settings-panel.tsx
 */
export async function httpsEnabled(): Promise<boolean> {
  try {
    const { readNetworkConfig } = await import("@/lib/tls/network-config.mjs");
    return readNetworkConfig().mode !== "off";
  } catch {
    // Unreadable config reads as "no HTTPS" — the direction that asks for confirmation rather
    // than the one that silently opens a clear-text port.
    return false;
  }
}

/**
 * Is any add-on that depends on this helper actually enabled?
 *
 * `startListener` refuses to bind when nothing is, so the settings page has to be able to say so —
 * otherwise an admin reads "switched on", sees no endpoint, and has no way to find out why. The
 * same condition, asked in the same terms, rather than a second rule that could drift from it.
 * REFS helpers/mcp/ui/settings-panel.tsx
 */
export async function carrierEnabled(): Promise<boolean> {
  const { dependentsOf } = await import("@/lib/helpers/registry");
  const ids = dependentsOf("mcp").map((d) => d.id);
  if (ids.length === 0) return false;
  return (await prisma.module.count({ where: { id: { in: ids }, enabled: true } })) > 0;
}
