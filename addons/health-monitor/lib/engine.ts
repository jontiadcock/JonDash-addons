import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import type { AlertEvent, ModuleSettings, MonitorRow, MonitorState } from "./types";
import { runCheck } from "./checks";
import { sendAlert, type Alert } from "./notify";
import {
  alertsInLastHour,
  channelsForMonitor,
  closeIncident,
  currentIncident,
  getMonitor,
  inMaintenance,
  logNotification,
  markIncidentNotified,
  nowIso,
  openIncident,
  parseConfig,
  recordResult,
  saveCheckState,
} from "./store";

/**
 * One monitor's check, from running it to deciding whether anyone should be told.
 *
 * The rules that stop this being noisy:
 *  - a failure must repeat `retries` times in a row before the monitor is called down,
 *    so a single dropped packet is recorded but never alerted on;
 *  - recovery is believed immediately, because a service coming back is not a false
 *    alarm worth delaying;
 *  - alerts are suppressed inside a maintenance window, while the monitor's parent is
 *    down, for a few minutes after this process started, and above an hourly ceiling.
 */

/** When this module's code was first loaded — the closest thing it has to "boot". */
export const LOADED_AT = Date.now();

function effectiveState(raw: MonitorState, latencyMs: number | undefined, degradedMs: number): MonitorState {
  if (raw !== "up") return raw;
  if (latencyMs !== undefined && latencyMs > degradedMs) return "degraded";
  return "up";
}

/** Alert suppression that applies to every event for this monitor right now. */
async function suppressed(
  ctx: ModuleContext,
  monitor: MonitorRow,
  settings: ModuleSettings,
): Promise<string | null> {
  const db = ctx.db!;
  if (!settings.alertsEnabled) return "alerts disabled";
  if (Date.now() - LOADED_AT < settings.quietAfterRestartMin * 60_000) return "quiet period after restart";
  if (await inMaintenance(db, monitor.id)) return "maintenance window";
  if (monitor.parentId) {
    const parent = await getMonitor(db, monitor.parentId);
    if (parent && parent.status === "down") return `parent ${parent.name} is down`;
  }
  if ((await alertsInLastHour(db)) >= settings.maxAlertsPerHour) return "hourly alert limit reached";
  return null;
}

/** Deliver one alert to every channel routed to the monitor, logging each attempt. */
async function dispatch(
  ctx: ModuleContext,
  monitor: MonitorRow,
  event: AlertEvent,
  detail: string,
  forSeconds: number | undefined,
  incidentId: number | null,
  settings: ModuleSettings,
): Promise<void> {
  const db = ctx.db!;
  const channels = await channelsForMonitor(db, monitor.id);
  if (channels.length === 0) return;

  const alert: Alert = {
    event,
    monitor: { id: monitor.id, name: monitor.name, kind: monitor.kind, target: monitor.target, runbook: monitor.runbook },
    detail,
    forSeconds,
  };

  for (const channel of channels) {
    const result = await sendAlert(ctx, channel, alert, settings.notifyEmails);
    await logNotification(db, {
      monitorId: monitor.id,
      channelId: channel.id,
      incidentId,
      event,
      ok: result.ok,
      error: result.error,
    });
    if (!result.ok && ctx.audit) {
      await ctx.audit("alert.failed", `${monitor.name} via ${channel.name}: ${result.error ?? "unknown"}`);
    }
  }
}

/**
 * Run one monitor and apply the result. Returns the state it settled on. Never throws —
 * the scheduler must survive any single monitor misbehaving.
 */
export async function checkMonitor(
  ctx: ModuleContext,
  monitor: MonitorRow,
  settings: ModuleSettings,
): Promise<MonitorState> {
  const db = ctx.db;
  if (!db) return "unknown";

  const cfg = parseConfig(monitor);
  const timeoutMs = monitor.timeoutMs ?? settings.defaultTimeoutMs;
  const degradedMs = monitor.degradedMs ?? settings.degradedMs;
  const confirmations = Math.max(1, monitor.retries ?? settings.defaultRetries);
  const intervalSec = monitor.intervalSec ?? settings.defaultIntervalSec;
  const certWarnDays = settings.certWarnDays[0] ?? 30;
  const ts = nowIso();

  let outcome;
  try {
    outcome = await runCheck(ctx, monitor, cfg, timeoutMs, certWarnDays);
  } catch (e) {
    outcome = { state: "down" as const, message: e instanceof Error ? e.message : String(e) };
  }

  const observed = effectiveState(outcome.state, outcome.latencyMs, degradedMs);
  const failing = observed === "down";
  const failStreak = failing ? monitor.failStreak + 1 : 0;
  const okStreak = failing ? 0 : monitor.okStreak + 1;

  // A down state has to be confirmed; anything else is believed at once.
  let status: MonitorState = monitor.status;
  if (failing) {
    if (failStreak >= confirmations) status = "down";
    else if (monitor.status === "unknown") status = "unknown";
  } else {
    status = observed;
  }

  await recordResult(db, monitor.id, observed, outcome, ts);
  await saveCheckState(db, monitor.id, {
    status,
    lastCheckAt: ts,
    nextCheckAt: new Date(Date.now() + intervalSec * 1000).toISOString(),
    lastLatencyMs: outcome.latencyMs ?? null,
    lastMessage: outcome.message ?? null,
    failStreak,
    okStreak,
  });

  const wasDown = monitor.status === "down";
  const isDown = status === "down";
  const detail = outcome.message ?? observed;
  const block = await suppressed(ctx, { ...monitor, status }, settings);

  if (isDown && !wasDown) {
    const incident = await openIncident(db, monitor.id, "down", detail);
    if (!block && incident) {
      await dispatch(ctx, monitor, "down", detail, undefined, incident.id, settings);
      await markIncidentNotified(db, incident.id);
    }
    return status;
  }

  if (!isDown && wasDown) {
    const incident = await currentIncident(db, monitor.id);
    const forSeconds = incident
      ? Math.round((Date.now() - Date.parse(incident.startedAt)) / 1000)
      : undefined;
    if (incident) await closeIncident(db, incident.id, incident.startedAt);
    if (!block) {
      await dispatch(ctx, monitor, "up", detail, forSeconds, incident?.id ?? null, settings);
    }
    return status;
  }

  if (isDown && wasDown && settings.renotifyMin > 0 && !block) {
    const incident = await currentIncident(db, monitor.id);
    const due =
      incident &&
      (!incident.lastNotifiedAt ||
        Date.now() - Date.parse(incident.lastNotifiedAt) >= settings.renotifyMin * 60_000);
    if (incident && due) {
      const forSeconds = Math.round((Date.now() - Date.parse(incident.startedAt)) / 1000);
      await dispatch(ctx, monitor, "down", detail, forSeconds, incident.id, settings);
      await markIncidentNotified(db, incident.id);
    }
    return status;
  }

  // Newly degraded: worth saying once, and for a certificate it is its own event.
  if (status === "degraded" && monitor.status !== "degraded" && monitor.status !== "unknown" && !block) {
    await dispatch(ctx, monitor, monitor.kind === "tls" ? "cert" : "degraded", detail, undefined, null, settings);
  }

  return status;
}
