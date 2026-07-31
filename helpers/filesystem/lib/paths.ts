import path from "node:path";
import fs from "node:fs";

/**
 * Path safety — everything this helper is asked to touch passes through here first. It
 * performs no I/O beyond `realpath`, has no dependencies, and is pure enough to test
 * exhaustively, which is deliberate: this is the only thing standing between a
 * misconfigured backup job and someone's operating system.
 *
 * PINS helpers/filesystem/tests/paths.test.ts
 */

/** Windows and macOS compare paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export type PathRefusal = { ok: false; reason: string };
export type PathOk = { ok: true; path: string };
/** REFS helpers/filesystem/lib/roots.ts */
export type PathVerdict = PathOk | PathRefusal;

const refuse = (reason: string): PathRefusal => ({ ok: false, reason });

/** Fold a canonical path for comparison only. Never store or display the folded form. */
function fold(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/**
 * Canonical form: absolute, separators normalised, no trailing separator (except a root),
 * symlinks resolved where the path already exists. A path is normalised BEFORE any
 * decision is made about it — comparing un-normalised paths is how `..`, symlinks, short
 * names and mixed separators defeat a deny-list.
 * Resolving matters: a root that passes every check can be a link pointing at `C:\Windows`.
 * Resolve the deepest existing part, then re-append the rest, so a destination that doesn't
 * exist yet is still judged by where it WOULD live.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/tests/paths.test.ts ·
 *      helpers/filesystem/tests/probe.test.ts
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

  // Judged on the RAW input: `path.normalize` turns an incomplete `\\server` into `\server`
  // (a path on the CURRENT DRIVE), so a mistyped share must be caught before normalising.
  if (/^[\\/]{2}/.test(raw)) {
    const parts = raw.slice(2).split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) {
      return refuse("Name the shared folder as well, like \\\\server\\backups.");
    }
  }

  let p = path.normalize(raw);

  // `path.normalize` resolves `..` textually. Anything left afterwards escaped the root.
  if (p.split(/[\\/]/).includes("..")) return refuse("That path is not allowed to contain “..”.");

  // ⚠ LOCAL PATHS ONLY. `realpath` on a UNC path makes Windows try to reach the server —
  // slow and inconsistent. A network path is canonical from its text; see `probeLocation`.
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

  // One canonical form, so `contains()` never special-cases a trailing separator: a drive
  // root keeps its own (`C:\`); a UNC share root and everything else loses it.
  const stripped = p.replace(/[\\/]+$/, "");
  if (stripped !== "" && !/^[A-Za-z]:$/.test(stripped)) p = stripped;
  return { ok: true, path: p };
}

/**
 * True when `child` is `parent` or lives beneath it. Segment-aware on purpose — a naive
 * `child.startsWith(parent)` reports that `C:\Data` contains `C:\DataOld`, which would
 * both refuse valid destinations and, in the source-inside-destination check, miss overlaps.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/copy.ts ·
 *      helpers/filesystem/lib/prune.ts · helpers/filesystem/lib/risk.ts ·
 *      helpers/filesystem/tests/paths.test.ts
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
 * Is this a bare drive root (`C:\`, `/`) — as opposed to a folder on one? UNC is excluded
 * deliberately: Node reports `\\server\share` as its own root, so a naive
 * `path.parse(p).root === p` would refuse a network share, precisely the destination most
 * people back up to. `\\server` alone (no share) is caught by `isBareUncServer` instead.
 *
 * REFS helpers/filesystem/lib/risk.ts
 */
export function isFilesystemRoot(p: string): boolean {
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
 * Directories a backup may never WRITE into, whatever an admin types. Reading is governed
 * separately, by the secret registry (`lib/secrets.ts`), which excludes secrets by file
 * identity — so a SOURCE may be as broad as `C:\` and JonDash's key still never leaves.
 *
 * ⚠ A backup tool that can write into the app is a backup tool that can REPLACE the app —
 * overwrite `modules/`, drop something into `.next`, and the next restart runs it. That is
 * why this list is absolute rather than merely warned about. `process.cwd()` is the
 * install root when the server runs.
 */
export function writeForbiddenRoots(installDir = process.cwd()): string[] {
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
 * Rules shared by both directions: a path must be real, absolute and unambiguous before
 * anyone asks what it is allowed to do.
 */
function assertWellFormed(input: string): PathVerdict {
  const c = canonicalise(input);
  if (!c.ok) return c;
  if (isBareUncServer(c.path)) {
    return refuse("Name the shared folder as well, like \\\\server\\backups.");
  }
  return c;
}

/**
 * A folder to READ from. Deliberately permissive — a drive root or JonDash's own folder are
 * both allowed, because protection lives on the FILES, not the location.
 *
 * ⚠ Refusing broad folders would protect a *location*, which relocating the data directory
 * walks straight around. `lib/secrets.ts` excludes the live secrets by file identity instead,
 * wherever they move; `lib/risk.ts` tells the admin what a broad choice actually contains.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/admin.ts ·
 *      helpers/filesystem/lib/copy.ts · helpers/filesystem/lib/probe.ts ·
 *      helpers/filesystem/lib/roots.ts · helpers/filesystem/tests/paths.test.ts
 */
export function assertUsableAsSource(input: string): PathVerdict {
  return assertWellFormed(input);
}

/**
 * A folder to WRITE into. Stricter, and not negotiable. A drive root IS allowed — `E:\` is
 * what an external backup disk looks like — but anywhere writing could alter this machine
 * rather than merely fill it (JonDash's own directory, the operating system) stays refused;
 * see `writeForbiddenRoots` for the exact list.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/copy.ts ·
 *      helpers/filesystem/lib/prune.ts · helpers/filesystem/tests/paths.test.ts ·
 *      helpers/filesystem/tests/probe.test.ts
 */
export function assertUsableAsDestination(input: string, installDir = process.cwd()): PathVerdict {
  const c = assertWellFormed(input);
  if (!c.ok) return c;
  const p = c.path;

  for (const forbidden of writeForbiddenRoots(installDir)) {
    if (contains(forbidden, p)) {
      return refuse(
        `Backups can't be written into ${forbidden} — that's JonDash's own folder or part of the system. Choose somewhere else.`,
      );
    }
    // Also refuse a parent OF a forbidden directory: writing to `C:\` by way of a folder
    // that contains Windows is the same mistake wearing a different hat.
    if (contains(p, forbidden)) {
      return refuse(`That folder contains ${forbidden}, which backups can't write into. Choose something narrower.`);
    }
  }
  return { ok: true, path: p };
}

/**
 * Source and destination must not overlap in either direction — a mirror whose destination
 * sits inside its source copies its own output forever, and the reverse deletes the thing
 * it is meant to protect.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/copy.ts ·
 *      helpers/filesystem/tests/paths.test.ts
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
