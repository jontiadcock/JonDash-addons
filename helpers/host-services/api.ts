import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import type { HelperApiFor } from "@/lib/helpers/types";
import { findEntry, listEntries } from "./lib/allowlist";
import { createRequest, execute, requestStatus, suggest, type RequestOutcome } from "./lib/requests";
import { capability, type ElevationSupport } from "./lib/grant";
import { readStates, type ServiceState } from "./lib/services";
import { isVerb, type Verb } from "./lib/names";

/**
 * The ENTIRE surface a module may reach. A module imports `@/helpers/host-services/api` and
 * nothing else — the verifier refuses any deeper path — so everything exported here is
 * supported forever, and everything not exported here is unreachable.
 *
 * Read that list twice before adding to it. Note what is absent and must stay absent:
 *
 *  - **No way to add an allowlist entry.** `suggest()` writes a row an admin may act on.
 *  - **No way to set `unattended`.** A module must never be able to remove its own leash.
 *  - **No way to run a command.** Three verbs against a list. This is not a shell.
 *  - **No way to enumerate services.** A module cannot discover what exists on the machine;
 *    that is a scoping decision and a privacy one.
 *  - **No `execute`.** Turning a request into an action belongs to an administrator, or to
 *    an entry an administrator already marked unattended.
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
});

export default api;
