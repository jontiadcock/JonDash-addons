import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import type { HelperApiFor } from "@/lib/helpers/types";
import { addEntry, findEntry, listEntries, removeEntry, setUnattended } from "./lib/allowlist";
import {
  createRequest,
  decline,
  execute,
  openSuggestions,
  pendingRequests,
  requestStatus,
  suggest,
  type RequestOutcome,
} from "./lib/requests";
import { capability, type ElevationSupport } from "./lib/grant";
import { readState, readStates, type ServiceState } from "./lib/services";
import { isVerb, type Verb } from "./lib/names";
import { assessRisk, type Risk } from "./lib/risk";

export type { Risk };

/**
 * The ENTIRE surface a module may reach. A module imports `@/helpers/host-services/api` and
 * nothing else — the verifier refuses any deeper path — so everything exported here is
 * supported forever, and everything not exported here is unreachable.
 *
 * ## Two surfaces, and the split is what the admin consented to
 *
 *  - **The module surface** — `list`, `request`, `requestStatus`, `suggest`, `myPending`,
 *    `capability`. Gated on `host-services:read` / `:control`.
 *  - **`admin.*`** — editing the allowlist. Requires an ADMIN in `ctx.user` **and** the
 *    module to have declared `host-services:configure`.
 *
 * ## Why `:configure` exists, which is the interesting part
 *
 * Up to `0.0.1-beta.4` these calls were here with **no capability at all** — gated only on
 * `ctx.user.role === "ADMIN"`. The consent screen said the module could *control the services
 * you listed*, and said nothing about adding to that list. **That was a privilege-escalation
 * path, found by the owner:** a module could display "Add Plex" and submit `sshd`, and since
 * the UAC prompt names `jondash-grant.exe` rather than the service, nothing on screen caught
 * it. The allowlist is meant to BE the boundary, and the thing it bounds could edit it.
 *
 * Deleting the calls made the allowlist uneditable, because a helper has no UI of its own.
 * So the power is back and **declared**: an admin sees, in red, that this module chooses what
 * goes on the list. Consenting to that knowingly is categorically different from it happening
 * behind a sentence about restarting.
 *
 * **Be clear about what `:configure` does NOT fix.** A module that has it can still submit a
 * different service than the one it displayed. What changed is that the admin agreed to let
 * this module manage the list at all — the deception is now *within* a granted power rather
 * than outside every granted power. That is better, and it is not the same as safe.
 *
 * **The real fix is placement.** Editing belongs on the helper's own settings page, where
 * JonDash renders the form and no module is in the path; then `:configure` is deleted rather
 * than merely honest. Asked of core 2026-07-26.
 *
 * ## Still absent, and must stay absent
 *
 *  - **No way to run a command.** Verbs against a list. This is not a shell.
 *  - **No way to enumerate services.** A module cannot discover what exists on the machine;
 *    that is a scoping decision and a privacy one.
 *  - **No unattended default.** `setUnattended` exists, but off is the default and always the
 *    admin's deliberate choice.
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

export type AdminEntry = Service & {
  unattended: boolean;
  grantState: "none" | "granted" | "partial" | "error";
  taskBase: string;
  addedAt: string;
};

export type AddOutcome =
  | { ok: true; entry: AdminEntry; risk: Risk }
  | { ok: false; reason: string; cancelledAtUac?: boolean };

export type Suggestion = { id: string; moduleId: string; serviceName: string; reason: string; createdAt: string };

/** Every call needs an ADMIN in `ctx.user` AND `host-services:configure`. */
export type HostServicesAdminApi = {
  entries(): Promise<AdminEntry[]>;
  /** Approve a service. **Raises a UAC prompt**, because it creates the OS grant. */
  add(input: { serviceName: string; label?: string; canControl?: boolean }): Promise<AddOutcome>;
  /** Remove an entry and its grants together. Prompts as well. */
  remove(entryId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Per entry: may a module act without an admin click? Off by default, never global. */
  setUnattended(entryId: string, unattended: boolean): Promise<{ ok: boolean }>;
  /** What adding this name would warn about. Pure — safe to call while typing. */
  assessRisk(serviceName: string): Risk;
  pending(): Promise<PendingRequest[]>;
  approve(requestId: string): Promise<RequestOutcome>;
  decline(requestId: string): Promise<{ ok: boolean }>;
  suggestions(): Promise<Suggestion[]>;
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
  /** Editing the allowlist. Needs an ADMIN **and** `host-services:configure`. */
  admin: HostServicesAdminApi;
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
   * not see another's.
   */
  async myPending() {
    if (!granted(ctx, "host-services:control")) return [];
    const [rows, entries] = await Promise.all([pendingRequests(), listEntries()]);
    return rows
      .filter((r) => r.moduleId === ctx.moduleId)
      .map((r) => toPending(r, entries));
  },

  admin: {
    async entries() {
      if (!canConfigure(ctx)) return [];
      const rows = await listEntries();
      const states = await readStates(rows.map((e) => e.serviceName));
      return rows.map((e) => ({
        id: e.id,
        name: e.serviceName,
        label: e.label,
        state: states.get(e.serviceName) ?? "unknown",
        canControl: e.canControl,
        unattended: e.unattended,
        grantState: e.grantState,
        taskBase: e.taskBase,
        addedAt: e.addedAt,
      }));
    },

    async add(input) {
      if (!canConfigure(ctx)) return { ok: false, reason: "not permitted" };
      const r = await addEntry({ ...input, addedBy: ctx.user?.id ?? null });
      if (!r.ok) {
        const cancelled = r.reason === "grant-refused" && r.outcome.status === "cancelled-at-uac";
        // The refusal is audited by the HELPER rather than left to the caller. A module
        // reaching for something it should not have is the most interesting line in the log,
        // and one that meant harm would simply decline to write it.
        await ctx.audit?.("host-services.entry.refused", `${input.serviceName}: ${r.reason}`);
        return { ok: false, reason: explain(r), cancelledAtUac: cancelled };
      }
      // Records the SERVICE NAME, not the label the module chose to display. If a module ever
      // shows one thing and submits another, the audit trail says which actually happened.
      await ctx.audit?.(
        "host-services.entry.add",
        `${r.entry.serviceName} (shown as "${r.entry.label}")${r.risk.level === "none" ? "" : ` — ${r.risk.level} risk`}`,
      );
      return {
        ok: true,
        risk: r.risk,
        entry: {
          id: r.entry.id,
          name: r.entry.serviceName,
          label: r.entry.label,
          state: await readState(r.entry.serviceName),
          canControl: r.entry.canControl,
          unattended: r.entry.unattended,
          grantState: r.entry.grantState,
          taskBase: r.entry.taskBase,
          addedAt: r.entry.addedAt,
        },
      };
    },

    async remove(entryId: string) {
      if (!canConfigure(ctx)) return { ok: false, reason: "not permitted" };
      const entry = await findEntry(entryId);
      const r = await removeEntry(entryId);
      if (!r.ok) return { ok: false, reason: r.outcome ? describeOutcome(r.outcome) : "could not remove the grant" };
      if (entry) await ctx.audit?.("host-services.entry.remove", `${entry.serviceName}`);
      return { ok: true };
    },

    async setUnattended(entryId: string, unattended: boolean) {
      if (!canConfigure(ctx)) return { ok: false };
      await setUnattended(entryId, unattended);
      const entry = await findEntry(entryId);
      await ctx.audit?.(
        "host-services.entry.unattended",
        `${entry?.serviceName ?? entryId} — ${unattended ? "may act without asking" : "asks each time"}`,
      );
      return { ok: true };
    },

    assessRisk(serviceName: string) {
      return assessRisk(serviceName);
    },

    async pending() {
      if (!canConfigure(ctx)) return [];
      const [rows, entries] = await Promise.all([pendingRequests(), listEntries()]);
      return rows.map((r) => toPending(r, entries));
    },

    async approve(requestId: string) {
      if (!canConfigure(ctx)) {
        return { status: "failed", at: new Date().toISOString(), detail: "not permitted" };
      }
      const outcome = await execute(requestId, ctx.user?.id ?? null);
      await ctx.audit?.("host-services.request.approve", `${requestId}: ${outcome.status}`);
      return outcome;
    },

    async decline(requestId: string) {
      if (!canConfigure(ctx)) return { ok: false };
      await decline(requestId, ctx.user?.id ?? null);
      await ctx.audit?.("host-services.request.decline", requestId);
      return { ok: true };
    },

    async suggestions() {
      if (!canConfigure(ctx)) return [];
      return openSuggestions();
    },
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

/**
 * BOTH gates, and they answer different questions.
 *
 * `:configure` is what the ADMIN agreed this module may do, shown in red at install. The
 * ADMIN role is who is driving right now. A background job in a module that holds
 * `:configure` still cannot edit the list, because there is no admin behind it.
 *
 * Both are forgeable by a determined module — it can spread its context and hand back a
 * doctored one — so neither is the last line. That is UAC, which is unforgeable and
 * content-free: it proves a person was at the machine, not what they agreed to.
 */
function canConfigure(ctx: ModuleContext): boolean {
  return ctx.user?.role === "ADMIN" && granted(ctx, "host-services:configure");
}

function explain(r: Exclude<Awaited<ReturnType<typeof addEntry>>, { ok: true }>): string {
  switch (r.reason) {
    case "duplicate":
      return "that service is already on the list";
    case "unusable-name":
      return "that name has no characters that can be used";
    case "name-clash":
      return `Windows would give this the same permission name as "${r.detail}", and two services cannot share one. Remove that entry first if this is the one you want.`;
    case "grant-refused":
      return describeOutcome(r.outcome);
  }
}

function describeOutcome(o: { status: string; reason?: string; detail?: string }): string {
  if (o.status === "cancelled-at-uac") return "you dismissed the Windows permission prompt";
  if (o.status === "timed-out") return "the permission prompt was not answered in time";
  if (o.status === "unavailable") {
    return o.reason === "grant-manager-missing"
      ? "this version of JonDash cannot grant that permission yet"
      : o.reason === "no-interactive-session"
        ? "JonDash cannot show a permission prompt on this machine"
        : "this platform is not supported";
  }
  return o.detail || "the permission could not be granted";
}

export default api;
