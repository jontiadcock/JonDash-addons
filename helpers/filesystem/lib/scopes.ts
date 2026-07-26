import fs from "node:fs/promises";
import path from "node:path";
import type { HelperCapabilityScope, ScopeCandidate, ScopeItem } from "@/lib/helpers/types";
import { addRoot, listRoots, removeRoot } from "./admin";
import { assessRoot } from "./risk";
import { identityOf, protectedIdentities } from "./secrets";

/**
 * The approved-folder set, as CORE-10 renders it.
 *
 * **One list behind three capabilities.** `filesystem:read`, `:write` and `:delete` all reach
 * exactly the same roots — a folder is not approved "for reading" — so all three declare this
 * same scope and core draws the list against each. That is redundant on screen and honest,
 * which is the right trade: showing the list only against `:read` would leave `:write` looking
 * unbounded, and showing it nowhere is the fragmentation CORE-10 exists to end. What differs
 * per capability is the switch: a module may hold read over these folders without holding
 * delete, which is the distinction that actually matters.
 */

const MAX_RESULTS = 30;

async function toItems(): Promise<ScopeItem[]> {
  const roots = await listRoots();
  return roots.map((r) => ({
    id: r.id,
    label: r.label,
    value: r.path,
    detail: r.riskNote ?? undefined,
  }));
}

/**
 * Folders the admin can tick instead of typing a path.
 *
 * Typing an absolute path correctly is exactly the friction that pushes somebody toward the
 * "everything" switch, which is what `browse` exists to prevent. `query` is treated as a
 * partial path: the deepest existing directory in it is listed, filtered by the trailing
 * fragment. Empty query offers the drive roots, which is where a person starts.
 *
 * **JonDash's own secrets are never offered.** Same identity check the copy engine and
 * `browse()` use — a candidate list that suggested `.data` would be inviting the admin to
 * approve the master key.
 */
async function findFolders(query: string): Promise<ScopeCandidate[]> {
  const q = query.trim();

  let dir: string;
  let fragment: string;
  if (!q) {
    // No query: offer somewhere to start rather than nothing.
    const drives = process.platform === "win32" ? ["C:\\", "D:\\", "E:\\"] : ["/", "/mnt", "/media", "/home"];
    const out: ScopeCandidate[] = [];
    for (const d of drives) {
      try {
        await fs.stat(d);
        out.push({ value: d, label: d, detail: "drive" });
      } catch {
        /* not present */
      }
    }
    return out;
  }

  if (q.endsWith(path.sep) || q.endsWith("/")) {
    dir = q;
    fragment = "";
  } else {
    dir = path.dirname(q);
    fragment = path.basename(q).toLowerCase();
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Unreadable or half-typed. The manual field still works — never an error page.
    return [];
  }

  const registry = await protectedIdentities();
  const taken = new Set((await listRoots()).map((r) => r.path.toLowerCase()));
  const out: ScopeCandidate[] = [];

  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (fragment && !e.name.toLowerCase().startsWith(fragment)) continue;

    const full = path.join(dir, e.name);
    try {
      const st = await fs.stat(full);
      if (registry.has(identityOf(st))) continue; // JonDash's own — never offered
    } catch {
      continue;
    }

    const risk = assessRoot(full);
    out.push({
      value: full,
      label: e.name,
      detail: risk.level === "none" ? undefined : `${risk.level} risk`,
      alreadyAdded: taken.has(full.toLowerCase()),
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

export const rootScope: HelperCapabilityScope = {
  noun: "folder",
  addHint: "D:\\Photos  or  \\\\nas\\backups",
  // Approving a folder is a database write. Nothing elevates.
  mayPrompt: false,

  list: toItems,
  browse: findFolders,

  add: async (_ctx, value) => {
    const r = await addRoot({ path: value, label: value });
    if (!r.ok) return { ok: false, error: r.reason };
    return { ok: true, message: `Approved ${r.root.path}.${r.risk ? ` ${r.risk}` : ""}` };
  },

  remove: async (_ctx, id) => {
    const gone = await removeRoot(id);
    return { ok: true, message: gone ? `Removed ${gone.path}.` : "Already gone." };
  },

  /* No `unbounded` on any of the three — see helper.ts. */
};
