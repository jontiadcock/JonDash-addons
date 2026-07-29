import type { ReactNode } from "react";
import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import systemMetrics, { type Snapshot } from "@/helpers/system-metrics/api";
import { bytes, pct, rate, uptime, levelFor, METER, TONE, type Level } from "../lib/format";
import { collectFor } from "../lib/groups";

/**
 * The dashboard tile — "is my box OK" at a glance.
 *
 * It draws its OWN card: the dashboard gives a widget a grid cell and nothing else, so
 * without `card` and a title it would render as loose text with no name. It leads with a
 * verdict, pessimistically: a full disk or tight memory is what you need to see, not "3
 * disks". Admin-only, like the module — the paths and hostname never reach a normal user.
 *
 * # Sizing (JonDash 1.8.0 B5/B6) — this is the hard case
 *
 * Since 1.8.0 the user can size this anywhere from **1×1 to full width**, and the frame
 * **clips rather than scrolls**. This widget has up to ten rows of detail, so it had the worst
 * version of the problem in the whole add-on set: at 1×1 nearly all of it simply vanished.
 *
 * Three things fix it, and only the first is a breakpoint:
 *
 * 1. **Core's two container thresholds** (`@[6rem]`, `@[8rem]`) decide how much *kind* of
 *    content appears — verdict alone, then the header, then the detail list.
 * 2. **The `FILL_GRID` below.** The frame is `container-type: inline-size`, so a container query
 *    can ask how WIDE this widget is but never how TALL — and a 12×1 widget is both very wide and
 *    very short. The grid needs no query: `1fr` rows stretch to use whatever height there is, and
 *    flow into another column only once that height is spent. Tall and narrow gives one long
 *    list; short and wide gives several columns. See its own comment for the two mechanisms that
 *    were tried first and why each was wrong.
 * 3. **Priority order.** Whatever still doesn't fit is clipped, so the order is the design:
 *    verdict, CPU, memory, then disks **fullest first** — not mount order, because the disk
 *    that matters is the full one. Uptime is last because it is the least urgent thing here.
 *
 * There is no `.slice(0, 3)` any more. A constant row count was chosen for one box size and
 * was wrong at every other — clipped when small, half-empty when large.
 *
 * ## The one limitation, stated rather than hidden
 *
 * The detail list needs `@[8rem]`, so a **1-wide × 6-tall** widget shows only the title and the
 * verdict even though it has plenty of height going spare. That is not an oversight: with
 * `inline-size` containment, 1×1 and 1×6 are *the same width* and therefore indistinguishable,
 * and the tie has to be broken one way. It is broken in favour of 1×1 — the floor the spec names,
 * and the size at which showing a label/value list would overflow the card. A one-unit column is
 * an odd shape for a stats tile; a 1×1 that spills is a bug on every dashboard.
 *
 * **Careful with Tailwind arbitrary values here:** a class containing parentheses generates no
 * CSS in a module (see MODULE.md), so fluid sizing is written as an inline `style`.
 */

const MODULE_PATH = "/m/host-vitals";

/**
 * The layout that makes a list **fill** its tile instead of huddling in the top-left corner.
 *
 * Two earlier attempts were both wrong, and for opposite reasons:
 *
 * - **Flex `flex-wrap`** starts a new column whenever it runs out of HEIGHT, without caring
 *   whether any WIDTH is left — so columns ran off the side of the card and text was sliced.
 * - **CSS `columns`** fixed the slicing but *balances* by default, so five rows in a large tile
 *   spread themselves one-per-column across the top and left the other 90% of the card empty.
 *   It never occurred to me to check that, because I was measuring for overflow and an empty
 *   card overflows nothing. The screenshot was the thing that showed it.
 *
 * A grid does both jobs at once:
 *
 * - `gridTemplateRows: repeat(auto-fit, minmax(1.5rem, 1fr))` — as many rows as the tile's height
 *   can hold at a readable minimum, each taking an equal share of it. **`1fr` is what fills the
 *   card**: rows stretch to use the height rather than stacking at 16px and stopping.
 * - `gridAutoFlow: column` — fill downward first, then start another column. So a tall tile is
 *   one long list, and a wide short one flows sideways.
 * - `gridAutoColumns: minmax(11rem, 1fr)` — columns share the width, never narrower than legible.
 *
 * It has to be an inline style: `minmax()` and `repeat()` contain parentheses, and on the
 * versions this module supports a Tailwind class containing `(` generates no CSS at all. (Fixed
 * in JonDash 1.8.2 — but the floor here is 1.8.0-beta.14, so the class form would silently do
 * nothing for most of the people who install this.)
 */
