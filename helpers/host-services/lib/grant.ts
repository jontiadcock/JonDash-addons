import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { isSafeBase, taskNameFor, type Verb } from "./names";

/**
 * The bridge to core's grant manager (OPS-18).
 *
 * A grant is a fixed OS-level permission: a Scheduled Task on Windows with "run with
 * highest privileges", a sudoers/polkit rule on Linux. Creating one prompts for elevation
 * ONCE. Using one never prompts, survives restarts of JonDash and of the machine, and works
 * with nobody logged in — which is what makes overnight automation possible at all.
 *
 * The rule the whole design rests on, from ../ELEVATION.md:
 *
 *   A granted action must be entirely self-contained. It must never read what to do from
 *   anywhere.
 *
 * The task stores the absolute path to `sc.exe` and a fixed service and verb. `schtasks
 * /run` accepts only a task name and cannot pass arguments, so what can happen without a
 * prompt is fixed at the instant the admin approved it, and enforced by Windows rather than
 * by this code. A task that read its action from a file would be a local privilege
 * escalation for every process on the machine.
 *
 * NOTE: the grant manager binary does not exist yet — core has accepted it as OPS-18 but
 * not shipped it. Everything here is written to that contract and reports
 * `grant-manager-missing` until it lands, which is why `capability()` exists and why no
 * call in this file silently degrades to something weaker.
 */

/** Why elevation is impossible here. Named separately so callers can switch on it. */
export type ElevationReason = "no-interactive-session" | "grant-manager-missing" | "unsupported-platform";

export type ElevationSupport = { ok: true; platform: "windows" | "linux" } | { ok: false; reason: ElevationReason };

/**
 * `cancelled-at-uac` and `failed` are separate on purpose, and so is `unavailable`. They
 * mean different things to a caller: "not now" invites a retry, "it broke" invites a look
 * at the detail, and "there is no grant" needs the admin to create one. Collapsing them
 * into a boolean is how a module ends up retrying a decision the admin already made.
 */
export type GrantOutcome =
  | { status: "ok" }
  | { status: "cancelled-at-uac" }
  | { status: "unavailable"; reason: ElevationReason }
  | { status: "failed"; detail: string };

/** Windows returns this when the user dismisses the UAC prompt. */
const ERROR_CANCELLED = 1223;

const TIMEOUT_MS = 120_000; // a UAC prompt waits on a human

/**
 * Where the binary lives: shipped inside the release, versioned with the app, resolved
 * relative to the install root rather than hardcoded. A grant it creates must never
 * reference this binary — the task points at `sc.exe` — or an app update would break every
 * existing grant.
 */
export function grantManagerPath(): string {
  const name = platform() === "win32" ? "jondash-grant.exe" : "jondash-grant";
  return join(process.cwd(), "bin", name);
}

/**
 * Can this installation create grants?
 *
 * Needs no capability to call: a module must be able to explain itself on a headless box
 * without having been granted anything.
 *
 * Note the asymmetry, which is easy to get backwards — CREATING a grant needs an
 * interactive desktop because that is where UAC prompts; USING one does not. A headless
 * install can therefore run grants made earlier but cannot make new ones.
 */
export function capability(): ElevationSupport {
  const p = platform();
  if (p !== "win32" && p !== "linux") return { ok: false, reason: "unsupported-platform" };
  if (!existsSync(grantManagerPath())) return { ok: false, reason: "grant-manager-missing" };
  if (!hasInteractiveSession()) return { ok: false, reason: "no-interactive-session" };
  return { ok: true, platform: p === "win32" ? "windows" : "linux" };
}

/**
 * Best-effort detection of a desktop that could show a prompt.
 *
 * Deliberately best-effort: Session 0 isolation cannot be detected reliably from Node, so
 * the authority is the grant manager itself, which refuses and says why. This exists to
 * give a useful answer BEFORE prompting rather than to be the safety check.
 */
