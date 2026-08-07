import { execFile } from "node:child_process";
import { platform } from "node:os";

/**
 * Reading service state. This is the only part of the helper that needs no privilege at
 * all — querying a service is something any user may do — so the dashboard stays useful
 * even on a machine where no grant has ever been created.
 *
 * Every call here uses `execFile` with an ARGUMENT ARRAY, never `exec` with a string.
 * That is not style: `exec` hands the string to a shell, so a service name is one `&` away
 * from being a command. Service names come from an admin-owned allowlist rather than from a
 * module, which makes that unlikely — but "unlikely" is not the standard for something that
 * would turn a read-only query into arbitrary execution.
 */

/** REFS helpers/host-services/api.ts · helpers/host-services/lib/enumerate.ts */
export type ServiceState = "running" | "stopped" | "starting" | "stopping" | "unknown";

/** Long enough for a slow SCM, short enough that a hung query can't wedge a page. */
const TIMEOUT_MS = 5000;

function run(file: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      // Non-zero exit is normal here — `sc query` on a missing service and `systemctl is-active`
      // on a stopped one both exit non-zero with useful output — exit code picks the fallback.
      resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/**
 * Windows: `sc query` prints `STATE : 4 RUNNING`. Match on the NUMBER, not the word — the
 * word is localised and the number is not. A dashboard that reads "unknown" on a German
 * Windows would be a real bug found only by someone running one.
 */
function parseScState(out: string): ServiceState {
  const m = /STATE\s*:\s*(\d+)/i.exec(out);
  if (!m) return "unknown";
  switch (Number(m[1])) {
    case 1:
      return "stopped";
    case 2:
      return "starting"; // START_PENDING
    case 3:
      return "stopping"; // STOP_PENDING
    case 4:
      return "running";
    case 5: // CONTINUE_PENDING
    case 6: // PAUSE_PENDING
    case 7: // PAUSED
      return "stopping";
    default:
      return "unknown";
  }
}

function parseSystemctlState(out: string): ServiceState {
  const s = out.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (s === "active") return "running";
  if (s === "inactive" || s === "failed") return "stopped";
  if (s === "activating") return "starting";
  if (s === "deactivating") return "stopping";
  return "unknown";
}

/**
 * Current state of ONE service, by its real name.
 *
 * Callers must resolve the name against the allowlist first. This function will happily
 * query anything it is given — the confinement lives in `api.ts`, deliberately in one
 * place, so there is exactly one thing to get right rather than one per call site.
 */
export async function readState(serviceName: string): Promise<ServiceState> {
  if (!serviceName.trim()) return "unknown";

  if (platform() === "win32") {
    const { out } = await run("sc.exe", ["query", serviceName]);
    // "does not exist as an installed service" — report unknown rather than inventing
    // "stopped", which would read as "it's there and it's off".
    if (/1060|does not exist/i.test(out)) return "unknown";
    return parseScState(out);
  }

  if (platform() === "linux") {
    const { out } = await run("systemctl", ["is-active", serviceName]);
    return parseSystemctlState(out);
  }

  return "unknown";
}

/**
 * States for several services at once. Failures degrade to `unknown`, never throw.
 * REFS helpers/host-services/api.ts · helpers/host-services/lib/scopes.ts ·
 *      helpers/host-services/ui/settings-panel.tsx
 */
export async function readStates(serviceNames: string[]): Promise<Map<string, ServiceState>> {
  const pairs = await Promise.all(
    serviceNames.map(async (n) => {
      try {
        return [n, await readState(n)] as const;
      } catch {
        return [n, "unknown" as ServiceState] as const;
      }
    }),
  );
  return new Map(pairs);
}

/** Whether this platform can control services at all. */
export function platformSupported(): boolean {
  return platform() === "win32" || platform() === "linux";
}
