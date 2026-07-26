import { getEffectivePermissionsUncached, type Permission } from "@/lib/auth/permissions";
import {
  listBindableAccounts,
  resolveBindableAccount,
  type BindableAccount,
} from "@/lib/auth/service-accounts";
import { touchKey, verifyKey, type KeyMode, type RefusalReason } from "./keys";
import { decide } from "./decide";

/**
 * The two gates. **This is the file that decides whether this helper is safe.**
 *
 * Every call is checked twice, and both must pass:
 *
 *   1. **The key's mode** — `read` or `act`. A read key cannot reach an acting tool.
 *   2. **The bound account's RBAC** — read from CORE's own tables, at call time.
 *
 * > **The mode can only ever NARROW. It never grants what the account lacks.**
 *
 * That sentence is the whole security property. Promoting a key to `act` must never become a
 * privilege-escalation path: an act-key bound to an account with no `sessions.manage` still cannot
 * revoke a session. The test asserting exactly that is the gate on whether this ships at all.
 *
 * **Permissions are resolved per call, never cached across calls.** An admin who strips a role
 * expects the agent to lose that power immediately, not at the next restart.
 */

/** What a tool needs in order to run. */
export type ToolRequirement = {
  /** `act` tools are refused outright to a read-only key, before RBAC is even consulted. */
  kind: "read" | "act";
  /** The core permission the bound account must hold. `null` = available to any valid key. */
  permission: Permission | null;
};

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
 */
export async function authorize(
  presentedKey: string | undefined,
  need: ToolRequirement,
  ip: string,
): Promise<AuthOutcome> {
  const out: { reason?: RefusalReason } = {};
  const key = await verifyKey(presentedKey, out);
  if (!key) return { ok: false, reason: out.reason ?? "bad-key" };

  // --- gate 1: the key's own mode -------------------------------------------
  //
  // Checked BEFORE the account is loaded. A read key attempting an acting tool must not even
  // cause a user lookup — it tells an attacker nothing, and it costs nothing to refuse early.
  // `permissionRequired: false` here because gate 2 has not run yet; this call can only refuse
  // on the mode, never allow past the permission check below.
  if (decide({ mode: key.mode, toolKind: need.kind, accountHasPermission: true, permissionRequired: false }) === "refuse") {
    return { ok: false, reason: "mode" };
  }

  // --- the bound account still has to exist, and still has to be bindable ----
  //
  // Re-resolved every call through the SAME function the mint form uses, rather than a direct user
  // lookup. That closes a case a plain existence check would miss: an account that is no longer a
  // service account fails closed here, not just a deleted one. `null` covers deleted, unknown,
  // disabled and human alike — one answer, so nothing distinguishes them.
  //
  // This is also why `accountId` is not a foreign key: a helper must not constrain core's User
  // table, so it verifies on every call instead. `onIdentityRemoved` tidies the dead rows, but the
  // security property lives here and does not depend on that hook firing.
  const account = await resolveBindableAccount(key.accountId);
  if (!account || account.status !== "ACTIVE") {
    return { ok: false, reason: "account-gone" };
  }

  // --- gate 2: the account's real permissions -------------------------------
  //
  // Core's own resolution, not a copy of it. ADMIN implies everything — including for a service
  // account, which may be ADMIN — otherwise it is the union of the account's access roles.
  //
  // The UNCACHED entry point, deliberately: `getEffectivePermissions` is wrapped in React's
  // `cache()`, and this runs in a bare HTTP listener with no request scope. Core measured that the
  // wrapper happens to work there, but that is undocumented React behaviour — and if it changed,
  // authorization would fail SILENTLY. Core added this sibling so the authorization path never
  // rests on an accident.
  const permissions = await getEffectivePermissionsUncached({ id: account.id, role: account.role });

  // The full decision, through the same function the escalation test drives. Both gates are
  // re-evaluated together here so the final answer comes from one place rather than from the
  // accumulated effect of two early returns.
  const verdict = decide({
    mode: key.mode,
    toolKind: need.kind,
    accountHasPermission: need.permission ? permissions.has(need.permission) : true,
    permissionRequired: need.permission !== null,
  });
  if (verdict === "refuse") {
    return { ok: false, reason: need.kind === "act" && key.mode !== "act" ? "mode" : "permission" };
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
 * **Service accounts only — never a person's.** `listBindableAccounts()` returns service accounts
 * exclusively, so a person cannot appear in the mint dropdown and cannot be bound even by a forged
 * id: `resolveBindableAccount` answers `null` for a human exactly as it does for a deleted or
 * unknown one. There is no filtering to get wrong at this end, which was the point of asking core
 * for the list rather than a predicate.
 *
 * Shipped in JonDash 1.7.3-beta.1 (SEC-07). Until it existed this returned false for everything and
 * the helper was deliberately unusable — allowing a person's account "for now" would have broken
 * every key already minted when it was later restricted, on a security boundary.
 */
export async function isBindableAccount(userId: string): Promise<boolean> {
  return (await resolveBindableAccount(userId)) !== null;
}

/** The accounts an administrator may choose from when minting a key. */
export async function bindableAccounts(): Promise<BindableAccount[]> {
  return listBindableAccounts();
}
