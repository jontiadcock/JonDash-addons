import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import docker from "@/helpers/docker/api";
import { MODULE_PATH, STATE_TONE, type ContainerState } from "../lib/constants";

/**
 * The dashboard tile — "is everything up".
 *
 * Draws its own card: the dashboard gives a widget a grid cell and nothing else.
 *
 * **No `stats()` here, deliberately.** It costs about a second per call because Docker samples
 * CPU twice, and a dashboard renders whether or not anyone is looking at this tile. Names and
 * states are cheap; resource use belongs on the page someone opened.
 */
export default async function DockerWidget({ ctx }: ModuleWidgetProps) {
  const api = docker(ctx);
  const status = await api.status();

  if (!status.ok) {
    return (
      <div className="card flex flex-col gap-2 p-4">
        <h3 className="font-medium">Docker</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {status.reason === "no-access"
            ? "Running, but JonDash isn't allowed to talk to it."
            : status.reason === "not-running"
              ? "Not running on this server."
              : status.detail}
        </p>
        <Link href={MODULE_PATH} className="text-xs" style={{ color: "var(--primary)" }}>
          Set it up
        </Link>
      </div>
    );
  }

  const containers = await api.list();
  const running = containers.filter((c) => c.state === "running");
  // Lead with what's wrong, not with a count — an unhealthy container is the thing you need to
  // see, and "12 containers" tells you nothing at a glance.
  const unhealthy = containers.filter((c) => c.health === "unhealthy");
  const stopped = containers.filter((c) => c.state === "exited" || c.state === "dead");

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">Docker</h3>
        <Link href={MODULE_PATH} className="text-xs" style={{ color: "var(--muted)" }}>
          All
        </Link>
      </div>

      <p
        className="text-sm font-medium"
        style={{
          color:
            unhealthy.length > 0
              ? "var(--danger)"
              : stopped.length > 0
                ? "var(--warning, var(--muted))"
                : "var(--success, inherit)",
        }}
      >
        {unhealthy.length > 0
          ? `${unhealthy.length} unhealthy`
          : stopped.length > 0
            ? `${running.length} running, ${stopped.length} stopped`
            : containers.length === 0
              ? "No containers"
              : `All ${running.length} running`}
      </p>

      <ul className="flex flex-col gap-1 text-xs">
        {containers.slice(0, 6).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2">
            <span className="truncate">{c.name}</span>
            <span className="shrink-0" style={{ color: STATE_TONE[c.state as ContainerState] }}>
              {c.health === "unhealthy" ? "unhealthy" : c.state}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
