import fsp from "node:fs/promises";
import path from "node:path";
import { assertUsableAsDestination, contains } from "./paths";
import { parseSnapshotName, selectForRetention, type GfsPolicy } from "./snapshots";
import type { RunLog } from "./logfile";

/**
 * Applying snapshot retention — the only code in this helper that destroys anything. The
 * pure decision of *what* to remove lives in `snapshots.ts`, tested without touching a disk;
 * this file is the thin, paranoid layer that carries it out.
 *
 * ⚠ `runPrune` derives its own plan and never accepts a list of paths to delete — a module
 * names a destination and a policy, never a victim, the whole difference between a
 * retention feature and a remote-delete primitive. Six more layers guard the walk below,
 * each commented at its own check: write-side rules, no recursion, exact-name match,
 * `lstat` not `stat`, re-checked containment, newest-snapshot refusal.
 */

export type SnapshotEntry = {
  name: string;
  /** Absolute path. Always inside the destination — re-checked, not assumed. */
  path: string;
  at: Date;
};

/** REFS helpers/filesystem/api.ts */
export type PrunePlan = {
  destination: string;
  /** Kept, each with the retention tier that saved it. */
  keep: { name: string; because: string }[];
  /** Removable. Never includes the newest snapshot. */
  remove: SnapshotEntry[];
  /** Directory entries that are not snapshots and were therefore never considered. */
  ignored: string[];
};

export type PruneResult = {
  removed: string[];
  /** Per-entry failures. One locked folder must not abandon the rest. */
  errors: { name: string; reason: string }[];
};

/** A refusal that applies to the whole operation, before anything is examined. */
export type PruneRefusal = { ok: false; reason: string };
export type PruneOk = { ok: true; plan: PrunePlan };

/**
 * What retention WOULD remove, having removed nothing. This is what an admin sees before
 * agreeing, and what `runPrune` recomputes for itself — the plan is never passed between
 * them, so there is no window in which a caller could alter it.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/tests/prune.test.ts
 */
export async function planPrune(destination: string, policy: GfsPolicy): Promise<PruneOk | PruneRefusal> {
  // Deleting is writing. The write-side rules refuse JonDash's own folder and the OS.
  const dest = assertUsableAsDestination(destination);
  if (!dest.ok) return { ok: false, reason: dest.reason };
  const root = dest.path;

  let entries;
  try {
    // No recursion: only DIRECT children of the destination are ever considered — nothing
    // here looks deeper for snapshots.
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    return { ok: false, reason: `Couldn't read that folder (${(e as NodeJS.ErrnoException)?.code ?? "unknown"}).` };
  }

  const found: SnapshotEntry[] = [];
  const ignored: string[] = [];

  for (const e of entries) {
    // Only exact snapshot names. Anything else is somebody's own folder and is not ours
    // to reason about, let alone remove.
    if (!parseSnapshotName(e.name)) {
      ignored.push(e.name);
      continue;
    }

    const abs = path.join(root, e.name);

    // Re-check containment on the joined path rather than trusting the name.
    if (!contains(root, abs)) {
      ignored.push(e.name);
      continue;
    }

    // lstat, so a symlink is identified as a symlink rather than followed into whatever it
    // points at. A link named like a snapshot must never make us delete its target.
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      ignored.push(e.name);
      continue;
    }

    const at = parseSnapshotName(e.name)!;
    found.push({ name: e.name, path: abs, at });
  }

  const decision = selectForRetention(
    found.map((f) => ({ name: f.name, at: f.at })),
    policy,
  );
  const byName = new Map(found.map((f) => [f.name, f]));

  const remove = decision.remove.map((s) => byName.get(s.name)!).filter(Boolean);

  // Belt and braces over `selectForRetention`'s own guarantee. If a future change to the
  // selection logic ever proposed removing everything, this refuses rather than obeys.
  if (found.length > 0 && remove.length >= found.length) {
    return { ok: false, reason: "Retention would remove every backup at that location. Refusing." };
  }

  return {
    ok: true,
    plan: {
      destination: root,
      keep: decision.keep.map((k) => ({ name: k.snapshot.name, because: k.because })),
      remove,
      ignored,
    },
  };
}

/**
 * Apply retention. Recomputes the plan from the policy rather than taking one — see the
 * `⚠` at the top of this file. Returns rather than throws for per-folder failures: one
 * snapshot held open by a backup viewer must not stop the rest being tidied.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/tests/prune.test.ts
 */
export async function runPrune(
  destination: string,
  policy: GfsPolicy,
  opts: { log?: RunLog | null; signal?: { aborted: boolean } } = {},
): Promise<{ ok: true; result: PruneResult; plan: PrunePlan } | PruneRefusal> {
  const planned = await planPrune(destination, policy);
  if (!planned.ok) return planned;
  const plan = planned.plan;

  const result: PruneResult = { removed: [], errors: [] };

  for (const entry of plan.remove) {
    if (opts.signal?.aborted) break;

    // Final gate, immediately before the irreversible bit. Cheap, and it closes any window
    // between planning and acting — the folder could have been replaced by a symlink since.
    if (!parseSnapshotName(entry.name) || !contains(plan.destination, entry.path)) {
      result.errors.push({ name: entry.name, reason: "Refused: no longer a snapshot inside the destination." });
      continue;
    }
    let st;
    try {
      st = await fsp.lstat(entry.path);
    } catch {
      continue; // already gone
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      result.errors.push({ name: entry.name, reason: "Refused: not a real folder." });
      continue;
    }

    // Written BEFORE the deletion, so a prune interrupted mid-way still says exactly how
    // far it got. A log written afterwards would lose the one entry that mattered.
    opts.log?.removed(entry.name, "outside the retention policy");

    try {
      await fsp.rm(entry.path, { recursive: true, force: false });
      result.removed.push(entry.name);
    } catch (e) {
      result.errors.push({ name: entry.name, reason: (e as NodeJS.ErrnoException)?.code ?? "could not remove" });
    }
  }

  return { ok: true, result, plan };
}
