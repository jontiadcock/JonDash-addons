import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import { hourlyBuckets, listMonitors, openIncidentCount, type HourBucket } from "./lib/store";
import { formatAgo, formatMs, stateColour, STATE_LABEL, worstState } from "./lib/format";
import { MODULE_PATH, type MonitorRow } from "./lib/types";
import { HealthStyles, InlineStatusStrip, StatusDot } from "./ui/parts";

/**
 * The dashboard widget: a single reassuring line when everything is up, and the detail only
 * when it isn't. Rendering does no work beyond reading — monitoring runs on the `scheduler`
 * helper from server start, so this shows the state as of the last tick, not something this
 * render just produced.
 *
 * Resizable from 1×1 to full width, and the frame clips rather than scrolls. The container-query
 * breakpoints at 6rem and 8rem (used throughout the JSX below) decide what content appears; the
 * row layout and clip-priority rules live with `FILL_GRID` and `shown` below, not here.
 */

/** See `service-control` — a guard against an unbounded list, not a layout size. */
const TILE_CAP = 24;

/**
 * The layout that makes a list **fill** its tile instead of huddling in the top-left corner.
 * See `host-vitals/ui/widget.tsx` for the full reasoning and the two mechanisms that were wrong
 * first: a wrapping flex layout (columns ran off the side of the card) and CSS `columns` (it
 * balances, so a few rows spread one-per-column across the top and left the rest empty).
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

/** REFS addons/health-monitor/module.ts */
export default async function HealthWidget({ ctx }: ModuleWidgetProps) {
  const db = ctx.db;
  const monitors: MonitorRow[] = db ? await listMonitors(db) : [];
  const openIncidents = db ? await openIncidentCount(db) : 0;

  const strips = new Map<string, HourBucket[]>();
  if (db) {
    for (const m of monitors) strips.set(m.id, await hourlyBuckets(db, m.id, 24));
  }

  const active = monitors.filter((m) => m.enabled === 1);
  const overall = worstState(active.map((m) => m.status));
  const problems = active.filter((m) => m.status === "down" || m.status === "degraded");

  // Problems first, then everything else, so clipping the tail always clips a healthy monitor.
  // The cap only bounds the list — how many of these 24 you SEE still follows the container.
  const shown = [...problems, ...monitors.filter((m) => !problems.includes(m))].slice(0, TILE_CAP);

  // "All up" has to mean it: a monitor that failed once but isn't confirmed down yet is
  // neither — saying otherwise is the one thing a status widget must never do.
  const pending = active.filter((m) => m.status === "unknown").length;
  const summary =
    problems.length > 0
      ? `${problems.length} of ${active.length} need attention`
      : pending > 0
        ? `${active.length - pending} up · ${pending} still checking`
        : `All ${active.length} up`;

  // The 1×1 form. A dot alone says "something is wrong" without saying how much, and a
  // sentence does not fit — so the smallest useful thing is a count.
  const short = problems.length > 0 ? `${problems.length}!` : `${active.length - pending}`;

  return (
    <div className="hm card flex h-full min-w-0 flex-col overflow-hidden p-2 @[8rem]:p-4">
      <HealthStyles />

      {/* Below 6rem the name costs a whole line and the status is the point, so it waits. */}
      <div className="hidden items-center justify-between gap-2 @[6rem]:flex">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium @[8rem]:text-sm">
          <StatusDot state={overall} />
          <span className="truncate">Health</span>
        </p>
        <Link
          href={MODULE_PATH}
          className="hidden shrink-0 text-xs @[8rem]:inline"
          style={{ color: "var(--primary)" }}
        >
          open
        </Link>
      </div>

      {/* At 1×1 this is the entire widget: a dot and a number, in the worst monitor's colour. */}
      <p
        className="flex items-center gap-1.5 font-medium @[6rem]:hidden"
        style={{ color: stateColour(overall) }}
      >
        <StatusDot state={overall} size={8} />
        {/* The span matters: `truncate` on a flex CONTAINER does nothing to a bare text node
            beside it, so the count needs its own box to be truncatable at all. */}
        <span className="truncate">{short}</span>
      </p>

      {monitors.length === 0 ? (
        <p className="mt-1 hidden truncate text-xs @[6rem]:block" style={{ color: "var(--muted)" }}>
          No monitors yet — add some under Admin → Addons → Health monitoring.
        </p>
      ) : (
        <>
          <p
            className="mt-1 hidden truncate text-xs @[6rem]:block"
            style={{ color: "var(--muted)" }}
          >
            {summary}
            {openIncidents > 0 ? ` · ${openIncidents} ongoing` : ""}
          </p>

          {/* A zero minimum height is what bounds the list — without it the flex child grows
              to its content and the grid has no height to divide into rows. */}
          <div className="mt-2 hidden min-h-0 flex-1 @[8rem]:block">
            <ul className="h-full" style={FILL_GRID}>
            {shown.map((m) => (
              <li
                key={m.id}
                className="relative flex min-w-0 items-center justify-between gap-3 pb-1"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot state={m.status} size={8} />
                  <span className="truncate">{m.name}</span>
                </span>
                <span className="flex-none tabular-nums" style={{ color: "var(--muted)" }}>
                  {m.status === "down" ? (
                    <span style={{ color: stateColour("down") }}>{STATE_LABEL.down}</span>
                  ) : (
                    formatMs(m.lastLatencyMs)
                  )}
                </span>
                {/* Overlaid into the row's own bottom padding — costs no height. */}
                <InlineStatusStrip buckets={strips.get(m.id) ?? []} />
              </li>
            ))}
          </ul>
          </div>

          {problems.length > 0 ? (
            <p
              className="mt-1 hidden shrink-0 truncate text-xs @[8rem]:block"
              style={{ color: "var(--muted)" }}
            >
              {problems[0].name}: {problems[0].lastMessage ?? "no detail"} · checked{" "}
              {formatAgo(problems[0].lastCheckAt)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
