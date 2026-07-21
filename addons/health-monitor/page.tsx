import Link from "next/link";
import type { ModulePageProps } from "@/lib/modules/types";
import { ensureRunning } from "./lib/scheduler";
import { lastConfigError } from "./lib/config";
import {
  getMonitor,
  hourlyBuckets,
  listIncidents,
  listMonitors,
  recentResults,
  uptimeWindow,
  type HourBucket,
} from "./lib/store";
import { formatAgo, formatDuration, formatMs, formatUptime, stateColour, STATE_LABEL } from "./lib/format";
import type { MonitorRow } from "./lib/types";
import { HealthStyles, Sparkline, Stat, StatusDot, StatusStrip } from "./ui/parts";

/**
 * The module's own page at /m/health-monitor — the list, and one monitor's detail at
 * /m/health-monitor/<id>. Read-only until the framework gives modules a way to handle
 * form submissions; configuration happens in the module's settings for now.
 */
export default async function HealthPage({ ctx, path }: ModulePageProps) {
  await ensureRunning(ctx);
  const db = ctx.db;
  if (!db) {
    return <p className="text-sm" style={{ color: "var(--muted)" }}>The module has no database handle.</p>;
  }

  const monitorId = path[0];
  if (monitorId) {
    const monitor = await getMonitor(db, monitorId);
    if (!monitor) {
      return (
        <div className="hm flex flex-col gap-3">
          <HealthStyles />
          <Link href="/m/health-monitor" className="text-sm" style={{ color: "var(--muted)" }}>
            ← Health
          </Link>
          <p className="text-sm">That monitor no longer exists.</p>
        </div>
      );
    }
    return <MonitorDetail ctx={ctx} monitor={monitor} />;
  }

  const monitors = await listMonitors(db);
  const configError = await lastConfigError(ctx);
  const strips = new Map<string, HourBucket[]>();
  const uptimes = new Map<string, string>();
  for (const m of monitors) {
    strips.set(m.id, await hourlyBuckets(db, m.id, 24));
    const stats = await uptimeWindow(db, m.id, 24);
    uptimes.set(m.id, formatUptime(stats.uptimePct, stats.checks));
  }

  return (
    <div className="hm flex flex-col gap-6">
      <HealthStyles />
      <section>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Health monitoring</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {monitors.length} monitor{monitors.length === 1 ? "" : "s"} · configured under Admin → Modules →
          Health monitoring
        </p>
      </section>

      {configError ? (
        <div className="card p-3 text-sm" style={{ borderColor: "var(--danger)" }}>
          <span style={{ color: "var(--danger)" }}>Configuration not applied:</span> {configError}
        </div>
      ) : null}

      {monitors.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Nothing is being monitored yet. Add monitors in the module&apos;s settings.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {monitors.map((m) => (
            <li key={m.id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link href={`/m/health-monitor/${m.id}`} className="flex items-center gap-2 font-medium">
                    <StatusDot state={m.status} />
                    <span className="truncate">{m.name}</span>
                  </Link>
                  <p className="mt-0.5 truncate text-xs" style={{ color: "var(--muted)" }}>
                    {m.kind} · {m.target}
                    {m.port ? `:${m.port}` : ""}
                  </p>
                </div>
                <div className="flex-none text-right">
                  <p className="text-sm" style={{ color: stateColour(m.status) }}>
                    {STATE_LABEL[m.status]}
                  </p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {formatMs(m.lastLatencyMs)} · {uptimes.get(m.id)} 24h
                  </p>
                </div>
              </div>
              <div className="mt-3">
                <StatusStrip buckets={strips.get(m.id) ?? []} height={18} maxWidth={460} />
              </div>
              {m.lastMessage ? (
                <p className="mt-2 truncate text-xs" style={{ color: "var(--muted)" }}>
                  {m.lastMessage} · {formatAgo(m.lastCheckAt)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function MonitorDetail({ ctx, monitor }: { ctx: ModulePageProps["ctx"]; monitor: MonitorRow }) {
  const db = ctx.db!;
  const [day, week, month] = await Promise.all([
    uptimeWindow(db, monitor.id, 24),
    uptimeWindow(db, monitor.id, 24 * 7),
    uptimeWindow(db, monitor.id, 24 * 30),
  ]);
  const buckets = await hourlyBuckets(db, monitor.id, 24);
  const recent = await recentResults(db, monitor.id, 60);
  const incidents = await listIncidents(db, monitor.id, 10);
  // A failed check has no latency; Number(null) is 0, which would draw a false floor
  // across the chart, so drop the nulls rather than plotting them as zero.
  const trend = recent
    .slice()
    .reverse()
    .filter((r) => r.latencyMs !== null && r.latencyMs !== undefined)
    .map((r) => Number(r.latencyMs))
    .filter((v) => Number.isFinite(v));

  return (
    <div className="hm flex flex-col gap-6">
      <HealthStyles />
      <section>
        <Link href="/m/health-monitor" className="text-sm" style={{ color: "var(--muted)" }}>
          ← Health
        </Link>
        <h1 className="mb-1 mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <StatusDot state={monitor.status} size={12} />
          {monitor.name}
        </h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {monitor.kind} · {monitor.target}
          {monitor.port ? `:${monitor.port}` : ""} · checked {formatAgo(monitor.lastCheckAt)}
        </p>
        {monitor.runbook ? (
          <p className="mt-1 text-sm">
            <span style={{ color: "var(--muted)" }}>Runbook: </span>
            {monitor.runbook}
          </p>
        ) : null}
      </section>

      <section className="card p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Now" value={STATE_LABEL[monitor.status]} hint={monitor.lastMessage ?? undefined} />
          <Stat label="Uptime 24h" value={formatUptime(day.uptimePct, day.checks)} hint={`${day.checks} checks`} />
          <Stat label="Uptime 7d" value={formatUptime(week.uptimePct, week.checks)} />
          <Stat label="Uptime 30d" value={formatUptime(month.uptimePct, month.checks)} />
          <Stat label="Response" value={formatMs(day.avgMs)} hint={`p95 ${formatMs(day.p95Ms)}`} />
        </div>
        <div className="mt-4">
          <StatusStrip buckets={buckets} height={22} maxWidth={520} />
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Last 24 hours, one bar per hour
          </p>
        </div>
        <div className="mt-4">
          <Sparkline values={trend} />
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Response time over the last {trend.length} checks
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold tracking-tight">Incidents</h2>
        {incidents.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No incidents recorded.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {incidents.map((i) => (
              <li key={i.id} className="card flex items-start justify-between gap-4 p-3 text-sm">
                <span className="min-w-0">
                  <span style={{ color: i.endedAt ? "var(--muted)" : stateColour("down") }}>
                    {i.endedAt ? "Resolved" : "Ongoing"}
                  </span>{" "}
                  · {new Date(i.startedAt).toLocaleString()}
                  <span className="block truncate text-xs" style={{ color: "var(--muted)" }}>
                    {i.reason ?? "no detail"}
                  </span>
                </span>
                <span className="flex-none text-xs" style={{ color: "var(--muted)" }}>
                  {i.endedAt ? formatDuration(i.durationSec) : formatAgo(i.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold tracking-tight">Recent checks</h2>
        <ul className="flex flex-col gap-1">
          {recent.slice(0, 20).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <StatusDot state={r.state} size={6} />
                <span className="truncate" style={{ color: "var(--muted)" }}>
                  {r.message ?? r.state}
                </span>
              </span>
              <span className="flex-none" style={{ color: "var(--muted)" }}>
                {formatMs(r.latencyMs)} · {formatAgo(r.ts)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
