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
    key: "alertsEnabled",
    label: "Send alerts",
    type: "boolean",
    default: true,
    help: "Turn off to keep watching everything but stay silent — useful while you are working on something.",
  },
  {
    key: "notifyEmails",
    label: "Who to email",
    type: "string",
    default: "",
    help: "Email addresses, separated by commas. Used by any email channel that doesn't name its own recipients. Email itself is set up in Admin → Email.",
  },
  {
    key: "defaultIntervalSec",
    label: "Default gap between checks (seconds)",
    type: "number",
    default: 60,
    help: "Used by a monitor that doesn't choose its own. 60 suits most things; use longer for anything slow or rate-limited.",
  },
  {
    key: "defaultTimeoutMs",
    label: "How long to wait for an answer (milliseconds)",
    type: "number",
    default: 10000,
    help: "10000 is 10 seconds. A check that takes longer than this counts as failed.",
  },
  {
    key: "defaultRetries",
    label: "Failures in a row before calling it down",
    type: "number",
    default: 2,
    help: "Stops one dropped packet raising an alarm. 2 means it must fail twice in a row. Recovery is always believed immediately.",
  },
  {
    key: "degradedMs",
    label: "Treat as slow above (milliseconds)",
    type: "number",
    default: 2000,
    help: "Still answering, but slower than this, shows amber instead of green — an early warning before something actually breaks.",
  },
  {
    key: "renotifyMin",
    label: "Remind me every (minutes)",
    type: "number",
    default: 30,
    help: "While something stays down, repeat the alert this often. Set to 0 to be told once per outage and not again.",
  },
  {
    key: "maxAlertsPerHour",
    label: "Never send more than (alerts per hour)",
    type: "number",
    default: 12,
    help: "A safety net: if lots of things fail at once, or one keeps flapping, you won't be buried.",
  },
  {
    key: "quietAfterRestartMin",
    label: "Stay quiet for (minutes) after JonDash restarts",
    type: "number",
    default: 3,
    help: "Updating or restarting JonDash briefly interrupts checks. This stops that looking like an outage.",
  },
  {
    key: "certWarnDays",
    label: "Warn before a certificate expires (days)",
    type: "string",
    default: "30,14,7",
    help: "Comma-separated. With 30,14,7 you are warned a month out, then a fortnight, then a week.",
  },
  {
    key: "retentionDays",
    label: "Keep history for (days)",
    type: "number",
    default: 30,
    help: "Older results are deleted so the database stays small. Incident records are kept for the same period.",
  },
  {
    key: "rollupAfterDays",
    label: "Compress detail after (days)",
    type: "number",
    default: 2,
    help: "Individual checks older than this become hourly summaries. Uptime figures stay accurate; the minute-by-minute detail goes.",
  },
  // `pollSeconds` was removed in 0.0.5-beta.1. Scheduled work now runs on the `scheduler`
  // helper, whose interval is fixed when the module is defined, so a user-tunable value
  // could no longer take effect. Nothing real is lost: it only controlled how often the
  // module LOOKED for due work, never how often anything was actually checked, and the
  // scan is fixed at 15s — shorter than the shortest interval a monitor can be given.
  {
    key: "maxConcurrent",
    label: "Checks to run at the same time",
    type: "number",
    default: 4,
    help: "Advanced. Raise it if you monitor a lot of things and checks fall behind; lower it if it puts load on your network.",
  },
  {
    key: "configJson",
    label: "Bulk import — JSON",
    type: "text",
    default: "",
    help: "Optional. For adding a lot at once or restoring a saved copy: paste it here, then press Run the import on the module page under Manage checks. It only adds and updates — it never deletes. Individual checks are added under Manage checks, not here.",
  },
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
