import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import type { HelperApiFor } from "@/lib/helpers/types";
import {
  installPackage,
  packageState,
  packageSupport,
  uninstallPackage,
  type GrantFailure,
} from "@/lib/elevation";
import { KNOWN, validatePackageId } from "./lib/packages";
import {
  createRequest,
  forgetInstalled,
  getRequest,
  getRequestAnyModule,
  hasOpenRequest,
  isExpired,
  listInstalled,
  pendingRequests,
  recordInstalled,
  settleRequest,
  weInstalled,
} from "./lib/store";

/**
 * The whole surface a module may reach.
 *
 * **A module can ask. Only an administrator can install.** Two gates stand between a module's
 * request and software arriving: an admin approving it in JonDash, where the package id is
 * shown verbatim, and then Windows asking again. The second is the unforgeable one, but the
 * first is where the actual understanding happens — the UAC dialog names
 * `jondash-elevate.exe` and says nothing at all about what is being installed.
 *
 * **Be honest about the bound.** This is weaker than the `host-services` grant model and no
 * amount of engineering changes that. An installer runs the vendor's code as administrator by
 * definition, so what this is bounded to is "anything in the winget catalogue" — not "nothing
 * bad". Any UI built on it must show the package id and not imply more safety than exists.
 */

export type { PackageState } from "@/lib/elevation";
export { KNOWN };

/**
 * Carries core's own reason rather than a narrowed copy. An earlier draft declared a
 * hand-picked subset and cast to it, which compiled — `as never` always does — while quietly
 * promising the caller a smaller set of reasons than it can actually return. Passing the
 * vocabulary through is both honest and one less thing to keep in step.
 */
export type InstallSupport = { ok: true } | { ok: false; reason: GrantFailure; message: string };

export type RequestResult = { ok: true; requestId: string } | { ok: false; reason: string };

export type RequestOutcome =
  | { status: "pending" }
  | { status: "done"; at: string }
  | { status: "declined"; at: string }
  | { status: "cancelled-at-uac"; at: string }
  | { status: "failed"; at: string; detail: string }
  | { status: "expired"; at: string };

export type AdminRequest = {
  id: string;
  moduleId: string;
  packageId: string;
  reason: string;
  action: "install" | "uninstall";
  createdAt: string;
};

export type InstalledByUs = { packageId: string; label: string | null; installedAt: string; forModule: string | null };

export type HostInstallApi = {
  /** Can this machine install anything? Needs no capability — a module must be able to
   *  explain itself on a box with no winget without being granted anything. */
  capability(): Promise<InstallSupport>;
  /** Is this package present? Unprivileged and unprompted. Needs `host-install:read`. */
  isInstalled(packageId: string): Promise<boolean | null>;
  /** Ask an administrator to install something. Inert. Needs `host-install:manage`. */
  requestInstall(packageId: string, reason: string): Promise<RequestResult>;
  /** Ask to remove something **JonDash installed**. Refused otherwise. Needs `host-install:manage`. */
  requestUninstall(packageId: string, reason: string): Promise<RequestResult>;
  /** What happened to a request THIS module raised. Needs `host-install:manage`. */
  requestStatus(requestId: string): Promise<RequestOutcome | null>;
  /** Admin-only. Every call refuses unless `ctx.user` is an ADMIN. */
  admin: {
    pending(): Promise<AdminRequest[]>;
    /** **Raises a UAC prompt and runs the installer.** Returns when it has finished. */
    approve(requestId: string): Promise<RequestOutcome>;
    decline(requestId: string): Promise<{ ok: boolean }>;
    /** What JonDash installed — the only things it may offer to remove. */
    installedByUs(): Promise<InstalledByUs[]>;
  };
};

function granted(ctx: ModuleContext, permission: DeclaredPermission): boolean {
  if (typeof ctx.can !== "function") return true;
  return ctx.can(permission);
}

/** Forgeable exactly as `ctx.can` is. It catches accidents and honest modules; what catches
 *  the rest is UAC, which cannot be faked from inside the app. */
function isAdmin(ctx: ModuleContext): boolean {
  return ctx.user?.role === "ADMIN";
}

function explain(reason: GrantFailure, message: string): string {
  switch (reason) {
    case "declined":
      return "you dismissed the Windows permission prompt";
    case "timed-out":
      return "the permission prompt was not answered in time";
    case "package-not-found":
      return "winget has no package with that name";
    case "no-package-manager":
      return "winget is not available on this machine";
    case "not-installed":
      return "this version of JonDash cannot install software";
    case "no-interactive-desktop":
      return "JonDash cannot show a permission prompt on this machine";
    case "unsupported-platform":
      return "installing software is only supported on Windows";
    default:
      return message;
  }
}

