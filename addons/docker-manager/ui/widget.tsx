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
 *
 * # Sizing (JonDash 1.8.0 B5/B6)
 *
 * The user can size this from 1×1 upward and the frame **clips rather than scrolls**, so:
 * core's two thresholds decide what kind of content appears, every row is exactly one line and the
 * list is CSS multi-column, so it flows into extra columns when the tile is wide and short, and
 * rows are in priority order — unhealthy, then stopped, then running.
 *
 * `.slice(0, 6)` is gone. A constant row count was picked for one box size and was wrong at
 * every other: clipped when small, half-empty when large. With the order above, whatever the
 * frame does clip is always the least interesting container.
 */
/** See `service-control`: a guard against an unbounded list, not a layout size. */
const TILE_CAP = 24;

export default async function DockerWidget({ ctx }: ModuleWidgetProps) {
  const api = docker(ctx);
  const status = await api.status();

  if (!status.ok) {
    return (
      <div className="card flex h-full min-w-0 flex-col justify-center overflow-hidden p-2 @[8rem]:p-4">
        {/* At 1×1 "Docker" truncates to "Dock…", which says nothing. A dash says "nothing to
            report here" in the space actually available. */}
        <p className="truncate font-medium @[6rem]:hidden" style={{ color: "var(--muted)" }}>
          —
        </p>
        <h3 className="hidden truncate text-xs font-medium @[6rem]:block @[8rem]:text-sm">Docker</h3>
        <p className="mt-1 hidden truncate text-xs @[6rem]:block" style={{ color: "var(--muted)" }}>
          {status.reason === "no-access"
            ? "Running, but JonDash isn't allowed to talk to it."
            : status.reason === "not-running"
              ? "Not running on this server."
              : status.detail}
        </p>
        <Link
          href={MODULE_PATH}
          className="mt-1 hidden truncate text-xs @[8rem]:inline"
          style={{ color: "var(--primary)" }}
        >
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

  // Same reasoning applied to the ROW ORDER, now that the frame decides how many rows survive.
  const rest = containers.filter(
    (c) => !unhealthy.includes(c) && !stopped.includes(c),
  );
  const ordered = [...unhealthy, ...stopped, ...rest].slice(0, TILE_CAP);

  const tone =
    unhealthy.length > 0
      ? "var(--danger)"
      : stopped.length > 0
        ? "var(--warning, var(--muted))"
        : "var(--success, inherit)";

  return (
    <div className="card flex h-full min-w-0 flex-col overflow-hidden p-2 @[8rem]:p-4">
      <div className="hidden items-baseline justify-between gap-2 @[6rem]:flex">
        <h3 className="truncate text-xs font-medium @[8rem]:text-sm">Docker</h3>
        <Link
          href={MODULE_PATH}
          className="hidden shrink-0 text-xs @[8rem]:inline"
          style={{ color: "var(--muted)" }}
        >
          All
        </Link>
      </div>

      <p className="truncate font-medium" style={{ color: tone }}>
        {/* The 1×1 form: a number in the colour of the worst thing that is true. */}
        <span className="@[6rem]:hidden">
          {unhealthy.length > 0
            ? `${unhealthy.length}!`
            : stopped.length > 0
              ? `${stopped.length}`
              : running.length}
        </span>
        <span className="hidden text-xs @[6rem]:inline @[8rem]:text-sm">
          {unhealthy.length > 0
            ? `${unhealthy.length} unhealthy`
            : stopped.length > 0
              ? `${running.length} running, ${stopped.length} stopped`
              : containers.length === 0
                ? "No containers"
                : `All ${running.length} running`}
        </span>
      </p>

      <ul className="mt-2 hidden min-h-0 flex-1 columns-[11rem] gap-x-5 gap-y-1 overflow-hidden text-xs @[8rem]:block">
        {ordered.map((c) => (
          <li key={c.id} className="flex min-w-0 break-inside-avoid items-center justify-between gap-2">
            <span className="truncate">{c.name}</span>
            <span
              className="shrink-0"
              style={{ color: STATE_TONE[c.state as ContainerState] }}
            >
              {c.health === "unhealthy" ? "unhealthy" : c.state}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
