import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import type {
  ChannelRow,
  CheckOutcome,
  IncidentRow,
  MonitorConfig,
  MonitorRow,
  MonitorState,
  ResultRow,
} from "./types";

/**
 * Every read and write the module makes, in one place, over `ctx.db` — the scoped raw-SQL
 * handle the framework grants a module for its own `mod_health_monitor_*` tables. Nothing
 * here touches a core table.
 *
 * Table names come from `ctx.db.table()` (which sanitises them), never from user input;
 * every value is a bound `?` parameter. SQLite has no boolean or date type, so booleans
 * are 0/1 and timestamps are ISO strings, which sort correctly as text.
 */

type Db = NonNullable<ModuleContext["db"]>;

/** Counts come back from SQLite raw queries as BigInt often enough to always coerce. */
function n(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseConfig(row: Pick<MonitorRow, "configJson">): MonitorConfig {
  try {
    const parsed: unknown = JSON.parse(row.configJson || "{}");
    return parsed && typeof parsed === "object" ? (parsed as MonitorConfig) : {};
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- monitors */

export async function listMonitors(db: Db): Promise<MonitorRow[]> {
  return db.query<MonitorRow>(
    `SELECT * FROM ${db.table("monitors")} ORDER BY sortOrder ASC, name ASC`,
  );
}

export async function getMonitor(db: Db, id: string): Promise<MonitorRow | null> {
  const rows = await db.query<MonitorRow>(`SELECT * FROM ${db.table("monitors")} WHERE id = ?`, id);
  return rows[0] ?? null;
}

/** Monitors that are enabled and due (or have never run), oldest due first. */
export async function dueMonitors(db: Db, limit: number): Promise<MonitorRow[]> {
  return db.query<MonitorRow>(
    `SELECT * FROM ${db.table("monitors")}
      WHERE enabled = 1 AND (nextCheckAt IS NULL OR nextCheckAt <= ?)
      ORDER BY nextCheckAt IS NULL DESC, nextCheckAt ASC
      LIMIT ?`,
    nowIso(),
    limit,
  );
}

export async function upsertMonitor(
  db: Db,
  m: {
    id: string;
    name: string;
    kind: string;
    target: string;
    port: number | null;
    configJson: string;
    intervalSec: number | null;
    timeoutMs: number | null;
    retries: number | null;
    degradedMs: number | null;
    parentId: string | null;
    runbook: string | null;
    enabled: number;
    sortOrder: number;
  },
): Promise<void> {
  const ts = nowIso();
  await db.run(
    `INSERT INTO ${db.table("monitors")}
       (id, name, kind, target, port, configJson, intervalSec, timeoutMs, retries, degradedMs,
        parentId, runbook, enabled, sortOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, target = excluded.target, port = excluded.port,
       configJson = excluded.configJson, intervalSec = excluded.intervalSec,
       timeoutMs = excluded.timeoutMs, retries = excluded.retries, degradedMs = excluded.degradedMs,
       parentId = excluded.parentId, runbook = excluded.runbook, enabled = excluded.enabled,
       sortOrder = excluded.sortOrder, updatedAt = excluded.updatedAt`,
    m.id, m.name, m.kind, m.target, m.port, m.configJson, m.intervalSec, m.timeoutMs, m.retries,
    m.degradedMs, m.parentId, m.runbook, m.enabled, m.sortOrder, ts, ts,
  );
}

/** Remove monitors (and their history) that are no longer declared. */
export async function deleteMonitorsExcept(db: Db, keepIds: string[]): Promise<number> {
  const all = await db.query<{ id: string }>(`SELECT id FROM ${db.table("monitors")}`);
  const keep = new Set(keepIds);
  const gone = all.map((r) => r.id).filter((id) => !keep.has(id));
  for (const id of gone) {
    for (const table of ["results", "rollups", "incidents", "routes", "notifications"]) {
      await db.run(`DELETE FROM ${db.table(table)} WHERE monitorId = ?`, id);
    }
    await db.run(`DELETE FROM ${db.table("monitors")} WHERE id = ?`, id);
  }
  return gone.length;
}

export async function saveCheckState(
  db: Db,
  id: string,
  patch: {
    status: MonitorState;
    lastCheckAt: string;
    nextCheckAt: string;
    lastLatencyMs: number | null;
    lastMessage: string | null;
    failStreak: number;
    okStreak: number;
  },
): Promise<void> {
  await db.run(
    `UPDATE ${db.table("monitors")}
        SET status = ?, lastCheckAt = ?, nextCheckAt = ?, lastLatencyMs = ?, lastMessage = ?,
            failStreak = ?, okStreak = ?, updatedAt = ?
      WHERE id = ?`,
    patch.status, patch.lastCheckAt, patch.nextCheckAt, patch.lastLatencyMs, patch.lastMessage,
    patch.failStreak, patch.okStreak, nowIso(), id,
  );
}

/* ----------------------------------------------------------------- results */

export async function recordResult(
  db: Db,
  monitorId: string,
  state: MonitorState,
  outcome: CheckOutcome,
  ts: string,
): Promise<void> {
  await db.run(
    `INSERT INTO ${db.table("results")} (monitorId, ts, state, latencyMs, code, message, phasesJson)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    monitorId,
    ts,
    state,
    outcome.latencyMs ?? null,
    outcome.code ?? null,
    outcome.message ?? null,
    outcome.phases ? JSON.stringify(outcome.phases) : null,
  );
}

export async function recentResults(db: Db, monitorId: string, limit: number): Promise<ResultRow[]> {
  return db.query<ResultRow>(
    `SELECT * FROM ${db.table("results")} WHERE monitorId = ? ORDER BY ts DESC LIMIT ?`,
    monitorId,
    limit,
  );
}

export async function resultsSince(db: Db, monitorId: string, sinceIso: string): Promise<ResultRow[]> {
  return db.query<ResultRow>(
    `SELECT * FROM ${db.table("results")} WHERE monitorId = ? AND ts >= ? ORDER BY ts ASC`,
    monitorId,
    sinceIso,
  );
}

export type UptimeStats = { checks: number; failures: number; degraded: number; uptimePct: number; avgMs: number | null; p95Ms: number | null };

/**
 * Uptime and latency over the last `hoursBack` hours, merging raw results with the
 * hourly summaries that replaced older raw rows — so a 30-day figure stays correct after
 * a rollup. The window is resolved here rather than by the caller so that components
 * never have to read the clock during render.
 */
export async function uptimeWindow(db: Db, monitorId: string, hoursBack: number): Promise<UptimeStats> {
  return uptimeSince(db, monitorId, new Date(Date.now() - hoursBack * 3_600_000).toISOString());
}

async function uptimeSince(db: Db, monitorId: string, sinceIso: string): Promise<UptimeStats> {
  const raw = await db.query<{ checks: unknown; failures: unknown; degraded: unknown; avgMs: unknown; maxMs: unknown }>(
    `SELECT COUNT(*) AS checks,
            SUM(CASE WHEN state = 'down' THEN 1 ELSE 0 END) AS failures,
            SUM(CASE WHEN state = 'degraded' THEN 1 ELSE 0 END) AS degraded,
            AVG(latencyMs) AS avgMs, MAX(latencyMs) AS maxMs
       FROM ${db.table("results")} WHERE monitorId = ? AND ts >= ?`,
    monitorId,
    sinceIso,
  );
  const roll = await db.query<{ checks: unknown; failures: unknown; degraded: unknown; avgMs: unknown }>(
    `SELECT SUM(checks) AS checks, SUM(failures) AS failures, SUM(degraded) AS degraded,
            AVG(avgMs) AS avgMs
       FROM ${db.table("rollups")} WHERE monitorId = ? AND hourStart >= ?`,
    monitorId,
    sinceIso,
  );

  const checks = n(raw[0]?.checks) + n(roll[0]?.checks);
  const failures = n(raw[0]?.failures) + n(roll[0]?.failures);
  const degraded = n(raw[0]?.degraded) + n(roll[0]?.degraded);
  const avgParts = [raw[0]?.avgMs, roll[0]?.avgMs]
    .map((v) => (v === null || v === undefined ? NaN : Number(v)))
    .filter((v) => Number.isFinite(v));
  const avgMs = avgParts.length ? Math.round(avgParts.reduce((a, b) => a + b, 0) / avgParts.length) : null;

  const lat = await db.query<{ latencyMs: number | null }>(
    `SELECT latencyMs FROM ${db.table("results")}
      WHERE monitorId = ? AND ts >= ? AND latencyMs IS NOT NULL ORDER BY latencyMs ASC`,
    monitorId,
    sinceIso,
  );
  const values = lat.map((r) => Number(r.latencyMs)).filter((v) => Number.isFinite(v));
  const p95Ms = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] : null;

  return {
    checks,
    failures,
    degraded,
    uptimePct: checks === 0 ? 0 : Math.round(((checks - failures) / checks) * 1000) / 10,
    avgMs,
    p95Ms,
  };
}

export type HourBucket = { hour: string; checks: number; failures: number; degraded: number };

/**
 * One bucket per hour for the last `hours`, merging raw results with rollups so the
 * strip keeps its shape after old results have been summarised. Hours with no data come
 * back with zero checks, which the UI draws as "no data" rather than as healthy.
 */
export async function hourlyBuckets(db: Db, monitorId: string, hours: number): Promise<HourBucket[]> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const raw = await db.query<{ h: string; c: unknown; f: unknown; d: unknown }>(
    `SELECT substr(ts, 1, 13) AS h, COUNT(*) AS c,
            SUM(CASE WHEN state = 'down' THEN 1 ELSE 0 END) AS f,
            SUM(CASE WHEN state = 'degraded' THEN 1 ELSE 0 END) AS d
       FROM ${db.table("results")} WHERE monitorId = ? AND ts >= ? GROUP BY h`,
    monitorId,
    since,
  );
  const rolled = await db.query<{ h: string; c: unknown; f: unknown; d: unknown }>(
    `SELECT substr(hourStart, 1, 13) AS h, checks AS c, failures AS f, degraded AS d
       FROM ${db.table("rollups")} WHERE monitorId = ? AND hourStart >= ?`,
    monitorId,
    since,
  );

  const byHour = new Map<string, HourBucket>();
  for (const row of [...rolled, ...raw]) {
    const existing = byHour.get(row.h);
    const bucket = existing ?? { hour: row.h, checks: 0, failures: 0, degraded: 0 };
    bucket.checks += n(row.c);
    bucket.failures += n(row.f);
    bucket.degraded += n(row.d);
    byHour.set(row.h, bucket);
  }

  const out: HourBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const h = new Date(Date.now() - i * 3_600_000).toISOString().slice(0, 13);
    out.push(byHour.get(h) ?? { hour: h, checks: 0, failures: 0, degraded: 0 });
  }
  return out;
}

/* ---------------------------------------------------------------- retention */

/**
 * Fold raw results older than `afterDays` into one row per hour, then delete them, and
 * drop summaries past the retention limit. Keeps the table bounded without losing shape.
 */
export async function rollupAndPrune(db: Db, afterDays: number, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - afterDays * 86_400_000).toISOString();
  const buckets = await db.query<{ hourStart: string; monitorId: string; checks: unknown; failures: unknown; degraded: unknown; avgMs: unknown; maxMs: unknown }>(
    `SELECT monitorId, substr(ts, 1, 13) || ':00:00.000Z' AS hourStart,
            COUNT(*) AS checks,
            SUM(CASE WHEN state = 'down' THEN 1 ELSE 0 END) AS failures,
            SUM(CASE WHEN state = 'degraded' THEN 1 ELSE 0 END) AS degraded,
            AVG(latencyMs) AS avgMs, MAX(latencyMs) AS maxMs
       FROM ${db.table("results")} WHERE ts < ?
      GROUP BY monitorId, hourStart`,
    cutoff,
  );

  for (const b of buckets) {
    await db.run(
      `INSERT INTO ${db.table("rollups")} (monitorId, hourStart, checks, failures, degraded, avgMs, p95Ms, maxMs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(monitorId, hourStart) DO UPDATE SET
         checks = excluded.checks, failures = excluded.failures, degraded = excluded.degraded,
         avgMs = excluded.avgMs, maxMs = excluded.maxMs`,
      b.monitorId, b.hourStart, n(b.checks), n(b.failures), n(b.degraded),
      b.avgMs === null ? null : Math.round(Number(b.avgMs)),
      // p95 needs the individual samples, which this row is replacing — it stays null,
      // so the 95th percentile is reported from the raw window only, never guessed.
      null,
      b.maxMs === null ? null : Math.round(Number(b.maxMs)),
    );
  }

  await db.run(`DELETE FROM ${db.table("results")} WHERE ts < ?`, cutoff);

  const keepFrom = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  await db.run(`DELETE FROM ${db.table("rollups")} WHERE hourStart < ?`, keepFrom);
  await db.run(`DELETE FROM ${db.table("notifications")} WHERE sentAt < ?`, keepFrom);
  await db.run(
    `DELETE FROM ${db.table("incidents")} WHERE endedAt IS NOT NULL AND endedAt < ?`,
    keepFrom,
  );
}

/* --------------------------------------------------------------- incidents */

export async function openIncident(db: Db, monitorId: string, state: string, reason: string): Promise<IncidentRow | null> {
  await db.run(
    `INSERT INTO ${db.table("incidents")} (monitorId, state, startedAt, reason, notifyCount)
     VALUES (?, ?, ?, ?, 0)`,
    monitorId,
    state,
    nowIso(),
    reason,
  );
  return currentIncident(db, monitorId);
}

export async function currentIncident(db: Db, monitorId: string): Promise<IncidentRow | null> {
  const rows = await db.query<IncidentRow>(
    `SELECT * FROM ${db.table("incidents")} WHERE monitorId = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1`,
    monitorId,
  );
  return rows[0] ?? null;
}

export async function closeIncident(db: Db, id: number, startedAt: string): Promise<void> {
  const ended = nowIso();
  const durationSec = Math.max(0, Math.round((Date.parse(ended) - Date.parse(startedAt)) / 1000));
  await db.run(
    `UPDATE ${db.table("incidents")} SET endedAt = ?, durationSec = ? WHERE id = ?`,
    ended,
    durationSec,
    id,
  );
}

export async function markIncidentNotified(db: Db, id: number): Promise<void> {
  await db.run(
    `UPDATE ${db.table("incidents")} SET lastNotifiedAt = ?, notifyCount = notifyCount + 1 WHERE id = ?`,
    nowIso(),
    id,
  );
}

export async function listIncidents(db: Db, monitorId: string, limit: number): Promise<IncidentRow[]> {
  return db.query<IncidentRow>(
    `SELECT * FROM ${db.table("incidents")} WHERE monitorId = ? ORDER BY startedAt DESC LIMIT ?`,
    monitorId,
    limit,
  );
}

export async function openIncidentCount(db: Db): Promise<number> {
  const rows = await db.query<{ c: unknown }>(
    `SELECT COUNT(*) AS c FROM ${db.table("incidents")} WHERE endedAt IS NULL`,
  );
  return n(rows[0]?.c);
}

/* ---------------------------------------------------------------- channels */

export async function listChannels(db: Db): Promise<ChannelRow[]> {
  return db.query<ChannelRow>(`SELECT * FROM ${db.table("channels")} ORDER BY name ASC`);
}

export async function upsertChannel(
  db: Db,
  c: { id: string; name: string; kind: string; configEnc: string; enabled: number },
): Promise<void> {
  const ts = nowIso();
  await db.run(
    `INSERT INTO ${db.table("channels")} (id, name, kind, configEnc, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, configEnc = excluded.configEnc,
       enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
    c.id, c.name, c.kind, c.configEnc, c.enabled, ts, ts,
  );
}

export async function deleteChannelsExcept(db: Db, keepIds: string[]): Promise<void> {
  const all = await db.query<{ id: string }>(`SELECT id FROM ${db.table("channels")}`);
  const keep = new Set(keepIds);
  for (const row of all) {
    if (keep.has(row.id)) continue;
    await db.run(`DELETE FROM ${db.table("routes")} WHERE channelId = ?`, row.id);
    await db.run(`DELETE FROM ${db.table("channels")} WHERE id = ?`, row.id);
  }
}

export async function setRoutes(db: Db, monitorId: string, channelIds: string[]): Promise<void> {
  await db.run(`DELETE FROM ${db.table("routes")} WHERE monitorId = ?`, monitorId);
  for (const channelId of channelIds) {
    await db.run(
      `INSERT OR IGNORE INTO ${db.table("routes")} (monitorId, channelId) VALUES (?, ?)`,
      monitorId,
      channelId,
    );
  }
}

/** The enabled channels a monitor alerts through. */
export async function channelsForMonitor(db: Db, monitorId: string): Promise<ChannelRow[]> {
  return db.query<ChannelRow>(
    `SELECT c.* FROM ${db.table("channels")} c
       JOIN ${db.table("routes")} r ON r.channelId = c.id
      WHERE r.monitorId = ? AND c.enabled = 1`,
    monitorId,
  );
}

/* ----------------------------------------------------------- notifications */

export async function logNotification(
  db: Db,
  entry: { monitorId: string; channelId: string; incidentId: number | null; event: string; ok: boolean; error?: string },
): Promise<void> {
  await db.run(
    `INSERT INTO ${db.table("notifications")} (monitorId, channelId, incidentId, event, sentAt, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entry.monitorId, entry.channelId, entry.incidentId, entry.event, nowIso(),
    entry.ok ? 1 : 0, entry.error ?? null,
  );
}

export async function alertsInLastHour(db: Db): Promise<number> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const rows = await db.query<{ c: unknown }>(
    `SELECT COUNT(*) AS c FROM ${db.table("notifications")} WHERE sentAt >= ? AND event <> 'test'`,
    since,
  );
  return n(rows[0]?.c);
}

/* ---------------------------------------------------------------- windows */

type MaintenanceRow = {
  id: string;
  monitorId: string | null;
  kind: string;
  startsAt: string | null;
  endsAt: string | null;
  daysMask: number | null;
  startMin: number | null;
  durationMin: number | null;
  enabled: number;
};

/**
 * Whether a monitor is inside a quiet window right now — either a one-off range or a
 * weekly slot. Weekly windows are evaluated in the server's local time, which is the
 * time the person configuring them is thinking in.
 */
export async function inMaintenance(db: Db, monitorId: string, at = new Date()): Promise<boolean> {
  const rows = await db.query<MaintenanceRow>(
    `SELECT * FROM ${db.table("maintenance")} WHERE enabled = 1 AND (monitorId IS NULL OR monitorId = ?)`,
    monitorId,
  );
  const minutes = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();

  return rows.some((w) => {
    if (w.kind === "once") {
      if (!w.startsAt || !w.endsAt) return false;
      const t = at.getTime();
      return t >= Date.parse(w.startsAt) && t <= Date.parse(w.endsAt);
    }
    if (w.kind === "weekly") {
      if (w.daysMask === null || w.startMin === null || w.durationMin === null) return false;
      if (!(w.daysMask & (1 << day))) return false;
      return minutes >= w.startMin && minutes < w.startMin + w.durationMin;
    }
    return false;
  });
}

export async function upsertMaintenance(
  db: Db,
  w: {
    id: string;
    monitorId: string | null;
    label: string | null;
    kind: string;
    startsAt: string | null;
    endsAt: string | null;
    daysMask: number | null;
    startMin: number | null;
    durationMin: number | null;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO ${db.table("maintenance")}
       (id, monitorId, label, kind, startsAt, endsAt, daysMask, startMin, durationMin, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       monitorId = excluded.monitorId, label = excluded.label, kind = excluded.kind,
       startsAt = excluded.startsAt, endsAt = excluded.endsAt, daysMask = excluded.daysMask,
       startMin = excluded.startMin, durationMin = excluded.durationMin`,
    w.id, w.monitorId, w.label, w.kind, w.startsAt, w.endsAt, w.daysMask, w.startMin, w.durationMin,
  );
}

export async function deleteMaintenanceExcept(db: Db, keepIds: string[]): Promise<void> {
  const all = await db.query<{ id: string }>(`SELECT id FROM ${db.table("maintenance")}`);
  const keep = new Set(keepIds);
  for (const row of all) {
    if (!keep.has(row.id)) await db.run(`DELETE FROM ${db.table("maintenance")} WHERE id = ?`, row.id);
  }
}
