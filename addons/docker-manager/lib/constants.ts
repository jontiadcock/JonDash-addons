/**
 * Ids, paths and formatting. No `server-only` and no data imports — the widget renders on the
 * dashboard, and one stray server import here drags the data layer into the browser bundle.
 */

/** REFS addons/docker-manager/actions.ts */
export const MODULE_ID = "docker-manager";
/** REFS addons/docker-manager/actions.ts · addons/docker-manager/ui/widget.tsx */
export const MODULE_PATH = `/m/${MODULE_ID}`;
/** REFS addons/docker-manager/actions.ts */
export const ADMIN_PATH = `/admin/modules/${MODULE_ID}`;

/**
 * The package id JonDash installs when Docker is missing.
 * REFS addons/docker-manager/actions.ts · addons/docker-manager/ui/settings-panel.tsx ·
 *      addons/docker-manager/ui/setup.tsx
 */
export const DOCKER_PACKAGE = "Docker.DockerDesktop";

/** REFS addons/docker-manager/page.tsx · addons/docker-manager/ui/widget.tsx */
export type ContainerState = "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "removing";

/** REFS addons/docker-manager/page.tsx */
export const STATE_LABEL: Record<ContainerState, string> = {
  running: "Running",
  exited: "Stopped",
  paused: "Paused",
  restarting: "Restarting",
  created: "Created",
  dead: "Dead",
  removing: "Removing",
};

/** REFS addons/docker-manager/page.tsx · addons/docker-manager/ui/widget.tsx */
export const STATE_TONE: Record<ContainerState, string> = {
  running: "var(--success, inherit)",
  exited: "var(--muted)",
  paused: "var(--warning, var(--muted))",
  restarting: "var(--warning, var(--muted))",
  created: "var(--muted)",
  dead: "var(--danger)",
  removing: "var(--muted)",
};

/**
 * Which actions make sense right now. Offering Start on a running container is noise, and
 * offering Unpause on one that isn't paused invites an error the person cannot act on.
 * REFS addons/docker-manager/page.tsx
 */
export function verbsFor(state: ContainerState): ("start" | "stop" | "restart" | "pause" | "unpause")[] {
  switch (state) {
    case "running":
      return ["restart", "pause", "stop"];
    case "paused":
      return ["unpause", "stop"];
    case "exited":
    case "created":
    case "dead":
      return ["start"];
    default:
      return [];
  }
}

/** REFS addons/docker-manager/page.tsx */
export function bytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * "3 days ago" — the question people ask of a container is "how long has this been up".
 * REFS addons/docker-manager/page.tsx
 */
export function since(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
