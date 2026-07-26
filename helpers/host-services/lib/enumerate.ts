import { execFile } from "node:child_process";
import type { ServiceState } from "./services";

/**
 * Every service on this machine, for the admin's picker.
 *
 * **This is admin-only and must never be re-exported from `api.ts`.** A module cannot discover
 * what runs on the host — that is both a scoping decision and a privacy one, and it is stated
 * as an absence in the API's own docblock. This file exists because CORE-10's `browse` is
 * called by CORE on an admin screen, behind `assertSameOrigin()` + `requirePermission
 * ("modules.manage")`, with no module anywhere in the path.
 *
 * **Needs no elevation.** Measured on Windows 11 from a non-elevated process: `Get-Service`
 * returned all 327 services with their states, and `sc query type= service state= all` exited
 * 0. Only start/stop/restart need the grant. That is what makes `browse` affordable — and
 * `browse` is what stops an admin reaching for "everything" because typing exact service names
 * is tedious.
 */

const TIMEOUT_MS = 8000;
/** Enough to find anything by typing two or three characters; short enough to stay a list. */
const MAX_RESULTS = 40;

export type HostService = { name: string; display: string; state: ServiceState };

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (_err, stdout, stderr) => resolve(`${stdout ?? ""}${stderr ?? ""}`),
    );
  });
}

/**
 * Windows. Parsed from `sc query`, whose records are separated by blank lines and whose
 * STATE line is matched on the NUMBER — the word is localised, the number is not.
 */
function parseSc(out: string): HostService[] {
  const services: HostService[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const name = /SERVICE_NAME:\s*(\S.*?)\s*$/im.exec(block)?.[1];
    if (!name) continue;
    const display = /DISPLAY_NAME:\s*(\S.*?)\s*$/im.exec(block)?.[1] ?? name;
    const code = Number(/STATE\s*:\s*(\d+)/i.exec(block)?.[1] ?? 0);
    const state: ServiceState =
      code === 4 ? "running" : code === 1 ? "stopped" : code === 2 ? "starting" : code === 3 ? "stopping" : "unknown";
    services.push({ name, display, state });
  }
  return services;
}

/** systemd. `--plain --no-legend` gives `unit load active sub description`. */
function parseSystemctl(out: string): HostService[] {
  const services: HostService[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\S+\.service)\s+\S+\s+(\S+)\s+\S+\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].replace(/\.service$/, "");
    const active = m[2].toLowerCase();
    services.push({
      name,
      display: m[3]?.trim() || name,
      state: active === "active" ? "running" : active === "activating" ? "starting" : "stopped",
    });
  }
  return services;
}

/**
 * Services matching what the admin typed, newest-irrelevant, capped.
 *
 * Returns [] rather than throwing on any failure: core's contract says a failing `browse`
 * shows the manual add field, never an error page. An admin who cannot browse can still type.
 */
export async function findServices(query: string): Promise<HostService[]> {
  const q = query.trim().toLowerCase();

  let all: HostService[] = [];
  try {
    all =
      process.platform === "win32"
        ? parseSc(await run("sc.exe", ["query", "type=", "service", "state=", "all"]))
        : parseSystemctl(await run("systemctl", ["list-units", "--type=service", "--all", "--plain", "--no-legend"]));
  } catch {
    return [];
  }

  const matched = q
    ? all.filter((s) => s.name.toLowerCase().includes(q) || s.display.toLowerCase().includes(q))
    : all;

  // An exact name first, then name matches, then display-name matches. Someone who typed a
  // service name exactly should not have to hunt for it below five description matches.
  matched.sort((a, b) => {
    const rank = (s: HostService) =>
      s.name.toLowerCase() === q ? 0 : s.name.toLowerCase().startsWith(q) ? 1 : s.name.toLowerCase().includes(q) ? 2 : 3;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return matched.slice(0, MAX_RESULTS);
}
