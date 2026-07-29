import type { ReactNode } from "react";
import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import systemMetrics, { type Snapshot } from "@/helpers/system-metrics/api";
import { bytes, pct, rate, uptime, levelFor, TONE, type Level } from "../lib/format";
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
 * 2. **`flex-col flex-wrap` on the detail list.** The frame is `container-type: inline-size`,
 *    so a container query can ask how WIDE this widget is but never how TALL — and a 12×1
 *    widget is both very wide and very short. Column-wrap needs no query: rows fill downward
 *    until they run out of height, then start a new column. Tall and narrow gives one column;
 *    short and wide gives several. It adapts to the dimension CSS won't let us ask about.
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
 * One label/value line, optionally with a usage level shown as a fill BEHIND the text.
 *
 * The fill used to be a separate 6px bar under the row, and that turned out to be the thing
 * that broke short widgets: it made a disk row 26px tall and the memory row 46px, so in a
 * 6×1 widget — where the whole list gets about 19px — those rows spilled straight out of the
 * card while the plain one-line rows fitted. Behind the text instead, **every row is exactly
 * one line tall**, which makes the column-wrap below predictable at any shape and costs no
 * information: width still reads as "how full", colour still reads as "how worried".
 *
 * `min(3px, var(--radius-control))` rather than a hardcoded 3: the radius token runs from
 * 999px on Crystal to 0px on Terminal, Brutalist and Paper, which are square-cornered on
 * purpose. A fixed 3px left rounded fills sitting inside hard-edged cards on exactly the
 * styles whose whole point is that nothing is rounded. `min` keeps it proportional on round
 * styles while collapsing to square where the style says square.
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
  return (
    <div className="relative flex min-w-0 items-center justify-between gap-3">
      {usedPct !== undefined && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            insetBlock: 0,
            insetInlineStart: 0,
            width: `${Math.min(100, Math.max(0, usedPct))}%`,
            background: TONE[levelFor(usedPct)],
            // Low enough that body text stays readable on every palette, high enough to read
            // as a level at a glance. The colour is doing the talking, not the saturation.
            opacity: 0.18,
            borderRadius: "min(3px, var(--radius-control))",
          }}
        />
      )}
      <dt className="relative truncate">{label}</dt>
      <dd className="relative shrink-0 truncate tabular-nums">{children}</dd>
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
    <div className="card flex h-full min-w-0 flex-col overflow-hidden p-2 @[8rem]:p-4">
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

      {/* The verdict is the one thing that survives at every size, down to 1×1. */}
      <p
        className="truncate font-medium @[6rem]:mt-1"
        style={{ color: TONE[v.level], fontSize: "clamp(0.75rem, 8cqw, 0.875rem)" }}
      >
        <span className="@[6rem]:hidden">{v.short}</span>
        <span className="hidden @[6rem]:inline">{v.text}</span>
      </p>

      {/*
        `flex-col flex-wrap` with a bounded height is what makes this fit without a height
        query: rows stack downward, and when they run out of room they start a new column
        instead of being clipped. `min-h-0` is what bounds it — without that the flex child
        grows to its content and the wrap never happens.
      */}
      <dl
        className="mt-2 hidden min-h-0 flex-1 flex-col flex-wrap content-start gap-x-5 gap-y-1.5 overflow-hidden text-xs @[8rem]:flex"
        style={{ color: "var(--muted)" }}
      >
        <Row label="CPU">
          {pct(m.cpu.usedPct)}
          {showLoad ? ` · ${m.cpu.load1!.toFixed(2)}` : ""}
        </Row>

        <Row label="Memory" usedPct={m.memory.usedPct}>
          {bytes(m.memory.usedBytes)} / {bytes(m.memory.totalBytes)}
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
  );
}