const api: HelperApiFor<HostInstallApi> = (ctx: ModuleContext) => ({
  async capability() {
    const s = packageSupport();
    // The message is passed through too — "winget isn't present on this machine" is something
    // a module can show a person, and re-deriving it here would only make it worse.
    return s.available ? { ok: true } : { ok: false, reason: s.reason, message: explain(s.reason, s.message) };
  },

  async isInstalled(packageId: string) {
    if (!granted(ctx, "host-install:read")) return null;
    const v = validatePackageId(packageId);
    if (!v.ok) return null;
    const r = await packageState(v.id);
    return r.ok ? r.value === "installed" : null;
  },

  async requestInstall(packageId: string, reason: string) {
    return raise(ctx, packageId, reason, "install");
  },

  async requestUninstall(packageId: string, reason: string) {
    // The uninstall rule, enforced at the point a module asks rather than at approval:
    // clean up what you created, never what you found. Software the admin installed
    // themselves is not ours to offer to remove.
    if (!granted(ctx, "host-install:manage")) return { ok: false, reason: "not permitted" };
    const v = validatePackageId(packageId);
    if (!v.ok) return { ok: false, reason: v.reason };
    if (!(await weInstalled(v.id))) {
      return { ok: false, reason: "JonDash did not install that, so it will not remove it." };
    }
    return raise(ctx, packageId, reason, "uninstall");
  },

  async requestStatus(requestId: string) {
    if (!granted(ctx, "host-install:manage")) return null;
    const r = await getRequest(ctx.moduleId, requestId);
    if (!r) return null;
    if (isExpired(r)) {
      await settleRequest(r.id, "expired", null);
      return { status: "expired", at: new Date().toISOString() };
    }
    switch (r.state) {
      case "pending":
        return { status: "pending" };
      case "done":
        return { status: "done", at: r.decidedAt ?? "" };
      case "declined":
        return { status: "declined", at: r.decidedAt ?? "" };
      case "cancelled-at-uac":
        return { status: "cancelled-at-uac", at: r.decidedAt ?? "" };
      case "failed":
        return { status: "failed", at: r.decidedAt ?? "", detail: r.detail ?? "" };
      default:
        return { status: "expired", at: r.decidedAt ?? "" };
    }
  },

  admin: {
    async pending() {
      if (!isAdmin(ctx)) return [];
      const rows = await pendingRequests();
      return rows.map((r) => ({
        id: r.id,
        moduleId: r.moduleId,
        packageId: r.packageId,
        reason: r.reason,
        action: r.action as "install" | "uninstall",
        createdAt: r.createdAt,
      }));
    },

    async approve(requestId: string) {
      const now = new Date().toISOString();
      if (!isAdmin(ctx)) return { status: "failed", at: now, detail: "administrator only" };

      const r = await getRequestAnyModule(requestId);
      if (!r || r.state !== "pending") return { status: "expired", at: now };

      const v = validatePackageId(r.packageId);
      if (!v.ok) {
        await settleRequest(requestId, "failed", ctx.user?.id ?? null, v.reason);
        return { status: "failed", at: now, detail: v.reason };
      }

      const userId = ctx.user?.id ?? null;
      const result =
        r.action === "install" ? await installPackage(v.id, { userId }) : await uninstallPackage(v.id, { userId });

      if (result.ok) {
        // Recorded only on success, and only for installs — the record is what later
        // authorises removal, so writing it optimistically would let JonDash offer to
        // uninstall something it never managed to install.
        if (r.action === "install") {
          await recordInstalled({ packageId: v.id, manager: "winget", installedBy: userId, forModule: r.moduleId });
        } else {
          await forgetInstalled(v.id);
        }
        await settleRequest(requestId, "done", userId, result.value);
        await ctx.audit?.(`host-install.${r.action}`, `${v.id} (${result.value})`);
        return { status: "done", at: now };
      }

      const detail = explain(result.reason, result.message);
      const state = result.reason === "declined" ? "cancelled-at-uac" : "failed";
      await settleRequest(requestId, state, userId, detail);
      await ctx.audit?.(`host-install.${r.action}.refused`, `${v.id}: ${detail}`);
      return state === "cancelled-at-uac" ? { status: "cancelled-at-uac", at: now } : { status: "failed", at: now, detail };
    },

    async decline(requestId: string) {
      if (!isAdmin(ctx)) return { ok: false };
      await settleRequest(requestId, "declined", ctx.user?.id ?? null);
      await ctx.audit?.("host-install.declined", requestId);
      return { ok: true };
    },

    async installedByUs() {
      if (!isAdmin(ctx)) return [];
      const rows = await listInstalled();
      return rows.map((r) => ({
        packageId: r.packageId,
        label: r.label,
        installedAt: r.installedAt,
        forModule: r.forModule,
      }));
    },
  },
});

async function raise(
  ctx: ModuleContext,
  packageId: string,
  reason: string,
  action: "install" | "uninstall",
): Promise<RequestResult> {
  if (!granted(ctx, "host-install:manage")) return { ok: false, reason: "not permitted" };

  const v = validatePackageId(packageId);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (!reason.trim()) return { ok: false, reason: "A reason is required — the admin reads it." };
  if (await hasOpenRequest(ctx.moduleId)) {
    return { ok: false, reason: "You already have a request waiting for the administrator." };
  }

  const requestId = await createRequest({ moduleId: ctx.moduleId, packageId: v.id, reason, action });
  await ctx.audit?.(`host-install.request.${action}`, `${ctx.moduleId} asked for ${v.id}`);
  return { ok: true, requestId };
}

export default api;
