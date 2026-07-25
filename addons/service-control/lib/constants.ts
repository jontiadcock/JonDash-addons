/**
 * Ids, paths and formatting.
 *
 * Deliberately free of `server-only` and of any database import — the widget is rendered on
 * the dashboard and a stray server import here would drag the data layer into the browser
 * bundle. Same rule the other modules follow.
 */

/** Must match the folder name. Changing it later orphans the module's data. */
export const MODULE_ID = "service-control";
export const MODULE_PATH = `/m/${MODULE_ID}`;
export const ADMIN_PATH = `/admin/modules/${MODULE_ID}`;

export type ServiceState = "running" | "stopped" | "starting" | "stopping" | "unknown";

/**
 * How a state reads to a person. "unknown" is deliberately not an error tone: on a machine
 * where the service was renamed or removed it is the honest answer, and colouring it red
 * would send people hunting for a fault that is really a typo in the allowlist.
 */
export const STATE_LABEL: Record<ServiceState, string> = {
  running: "Running",
  stopped: "Stopped",
  starting: "Starting…",
  stopping: "Stopping…",
  unknown: "Not found",
};

export const STATE_TONE: Record<ServiceState, string> = {
  running: "var(--success, inherit)",
  stopped: "var(--muted)",
  starting: "var(--warning, var(--muted))",
  stopping: "var(--warning, var(--muted))",
  unknown: "var(--muted)",
};

/** Which verbs make sense right now. Offering "Start" on a running service is noise. */
export function verbsFor(state: ServiceState): ("start" | "stop" | "restart")[] {
  switch (state) {
    case "running":
      return ["restart", "stop"];
    case "stopped":
      return ["start"];
    case "starting":
    case "stopping":
      return [];
    default:
      return [];
  }
}

/** "2 hours ago". Relative, because the question is "is this recent?". */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.abs(t - now) / 1000;
  const ahead = t > now;
  const say = (n: number, unit: string) => {
    const v = Math.round(n);
    const plural = `${v} ${unit}${v === 1 ? "" : "s"}`;
    return ahead ? `in ${plural}` : `${plural} ago`;
  };
  if (s < 45) return ahead ? "in a moment" : "just now";
  if (s < 5400) return say(s / 60, "minute");
  if (s < 129600) return say(s / 3600, "hour");
  return say(s / 86400, "day");
}
