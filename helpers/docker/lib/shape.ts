import type { RawContainer, RawStats } from "./engine";

/**
 * Turning the engine's answers into the shapes a module sees.
 *
 * Kept apart from `engine.ts` so it is pure and testable — no socket, no platform. Every odd
 * case below was met in real output rather than imagined.
 */

/** REFS helpers/docker/api.ts */
export type ContainerState = "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "removing";

/** REFS helpers/docker/api.ts */
export type Container = {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  createdAt: string;
  ports: { private: number; public: number | null; protocol: string }[];
  project: string | null;
  service: string | null;
};

/** REFS helpers/docker/api.ts */
export type ContainerStats = {
  cpuPct: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPct: number;
};

const STATES: ContainerState[] = ["running", "exited", "paused", "restarting", "created", "dead", "removing"];

/** REFS helpers/docker/api.ts · helpers/docker/tests/shape.test.ts */
export function toContainer(r: RawContainer): Container {
  return {
    id: r.Id,
    // Docker returns names with a leading slash, and a container can have several. The first
    // is the one people recognise.
    name: (r.Names?.[0] ?? "").replace(/^\//, "") || r.Id.slice(0, 12),
    image: r.Image ?? "",
    state: STATES.includes(r.State as ContainerState) ? (r.State as ContainerState) : "dead",
    status: r.Status ?? "",
    // Health lives inside the status string ("Up 3 days (healthy)") since the list endpoint has
    // no health field — parsing prose beats an inspect call per container on every render.
    health: /\(healthy\)/i.test(r.Status ?? "")
      ? "healthy"
      : /\(unhealthy\)/i.test(r.Status ?? "")
        ? "unhealthy"
        : /health: starting/i.test(r.Status ?? "")
          ? "starting"
          : "none",
    createdAt: new Date((r.Created ?? 0) * 1000).toISOString(),
    ports: (r.Ports ?? []).map((p) => ({
      private: p.PrivatePort,
      public: p.PublicPort ?? null,
      protocol: p.Type ?? "tcp",
    })),
    project: r.Labels?.["com.docker.compose.project"] ?? null,
    service: r.Labels?.["com.docker.compose.service"] ?? null,
  };
}

/**
 * CPU percentage, the way Docker itself calculates it: the container's share of the delta in
 * total system CPU time between two samples, scaled by core count.
 *
 * Returns 0 rather than NaN when there is no previous sample — a container that started a
 * moment ago has no delta, and `NaN%` on a dashboard reads as a bug.
 * REFS helpers/docker/api.ts · helpers/docker/tests/shape.test.ts
 */
export function toStats(r: RawStats): ContainerStats {
  const cpuDelta = (r.cpu_stats?.cpu_usage?.total_usage ?? 0) - (r.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (r.cpu_stats?.system_cpu_usage ?? 0) - (r.precpu_stats?.system_cpu_usage ?? 0);
  const cores = r.cpu_stats?.online_cpus ?? 1;

  const cpuPct = sysDelta > 0 && cpuDelta > 0 ? Math.min(100, (cpuDelta / sysDelta) * cores * 100) : 0;

  const memoryBytes = r.memory_stats?.usage ?? 0;
  const memoryLimitBytes = r.memory_stats?.limit ?? 0;

  return {
    cpuPct: Math.round(cpuPct * 10) / 10,
    memoryBytes,
    memoryLimitBytes,
    // An unlimited container reports the host's whole memory as its limit, so a percentage is
    // still meaningful — but guard the zero case rather than dividing by it.
    memoryPct: memoryLimitBytes > 0 ? Math.round((memoryBytes / memoryLimitBytes) * 1000) / 10 : 0,
  };
}

/**
 * Trailing blank lines are the norm in log output and add nothing but scroll.
 * REFS helpers/docker/api.ts · helpers/docker/tests/shape.test.ts
 */
export function toLines(text: string, tail: number): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-tail);
}
