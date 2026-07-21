import Link from "next/link";
import type { ModulePageProps } from "@/lib/modules/types";
import { ensureRunning } from "./lib/scheduler";
import { lastConfigError } from "./lib/config";
import {
  getMonitor,
  hourlyBuckets,
  listChannels,
  listIncidents,
  listMonitors,
  recentResults,
  routeIdsFor,
  parseConfig,
  uptimeWindow,
  type HourBucket,
} from "./lib/store";
import { formatAgo, formatDuration, formatMs, formatUptime, stateColour, STATE_LABEL, worstState } from "./lib/format";
import { CHANNEL_CHOICES } from "./lib/forms";
import { MODULE_PATH, type ChannelRow, type MonitorRow } from "./lib/types";
import { HealthStyles, Sparkline, Stat, StatusDot, StatusStrip } from "./ui/parts";
import { ActionForm, Field } from "./ui/form";
import { MonitorFields } from "./ui/monitor-fields";
import {
  checkNowAction,
  deleteChannelAction,
  deleteMonitorAction,
  importConfigAction,
  saveChannelAction,
  saveMonitorAction,
  testChannelAction,
} from "./actions";

/**
 * The module's pages:
 *   /m/health-monitor                → what's up, what isn't, and how to add something
 *   /m/health-monitor/monitor/<id>   → one thing in detail, and how to change it
 *   /m/health-monitor/alerts         → where alerts go
 *
 * Everything is configured here rather than in the settings screen, because adding a
 * monitor is a normal thing to do and settings are for tuning.
 */
export default async function HealthPage({ ctx, path }: ModulePageProps) {
  await ensureRunning();
  const db = ctx.db;
  if (!db) {
    return <p className="text-sm" style={{ color: "var(--muted)" }}>The module has no database.</p>;
  }

  if (path[0] === "alerts") return <AlertsPage ctx={ctx} />;

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
      <Back />
      <p className="text-sm">That monitor no longer exists.</p>
    </div>
  );
}

function Back({ label = "← Health" }: { label?: string }) {
  return (
    <Link href={MODULE_PATH} className="text-sm" style={{ color: "var(--muted)" }}>
      {label}
    </Link>
  );
}

/* ------------------------------------------------------------------ overview */

async function Overview({ ctx }: { ctx: ModulePageProps["ctx"] }) {
  const db = ctx.db!;
  const monitors = await listMonitors(db);
  const channels = await listChannels(db);
  const configError = await lastConfigError(ctx);

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
              ? "Nothing is being watched yet."
              : problems.length === 0
                ? `Everything is up — ${monitors.length} being watched.`
                : `${problems.length} of ${active.length} need attention.`}
          </p>
        </div>
        <Link href={`${MODULE_PATH}/alerts`} className="btn btn-ghost">
          Alerts{channels.length ? ` (${channels.length})` : ""}
        </Link>
      </section>

      {configError ? (
        <div className="card p-3 text-sm" style={{ borderColor: "var(--danger)" }}>
          <span style={{ color: "var(--danger)" }}>Last import failed:</span> {configError}
        </div>
      ) : null}

      {channels.length === 0 && monitors.length > 0 ? (
        <div className="card p-3 text-sm">
          Nothing will tell you when something breaks yet.{" "}
          <Link href={`${MODULE_PATH}/alerts`} style={{ color: "var(--primary)" }}>
            Set up where alerts should go
          </Link>
          .
        </div>
      ) : null}

      {monitors.length > 0 ? (
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
                    {m.target}
                    {m.port ? `:${m.port}` : ""}
                    {m.enabled === 1 ? "" : " · paused"}
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
      ) : null}

      <section className="card p-4">
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Add something to watch</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
          A website, a port, a device that answers a ping, a domain name, or an HTTPS certificate.
        </p>
        <ActionForm action={saveMonitorAction} submitLabel="Start watching it">
          <MonitorFields channels={channels} others={monitors} />
        </ActionForm>
      </section>

      <details className="card p-4">
        <summary className="cursor-pointer text-sm font-medium">Bulk import</summary>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          Paste a saved configuration into the <strong>bulk import box</strong> in this module&apos;s
          settings, then press the button below. It only adds and updates — nothing is ever deleted
          this way.
        </p>
        <div className="mt-3">
          <ActionForm action={importConfigAction} submitLabel="Import from settings" variant="ghost" />
        </div>
      </details>
    </div>
  );
}

