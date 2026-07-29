/**
 * Pure formatting helpers for the Host vitals UI. No JonDash imports, no host access — this
 * module never touches the machine; it only renders numbers the `system-metrics` helper
 * already gathered. Kept separate so it can be unit-tested without a database.
 */

/**
 * Bytes → a human size, e.g. "31.8 GB", "1.8 TB".
 *
 * **Binary maths (÷1024), decimal-style labels (GB/TB).** That is deliberately what Windows
 * Explorer and `df -h` do, so JonDash agrees with the tools someone would check it against.
 * It does mean a drive sold as "2 TB" reads as 1.8 TB here — but it reads that way in
 * Explorer too, and agreeing with the machine beats agreeing with the packaging.
 *
 * (Strictly, 1024-based units are KiB/MiB/GiB. Memory really is binary — 32 GB of RAM is
 * exactly 32 GiB — so for memory these labels are precisely right; for disks they follow the
 * same convention every OS file manager uses.)
 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Bytes per second → "12.3 MB/s". Same unit convention as `bytes`. */
export function rate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "—";
  return `${bytes(bytesPerSec)}/s`;
}

/** Fan/clock style integers with a unit, or an em dash when absent. */
export function withUnit(n: number | null | undefined, unit: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n)} ${unit}`;
}

/** MHz → "3.4 GHz" once it passes a thousand, else "800 MHz". */
export function clock(mhz: number | null | undefined): string {
  if (mhz === null || mhz === undefined || !Number.isFinite(mhz) || mhz <= 0) return "—";
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(1)} GHz` : `${Math.round(mhz)} MHz`;
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

/**
 * The same three levels, for a **filled bar** rather than for text.
 *
 * `TONE.ok` is `--muted` because healthy text should not shout — but a *meter* painted in the muted
 * colour reads as broken rather than calm: the fill is the same grey as the track's own label, so a
 * disk at 64% looks like a rendering glitch instead of a measurement. A healthy bar takes the app's
 * accent, which is the colour JonDash already uses for "this is the normal, working state", and the
 * warning and danger levels stay as they are because at those levels shouting is the point.
 */
export const METER: Record<Level, string> = {
  ok: "var(--primary)",
  warn: "var(--warning, #b45309)",
  bad: "var(--danger)",
};
