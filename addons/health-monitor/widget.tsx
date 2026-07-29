import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import { hourlyBuckets, listMonitors, openIncidentCount, type HourBucket } from "./lib/store";
import { formatAgo, formatMs, stateColour, STATE_LABEL, worstState } from "./lib/format";
import { MODULE_PATH, type MonitorRow } from "./lib/types";
import { HealthStyles, InlineStatusStrip, StatusDot } from "./ui/parts";

/**
 * The dashboard widget: a single reassuring line when everything is up, and the detail
 * only when it isn't.
 *
 * Rendering does no work beyond reading. Monitoring runs on the `scheduler` helper from
 * server start, so what you see here is the state as of the last tick — not something
 * this render just went and produced.
 *
 * # Sizing (JonDash 1.8.0 B5/B6)
 *
 * The user can make this anything from 1×1 to full width, and the frame **clips rather than
 * scrolls**. Three rules, all learned the hard way on `host-vitals`:
 *
 * 1. **Core's two thresholds** (`@[6rem]`, `@[8rem]`) decide what *kind* of content appears.
 * 2. **Every row is exactly one line**, and the list is CSS multi-column (`columns-[11rem]`) —
 *    rows fill downward, then continue in a new column. A container query reports width and never
 *    height, and multi-column is how you adapt to the axis you cannot ask about. It must be
 *    `columns`, NOT `flex-wrap`: flex column-wrap starts a new column when it runs out of height
 *    with no regard for remaining width, so columns ran off the side of the card and text was
 *    half-cut at the edge. `columns` derives the count from the width, so they always fit.
 * 3. **Priority order**, because whatever doesn't fit is clipped: anything broken comes first,
 *    so a failing monitor is never the thing that disappears.
 *
 * `MAX_ROWS = 4` is gone. A constant row count was chosen for one box size and was wrong at every
 * other — clipped when small, half-empty when large. The count now follows the container.
 */

/** See `service-control` for the reasoning: a guard against an unbounded list, not a layout size. */
const TILE_CAP = 24;
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

  // Problems first, then everything else, so the frame clipping the tail always clips a healthy
  // monitor. The cap is a guard against an unbounded list, not the old layout constant: how many
  // of these 24 you SEE still follows the container. A tile is a summary; the page is the list.
  const shown = [...problems, ...monitors.filter((m) => !problems.includes(m))].slice(0, TILE_CAP);

  // "All up" has to mean it: a monitor that has failed once but hasn't been confirmed
  // down yet is neither up nor down, and saying otherwise is the one thing a status
  // widget must never do.
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

          {/*
            `min-h-0` is what bounds this list, and without it the flex child grows to its
            content and the column-wrap never happens. `content-start` keeps the columns packed
            to the left instead of spreading across a wide tile.
          */}
          <ul className="mt-2 hidden min-h-0 flex-1 columns-[11rem] gap-x-5 gap-y-1.5 overflow-hidden @[8rem]:block">
            {shown.map((m) => (
              <li
                key={m.id}
                className="relative flex min-w-0 break-inside-avoid items-center justify-between gap-3 pb-1 text-xs"
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
