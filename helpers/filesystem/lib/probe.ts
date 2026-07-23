import fsp from "node:fs/promises";
import path from "node:path";
import { assertUsableAsSource } from "./paths";

/**
 * "Test this location" — the explicit check an admin runs before saving a root.
 *
 * Kept apart from `assertUsable` on purpose. Validation is textual, instant and
 * deterministic; this touches the disk and may block for seconds on an unreachable share,
 * so it only ever runs because somebody pressed a button and is waiting for the answer.
 * Nothing on a save path, a render, or a scheduled tick may call it implicitly.
 *
 * It answers the two questions that actually go wrong in practice — *is it there?* and
 * *can I write to it?* — and it answers them by trying, not by reading permission bits,
 * because a network share will happily report rights it won't honour.
 */

export type ProbeResult = {
  ok: boolean;
  /** One sentence an admin can act on. Populated whether or not it succeeded. */
  message: string;
  exists: boolean;
  writable: boolean;
  /** How long the check took. A slow share is worth surfacing before it's used nightly. */
  elapsedMs: number;
};

/** Long enough for a sleeping USB disk to spin up; short enough not to feel broken. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Turn an OS error code into something an admin can act on.
 *
 * Added in 0.0.2 after live testing surfaced `Couldn't open that folder (UNKNOWN).` for an
 * unreachable share. `UNKNOWN` is what Windows returns when it cannot resolve a UNC host —
 * which is both the single most likely failure for a backup destination and, as a message,
 * completely useless. Anything reaching the admin should say what to check next.
 */
export function explainCode(code: string | undefined, isNetwork: boolean, verb: "open" | "write"): string {
  switch (code) {
    case "ENOENT":
      return isNetwork
        ? "That shared folder wasn't found. Check the server name and the share name are spelled correctly."
        : "That folder doesn't exist. Create it first, or check the spelling.";
    case "EACCES":
    case "EPERM":
      return verb === "write"
        ? "That folder exists, but JonDash isn't allowed to write to it. Check the permissions on the folder."
        : "That folder exists, but JonDash isn't allowed to open it. Check the permissions on the folder.";
    // Windows reports an unreachable UNC host as UNKNOWN; the network codes are what
    // POSIX and resolved-but-unreachable hosts give.
    case "UNKNOWN":
    case "ENOTFOUND":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ETIMEDOUT":
    case "ENETDOWN":
      return isNetwork
        ? "Couldn't reach that network location. Check the server is switched on, the name is right, and that this machine is signed in to it."
        : "Couldn't reach that location. If it's a removable drive, check it's plugged in.";
    case "ENOTDIR":
      return "Part of that path is a file, not a folder.";
    case "EBUSY":
      return "That folder is in use by another program.";
    case "ENOSPC":
      return "There's no space left at that location.";
    case "EROFS":
      return "That location is read-only.";
    case "ENAMETOOLONG":
      return "That path is too long for this system.";
    case "EINVAL":
      return "That path isn't valid on this system. Check for characters a folder name can't contain.";
    default:
      return verb === "write"
        ? `Couldn't write to that folder${code ? ` (${code})` : ""}.`
        : `Couldn't open that folder${code ? ` (${code})` : ""}.`;
  }
}

function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms).unref?.(),
    ),
  ]);
}

/**
 * @param wantWritable destinations must be writable; a source only needs reading.
 */
export async function probeLocation(
  input: string,
  { wantWritable = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
): Promise<ProbeResult> {
  const started = Date.now();
  const done = (r: Omit<ProbeResult, "elapsedMs">): ProbeResult => ({
    ...r,
    elapsedMs: Date.now() - started,
  });

  const isNetwork = /^[\\/]{2}/.test(input.trim());

  // Only that the path is well-formed. Since 0.0.2 a source may be anywhere, so this no
  // longer rejects broad or system locations — it just declines to reach out on behalf of
  // something that isn't a real path.
  const verdict = assertUsableAsSource(input);
  if (!verdict.ok) {
    return done({ ok: false, message: verdict.reason, exists: false, writable: false });
  }
  const target = verdict.path;

  let exists = false;
  try {
    const stat = await timeout(fsp.stat(target), timeoutMs);
    if (!stat.isDirectory()) {
      return done({ ok: false, message: "That path is a file, not a folder.", exists: true, writable: false });
    }
    exists = true;
  } catch (e) {
    const why = (e as Error)?.message;
    if (why === "TIMEOUT") {
      return done({
        ok: false,
        exists: false,
        writable: false,
        message: `Couldn't reach that location within ${Math.round(timeoutMs / 1000)} seconds. If it's a network share, check the machine is on and you're signed in to it.`,
      });
    }
    return done({
      ok: false,
      exists: false,
      writable: false,
      message: explainCode((e as NodeJS.ErrnoException)?.code, isNetwork, "open"),
    });
  }

  if (!wantWritable) {
    return done({ ok: true, message: "Folder found and readable.", exists, writable: false });
  }

  // Prove writability by writing. A network share often reports rights it won't honour,
  // and finding that out nightly at 2am is exactly what this button is for.
  const marker = path.join(target, `.jondash-write-test-${process.pid}-${Date.now()}`);
  try {
    await timeout(fsp.writeFile(marker, "jondash write test"), timeoutMs);
    await fsp.rm(marker, { force: true });
    return done({ ok: true, message: "Folder found, and JonDash can write to it.", exists, writable: true });
  } catch (e) {
    const why = (e as Error)?.message;
    await fsp.rm(marker, { force: true }).catch(() => undefined);
    return done({
      ok: false,
      exists,
      writable: false,
      message:
        why === "TIMEOUT"
          ? "The folder answered, but writing to it timed out. It may be very slow or briefly disconnected."
          : explainCode((e as NodeJS.ErrnoException)?.code, isNetwork, "write"),
    });
  }
}
