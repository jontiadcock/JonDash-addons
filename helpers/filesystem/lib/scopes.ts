import fs from "node:fs/promises";
import path from "node:path";
import type { HelperCapabilityScope, ScopeCandidate, ScopeItem } from "@/lib/helpers/types";
import {
  addRoot,
  isUnbounded,
  jondashProtected,
  listRoots,
  removeRoot,
  setJondashProtected,
  setUnbounded,
  type Verb,
} from "./admin";
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

/**
 * The unbounded wording, per verb.
 *
 * **Each names the worst thing it reaches, not the average one**, because this sentence is the
 * only thing an admin reads before agreeing. All three say that JonDash's own data stays
 * protected *and* that the protection can be switched off — a warning that mentioned only the
 * safe state would be describing a different switch from the one on screen.
 */
const WARNINGS: Record<Verb, string> = {
  read:
    "Any module you allow this will be able to read every file on this machine — documents, photos, saved passwords, anything. JonDash's own data stays protected unless you turn that protection off below.",
  write:
    "Any module you allow this will be able to create and overwrite files anywhere on this machine, including other people's documents and anything another program is relying on. JonDash's own data stays protected unless you turn that protection off below.",
  delete:
    "Any module you allow this will be able to delete any file on this machine, permanently and without asking. There is no undo. JonDash's own data stays protected unless you turn that protection off below.",
};

/**
 * One scope per capability, sharing one folder list.
 *
 * A folder is not approved "for reading" — the same roots back all three — so `list`, `browse`,
 * `add` and `remove` are identical and core draws the list against each capability. What
 * differs is the switch: read, write and delete each carry their own "everything", so an admin
 * can let a module read anywhere without letting it delete anywhere.
 */
export function rootScopeFor(verb: Verb): HelperCapabilityScope {
  return {
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

    unbounded: {
      warning: WARNINGS[verb],
      isOn: () => isUnbounded(verb),
      set: async (_ctx, on) => {
        await setUnbounded(verb, on);
        return { ok: true, message: on ? "Every folder is now reachable." : "Back to the approved folders only." };
      },

      /**
       * The protection, in the slot core added for it (1.7.2-beta.2).
       *
       * **Defaults to ON and is shared by all three verbs**, because it names a set of FILES
       * rather than a verb — protecting JonDash's data from reading but not from deletion
       * would be a distinction with no safe reading. Core renders it only while the grant is
       * on, and confirms the OFF direction, which is the widening one here: the rest of the
       * page confirms switching things on, and this is the exception.
       */
      option: {
        label: "Exclude JonDash's own data",
        warning:
          "Turning this off exposes JonDash's own encryption key, its database and its elevation binaries to any module holding this. The key decrypts every two-factor secret and every backup you have taken. A module could also destroy this installation. Nothing about JonDash protects itself once this is off.",
        isOn: jondashProtected,
        set: async (_ctx, on) => {
          await setJondashProtected(on);
          return {
            ok: true,
            message: on
              ? "JonDash's own data is protected again."
              : "JonDash's own data is now reachable — its encryption key, database and binaries included.",
          };
        },
      },
    },
  };
}