function hasInteractiveSession(): boolean {
  if (platform() === "linux") return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  // A Windows service runs in Session 0 with no desktop. SESSIONNAME is set for interactive
  // logons ("Console", "RDP-Tcp#0") and absent under most service hosts.
  return Boolean(process.env.SESSIONNAME);
}

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(grantManagerPath(), args, { timeout: TIMEOUT_MS, windowsHide: false }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out });
    });
  });
}

/**
 * Create the grants for one allowlist entry — all its verbs behind a SINGLE elevation.
 *
 * Batching by arguments is safe and batching by file is not: `--create-from <file>` would
 * reintroduce the mutable instruction source the whole design excludes. Three separate
 * prompts to add one service would also train the admin to click through them, which is the
 * habituation this model exists to avoid; prompts two and three carry no new information,
 * because the decision actually being made is "may JonDash control this service".
 */
export async function createGrants(serviceName: string, taskBase: string, verbs: Verb[]): Promise<GrantOutcome> {
  const support = capability();
  if (!support.ok) return { status: "unavailable", reason: support.reason };
  if (!isSafeBase(taskBase)) return { status: "failed", detail: "unsafe task name" };

  const args = ["--create", "--service", serviceName, "--base", taskBase];
  for (const v of verbs) args.push("--verb", v);

  const { code, out } = await run(args);
  if (code === 0) return { status: "ok" };
  if (code === ERROR_CANCELLED) return { status: "cancelled-at-uac" };
  return { status: "failed", detail: out || `grant manager exited ${code}` };
}

/**
 * Remove an entry's grants.
 *
 * Removing an allowlist entry and removing its grants are ONE action, never two — a list
 * entry that disappears while the OS grant survives is exactly the orphan nobody audits.
 * `--remove` is idempotent, so a retry after a partial failure is safe.
 */
export async function removeGrants(taskBase: string, verbs: Verb[]): Promise<GrantOutcome> {
  const support = capability();
  if (!support.ok) return { status: "unavailable", reason: support.reason };

  const args = ["--remove", "--base", taskBase];
  for (const v of verbs) args.push("--verb", v);

  const { code, out } = await run(args);
  if (code === 0) return { status: "ok" };
  if (code === ERROR_CANCELLED) return { status: "cancelled-at-uac" };
  return { status: "failed", detail: out || `grant manager exited ${code}` };
}

/**
 * Run an already-granted action. **This does not elevate and does not prompt** — it asks
 * the OS to run a task that was authorised earlier, which is the entire point of the model.
 *
 * `schtasks /run` takes only a task name; there is no way to pass an argument, and that is
 * what makes the grant's scope enforceable by Windows rather than by convention.
 */
export async function runGrant(taskBase: string, verb: Verb): Promise<GrantOutcome> {
  if (!isSafeBase(taskBase)) return { status: "failed", detail: "unsafe task name" };

  if (platform() === "win32") {
    return new Promise((resolve) => {
      execFile(
        "schtasks.exe",
        ["/run", "/tn", taskNameFor(taskBase, verb)],
        { timeout: 30_000, windowsHide: true },
        (err, stdout, stderr) => {
          const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
          if (!err) return resolve({ status: "ok" });
          // The task not existing means the grant was never made, or was removed outside
          // JonDash — reported as unavailable rather than failed, because the fix is to
          // re-grant it, not to retry the action.
          if (/cannot find|does not exist|ERROR: The system cannot find/i.test(out)) {
            return resolve({ status: "unavailable", reason: "grant-manager-missing" });
          }
          resolve({ status: "failed", detail: out || "schtasks failed" });
        },
      );
    });
  }

  if (platform() === "linux") {
    return new Promise((resolve) => {
      execFile(
        "sudo",
        ["-n", "systemctl", verb, taskBase],
        { timeout: 30_000 },
        (err, stdout, stderr) => {
          const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
          if (!err) return resolve({ status: "ok" });
          // `sudo -n` never prompts. A password demand here means the sudoers rule is gone.
          if (/password is required|a terminal is required/i.test(out)) {
            return resolve({ status: "unavailable", reason: "grant-manager-missing" });
          }
          resolve({ status: "failed", detail: out || "systemctl failed" });
        },
      );
    });
  }

  return { status: "unavailable", reason: "unsupported-platform" };
}