const FILL_GRID = {
  display: "grid",
  gridAutoFlow: "column",
  gridTemplateRows: "repeat(auto-fit, minmax(1rem, 1fr))",
  gridAutoColumns: "minmax(11rem, 1fr)",
  columnGap: "1.25rem",
  overflow: "hidden",
  /*
   * The type has to scale with the tile, and this took a second pass to get right. `1fr` rows
   * share the whole height between however many readings there are, so six readings in a tall
   * card get a row each of well over 100px — and 12px text stranded in a 117px row does not look
   * generous, it looks stretched, like a table someone dragged the corner of. The row height is
   * doing the filling; the type has to keep up with it or the card reads as broken.
   *
   * `4.5cqw` ties it to the card's width, and `min(…, 5cqh)` to its height — which is the term
   * that matters, because row height comes from height, and because a very wide, very short tile
   * would otherwise compute a headline-sized font for a row 16px tall. Both units mean the card
   * only because the root declares size containment.
   */
  // The outer max() is a floor and is NOT optional: min(..., 5cqh) alone has nothing holding it
  // up, so a one-unit-high tile computed a 3.45px font — technically unclipped and completely
  // unreadable. A cap needs a floor underneath it or it is just a smaller bug.
  fontSize: "max(0.6875rem, min(clamp(0.75rem, 4.5cqw, 2rem), 5cqh))",
} as const;

/**
 * The worst thing currently true about the host, or "healthy" if nothing is wrong.
 *
 * `short` is the 1×1 form. Below `@[6rem]` there is no room for a sentence, and truncating the
 * long one to "Memory is ti…" tells you less than "94%" does.
 */
function verdict(m: Snapshot): { text: string; short: string; level: Level } {
  const fullest = m.disks.reduce<number>((max, d) => Math.max(max, d.usedPct), 0);
  if (m.memory.usedPct >= 90 && m.memory.usedPct >= fullest) {
    return {
      text: `Memory is tight — ${pct(m.memory.usedPct)} used`,
      short: pct(m.memory.usedPct),
      level: "bad",
    };
  }
  if (fullest >= 90) {
    const disk = m.disks.find((d) => d.usedPct === fullest);
    return {
      text: `${disk?.mount ?? "A disk"} is nearly full — ${pct(fullest)}`,
      short: pct(fullest),
      level: "bad",
    };
  }
  // Swap in heavy use means real memory pressure even when free memory looks fine.
  if (m.swap && m.swap.totalBytes > 0 && m.swap.usedPct >= 50) {
    return {
      text: `Swapping — ${pct(m.swap.usedPct)} of swap in use`,
      short: "Swap",
      level: "warn",
    };
  }
  if (m.battery && m.battery.status === "discharging" && (m.battery.percent ?? 100) <= 20) {
    return { text: `On battery — ${m.battery.percent}% left`, short: "Batt", level: "warn" };
  }
  if (fullest >= 75 || m.memory.usedPct >= 75) {
    return { text: "Getting busy", short: "Busy", level: "warn" };
  }
  return { text: "All healthy", short: "OK", level: "ok" };
}

/** Total throughput across interfaces, so the tile shows one number rather than a list. */
function totalNet(m: Snapshot): { rx: number; tx: number } | null {
  if (!m.networkIo || m.networkIo.length === 0) return null;
  return m.networkIo.reduce(
    (acc, n) => ({ rx: acc.rx + n.rxBytesPerSec, tx: acc.tx + n.txBytesPerSec }),
    { rx: 0, tx: 0 },
  );
}

/**
 * One reading: a muted label, the figure in the card's own text colour, and — where the reading
 * is a proportion — a slim meter along the bottom edge of the row.
 *
 * **The meter has been through three shapes and the middle one was genuinely ugly.** It began as a
 * 6px bar on its own line, which doubled the row height and pushed rows out of short tiles. So it
 * moved to a translucent fill *behind* the text, which fixed the height and looked bad: a partial
 * block at 18% opacity starting under the label reads as a stray selection highlight, not as a
 * measurement, and on a wide row it is a grey smudge with a hard edge in the middle of nowhere.
 *
 * It is now a **track and fill pinned to the bottom of the row** — the shape everyone already
 * recognises as a meter. It is absolutely positioned, so like the background fill it still costs no
 * height and short tiles stay correct; but it has a visible track, so the empty part reads as
 * "space remaining" rather than as an edge, and the label sits on plain card background where it
 * belongs.
 *
 * `min(1.5px, var(--radius-control))` rather than a hardcoded radius: the token runs from 999px on
 * Crystal to 0px on Terminal, Brutalist and Paper, which are square-cornered on purpose. A fixed
 * radius leaves rounded bars inside hard-edged cards on exactly the styles whose whole point is
 * that nothing is rounded. `min` keeps it proportional where the style is round and collapses it to
 * square where the style says square.
 */
