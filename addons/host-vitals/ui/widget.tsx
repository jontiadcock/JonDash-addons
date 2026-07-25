import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import systemMetrics, { type Snapshot } from "@/helpers/system-metrics/api";
import { bytes, pct, rate, uptime, levelFor, TONE, type Level } from "../lib/format";
import { collectFor } from "../lib/groups";

/**
 * The dashboard tile — "is my box OK" at a glance.
 *
 * It draws its OWN card: the dashboard gives a widget a grid cell and nothing else, so
 * without `card p-4` and a title it would render as loose text with no name. It leads with a
 * verdict, pessimistically: a full disk or tight memory is what you need to see, not "3
 * disks". Admin-only, like the module — the paths and hostname never reach a normal user.
 */

const MODULE_PATH = "/m/host-vitals";

/** The worst thing currently true about the host, or "healthy" if nothing is wrong. */
function verdict(m: Snapshot): { text: string; level: Level } {
  const fullest = m.disks.reduce<number>((max, d) => Math.max(max, d.usedPct), 0);
  if (m.memory.usedPct >= 90 && m.memory.usedPct >= fullest) {
    return { text: `Memory is tight — ${pct(m.memory.usedPct)} used`, level: "bad" };
  }
  if (fullest >= 90) {
    const disk = m.disks.find((d) => d.usedPct === fullest);
    return { text: `${disk?.mount ?? "A disk"} is nearly full — ${pct(fullest)}`, level: "bad" };
  }
  // Swap in heavy use means real memory pressure even when free memory looks fine.
  if (m.swap && m.swap.totalBytes > 0 && m.swap.usedPct >= 50) {
    return { text: `Swapping — ${pct(m.swap.usedPct)} of swap in use`, level: "warn" };
  }
  if (m.battery && m.battery.status === "discharging" && (m.battery.percent ?? 100) <= 20) {
    return { text: `On battery — ${m.battery.percent}% left`, level: "warn" };
  }
  if (fullest >= 75 || m.memory.usedPct >= 75) {
    return { text: "Getting busy", level: "warn" };
  }
  return { text: "All healthy", level: "ok" };
}

/** Total throughput across interfaces, so the tile shows one number rather than a list. */
function totalNet(m: Snapshot): { rx: number; tx: number } | null {
  if (!m.networkIo || m.networkIo.length === 0) return null;
  return m.networkIo.reduce(
    (acc, n) => ({ rx: acc.rx + n.rxBytesPerSec, tx: acc.tx + n.txBytesPerSec }),
    { rx: 0, tx: 0 },
  );
}

/** A slim usage bar that follows the app theme. */
function Bar({ usedPct }: { usedPct: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: "100%",
        height: 6,
        borderRadius: 3,
        background: "var(--border)",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          display: "block",
          height: "100%",
          width: `${Math.min(100, Math.max(0, usedPct))}%`,
          background: TONE[levelFor(usedPct)],
        }}
      />
    </span>
  );
}

export default async function HostVitalsWidget({ ctx }: ModuleWidgetProps) {
  // Only gather what the admin left switched on — a metric turned off is never sampled.
  const settings = await ctx.settings.all();
  const m = await systemMetrics(ctx).read({ collect: collectFor(settings) });

  if (!m) {
    return (
      <div className="card p-4">
        <p className="font-medium">Host vitals</p>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Host metrics are not available.
        </p>
      </div>
    );
  }

  const v = verdict(m);
  const showLoad = m.cpu.load1 !== null;
  const net = totalNet(m);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">Host vitals</p>
        <Link href={MODULE_PATH} className="text-sm" style={{ color: "var(--primary)" }}>
          open
        </Link>
      </div>

      <p className="mt-1 text-sm font-medium" style={{ color: TONE[v.level] }}>
        {v.text}
      </p>

      <dl className="mt-3 flex flex-col gap-2 text-xs" style={{ color: "var(--muted)" }}>
        <div className="flex items-center justify-between gap-3">
          <dt>CPU</dt>
          <dd>
            {pct(m.cpu.usedPct)}
            {showLoad ? ` · load ${m.cpu.load1!.toFixed(2)}` : ""}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <dt>Memory</dt>
            <dd>
              {bytes(m.memory.usedBytes)} / {bytes(m.memory.totalBytes)} · {pct(m.memory.usedPct)}
            </dd>
          </div>
          <Bar usedPct={m.memory.usedPct} />
        </div>
        {m.swap && m.swap.totalBytes > 0 && (
          <div className="flex items-center justify-between gap-3">
            <dt>Swap</dt>
            <dd>
              {bytes(m.swap.usedBytes)} / {bytes(m.swap.totalBytes)} · {pct(m.swap.usedPct)}
            </dd>
          </div>
        )}
        {m.disks.slice(0, 3).map((d) => (
          <div key={d.mount} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <dt className="truncate">{d.mount}</dt>
              <dd>{pct(d.usedPct)}</dd>
            </div>
            <Bar usedPct={d.usedPct} />
          </div>
        ))}
        {net && (
          <div className="flex items-center justify-between gap-3">
            <dt>Network</dt>
            <dd>
              ↓ {rate(net.rx)} · ↑ {rate(net.tx)}
            </dd>
          </div>
        )}
        {m.battery && (
          <div className="flex items-center justify-between gap-3">
            <dt>Battery</dt>
            <dd>
              {m.battery.percent !== null ? `${m.battery.percent}%` : "—"} · {m.battery.status}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <dt>Uptime</dt>
          <dd>{uptime(m.host.uptimeSec)}</dd>
        </div>
      </dl>

      {m.disks.length > 3 && (
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          and {m.disks.length - 3} more disk{m.disks.length - 3 === 1 ? "" : "s"} — see the page
        </p>
      )}
    </div>
  );
}
