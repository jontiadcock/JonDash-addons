import fsp from "node:fs/promises";
import path from "node:path";
import { assertUsable, assertDistinct, contains } from "./paths";

/**
 * The copy engine.
 *
 * Deliberately plain Node — no `robocopy`, no `rsync`, no shell. There is no command
 * string to get quoting wrong in, behaviour is identical on every platform, and the whole
 * thing stays reviewable.
 *
 * Two modes ship first, neither of which deletes anything:
 *
 *   sync      — copy what's new or changed. The destination only ever grows.
 *   snapshot  — copy into a dated folder of its own, leaving previous ones alone.
 *
 * `mirror`, which deletes, is deliberately absent until the guards it needs have been
 * tested against real failures rather than unit tests. See HELPER.md.
 */

export type CopyMode = "sync" | "snapshot";

export type CopyOptions = {
  mode: CopyMode;
  /** Names to skip entirely, matched against each entry's own name. */
  exclude?: string[];
  /** Aborts a run in progress. Checked between files, so a huge file still finishes. */
  signal?: { aborted: boolean };
  onProgress?: (p: Progress) => void;
};

export type Progress = { filesDone: number; bytesDone: number; currentPath: string };

export type CopyPlan = {
  /** Files that would be created at the destination. */
  toCreate: string[];
  /** Files that exist at both ends but differ. */
  toUpdate: string[];
  /** Files already identical — copied by nobody, but worth reporting. */
  unchanged: number;
  totalBytes: number;
  /** Where the run would actually write. For snapshot this is the dated subfolder. */
  destination: string;
};

export type CopyResult = {
  state: "done" | "cancelled" | "failed";
  filesCopied: number;
  bytesCopied: number;
  destination: string;
  /** Per-file failures. One unreadable file must not abandon the whole backup. */
  errors: { path: string; reason: string }[];
};

/** A file is "the same" if size and modified time match — what every backup tool uses. */
function same(a: { size: number; mtimeMs: number }, b: { size: number; mtimeMs: number }): boolean {
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000; // FAT32 has 2s granularity
}

/** Every file beneath `dir`, as paths relative to it. Symlinks are never followed. */
async function walk(dir: string, exclude: Set<string>, base = ""): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // an unreadable subfolder skips, it does not abort the backup
  }
  const out: string[] = [];
  for (const e of entries) {
    if (exclude.has(e.name)) continue;
    const rel = base ? path.join(base, e.name) : e.name;
    if (e.isSymbolicLink()) continue; // never follow a link out of the source
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), exclude, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Where a run will write. `snapshot` gets its own dated folder; `sync` writes in place. */
export function resolveDestination(dest: string, mode: CopyMode, now = new Date()): string {
  if (mode !== "snapshot") return dest;
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return path.join(dest, stamp);
}

/**
 * A dry run: exactly what a real run would do, without doing any of it. This is what the
 * admin sees before pressing the button, and what makes a surprise impossible.
 */
export async function planCopy(
  source: string,
  dest: string,
  opts: Pick<CopyOptions, "mode" | "exclude">,
): Promise<CopyPlan> {
  const destination = resolveDestination(dest, opts.mode);
  const exclude = new Set(opts.exclude ?? []);
  const files = await walk(source, exclude);

  const plan: CopyPlan = { toCreate: [], toUpdate: [], unchanged: 0, totalBytes: 0, destination };
  for (const rel of files) {
    const from = path.join(source, rel);
    let src;
    try {
      src = await fsp.stat(from);
    } catch {
      continue;
    }
    plan.totalBytes += src.size;
    if (opts.mode === "snapshot") {
      plan.toCreate.push(rel); // a snapshot is always a fresh copy
      continue;
    }
    try {
      const dst = await fsp.stat(path.join(destination, rel));
      if (same(src, dst)) plan.unchanged += 1;
      else plan.toUpdate.push(rel);
    } catch {
      plan.toCreate.push(rel);
    }
  }
  return plan;
}

/**
 * Run the copy. Returns rather than throws for per-file problems: a single locked file
 * must not cost you the other ten thousand.
 */
export async function runCopy(
  source: string,
  dest: string,
  opts: CopyOptions,
): Promise<CopyResult> {
  const destination = resolveDestination(dest, opts.mode);
  const result: CopyResult = {
    state: "done",
    filesCopied: 0,
    bytesCopied: 0,
    destination,
    errors: [],
  };

  // Re-check containment against the RESOLVED destination. A caller could have passed a
  // pair that only overlaps once the dated subfolder is appended.
  for (const p of [source, destination]) {
    const v = assertUsable(p);
    if (!v.ok) return { ...result, state: "failed", errors: [{ path: p, reason: v.reason }] };
  }
  const distinct = assertDistinct(source, destination);
  if (!distinct.ok) {
    return { ...result, state: "failed", errors: [{ path: destination, reason: distinct.reason }] };
  }

  const exclude = new Set(opts.exclude ?? []);
  const files = await walk(source, exclude);

  for (const rel of files) {
    if (opts.signal?.aborted) return { ...result, state: "cancelled" };

    const from = path.join(source, rel);
    const to = path.join(destination, rel);

    // Belt and braces: a crafted relative path must not be able to write outside the
    // destination, however it was produced.
    if (!contains(destination, to)) {
      result.errors.push({ path: rel, reason: "Refused: that would write outside the destination." });
      continue;
    }

    try {
      const src = await fsp.stat(from);
      if (opts.mode === "sync") {
        try {
          const dst = await fsp.stat(to);
          if (same(src, dst)) continue; // already there and identical
        } catch {
          /* not at the destination yet — copy it */
        }
      }
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      // Carry the modified time across, or every run would think everything changed.
      await fsp.utimes(to, src.atime, src.mtime).catch(() => undefined);

      result.filesCopied += 1;
      result.bytesCopied += src.size;
      opts.onProgress?.({
        filesDone: result.filesCopied,
        bytesDone: result.bytesCopied,
        currentPath: rel,
      });
    } catch (e) {
      result.errors.push({ path: rel, reason: (e as NodeJS.ErrnoException)?.code ?? "copy failed" });
    }
  }
  return result;
}
