import fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { assertUsableAsSource, assertUsableAsDestination, assertDistinct, contains } from "./paths";
import {
  CONTENT_CHECK_MAX_BYTES,
  contentReason,
  identityReason,
  type SecretRegistry,
} from "./secrets";
import type { RunLog } from "./logfile";

/**
 * The copy engine.
 *
 * Deliberately plain Node — no `robocopy`, no `rsync`, no shell. There is no command
 * string to get quoting wrong in, behaviour is identical on every platform, and the whole
 * thing stays reviewable.
 *
 * Two modes ship, neither of which deletes anything:
 *
 *   sync      — copy what's new or changed. The destination only ever grows.
 *   snapshot  — copy into a dated folder of its own, leaving previous ones alone.
 *
 * `mirror`, which deletes, is deliberately absent until the guards it needs have been
 * tested against real failures rather than unit tests. See HELPER.md.
 *
 * ## Since 0.0.2: the source may be anything
 *
 * Broad sources like `C:\` used to be refused outright. They are now allowed, and the
 * protection moved onto the files themselves — every entry is checked against the secret
 * registry (`secrets.ts`) by file identity before it is read, and small files are checked
 * again by content before they are written. That means two things for this file:
 *
 *  - **The walk streams.** A generator, not an array: `C:\` has millions of entries and
 *    materialising them all before copying the first one is both slow to start and
 *    needlessly large in memory.
 *  - **Failures are counted, not accumulated.** A drive-wide run produces a lot of
 *    "permission denied" — locked files, other users' profiles, `System Volume
 *    Information`. Keeping every one in memory is how a backup tool runs the server out
 *    of it. A capped sample is kept for the UI; the full record goes to the log file.
 */

export type CopyMode = "sync" | "snapshot";

export type CopyOptions = {
  mode: CopyMode;
  /** Names to skip entirely, matched against each entry's own name. */
  exclude?: string[];
  /** Aborts a run in progress. Checked between files, so a huge file still finishes. */
  signal?: { aborted: boolean };
  onProgress?: (p: Progress) => void;
  /**
   * The secrets to step over. Optional so the engine stays testable in isolation, but the
   * helper's real API always supplies one — a run without it protects nothing.
   */
  registry?: SecretRegistry;
  /** Where the per-file record goes. */
  log?: RunLog | null;
};

export type Progress = { filesDone: number; bytesDone: number; currentPath: string };

/** How many individual errors/skips to hand back for display. The log file has them all. */
export const MAX_RECORDED = 1000;

export type CopyPlan = {
  /** Files that would be created at the destination. */
  toCreate: string[];
  /** Files that exist at both ends but differ. */
  toUpdate: string[];
  /** Files already identical — copied by nobody, but worth reporting. */
  unchanged: number;
  /** Files that would be stepped over, and why. */
  skipped: { path: string; reason: string }[];
  totalBytes: number;
  /** Where the run would actually write. For snapshot this is the dated subfolder. */
  destination: string;
};

export type CopyResult = {
  state: "done" | "cancelled" | "failed";
  filesCopied: number;
  bytesCopied: number;
  destination: string;
  /** A capped sample of per-file failures. One unreadable file must not abandon the backup. */
  errors: { path: string; reason: string }[];
  /** The true total, which may exceed `errors.length`. */
  errorCount: number;
  /** A capped sample of files deliberately not copied, and why. */
  skipped: { path: string; reason: string }[];
  /** The true total, which may exceed `skipped.length`. */
  skippedCount: number;
};

/** A file is "the same" if size and modified time match — what every backup tool uses. */
function same(a: { size: number; mtimeMs: number }, b: { size: number; mtimeMs: number }): boolean {
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000; // FAT32 has 2s granularity
}

type Found = { rel: string; abs: string; st: Stats };
type SkipSink = (rel: string, reason: string) => void;

/**
 * Every file beneath `dir`, streamed. Symlinks are never followed, and anything the
 * registry recognises is stepped over — a protected DIRECTORY is skipped whole, so
 * `.data` costs one comparison rather than one per file inside it.
 *
 * The `stat` taken here is handed to the caller, so identity checking adds no I/O the
 * copy did not already need.
 */
