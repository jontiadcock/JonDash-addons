import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import type { HelperApiFor } from "@/lib/helpers/types";
import { findEntry, listEntries } from "./lib/allowlist";
import { createRequest, execute, pendingRequests, requestStatus, suggest, type RequestOutcome } from "./lib/requests";
import { capability, type ElevationSupport } from "./lib/grant";
import { readStates, type ServiceState } from "./lib/services";
import { isVerb, type Verb } from "./lib/names";
import type { Risk } from "./lib/risk";

// Still exported for the helper's own settings page to use once core provides one. Nothing a
// module can reach returns it.
export type { Risk };

/**
 * The ENTIRE surface a module may reach. A module imports `@/helpers/host-services/api` and
 * nothing else — the verifier refuses any deeper path — so everything exported here is
 * supported forever, and everything not exported here is unreachable.
 *
 * > **A module can name a service. It can never add one.**
 *
 * ## The `admin.*` surface was REMOVED, and why it should never come back
 *
 * Versions up to `0.0.1-beta.4` exposed `admin.add`/`remove`/`setUnattended`/`approve` here,
 * so the consuming module could render the allowlist editor. It was gated on
 * `ctx.user.role === "ADMIN"` and justified by "there is nowhere else to put the UI".
 *
 * **That was a privilege-escalation path, found by the owner.** The consent screen says only:
 *
 *     "See whether the services you list are running"
 *     "Start, stop and restart the services you list"
 *
 * Neither discloses *adding to that list* — yet `admin.add` took the service name **from the
 * module's own form**. A module could display "Add Plex" and submit `sshd`. The UAC prompt
 * names `jondash-grant.exe` and says nothing about which service, so nothing on screen would
 * catch the substitution. **The allowlist is supposed to BE the boundary, and the thing it
 * bounds could edit it.**
 *
 * The two mitigations were weaker than they read. `ctx.user` is forgeable exactly as
 * `ctx.can` is — a module can spread its context and hand back a doctored one. UAC is
 * unforgeable but content-free: it proves a human was present, not what they agreed to.
 *
 * **The fix is placement, not another check.** The allowlist editor belongs on the helper's
 * own settings page, where JonDash renders the form and the helper receives the values with
 * no module in the path. Until core ships that slot (asked 2026-07-26), the allowlist cannot
 * be edited at all — the feature is inert rather than unsound, which is the right way round.
 *
 * ## Still absent, and must stay absent
 *
 *  - **No way to add, remove or reconfigure an allowlist entry.**
 *  - **No way to run a command.** Three verbs against a list. This is not a shell.
 *  - **No way to enumerate services.** A module cannot discover what exists on the machine;
 *    that is a scoping decision and a privacy one.
 *  - **No `execute`.** Turning a request into an action belongs to an administrator.
 */

export type { ServiceState, RequestOutcome, ElevationSupport, Verb };

export type Service = {
  id: string;
  name: string;
  label: string;
  state: ServiceState;
  canControl: boolean;
};

export type RequestResult = { ok: true; requestId: string; status: "pending" | "ran" } | { ok: false; reason: string };

/**
 * A queued request, for a module to show its own pending asks.
 *
 * **Read-only, and scoped to the asking module.** There is deliberately no `approve` here:
 * turning a request into an action is an administrator's decision, and it happens on
 * JonDash's own screens where the service name comes from the allowlist rather than from a
 * module's form.
 */
export type PendingRequest = {
  id: string;
  entryId: string;
  serviceLabel: string;
  action: Verb;
  createdAt: string;
};

export type HostServicesApi = {
  /** Can this installation elevate at all? Needs no capability — a module must be able to
   *  explain itself on a headless box without having been granted anything. */
  capability(): Promise<ElevationSupport>;
  /** The allowlisted services and their current state. Needs `host-services:read`. */
  list(): Promise<Service[]>;
  /** Ask for an action. Needs `host-services:control`. */
  request(serviceId: string, action: Verb): Promise<RequestResult>;
  /** What happened to a request THIS module raised. Needs `host-services:control`. */
  requestStatus(requestId: string): Promise<RequestOutcome | null>;
  /** Ask the admin to allowlist a service. Inert. Needs `host-services:control`. */
  suggest(name: string, reason: string): Promise<RequestResult>;
  /** This module's own queued requests, read-only. Needs `host-services:control`. */
  myPending(): Promise<PendingRequest[]>;
};

