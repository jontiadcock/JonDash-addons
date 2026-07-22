import Link from "next/link";
import type { ModulePageProps } from "@/lib/modules/types";
import {
  getMonitor,
  hourlyBuckets,
  listIncidents,
  listMonitors,
  recentResults,
  uptimeWindow,
  type HourBucket,
} from "./lib/store";
import { formatAgo, formatDuration, formatMs, formatUptime, stateColour, STATE_LABEL, worstState } from "./lib/format";
import { KIND_CHOICES } from "./lib/forms";
import { ADMIN_PATH, MODULE_PATH, type MonitorRow } from "./lib/types";
import { HealthStyles, Sparkline, Stat, StatusDot, StatusStrip } from "./ui/parts";

/**
 * The module's pages, split so that looking and changing are different places:
 *
 *   /m/health-monitor                → what's up and what isn't. Display only.
 *   /m/health-monitor/monitor/<id>   → one check's history and outages. Display only.
 *
 * Nothing on a display page changes anything, so a dashboard can be left open without a
 * misplaced click reconfiguring the monitoring.
 */
export default async function HealthPage({ ctx, path }: ModulePageProps) {
  const db = ctx.db;
  if (!db) {
    return <p className="text-sm" style={{ color: "var(--muted)" }}>The module has no database.</p>;
  }

  if (path[0] === "monitor" && path[1]) {
    const monitor = await getMonitor(db, path[1]);
    if (!monitor) return <NotFound />;
    return <MonitorDetail ctx={ctx} monitor={monitor} />;
  }

  return <Overview ctx={ctx} />;
}

function NotFound() {
  return (
    <div className="hm flex flex-col gap-3">
      <HealthStyles />
      <Link href={MODULE_PATH} className="text-sm" style={{ color: "var(--muted)" }}>← Health</Link>
      <p className="text-sm">That check no longer exists.</p>
    </div>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm" style={{ color: "var(--muted)" }}>
      {label}
    </Link>
  );
}

/* ---------------------------------------------------------- display: overview */

async function Overview({ ctx }: { ctx: ModulePageProps["ctx"] }) {
  const db = ctx.db!;
  const monitors = await listMonitors(db);

  const strips = new Map<string, HourBucket[]>();
  const uptimes = new Map<string, string>();
  for (const m of monitors) {
    strips.set(m.id, await hourlyBuckets(db, m.id, 24));
    const stats = await uptimeWindow(db, m.id, 24);
    uptimes.set(m.id, formatUptime(stats.uptimePct, stats.checks));
  }

  const active = monitors.filter((m) => m.enabled === 1);
  const overall = worstState(active.map((m) => m.status));
  const problems = active.filter((m) => m.status === "down" || m.status === "degraded");
  const pending = active.filter((m) => m.status === "unknown").length;

  return (
    <div className="hm flex flex-col gap-6">
      <HealthStyles />

      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <StatusDot state={overall} size={12} />
            Health monitoring
          </h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {monitors.length === 0
              ? "No checks set up yet."
              : problems.length > 0
                ? `${problems.length} of ${active.length} need attention.`
                : pending > 0
                  ? `${active.length - pending} up, ${pending} still checking.`
                  : `All ${active.length} up.`}
          </p>
        </div>
        <Link href={ADMIN_PATH} className="btn btn-ghost">
          Manage checks
        </Link>
      </section>

      {monitors.length === 0 ? (
        <div className="card p-4 text-sm">
          <p className="font-medium">Nothing is being watched yet</p>
          <p className="mt-1" style={{ color: "var(--muted)" }}>
            Add your first check — a website, a device that answers a ping, a port, a domain name or an
            SSL certificate.
          </p>
          <p className="mt-3">
            <Link href={ADMIN_PATH} className="btn btn-primary">
              Add a check
            </Link>
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {monitors.map((m) => (
            <li key={m.id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link
                    href={`${MODULE_PATH}/monitor/${m.id}`}
                    className="flex items-center gap-2 font-medium"
                  >
                    <StatusDot state={m.enabled === 1 ? m.status : "unknown"} />
                    <span className="truncate">{m.name}</span>
                  </Link>
                  <p className="mt-0.5 truncate text-xs" style={{ color: "var(--muted)" }}>
                    {kindLabel(m)} · {m.target}
                    {m.port ? `:${m.port}` : ""}
                  </p>
                </div>
                <div className="flex-none text-right">
                  <p className="text-sm" style={{ color: stateColour(m.status) }}>
                    {m.enabled === 1 ? STATE_LABEL[m.status] : "Paused"}
                  </p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {formatMs(m.lastLatencyMs)} · {uptimes.get(m.id)} today
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

function kindLabel(m: MonitorRow): string {
  return KIND_CHOICES.find((k) => k.value === m.kind)?.label ?? m.kind;
}

/* ------------------------------------------------------------ display: detail */

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
  const trend = recent
    .slice()
    .reverse()
    .filter((r) => r.latencyMs !== null && r.latencyMs !== undefined)
    .map((r) => Number(r.latencyMs))
    .filter((v) => Number.isFinite(v));

  return (
    <div className="hm flex flex-col gap-6">
      <HealthStyles />
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <BackLink href={MODULE_PATH} label="← Health" />
          <h1 className="mb-1 mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <StatusDot state={monitor.enabled === 1 ? monitor.status : "unknown"} size={12} />
            {monitor.name}
          </h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {kindLabel(monitor)} · {monitor.target}
            {monitor.port ? `:${monitor.port}` : ""} · checked {formatAgo(monitor.lastCheckAt)}
          </p>
          {monitor.runbook ? (
            <p className="mt-1 text-sm">
              <span style={{ color: "var(--muted)" }}>Note: </span>
              {monitor.runbook}
            </p>
          ) : null}
        </div>
        <Link href={ADMIN_PATH} className="btn btn-ghost">
          Change this check
        </Link>
      </section>

      <section className="card p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Now" value={monitor.enabled === 1 ? STATE_LABEL[monitor.status] : "Paused"} hint={monitor.lastMessage ?? undefined} />
          <Stat label="Uptime today" value={formatUptime(day.uptimePct, day.checks)} hint={`${day.checks} checks`} />
          <Stat label="Last 7 days" value={formatUptime(week.uptimePct, week.checks)} />
          <Stat label="Last 30 days" value={formatUptime(month.uptimePct, month.checks)} />
          <Stat label="Typical response" value={formatMs(day.avgMs)} hint={`slowest 5% over ${formatMs(day.p95Ms)}`} />
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
        <h2 className="mb-2 text-lg font-semibold tracking-tight">Outages</h2>
        {incidents.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            None recorded — it hasn&apos;t gone down since you started watching it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {incidents.map((i) => (
              <li key={i.id} className="card flex items-start justify-between gap-4 p-3 text-sm">
                <span className="min-w-0">
                  <span style={{ color: i.endedAt ? "var(--muted)" : stateColour("down") }}>
                    {i.endedAt ? "Recovered" : "Still down"}
                  </span>{" "}
                  · started {new Date(i.startedAt).toLocaleString()}
                  <span className="block truncate text-xs" style={{ color: "var(--muted)" }}>
                    {i.reason ?? "no detail"}
                  </span>
                </span>
                <span className="flex-none text-xs" style={{ color: "var(--muted)" }}>
                  {i.endedAt ? `down for ${formatDuration(i.durationSec)}` : formatAgo(i.startedAt)}
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
