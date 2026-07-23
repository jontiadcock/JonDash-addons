/**
 * Ids, paths and formatting.
 *
 * Deliberately free of `server-only` and of any database import: the dashboard widget and
 * the live-progress component are CLIENT components, and they need these. A single stray
 * server import here would drag the whole data layer into the browser bundle — which is
 * exactly the mistake health-monitor's `ui/form.tsx` calls out in its own header.
 */

/** Must match the folder name. Changing it later orphans the module's data. */
export const MODULE_ID = "backup-manager";
export const MODULE_PATH = `/m/${MODULE_ID}`;
export const ADMIN_PATH = `/admin/modules/${MODULE_ID}`;

/** A job's own page, e.g. /m/backup-manager/job/<id>. */
export const jobPath = (jobId: string) => `${MODULE_PATH}/job/${jobId}`;

/** Bytes → something a person reads. */
export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Minutes past midnight → "02:00". */
export function formatTime(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** A span in ms → "1m 20s". Rounded, because nobody needs the milliseconds. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * "2 hours ago" / "in 6 hours".
 *
 * Relative rather than absolute because the question people actually ask a backup tool is
 * "is this recent?", not "what was the timestamp?". The exact time is still shown on the
 * job's own page, where you've gone looking for detail.
 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";

  const diff = t - now;
  const ahead = diff > 0;
  const s = Math.abs(diff) / 1000;
  const say = (n: number, unit: string) => {
    const v = Math.round(n);
    const plural = `${v} ${unit}${v === 1 ? "" : "s"}`;
    return ahead ? `in ${plural}` : `${plural} ago`;
  };

  if (s < 45) return ahead ? "in a moment" : "just now";
  if (s < 5400) return say(s / 60, "minute");
  if (s < 129600) return say(s / 3600, "hour");
  return say(s / 86400, "day");
}

/** An absolute timestamp, for the places detail matters. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "—";
}

/** How long a run took, from its two timestamps. Null while it is still going. */
export function runDuration(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(finishedAt);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

/** The health of a job in one word, for a widget that has room for very little. */
export type Health = "ok" | "warn" | "bad" | "running" | "idle";

export const HEALTH_TONE: Record<Health, string> = {
  ok: "var(--success, inherit)",
  warn: "var(--warning, var(--muted))",
  bad: "var(--danger)",
  running: "inherit",
  idle: "var(--muted)",
};