async function* walkFiles(
  dir: string,
  exclude: Set<string>,
  registry: SecretRegistry | undefined,
  onSkip: SkipSink,
  base = "",
): AsyncGenerator<Found> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    // An unreadable subfolder skips; it does not abort the backup. On a drive-wide run
    // this is routine, not exceptional.
    onSkip(base || dir, `couldn't be read (${(e as NodeJS.ErrnoException)?.code ?? "unknown"})`);
    return;
  }

  for (const e of entries) {
    if (exclude.has(e.name)) continue;
    const rel = base ? path.join(base, e.name) : e.name;
    const abs = path.join(dir, e.name);

    if (e.isSymbolicLink()) continue; // never follow a link out of the source

    let st: Stats;
    try {
      st = await fsp.stat(abs);
    } catch {
      continue; // vanished, or not statable — nothing to copy
    }

    const protectedBy = registry ? identityReason(registry, st) : null;
    if (protectedBy) {
      onSkip(rel, protectedBy);
      continue;
    }

    if (st.isDirectory()) yield* walkFiles(abs, exclude, registry, onSkip, rel);
    else if (st.isFile()) yield { rel, abs, st };
  }
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
  opts: Pick<CopyOptions, "mode" | "exclude" | "registry">,
): Promise<CopyPlan> {
  const destination = resolveDestination(dest, opts.mode);
  const exclude = new Set(opts.exclude ?? []);
  const plan: CopyPlan = {
    toCreate: [],
    toUpdate: [],
    unchanged: 0,
    skipped: [],
    totalBytes: 0,
    destination,
  };

  const onSkip: SkipSink = (rel, reason) => {
    if (plan.skipped.length < MAX_RECORDED) plan.skipped.push({ path: rel, reason });
  };

  for await (const { rel, st } of walkFiles(source, exclude, opts.registry, onSkip)) {
    plan.totalBytes += st.size;
    if (opts.mode === "snapshot") {
      plan.toCreate.push(rel); // a snapshot is always a fresh copy
      continue;
    }
    try {
      const dst = await fsp.stat(path.join(destination, rel));
      if (same(st, dst)) plan.unchanged += 1;
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
export async function runCopy(source: string, dest: string, opts: CopyOptions): Promise<CopyResult> {
  const destination = resolveDestination(dest, opts.mode);
  const result: CopyResult = {
    state: "done",
    filesCopied: 0,
    bytesCopied: 0,
    destination,
    errors: [],
    errorCount: 0,
    skipped: [],
    skippedCount: 0,
    };

  const fail = (p: string, reason: string): CopyResult => ({
    ...result,
    state: "failed",
    errors: [{ path: p, reason }],
    errorCount: 1,
  });

  // Re-check against the RESOLVED destination. A caller could have passed a pair that
  // only overlaps once the dated subfolder is appended. Note the asymmetry: the source is
  // checked only for being well-formed, the destination for where it is allowed to write.
  const src = assertUsableAsSource(source);
  if (!src.ok) return fail(source, src.reason);
  const dst = assertUsableAsDestination(destination);
  if (!dst.ok) return fail(destination, dst.reason);
  const distinct = assertDistinct(source, destination);
  if (!distinct.ok) return fail(destination, distinct.reason);

  const noteSkip = (rel: string, reason: string) => {
    result.skippedCount += 1;
    if (result.skipped.length < MAX_RECORDED) result.skipped.push({ path: rel, reason });
    opts.log?.skipped(rel, reason);
  };
  const noteError = (rel: string, reason: string) => {
    result.errorCount += 1;
    if (result.errors.length < MAX_RECORDED) result.errors.push({ path: rel, reason });
    opts.log?.failed(rel, reason);
  };

  const exclude = new Set(opts.exclude ?? []);

  for await (const { rel, abs, st } of walkFiles(source, exclude, opts.registry, noteSkip)) {
    if (opts.signal?.aborted) return { ...result, state: "cancelled" };

    const to = path.join(destination, rel);

    // Belt and braces: a crafted relative path must not be able to write outside the
    // destination, however it was produced.
    if (!contains(destination, to)) {
      noteError(rel, "Refused: that would write outside the destination.");
      continue;
    }

    try {
      if (opts.mode === "sync") {
        try {
          const existing = await fsp.stat(to);
          if (same(st, existing)) continue; // already there and identical
        } catch {
          /* not at the destination yet — copy it */
        }
      }

      // Tier 2, paid for only on files actually about to be written. A verbatim copy of a
      // secret has its own identity, so tier 1 cannot see it — but its BYTES give it away.
      // Checking here rather than during the walk means an unchanged file already sitting
      // at the destination costs nothing.
      if (opts.registry && st.size <= CONTENT_CHECK_MAX_BYTES) {
        let buf: Buffer | null = null;
        try {
          buf = await fsp.readFile(abs);
        } catch {
          buf = null; // unreadable; the copy below will report it properly
        }
        if (buf) {
          const why = contentReason(opts.registry, buf);
          if (why) {
            noteSkip(rel, why);
            continue;
          }
        }
      }

      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(abs, to);
      // Carry the modified time across, or every run would think everything changed.
      await fsp.utimes(to, st.atime, st.mtime).catch(() => undefined);

      result.filesCopied += 1;
      result.bytesCopied += st.size;
      opts.log?.copied(rel, st.size);
      opts.onProgress?.({
        filesDone: result.filesCopied,
        bytesDone: result.bytesCopied,
        currentPath: rel,
      });
    } catch (e) {
      noteError(rel, (e as NodeJS.ErrnoException)?.code ?? "copy failed");
    }
  }
  return result;
}
