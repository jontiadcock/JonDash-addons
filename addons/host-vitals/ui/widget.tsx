import type { ReactNode } from "react";
import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
// This widget's only host access: the system-metrics helper's read-only surface. Its shape
// (`Snapshot`) drives every row below — see helpers/system-metrics/api.ts.
import systemMetrics, { type Snapshot } from "@/helpers/system-metrics/api";
import { bytes, pct, rate, uptime, levelFor, METER, TONE, type Level } from "../lib/format";
import { collectFor } from "../lib/groups";

/**
 * The dashboard tile — "is my box OK" at a glance. Draws its OWN card (the dashboard supplies
 * only a grid cell), leads with a verdict pessimistically, admin-only like the module.
 * ⚠ Resizable 1×1 to full width (JonDash 1.8.0 B5/B6), and the frame CLIPS rather than scrolls,
 * so every size has to degrade on purpose. Three mechanisms do it: core's two container-size
 * breakpoints gate how much detail shows; `FILL_GRID` below fills both width and height (see
 * its own comment); and whatever doesn't fit is cut in priority order — verdict, CPU, memory,
 * disks fullest-first, uptime last (see the sort below).
 * ⚠ A 1-wide tile shows only the title and verdict even at full height: under container
 * `inline-size` a 1×1 and a 1×6 are the same WIDTH and so indistinguishable, and the tie is
 * broken toward the floor the spec names — not a bug to "fix" with a height rule.
 */

const MODULE_PATH = "/m/host-vitals";

/**
 * The layout that makes a list **fill** its tile instead of huddling in the top-left corner.
 * ⚠ Not flex with wrapping (runs a new column on height alone, ignoring width, so columns ran
 * off the card) and not CSS `columns` either (it *balances* by default, so five rows in a large
 * tile bunch across the top and leave most of the card empty — invisible to an overflow check,
 * since an empty card overflows nothing).
 * A grid does both jobs: `repeat(auto-fit, minmax(1rem, 1fr))` rows fill the height instead of
 * stacking and stopping, `gridAutoFlow: column` goes downward before sideways, and
 * `gridAutoColumns` keeps columns legible. Inline style, not a class — `minmax()`/`repeat()`
 * contain `(`, which generates no CSS on this module's 1.8.0 floor (fixed in 1.8.2).
 */
const FILL_GRID = {
  display: "grid",
  gridAutoFlow: "column",
  gridTemplateRows: "repeat(auto-fit, minmax(1rem, 1fr))",
  gridAutoColumns: "minmax(11rem, 1fr)",
  columnGap: "1.25rem",
  overflow: "hidden",
  /*
   * Row height varies a lot — six readings in a tall card get 100px+ rows each, and 12px text
   * stranded in one looks stretched, not generous, so type has to scale with the row height.
   * `4.5cqw` ties it to the card's width, `min(…, 5cqh)` to its height — the term that matters,
   * since row height comes from height — and both resolve against the card because the root
   * declares size containment.
   * ⚠ The outer `max()` is a floor and is NOT optional: `min(…, 5cqh)` alone has nothing to
   * hold it up, and a one-row-tall tile computed an unreadable ~3.45px font without it.
   */
  fontSize: "max(0.6875rem, min(clamp(0.75rem, 4.5cqw, 2rem), 5cqh))",
} as const;

/**
 * The worst thing currently true about the host, or "healthy" if nothing is wrong.
 *
 * `short` is the 1×1 form. Below the smaller container breakpoint there is no room for a
 * sentence, and truncating the long one to "Memory is ti…" tells you less than "94%" does.
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
 * is a proportion — a slim meter pinned to the bottom edge of the row.
 * ⚠ Absolutely positioned on purpose: on the row's own line a meter doubles the row height and
 * pushes rows out of short tiles; behind the text it reads as a stray selection highlight, not a
 * measurement. Pinned to the bottom it costs no height, still shows a visible track (so empty
 * space reads as "remaining", not an edge), and leaves the label on plain card background.
 * `min(1.5px, var(--radius-control))`, not a hardcoded radius: the token runs 999px on Crystal to
 * 0px on Terminal/Brutalist/Paper, which are square by design — `min` stays proportional where
 * the style is round and collapses to square where it says square.
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

/**
 * The entry point core renders on the dashboard.
 * REFS addons/host-vitals/module.ts › DashboardWidget · addons/host-vitals/tests/widget.test.ts
 */
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
    /*
     * `containerType: size` makes THIS TILE the container the `cqh` units below resolve
     * against. Core keeps the dashboard frame on `inline-size` on purpose, so without this a
     * height unit would quietly measure the browser window instead of the card. Declared on our
     * own root, the risk is confined to this one widget: the root fills its grid cell's full
     * height, so the height is definite, and if that ever stopped being true only this tile
     * would suffer.
     */
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
        the versions this module supports, and an inline `display:grid` would override the class
        that hides the list below the larger breakpoint.
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
