import { getEffectivePermissionsUncached, type Permission } from "@/lib/auth/permissions";
import {
  listBindableAccounts,
  resolveBindableAccount,
  type BindableAccount,
} from "@/lib/auth/service-accounts";
import { touchKey, verifyKey, type KeyMode, type RefusalReason } from "./keys";
import { decide, modeAllows, type ToolKind } from "./decide";

/**
 * The two gates that decide whether this helper is safe, both checked on every call:
 *   1. The key's mode — `read` or `act`. A read key cannot reach an acting tool.
 *   2. The bound account's RBAC — read from core's own tables, at call time.
 *
 * ⚠ The mode can only ever NARROW; it never grants what the account lacks. An act-key bound to
 * an account with no `sessions.manage` still cannot revoke a session — the test asserting exactly
 * that is the gate on whether this ships at all.
 *
 * Permissions are resolved per call, never cached — stripping a role must cost the agent that
 * power immediately, not at the next restart.
 */

/** What a tool needs in order to run. */
export type ToolRequirement = {
  /** Refused outright to a key below this rung, before RBAC is even consulted. */
  kind: ToolKind;
  /** The core permission the bound account must hold. `null` = available to any valid key. */
  permission: Permission | null;
};

/** REFS helpers/mcp/lib/tools-act.ts · helpers/mcp/lib/tools.ts */
export type Identity = {
  keyId: string;
  accountId: string;
  mode: KeyMode;
  /** Resolved once per call and passed to the tool, so it never re-queries. */
  permissions: Set<Permission>;
};

export type AuthOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; reason: RefusalReason | "mode" | "permission" };

/**
 * Resolve and authorize a call.
 *
 * **The caller must convert every `ok: false` into one identical client response.** The reason
 * exists for the admin's refusal log and for tests. If it ever reaches the client, an attacker can
 * distinguish "no such key" from "valid key, wrong permission" — which maps the install.
 * REFS helpers/mcp/lib/dispatch.ts
 */
export async function authorize(
  presentedKey: string | undefined,
  need: ToolRequirement,
  ip: string,
): Promise<AuthOutcome> {
  const out: { reason?: RefusalReason } = {};
  const key = await verifyKey(presentedKey, out);
  if (!key) return { ok: false, reason: out.reason ?? "bad-key" };

  // Gate 1 — the key's OWN mode, checked before the account loads: a read key attempting an
  // acting tool must not even cause a user lookup. Refuses on mode only; gate 2 decides permission.
  if (!modeAllows(key.mode, need.kind)) {
    return { ok: false, reason: "mode" };
  }

  /*
   * Re-resolved every call via the SAME function the mint form uses, so an account that is no
   * longer a service account fails closed here too — `null` covers deleted, unknown, disabled and
   * human alike, one answer for all of them.
   *
   * `accountId` is not a foreign key: a helper must not constrain core's User table, so this
   * verifies on every call instead of relying on `onIdentityRemoved`'s cleanup.
   *
   * The helper id lets core stamp "last used, by which add-on" on the account for its own page —
   * fire-and-forget and throttled on core's side, so it adds no latency here.
   */
  const account = await resolveBindableAccount(key.accountId, "mcp");
  if (!account || account.status !== "ACTIVE") {
    return { ok: false, reason: "account-gone" };
  }

  /*
   * Core's own resolution, not a copy — ADMIN implies everything, including for a service account,
   * otherwise it is the union of the account's access roles.
   *
   * ⚠ Deliberately the UNCACHED entry point: `getEffectivePermissions` wraps React's `cache()`,
   * which happens to work in this bare HTTP listener with no request scope, but that is
   * undocumented behaviour — if it changed, authorization would fail SILENTLY.
   */
  const permissions = await getEffectivePermissionsUncached({ id: account.id, role: account.role });

  // The full decision, through the same function the escalation test drives — both gates
  // re-evaluated together so the answer comes from one place, not two early returns.
  const verdict = decide({
    mode: key.mode,
    toolKind: need.kind,
    accountHasPermission: need.permission ? permissions.has(need.permission) : true,
    permissionRequired: need.permission !== null,
  });
  if (verdict === "refuse") {
    return { ok: false, reason: !modeAllows(key.mode, need.kind) ? "mode" : "permission" };
  }

  await touchKey(key.keyId, ip);
  return {
    ok: true,
    identity: { keyId: key.keyId, accountId: account.id, mode: key.mode, permissions },
  };
}

/**
 * Is this account one a key may bind to?
 *
 * ⚠ Service accounts only — never a person's. `listBindableAccounts()` excludes people from the
 * mint dropdown, and `resolveBindableAccount` refuses a human just as it does a deleted or unknown
 * account — a forged id does not help either, there is no filtering to get wrong at this end.
 * REFS helpers/mcp/helper.ts
 */
export async function isBindableAccount(userId: string): Promise<boolean> {
  return (await resolveBindableAccount(userId)) !== null;
}

/** The accounts an administrator may choose from when minting a key. */
export async function bindableAccounts(): Promise<BindableAccount[]> {
  return listBindableAccounts();
}
