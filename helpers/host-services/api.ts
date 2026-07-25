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
 * TWO surfaces, and the split is the security boundary:
 *
 *  - **The module surface** (`list`, `request`, `requestStatus`, `suggest`, `capability`)
 *    is what a module uses at runtime, gated on the permissions it declared.
 *  - **`admin.*`** is for the consumer's settings panel and requires an authenticated
 *    ADMIN in `ctx.user`. A module running on its own — a background job, a widget render,
 *    anything with no signed-in admin behind it — cannot reach it at all.
 *
 * **Why there is an admin surface here at all**, since an earlier draft of HELPER.md said a
 * module could never add an allowlist entry: a helper has no UI of its own, and core has no
 * generic editor for helper configuration. With no mutator anywhere the allowlist could
 * never be populated, so that guarantee was not strict — it was unimplementable. The real
 * boundary in this app is not module-versus-helper, it is *whether an admin is behind the
 * call*, which is the shape `filesystem` already uses for approved roots.
 *
 * **What actually stops a hostile module**, since `ctx.user` is forgeable exactly as
 * `ctx.can` is — a module can spread its context and hand back a doctored one:
 *
 *  - The admin check catches accidents and honest mistakes, which is most of them.
 *  - **UAC catches the rest, and it cannot be forged.** Creating an entry creates an OS
 *    grant, which raises a real elevation prompt a human must approve at the machine. A
 *    module that fakes an admin context still cannot obtain a standing privilege silently.
 *
 * Still absent, and must stay absent:
 *
 *  - **No way to run a command.** Three verbs against a list. This is not a shell.
 *  - **No way to enumerate services.** A module cannot discover what exists on the machine;
 *    that is a scoping decision and a privacy one.
 *  - **No `execute` on the module surface.** Turning a request into an action belongs to an
 *    administrator, or to an entry an administrator already marked unattended.
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

/** Everything under here requires `ctx.user.role === "ADMIN"`. Rendered from the consuming
 *  module's SettingsPanel, which only an administrator can reach. */
export type HostServicesAdminApi = {
  /** Entries with their grant and automation state — more than the module surface shows. */
  entries(): Promise<AdminEntry[]>;
  /** Approve a service. **Raises a UAC prompt**, because it creates the OS grant. */
  add(input: {
    serviceName: string;
    label?: string;
    canControl?: boolean;
    unattended?: boolean;
  }): Promise<AddOutcome>;
  /** Remove an entry and its grants together. */
  remove(entryId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Per-entry: may a module act without an admin click? Never global, never module-settable. */
  setUnattended(entryId: string, unattended: boolean): Promise<{ ok: boolean }>;
  /** What adding this name would warn about. Pure — safe to call while typing in a form. */
  assessRisk(serviceName: string): Risk;
  /** The approval queue, and the two things an admin can do with an item in it. */
  pending(): Promise<PendingRequest[]>;
  approve(requestId: string): Promise<RequestOutcome>;
  decline(requestId: string): Promise<{ ok: boolean }>;
  /** Suggestions modules have raised, for the prefilled-form flow. */
  suggestions(): Promise<Suggestion[]>;
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

export type PendingRequest = {
  id: string;
  moduleId: string;
  entryId: string;
  serviceLabel: string;
  action: Verb;
  createdAt: string;
};

export type Suggestion = { id: string; moduleId: string; serviceName: string; reason: string; createdAt: string };

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
  /** Admin-only surface. Every call refuses unless `ctx.user` is an ADMIN. */
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

  admin: {
    async entries() {
      if (!isAdmin(ctx)) return [];
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
      if (!isAdmin(ctx)) return { ok: false, reason: "administrator only" };
      const r = await addEntry({ ...input, addedBy: ctx.user?.id ?? null });
      if (!r.ok) {
        // "Cancelled at UAC" is surfaced distinctly so the settings panel can say "you
        // dismissed the prompt" rather than "it failed" — different words for a decision
        // the admin made deliberately.
        const cancelled = r.reason === "grant-refused" && r.outcome.status === "cancelled-at-uac";
        await ctx.audit?.("host-services.entry.refused", `${input.serviceName}: ${r.reason}`);
        return { ok: false, reason: explain(r), cancelledAtUac: cancelled };
      }
      await ctx.audit?.(
        "host-services.entry.add",
        `${r.entry.label} — ${r.entry.serviceName}${r.risk.level === "none" ? "" : ` (${r.risk.level} risk)`}`,
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
      if (!isAdmin(ctx)) return { ok: false, reason: "administrator only" };
      const entry = await findEntry(entryId);
      const r = await removeEntry(entryId);
      if (!r.ok) return { ok: false, reason: r.outcome ? describeOutcome(r.outcome) : "could not remove the grant" };
      if (entry) await ctx.audit?.("host-services.entry.remove", `${entry.label} — ${entry.serviceName}`);
      return { ok: true };
    },

    async setUnattended(entryId: string, unattended: boolean) {
      if (!isAdmin(ctx)) return { ok: false };
      await setUnattended(entryId, unattended);
      const entry = await findEntry(entryId);
      await ctx.audit?.(
        "host-services.entry.unattended",
        `${entry?.label ?? entryId} — ${unattended ? "may act without asking" : "asks each time"}`,
      );
      return { ok: true };
    },

    assessRisk(serviceName: string) {
      return assessRisk(serviceName);
    },

    async pending() {
      if (!isAdmin(ctx)) return [];
      const rows = await pendingRequests();
      const entries = await listEntries();
      return rows.map((r) => ({
        id: r.id,
        moduleId: r.moduleId,
        entryId: r.entryId,
        serviceLabel: entries.find((e) => e.id === r.entryId)?.label ?? "(removed)",
        action: r.action as Verb,
        createdAt: r.createdAt,
      }));
    },

    async approve(requestId: string) {
      if (!isAdmin(ctx)) return { status: "failed", at: new Date().toISOString(), detail: "administrator only" };
      const outcome = await execute(requestId, ctx.user?.id ?? null);
      await ctx.audit?.("host-services.request.approve", `${requestId}: ${outcome.status}`);
      return outcome;
    },

    async decline(requestId: string) {
      if (!isAdmin(ctx)) return { ok: false };
      await decline(requestId, ctx.user?.id ?? null);
      await ctx.audit?.("host-services.request.decline", requestId);
      return { ok: true };
    },

    async suggestions() {
      if (!isAdmin(ctx)) return [];
      return openSuggestions();
    },
  },
});

/**
 * Forgeable exactly as `ctx.can` is — a module can spread its context and hand back a
 * doctored one. Checked anyway, because it catches every accident and every honest module,
 * which is nearly all of them. What catches the rest is UAC: creating an entry raises a
 * real elevation prompt, so a forged admin context still cannot obtain a standing privilege
 * silently. This check is the first layer, not the only one.
 */
function isAdmin(ctx: ModuleContext): boolean {
  return ctx.user?.role === "ADMIN";
}

function explain(r: Exclude<Awaited<ReturnType<typeof addEntry>>, { ok: true }>): string {
  switch (r.reason) {
    case "duplicate":
      return "that service is already on the list";
    case "unusable-name":
      return "that name has no characters that can be used";
    case "no-free-name":
      return "too many services with similar names";
    case "grant-refused":
      return describeOutcome(r.outcome);
  }
}

function describeOutcome(o: { status: string; reason?: string; detail?: string }): string {
  if (o.status === "cancelled-at-uac") return "you dismissed the Windows permission prompt";
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
