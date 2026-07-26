import { prisma } from "@/lib/db";
import { getEffectivePermissions, type Permission } from "@/lib/auth/permissions";
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

  // --- the bound account still has to exist ---------------------------------
  //
  // Re-resolved every call rather than trusted from the key row: an account deleted or disabled
  // since the key was minted must fail closed, immediately. This is also why `accountId` is not a
  // foreign key — a helper must not constrain core's User table, so it verifies instead.
  const account = await prisma.user.findUnique({
    where: { id: key.accountId },
    select: { id: true, role: true, status: true },
  });
  if (!account || account.status !== "ACTIVE") {
    return { ok: false, reason: "account-gone" };
  }

  // --- gate 2: the account's real permissions -------------------------------
  //
  // Core's own resolution, not a copy of it. ADMIN implies everything; otherwise it is the union
  // of the account's access roles. If core changes how permissions work, this changes with it.
  const permissions = await getEffectivePermissions({ id: account.id, role: account.role });

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
 * **Service accounts only — never a person's account.** Core has been asked for service accounts
 * (identities that hold permissions but can never be logged into); until they land, this returns
 * false for everything and the helper cannot be used. That is deliberate: allowing a person's
 * account now and restricting later would break every key already minted, on a security boundary.
 *
 * When core ships them, this becomes the single place that decides — one predicate, not a check
 * scattered across the mint form, the settings page and the auth path.
 */
export async function isBindableAccount(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") return false;

  // TODO(core): replace with the real service-account predicate once it exists. Returning false
  // here is what makes the dependency honest — the helper visibly cannot be used yet, rather than
  // quietly binding to a human.
  return false;
}
