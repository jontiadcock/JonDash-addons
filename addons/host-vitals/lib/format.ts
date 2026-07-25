/**
 * Pure formatting helpers for the Host vitals UI. No JonDash imports, no host access — this
 * module never touches the machine; it only renders numbers the `system-metrics` helper
 * already gathered. Kept separate so it can be unit-tested without a database.
 */

/** Bytes → the largest sensible binary unit, one decimal. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** A whole-number percentage for display. */
export function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

/** Seconds → "5d 3h", "3h 12m", "8m" — coarse on purpose; uptime doesn't need seconds. */
export function uptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Health of a single usage percentage: fine < 75 ≤ warn < 90 ≤ bad. */
export type Level = "ok" | "warn" | "bad";

export function levelFor(usedPct: number): Level {
  if (usedPct >= 90) return "bad";
  if (usedPct >= 75) return "warn";
  return "ok";
}

/** The JonDash tone variable for a level, so the UI follows the app's own theme. */
export const TONE: Record<Level, string> = {
  ok: "var(--muted)",
  warn: "var(--warning, #b45309)",
  bad: "var(--danger)",
};
