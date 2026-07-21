import type { ModuleContext, ModuleSettingField } from "@/lib/modules/types";
import type { ModuleSettings } from "./types";

/**
 * The module's settings: one declaration used both for the framework's auto-rendered
 * form and for reading values back, so the two can't drift. Every value is coerced and
 * clamped on read — a setting comes back as whatever was typed into a form, and a
 * nonsense interval would otherwise turn the scheduler into a busy loop.
 */

export const SETTING_FIELDS: ModuleSettingField[] = [
  {
    key: "configJson",
    label: "Monitors and channels (JSON)",
    type: "string",
    default: "",
    help: "Temporary while the framework gains a way for modules to handle forms. See CONFIG.md for the format; leave empty to configure nothing.",
  },
  { key: "alertsEnabled", label: "Send alerts", type: "boolean", default: true, help: "Off = keep checking, send nothing." },
  { key: "notifyEmails", label: "Alert email recipients", type: "string", default: "", help: "Comma-separated. Used by email channels." },
  { key: "pollSeconds", label: "Scheduler tick (seconds)", type: "number", default: 15 },
  { key: "defaultIntervalSec", label: "Default check interval (seconds)", type: "number", default: 60 },
  { key: "defaultTimeoutMs", label: "Default timeout (ms)", type: "number", default: 10000 },
  { key: "defaultRetries", label: "Confirmations before a state change", type: "number", default: 2 },
  { key: "degradedMs", label: "Slow-response budget (ms)", type: "number", default: 2000, help: "Answering but slower than this counts as degraded." },
  { key: "maxConcurrent", label: "Concurrent checks", type: "number", default: 4 },
  { key: "rollupAfterDays", label: "Summarise results after (days)", type: "number", default: 2 },
  { key: "retentionDays", label: "Keep history for (days)", type: "number", default: 30 },
  { key: "quietAfterRestartMin", label: "Quiet period after restart (minutes)", type: "number", default: 3 },
  { key: "renotifyMin", label: "Repeat alerts every (minutes)", type: "number", default: 30, help: "0 = alert once per incident." },
  { key: "maxAlertsPerHour", label: "Maximum alerts per hour", type: "number", default: 12 },
  { key: "certWarnDays", label: "Certificate warning days", type: "string", default: "30,14,7" },
];

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function list(v: unknown): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read every setting, coerced and clamped to something the engine can safely use. */
export async function readSettings(ctx: ModuleContext): Promise<ModuleSettings> {
  const s = await ctx.settings.all();
  return {
    pollSeconds: num(s.pollSeconds, 15, 5, 3600),
    defaultIntervalSec: num(s.defaultIntervalSec, 60, 10, 86_400),
    defaultTimeoutMs: num(s.defaultTimeoutMs, 10_000, 500, 120_000),
    defaultRetries: num(s.defaultRetries, 2, 0, 10),
    degradedMs: num(s.degradedMs, 2000, 1, 120_000),
    maxConcurrent: num(s.maxConcurrent, 4, 1, 32),
    rollupAfterDays: num(s.rollupAfterDays, 2, 1, 365),
    retentionDays: num(s.retentionDays, 30, 1, 3650),
    quietAfterRestartMin: num(s.quietAfterRestartMin, 3, 0, 120),
    renotifyMin: num(s.renotifyMin, 30, 0, 10_080),
    maxAlertsPerHour: num(s.maxAlertsPerHour, 12, 1, 500),
    certWarnDays: (list(s.certWarnDays).length ? list(s.certWarnDays) : ["30", "14", "7"])
      .map((d) => num(d, 0, 0, 3650))
      .filter((d) => d > 0)
      .sort((a, b) => b - a),
    notifyEmails: list(s.notifyEmails),
    alertsEnabled: s.alertsEnabled !== false,
  };
}