/* -------------------------------------------------------------------- detail */

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
  const channels = await listChannels(db);
  const routedTo = await routeIdsFor(db, monitor.id);
  const others = (await listMonitors(db)).filter((m) => m.id !== monitor.id);
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
        <Back />
        <h1 className="mb-1 mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <StatusDot state={monitor.enabled === 1 ? monitor.status : "unknown"} size={12} />
          {monitor.name}
        </h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {monitor.target}
          {monitor.port ? `:${monitor.port}` : ""} · checked {formatAgo(monitor.lastCheckAt)}
        </p>
        {monitor.runbook ? (
          <p className="mt-1 text-sm">
            <span style={{ color: "var(--muted)" }}>Note: </span>
            {monitor.runbook}
          </p>
        ) : null}
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
        <div className="mt-4 flex flex-wrap gap-2">
          <ActionForm action={checkNowAction} submitLabel="Check it now" variant="ghost" inline>
            <input type="hidden" name="id" value={monitor.id} />
          </ActionForm>
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

      <section className="card p-4">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Settings for this monitor</h2>
        <ActionForm action={saveMonitorAction} submitLabel="Save changes">
          <MonitorFields
            monitor={monitor}
            config={parseConfig(monitor)}
            channels={channels}
            routedTo={routedTo}
            others={others}
          />
        </ActionForm>
      </section>

      <section className="card p-4">
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Stop watching this</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
          Removes the monitor and everything recorded about it. To pause it instead, untick
          &ldquo;Checking is switched on&rdquo; above.
        </p>
        <ActionForm
          action={deleteMonitorAction}
          submitLabel="Delete this monitor"
          variant="danger"
          confirm={`Delete “${monitor.name}” and all of its history? This cannot be undone.`}
        >
          <input type="hidden" name="id" value={monitor.id} />
        </ActionForm>
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

/* -------------------------------------------------------------------- alerts */

async function AlertsPage({ ctx }: { ctx: ModulePageProps["ctx"] }) {
  const db = ctx.db!;
  const channels: ChannelRow[] = await listChannels(db);
  const kindLabel = new Map(CHANNEL_CHOICES.map((c) => [c.value, c.label]));

  return (
    <div className="hm flex flex-col gap-6">
      <HealthStyles />
      <section>
        <Back />
        <h1 className="mb-1 mt-1 text-2xl font-semibold tracking-tight">Where alerts go</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Add a destination here, then tick it on each monitor that should use it. Send a test before
          you rely on it.
        </p>
      </section>

      {channels.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Nothing set up yet — you will not be told when something breaks.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {channels.map((c) => (
            <li key={c.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium">{c.name}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {kindLabel.get(c.kind) ?? c.kind} · details are stored encrypted and not shown again
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ActionForm action={testChannelAction} submitLabel="Send a test" variant="ghost" inline>
                  <input type="hidden" name="id" value={c.id} />
                </ActionForm>
                <ActionForm
                  action={deleteChannelAction}
                  submitLabel="Remove"
                  variant="danger"
                  inline
                  confirm={`Remove “${c.name}”? Monitors using it will stop alerting there.`}
                >
                  <input type="hidden" name="id" value={c.id} />
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="card p-4">
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Add a destination</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
          Fill in only the boxes your choice needs — each option says what it wants.
        </p>
        <ActionForm action={saveChannelAction} submitLabel="Add it">
          <Field label="Name" help="How you'll recognise it — “My phone”, “Team chat”.">
            <input className="input" name="name" maxLength={80} required />
          </Field>

          <Field label="Send to">
            <select className="input" name="kind" defaultValue="email">
              {CHANNEL_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="card p-3 text-xs" style={{ color: "var(--muted)" }}>
            <p className="mb-1 font-medium" style={{ color: "var(--foreground)" }}>
              What each one needs
            </p>
            <ul className="flex flex-col gap-1">
              {CHANNEL_CHOICES.map((c) => (
                <li key={c.value}>
                  <strong>{c.label}:</strong> {c.needs}
                </li>
              ))}
            </ul>
          </div>

          <Field label="URL" help="The web address alerts are posted to. Not needed for email or Telegram.">
            <input className="input" name="url" type="url" placeholder="https://…" maxLength={500} />
          </Field>

          <Field label="Secret or token" help="A bot token, an app token, or a value to send as an Authorization header. Stored encrypted.">
            <input className="input" name="secret" maxLength={300} />
          </Field>

          <Field label="Topic or chat" help="The ntfy topic, or the Telegram chat id.">
            <input className="input" name="topic" maxLength={200} />
          </Field>

          <Field label="Email addresses" help="Email only. Comma-separated. Leave blank to use the module's recipient list.">
            <input className="input" name="recipients" maxLength={500} placeholder="you@example.com" />
          </Field>
        </ActionForm>
      </section>
    </div>
  );
}
