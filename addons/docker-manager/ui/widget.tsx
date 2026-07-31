import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import docker from "@/helpers/docker/api";
import { MODULE_PATH, STATE_TONE, type ContainerState } from "../lib/constants";

/**
 * The dashboard tile — "is everything up". Draws its own card: the dashboard gives a widget
 * only a grid cell and nothing else.
 *
 * ⚠ No `stats()` here, deliberately — it costs about a second per call since Docker samples
 * CPU twice, and the dashboard renders whether or not anyone is looking. Names and states are
 * cheap; resource use belongs on the page someone opened.
 *
 * Sizing: the frame **clips rather than scrolls** from 1×1 upward. Rows are one line each in a
 * CSS multi-column list that flows wider on a short tile, sorted unhealthy → stopped → running
 * so whatever gets clipped is always the least interesting container.
 */

/** See `service-control`: a guard against an unbounded list, not a layout size. */
const TILE_CAP = 24;

/**
 * The layout that makes a list **fill** its tile instead of huddling in the top-left corner.
 * See `host-vitals/ui/widget.tsx` for the full reasoning and the two mechanisms that were wrong
 * first: flex wrapping (columns ran off the side of the card) and CSS multi-column (it balances,
 * so a few rows spread one-per-column across the top and left the rest of the card empty).
 *
 * `1fr` rows are what fill the height; `gridAutoFlow: column` fills downward before going
 * sideways, so a tall tile is one long list and a wide short one flows into columns.
 *
 * Inline rather than Tailwind because `minmax()` and `repeat()` contain parentheses, and on the
 * versions this module supports such a class generates no CSS at all.
 */
const FILL_GRID = {
  display: "grid",
  gridAutoFlow: "column",
  gridTemplateRows: "repeat(auto-fit, minmax(1rem, 1fr))",
  gridAutoColumns: "minmax(11rem, 1fr)",
  columnGap: "1.25rem",
  overflow: "hidden",
  fontSize: "clamp(0.75rem, 1.3cqw, 1rem)",
} as const;


/** REFS addons/docker-manager/module.ts */
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

      <p className="truncate font-medium" style={{ color: tone, fontSize: "clamp(0.875rem, 4cqw, 1.75rem)" }}>
        {/* The 1×1 form: a number in the colour of the worst thing that is true. */}
        <span className="@[6rem]:hidden">
          {unhealthy.length > 0
            ? `${unhealthy.length}!`
            : stopped.length > 0
              ? `${stopped.length}`
              : running.length}
        </span>
        <span className="hidden @[6rem]:inline">
          {unhealthy.length > 0
            ? `${unhealthy.length} unhealthy`
            : stopped.length > 0
              ? `${running.length} running, ${stopped.length} stopped`
              : containers.length === 0
                ? "No containers"
                : `All ${running.length} running`}
        </span>
      </p>

      <div className="mt-2 hidden min-h-0 flex-1 @[8rem]:block">
            <ul className="h-full" style={FILL_GRID}>
        {ordered.map((c) => (
          <li key={c.id} className="flex min-w-0 items-center justify-between gap-2">
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
    </div>
  );
}
