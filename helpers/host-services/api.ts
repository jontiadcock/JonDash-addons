import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import type { HelperApiFor } from "@/lib/helpers/types";
import { findEntry, listEntries } from "./lib/allowlist";
import { createRequest, execute, pendingRequests, requestStatus, suggest, type RequestOutcome } from "./lib/requests";
import { capability, type ElevationSupport } from "./lib/grant";
import { findServices } from "./lib/enumerate";
import { readIsUnbounded } from "./lib/scopes";
import { readStates, type ServiceState } from "./lib/services";
import { isVerb, type Verb } from "./lib/names";

/**
 * The ENTIRE surface a module may reach — it imports `@/helpers/host-services/api` and nothing
 * deeper, so everything exported here is supported forever and nothing else is reachable.
 *
 * ⚠ A module can name a service. It can never add one — structural, not promised. This file
 * once exposed the allowlist mutators directly, so the CALLING module supplied the service
 * name being approved and could show "Add Plex" while submitting `sshd`. HELPERS-DESIGN Rule 8:
 * a module-facing API is read and request, never add, remove or approve.
 * ⚠ Absent, and must stay absent: allowlist edits (Admin → Permissions owns them), running an
 * arbitrary command (verbs against a list only), service enumeration, and `execute` — turning a
 * request into an action belongs to an administrator alone.
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

export type PendingRequest = {
  id: string;
  moduleId: string;
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

  /**
   * The approved services — or every service on the machine, if the admin turned that on.
   *
   * The unbounded switch widens READING only, and the widening is real rather than cosmetic:
   * a module genuinely sees services nobody listed. What it does not do is make any of them
   * controllable. Everything returned by the unbounded path carries `canControl: false` and a
   * synthetic id that `request()` will not resolve, so the control path is unchanged — it
   * still refuses anything that is not an allowlisted, controllable entry.
   */
  async list() {
    if (!granted(ctx, "host-services:read")) return [];
    const entries = await listEntries();
    const states = await readStates(entries.map((e) => e.serviceName));
    const listed = entries.map((e) => ({
      id: e.id,
      name: e.serviceName,
      label: e.label,
      state: states.get(e.serviceName) ?? "unknown",
      canControl: e.canControl,
    }));

    if (!(await readIsUnbounded())) return listed;

    const known = new Set(entries.map((e) => e.serviceName.toLowerCase()));
    // Empty query = everything. This is the one caller allowed to ask for that, and only
    // because an admin explicitly turned the switch on.
    const all = await findServices("");
    const extra = all
      .filter((s) => !known.has(s.name.toLowerCase()))
      .map((s) => ({
        // Prefixed rather than a real row id: there is no entry to remove, and `findEntry`
        // will not match it, so an id from here can never reach a grant.
        id: `unlisted:${s.name}`,
        name: s.name,
        label: s.display,
        state: s.state,
        canControl: false,
      }));
    return [...listed, ...extra];
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

    // The admin decided, per service, whether this needs a click — automation exists because a
    // health check can't wait for a human at 3am, but it is never a default a module can set.
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
   * not see another's.
   */
  async myPending() {
    if (!granted(ctx, "host-services:control")) return [];
    const [rows, entries] = await Promise.all([pendingRequests(), listEntries()]);
    return rows
      .filter((r) => r.moduleId === ctx.moduleId)
      .map((r) => toPending(r, entries));
  },
});

/** Shared shape for a queued request, so the module and admin views cannot drift. */
function toPending(
  r: { id: string; moduleId: string; entryId: string; action: string; createdAt: string },
  entries: { id: string; label: string }[],
): PendingRequest {
  return {
    id: r.id,
    moduleId: r.moduleId,
    entryId: r.entryId,
    serviceLabel: entries.find((e) => e.id === r.entryId)?.label ?? "(removed)",
    action: r.action as Verb,
    createdAt: r.createdAt,
  };
}

/* `canConfigure` and the wording for a refused add have both gone to `helper.ts`, where the
   settings panel and `onSettingsSubmit` live. Nothing in this file can change the allowlist,
   so nothing in it needs to explain why a change was refused. */

/**
 * REFS addons/service-control/actions.ts · addons/service-control/page.tsx ·
 *      addons/service-control/ui/settings-panel.tsx · addons/service-control/ui/widget.tsx
 */
export default api;
