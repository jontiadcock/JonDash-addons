import fsp from "node:fs/promises";
import path from "node:path";
import { assertUsable } from "./paths";

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

  // Never probe somewhere we would refuse anyway — that would reach out to a system
  // directory or an unreachable host just to say "no".
  const verdict = assertUsable(input);
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
    const code = (e as NodeJS.ErrnoException)?.code;
    return done({
      ok: false,
      exists: false,
      writable: false,
      message:
        code === "ENOENT"
          ? "That folder doesn't exist. Create it first, or check the spelling."
          : code === "EACCES" || code === "EPERM"
            ? "That folder exists, but JonDash isn't allowed to open it."
            : `Couldn't open that folder (${code ?? "unknown error"}).`,
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
          : "The folder exists, but JonDash can't write to it. Check the permissions on it.",
    });
  }
}