function Row({
  label,
  usedPct,
  children,
}: {
  label: string;
  usedPct?: number;
  children: ReactNode;
}) {
  const metered = usedPct !== undefined;
  return (
    <div
      className="relative flex min-w-0 items-center justify-between gap-3"
      style={metered ? { paddingBottom: "0.35em" } : undefined}
    >
      <dt className="min-w-0 truncate" style={{ color: "var(--muted)" }}>
        {label}
      </dt>
      <dd className="shrink-0 truncate font-medium tabular-nums" style={{ color: "var(--foreground)" }}>
        {children}
      </dd>
      {metered && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            insetInline: 0,
            bottom: 0,
            height: "0.2em",
            minHeight: 2,
            background: "var(--border)",
            borderRadius: "min(1.5px, var(--radius-control))",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${Math.min(100, Math.max(0, usedPct))}%`,
              background: METER[levelFor(usedPct)],
              borderRadius: "inherit",
            }}
          />
        </span>
      )}
    </div>
  );
}

export default async function HostVitalsWidget({ ctx }: ModuleWidgetProps) {
  // Only gather what the admin left switched on — a metric turned off is never sampled.
  const settings = await ctx.settings.all();
  const m = await systemMetrics(ctx).read({ collect: collectFor(settings) });

  if (!m) {
    return (
      <div className="card flex h-full min-w-0 flex-col justify-center overflow-hidden p-2 @[8rem]:p-4">
        <p className="truncate text-xs font-medium @[8rem]:text-sm">Host vitals</p>
        <p className="mt-1 hidden truncate text-xs @[6rem]:block" style={{ color: "var(--muted)" }}>
          Host metrics are not available.
        </p>
      </div>
    );
  }

  const v = verdict(m);
  const showLoad = m.cpu.load1 !== null;
  const net = totalNet(m);
  // Fullest first: if only some disks survive the clip, they should be the ones in trouble.
  const disks = [...m.disks].sort((a, b) => b.usedPct - a.usedPct);

  return (
    // `containerType: size` makes THIS TILE the container the `cqh` units below resolve against.
    // Core keeps the dashboard frame on `inline-size` on purpose, so without this a height unit
    // would quietly measure the browser window instead of the card. Declaring it on our own root
    // confines the risk to this one widget: the root is `h-full` inside a sized grid cell, so its
    // height is definite, and if that ever stopped being true only this tile would suffer.
    <div
      className="card flex h-full min-w-0 flex-col overflow-hidden p-2 @[8rem]:p-4"
      style={{ containerType: "size" }}
    >
      {/* Below 6rem the name costs a whole line and the verdict is the point — so it waits. */}
      <div className="hidden items-center justify-between gap-2 @[6rem]:flex">
        <p className="truncate text-xs font-medium @[8rem]:text-sm">Host vitals</p>
        <Link
          href={MODULE_PATH}
          className="hidden shrink-0 text-xs @[8rem]:inline"
          style={{ color: "var(--primary)" }}
        >
          open
        </Link>
      </div>

      {/*
        The verdict is the one thing that survives at every size, down to 1×1 — and on a big card
        it is the headline, so it scales with the tile instead of staying a 14px line above a wall
        of readings. Capped against the height too, since a wide short tile has none to spare.
      */}
      <p
        className="truncate font-semibold leading-tight @[6rem]:mt-0.5"
        style={{
          color: TONE[v.level],
          fontSize: "max(0.8125rem, min(clamp(0.8125rem, 5cqw, 1.75rem), 22cqh))",
        }}
      >
        <span className="@[6rem]:hidden">{v.short}</span>
        <span className="hidden @[6rem]:inline">{v.text}</span>
      </p>

      {/*
        The wrapper owns the conditional display, the grid owns the layout. They have to be two
        elements: the grid needs `minmax()`/`repeat()`, which only an inline style can express on
        the versions this module supports, and an inline `display:grid` would override the
        `@[8rem]:block` that hides the list on a tiny tile.
      */}
      <div className="mt-2 hidden min-h-0 flex-1 @[8rem]:block">
        <dl className="h-full" style={{ ...FILL_GRID, color: "var(--muted)" }}>
        <Row label="CPU">
          {pct(m.cpu.usedPct)}
          {showLoad ? ` · ${m.cpu.load1!.toFixed(2)}` : ""}
        </Row>

        {/*
          A percentage, like every other metered reading — a row that read "14.5 GB / 31.8 GB"
          while the disks beside it read "64%" made the column look like two different tables. The
          absolute figures are still worth having, so they follow in muted text once the tile is
          wide enough to hold both without either being truncated.
        */}
        <Row label="Memory" usedPct={m.memory.usedPct}>
          {pct(m.memory.usedPct)}
          <span className="hidden font-normal @[22rem]:inline" style={{ color: "var(--muted)" }}>
            {" "}
            · {bytes(m.memory.usedBytes)} / {bytes(m.memory.totalBytes)}
          </span>
        </Row>

        {disks.map((d) => (
          <Row key={d.mount} label={d.mount} usedPct={d.usedPct}>
            {pct(d.usedPct)}
          </Row>
        ))}

        {m.swap && m.swap.totalBytes > 0 && <Row label="Swap">{pct(m.swap.usedPct)}</Row>}

        {net && (
          <Row label="Network">
            ↓ {rate(net.rx)} · ↑ {rate(net.tx)}
          </Row>
        )}

        {m.battery && (
          <Row label="Battery">
            {m.battery.percent !== null ? `${m.battery.percent}%` : "—"} · {m.battery.status}
          </Row>
        )}

        <Row label="Uptime">{uptime(m.host.uptimeSec)}</Row>
        </dl>
      </div>
    </div>
  );
}