/**
 * `ctx.can()` is advisory, not forge-proof — a module can spread its context and hand a
 * doctored one back. It is checked anyway, at the top of every privileged call, because it
 * is the difference between a module accidentally exceeding what it declared and one
 * deliberately doing so. The former is common and worth catching; only the latter survives
 * this, and that is a different problem with a different answer.
 *
 * Absent on older cores, where it degrades to permitted rather than refusing everything —
 * this helper's `minAppVersion` already requires a core that has it.
 */
function granted(ctx: ModuleContext, permission: DeclaredPermission): boolean {
  if (typeof ctx.can !== "function") return true;
  return ctx.can(permission);
}

const api: HelperApiFor<HostServicesApi> = (ctx: ModuleContext) => ({
  async capability() {
    return capability();
  },

  async list() {
    if (!granted(ctx, "host-services:read")) return [];
    const entries = await listEntries();
    const states = await readStates(entries.map((e) => e.serviceName));
    return entries.map((e) => ({
      id: e.id,
      name: e.serviceName,
      label: e.label,
      state: states.get(e.serviceName) ?? "unknown",
      canControl: e.canControl,
    }));
  },

  async request(serviceId: string, action: Verb) {
    if (!granted(ctx, "host-services:control")) return { ok: false, reason: "not permitted" };
    if (!isVerb(action)) return { ok: false, reason: "unknown action" };

    const entry = await findEntry(serviceId);
    // Identical refusal whether the id is unknown or read-only. A different message for
    // each would let a module probe the allowlist by trying ids and reading the replies.
    if (!entry || !entry.canControl) return { ok: false, reason: "not in the list" };

    const requestId = await createRequest(ctx.moduleId, entry.id, action);
    await ctx.audit?.(
      "host-services.request",
      `${ctx.moduleId} asked to ${action} ${entry.serviceName}`,
    );

    // The admin decided, per service, whether this needs a click. Automation is the entire
    // reason the option exists — a health check restarting a hung service at 3am cannot wait
    // for a human — but it is never a default and never something a module can set.
    if (entry.unattended) {
      const outcome = await execute(requestId, null);
      if (outcome.status === "approved" && outcome.ok) return { ok: true, requestId, status: "ran" };
      return { ok: true, requestId, status: "pending" };
    }

    return { ok: true, requestId, status: "pending" };
  },

  async requestStatus(requestId: string) {
    if (!granted(ctx, "host-services:control")) return null;
    return requestStatus(ctx.moduleId, requestId);
  },

  async suggest(name: string, reason: string) {
    if (!granted(ctx, "host-services:control")) return { ok: false, reason: "not permitted" };
    const r = await suggest(ctx.moduleId, name, reason);
    if (!r.ok) return { ok: false, reason: r.reason };
    await ctx.audit?.("host-services.suggest", `${ctx.moduleId} suggested ${name}`);
    return { ok: true, requestId: r.id, status: "pending" };
  },

  /**
   * This module's own queued requests. Read-only, and scoped to the caller — one module must
   * not see another's, and nothing here can approve anything.
   */
  async myPending() {
    if (!granted(ctx, "host-services:control")) return [];
    const [rows, entries] = await Promise.all([pendingRequests(), listEntries()]);
    return rows
      .filter((r) => r.moduleId === ctx.moduleId)
      .map((r) => ({
        id: r.id,
        entryId: r.entryId,
        serviceLabel: entries.find((e) => e.id === r.entryId)?.label ?? "(removed)",
        action: r.action as Verb,
        createdAt: r.createdAt,
      }));
  },
});

export default api;
