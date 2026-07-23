import path from "node:path";
import fs from "node:fs";

/**
 * Path safety. Everything this helper is ever asked to touch passes through here first.
 *
 * This file is deliberately the first thing written and the most heavily tested part of
 * the helper, because it is the only thing standing between a misconfigured backup job
 * and someone's operating system. It performs no I/O beyond `realpath`, has no
 * dependencies, and is pure enough to test exhaustively.
 *
 * Two ideas do all the work:
 *
 *   1. A path is normalised to a single canonical form BEFORE any decision is made about
 *      it. Comparing un-normalised paths is how `..`, symlinks, short names and mixed
 *      separators defeat a deny-list.
 *   2. Containment is tested on path SEGMENTS, never on string prefixes. `C:\Data` does
 *      not contain `C:\DataOld`, and a check that says otherwise will one day refuse a
 *      legitimate backup or — far worse — permit one it shouldn't.
 */

/** Windows and macOS compare paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export type PathRefusal = { ok: false; reason: string };
export type PathOk = { ok: true; path: string };
export type PathVerdict = PathOk | PathRefusal;

const refuse = (reason: string): PathRefusal => ({ ok: false, reason });

/** Fold a canonical path for comparison only. Never store or display the folded form. */
function fold(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/**
 * Canonical form: absolute, separators normalised, no trailing separator (except a root),
 * and symlinks resolved where the path already exists.
 *
 * Resolving symlinks matters: a root that passes every check can be a link pointing at
 * `C:\Windows`. We resolve the deepest part that exists, then re-append the rest, so a
 * destination that doesn't exist yet can still be judged by where it WOULD live.
 */
export function canonicalise(input: string): PathVerdict {
  if (typeof input !== "string" || input.trim() === "") return refuse("No path was given.");
  const raw = input.trim();

  // Reject before normalising: `path.resolve` would silently make these absolute against
  // the current directory, turning a typo into a valid path somewhere unexpected.
  if (!path.isAbsolute(raw)) {
    return refuse("Enter a full path, starting with a drive letter or \\\\server\\share.");
  }

  if (raw.includes("\0")) return refuse("That path contains an invalid character.");

  // UNC must be judged on the RAW input, before normalising. `path.normalize` rewrites an
  // incomplete `\\server` into `\server` — a rooted path on the CURRENT DRIVE — so a
  // mistyped share name would silently become a real folder somewhere else entirely
  // rather than an error. Decide it here, while the user's intent is still visible.
  if (/^[\\/]{2}/.test(raw)) {
    const parts = raw.slice(2).split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) {
      return refuse("Name the shared folder as well, like \\\\server\\backups.");
    }
  }

  let p = path.normalize(raw);

  // `path.normalize` resolves `..` textually. Anything left afterwards escaped the root.
  if (p.split(/[\\/]/).includes("..")) return refuse("That path is not allowed to contain “..”.");

  // Resolve symlinks on the deepest existing ancestor, then re-attach the missing tail.
  //
  // LOCAL PATHS ONLY. `realpath` on a UNC path makes Windows try to REACH THE SERVER: the
  // same check took 187ms or 5s depending on whether the failure was DNS-cached, and gave
  // a different verdict each time. Validation must be instant and deterministic, so a
  // network path is canonical from its text alone and reachability is a separate,
  // explicit question — see `probeLocation`. The escape this resolution defends against (a
  // symlink pointing at a system directory) is a local one, so nothing is given up.
  if (!isUnc(p)) {
    const tail: string[] = [];
    let probe = p;
    for (;;) {
      try {
        probe = fs.realpathSync.native(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break; // reached a root that doesn't resolve; use as-is
        tail.unshift(path.basename(probe));
        probe = parent;
      }
    }
    p = tail.length ? path.join(probe, ...tail) : probe;
  }

  // One canonical form, so `contains()` can compare two paths without special cases.
  // A drive root keeps its separator (`C:\`); everything else, including a UNC share root
  // (which `path.normalize` returns as `\\server\share\`), loses it.
  const stripped = p.replace(/[\\/]+$/, "");
  if (stripped !== "" && !/^[A-Za-z]:$/.test(stripped)) p = stripped;
  return { ok: true, path: p };
}

/**
 * True when `child` is `parent` or lives beneath it.
 *
 * Segment-aware on purpose. A naive `child.startsWith(parent)` reports that `C:\Data`
 * contains `C:\DataOld`, which would both refuse valid destinations and — in the
 * source-inside-destination check — miss real overlaps.
 */
export function contains(parent: string, child: string): boolean {
  const a = fold(parent);
  const b = fold(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A UNC path — `\\server\share\...`. Windows treats the SHARE as the path root. */
function isUnc(p: string): boolean {
  return p.startsWith("\\\\");
}

/**
 * Is this a bare drive root (`C:\`, `/`) — as opposed to a folder on one?
 *
 * UNC is excluded deliberately. Node reports `\\server\share` as its own root, so a naive
 * `path.parse(p).root === p` refuses a network share — which is precisely the destination
 * most people back up to. A share root is a location; a drive root is a whole disk.
 * `\\server` alone is caught by `isBareUncServer` instead.
 */
function isFilesystemRoot(p: string): boolean {
  if (isUnc(p)) return false;
  return path.parse(p).root === p;
}

/**
 * A UNC share root (`\\server\share`) is a legitimate backup destination — it is what a
 * NAS looks like. `\\server` alone is not: it names a machine, not a location.
 */
function isBareUncServer(p: string): boolean {
  if (!isUnc(p)) return false;
  const parts = p.slice(2).split(/[\\/]/).filter(Boolean);
  return parts.length < 2;
}

/**
 * Directories no backup may ever read from or write to, whatever an admin types.
 *
 * The install directory is first for a reason: a backup tool that can write into the app
 * is a backup tool that can replace the app, and `.data/secrets.json` inside it holds the
 * master encryption key. `process.cwd()` is the install root when the server runs.
 */
export function forbiddenRoots(installDir = process.cwd()): string[] {
  const out: string[] = [];
  const add = (p?: string) => {
    if (!p) return;
    const c = canonicalise(p);
    if (c.ok) out.push(c.path);
  };

  add(installDir);

  if (process.platform === "win32") {
    add(process.env.SystemRoot ?? "C:\\Windows");
    add(process.env.ProgramFiles ?? "C:\\Program Files");
    add(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)");
    add(process.env.ProgramData ?? "C:\\ProgramData");
  } else {
    for (const p of ["/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var"]) {
      add(p);
    }
  }
  return out;
}

/**
 * The full check. Returns the canonical path, or a refusal with a reason an admin can act
 * on — never a silently narrowed path that happens to work.
 */
export function assertUsable(input: string, installDir = process.cwd()): PathVerdict {
  const c = canonicalise(input);
  if (!c.ok) return c;
  const p = c.path;

  if (isFilesystemRoot(p)) {
    return refuse("Choose a folder rather than a whole drive — backing up a drive root is never what you want.");
  }
  if (isBareUncServer(p)) {
    return refuse("Name the shared folder as well, like \\\\server\\backups.");
  }

  for (const forbidden of forbiddenRoots(installDir)) {
    if (contains(forbidden, p)) {
      return refuse(`That location is part of the system or of JonDash itself (${forbidden}) and can't be used.`);
    }
    // Also refuse a parent OF a forbidden directory: backing up `C:\` by way of a folder
    // that contains Windows is the same mistake wearing a different hat.
    if (contains(p, forbidden)) {
      return refuse(`That folder contains a protected location (${forbidden}). Choose something narrower.`);
    }
  }
  return { ok: true, path: p };
}

/**
 * Source and destination must not overlap in either direction — a mirror whose
 * destination sits inside its source copies its own output forever, and the reverse
 * deletes the thing it is meant to protect.
 */
export function assertDistinct(source: string, dest: string): PathVerdict {
  if (contains(source, dest)) {
    return refuse("The destination is inside the source folder. Choose somewhere outside it.");
  }
  if (contains(dest, source)) {
    return refuse("The source is inside the destination folder. Choose somewhere outside it.");
  }
  return { ok: true, path: dest };
}
