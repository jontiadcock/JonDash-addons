import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import type { HelperCapabilityScope, ScopeCandidate, ScopeItem } from "@/lib/helpers/types";
import { addEntry, findEntry, listEntries, removeEntry, setUnattended, type Entry } from "./allowlist";
import { findServices } from "./enumerate";
import { readStates } from "./services";
import { explainAdd, explainRemove } from "./wording";

/**
 * The two scopes CORE-10 renders on Admin → Permissions.
 *
 * **`scope` is per CAPABILITY, not per helper, and that turns out to do real work here.** One
 * table backs both, and the split falls out of it:
 *
 *  - `host-services:read`  — every approved service. Adding one takes no elevation, so
 *                            `mayPrompt` is false, and "see them all" is offerable.
 *  - `host-services:control` — only the ones actually controllable. Adding creates the OS
 *                            grant, so `mayPrompt` is true, and there is no "control them all".
 *
 * A service approved read-only is simply a member of the first and not the second. No flag on
 * the item, no wording to explain it — the two lists say it.
 *
 * **`host-services:control` deliberately omits `unbounded`, and that is structural.** A grant is
 * one Scheduled Task per (service, verb) with both baked into the task definition, because
 * `schtasks /run` takes a task name and cannot pass arguments. "Control everything" would need
 * either a task per service — about a thousand, each with its own prompt — or one elevated
 * runner taking a service name, which converts a frozen action into a variable one and must
 * then be approved every time. That is the thing the elevation design exists to prevent, so the
 * switch would buy nothing. See helpers/ELEVATION.md.
 */

const SETTINGS = () => helperTableName("host-services", "settings");
const UNBOUNDED_READ = "read.unbounded";

async function getFlag(key: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM ${SETTINGS()} WHERE key = ?`,
      key,
    );
    return rows[0]?.value === "1";
  } catch {
    // Table missing on an install that has not booted the migration yet. Absent = off, which
    // is the safe direction: never report a wider grant than is actually stored.
    return false;
  }
}

async function setFlag(key: string, on: boolean): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${SETTINGS()} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    on ? "1" : "0",
  );
}

/** Whether a module holding `host-services:read` may see every service, not just the listed ones. */
export function readIsUnbounded(): Promise<boolean> {
  return getFlag(UNBOUNDED_READ);
}

/** Shared renderer for a list row: the real service name is the `value`, always shown by core. */
async function toItems(entries: Entry[]): Promise<ScopeItem[]> {
  const states = await readStates(entries.map((e) => e.serviceName));
  return entries.map((e) => ({
    id: e.id,
    label: e.label,
    value: e.serviceName,
    detail: states.get(e.serviceName) ?? "unknown",
  }));
}

/** Candidates minus what is already on the list, so ticking cannot produce a duplicate. */
async function candidates(query: string, taken: Set<string>): Promise<ScopeCandidate[]> {
  const found = await findServices(query);
  return found.map((s) => ({
    value: s.name,
    label: s.display,
    detail: s.state,
    alreadyAdded: taken.has(s.name.toLowerCase()),
  }));
}

/* ------------------------------------------------------------------ read */

export const readScope: HelperCapabilityScope = {
  noun: "service",
  addHint: "Spooler",
  // Adding a read-only entry creates no grant, so nothing prompts.
  mayPrompt: false,

  list: async () => toItems(await listEntries()),

  browse: async (query) => {
    const taken = new Set((await listEntries()).map((e) => e.serviceName.toLowerCase()));
    return candidates(query, taken);
  },

  add: async (_ctx, value) => {
    const r = await addEntry({ serviceName: value, canControl: false });
    if (!r.ok) return { ok: false, error: explainAdd(r) };
    return { ok: true, message: `${r.entry.serviceName} added.` };
  },

  /**
   * Removing from "can see" would orphan an OS grant if the service were also controllable, so
   * it refuses and says where to go. Cascading would silently revoke a grant the admin did not
   * click on, from the list that looks like the harmless one.
   */
  remove: async (_ctx, id) => {
    const entry = await findEntry(id);
    if (entry?.canControl) {
      return {
        ok: false,
        error: `${entry.serviceName} is also approved for control. Remove it from "control services" first — that revokes the Windows permission too.`,
      };
    }
    const r = await removeEntry(id);
    return r.ok ? { ok: true, message: "Removed." } : { ok: false, error: explainRemove(r) };
  },

  unbounded: {
    warning:
      "Any module you allow this will see every service on this machine and whether it is running — including software you have not listed here. It cannot start or stop anything.",
    isOn: readIsUnbounded,
    set: async (_ctx, on) => {
      await setFlag(UNBOUNDED_READ, on);
      return { ok: true, message: on ? "Modules can now see every service." : "Back to the listed services only." };
    },
  },
};

/* --------------------------------------------------------------- control */

export const controlScope: HelperCapabilityScope = {
  noun: "service",
  addHint: "Spooler",
  // Adding or removing here creates or deletes a Scheduled Task, which raises UAC.
  mayPrompt: true,

  list: async () => {
    const entries = (await listEntries()).filter((e) => e.canControl);
    const items = await toItems(entries);
    // `toggleOn` rides on the item rather than a callback: the helper already knows it here,
    // and a second read could disagree with the list it is drawn beside.
    return items.map((it) => ({
      ...it,
      toggleOn: entries.find((e) => e.id === it.id)?.unattended ?? false,
    }));
  },

  browse: async (query) => {
    const taken = new Set(
      (await listEntries()).filter((e) => e.canControl).map((e) => e.serviceName.toLowerCase()),
    );
    return candidates(query, taken);
  },

  add: async (_ctx, value) => {
    const r = await addEntry({ serviceName: value, canControl: true });
    if (!r.ok) return { ok: false, error: explainAdd(r) };
    const risk = r.risk.level === "none" ? "" : ` ${r.risk.message}`;
    return { ok: true, message: `${r.entry.serviceName} can now be controlled.${risk}` };
  },

  remove: async (_ctx, id) => {
    const r = await removeEntry(id);
    return r.ok ? { ok: true, message: "Removed, and the Windows permission revoked." } : { ok: false, error: explainRemove(r) };
  },

  itemToggle: {
    label: "Allow without asking",
    warning:
      "A module will be able to start, stop and restart this service on its own, with no prompt and nothing for you to approve at the time. Automation is the point — a health check restarting a hung service at 3am cannot wait for a person — but until now every action waited for you.",
    set: async (_ctx, id, on) => {
      await setUnattended(id, on);
      return { ok: true, message: on ? "Will act without asking." : "Will ask each time." };
    },
  },

  /* No `unbounded`. See the docblock at the top of this file — it is unavailable here for a
     structural reason, not omitted for caution. */
};
