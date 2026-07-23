/**
 * When a backup should next run.
 *
 * Pure: no database, no clock unless one is handed in, no `server-only`. That is deliberate
 * — this is date arithmetic, which is where the bugs live, and the only way to be confident
 * about "every weeknight at 2am, but it's currently Friday 3am and the clocks went back" is
 * to be able to test it exhaustively without a server.
 *
 * Two kinds, because they answer different questions:
 *
 *   interval — "every N hours". Anchored to a time of day so it doesn't drift later on
 *              every run, which is what "now + N hours" does.
 *   daily    — "at 02:00 on these days". What people actually mean by a nightly backup.
 *
 * Local time throughout, on purpose. An admin who says 2am means 2am on the machine's
 * clock, including after a daylight-saving change; using UTC would silently shift their
 * backup by an hour twice a year.
 */

export type ScheduleKind = "interval" | "daily";

export type Schedule = {
  kind: ScheduleKind;
  /** Interval only. Hours between runs. */
  everyHours: number;
  /** Minutes past midnight, local time. Both kinds. */
  atMinute: number;
  /** Daily only. Days of the week, 0 = Sunday. Empty means every day. */
  days: number[];
};

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * CSV in the database → a clean, de-duplicated, sorted list. Junk is dropped, not guessed at.
 *
 * **Blank parts are skipped BEFORE any coercion, and that is the whole point.** `Number("")`
 * is `0`, and `0` is Sunday — so `"".split(",")` giving `[""]` would turn "no days chosen",
 * which is the default meaning "every day", into "Sundays only". Every job created with
 * default settings would have quietly run once a week. Caught by tests; it produced no error,
 * just a backup that ran six times less often than the admin asked for.
 */
export function parseDays(csv: string): number[] {
  const out = new Set<number>();
  for (const part of String(csv ?? "").split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export const formatDays = (days: number[]): string => days.join(",");

/** "Mon, Tue, Wed" — or "every day", which is what an empty list means. */
export function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "every day";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "weekdays";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "weekends";
  return days.map((d) => WEEKDAY_NAMES[d]).join(", ");
}

/** One line an admin can read back to check they got what they meant. */
export function describeSchedule(s: Schedule, formatTime: (m: number) => string): string {
  return s.kind === "daily"
    ? `${describeDays(s.days)} at ${formatTime(s.atMinute)}`
    : `every ${s.everyHours}h from ${formatTime(s.atMinute)}`;
}

/** Midnight local time on the day containing `d`. */
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * The next moment this schedule fires, strictly after `from`.
 *
 * Strictly after matters: computing "the next run" at the instant a run starts must not
 * return that same instant, or the job re-fires on every tick forever.
 */
export function nextRun(s: Schedule, from: Date = new Date()): Date {
  const atMinute = Math.min(1439, Math.max(0, Math.trunc(s.atMinute)));

  if (s.kind === "daily") {
    const days = parseDays(formatDays(s.days));
    // Walk forward a day at a time. Slower than arithmetic and completely immune to month
    // ends, leap years and daylight saving — `setDate` handles all three, and this runs
    // once per job per run, not in a loop that anybody will notice.
    for (let i = 0; i <= 14; i++) {
      const candidate = startOfDay(from);
      candidate.setDate(candidate.getDate() + i);
      candidate.setMinutes(atMinute);
      if (candidate.getTime() <= from.getTime()) continue;
      if (days.length === 0 || days.includes(candidate.getDay())) return candidate;
    }
    // Unreachable with a valid day list; a fortnight covers every weekly pattern. Falling
    // back to tomorrow beats returning something in the past and looping.
    const fallback = startOfDay(from);
    fallback.setDate(fallback.getDate() + 1);
    fallback.setMinutes(atMinute);
    return fallback;
  }

  // Interval: anchored to the time of day, stepped by `everyHours` until it is in the
  // future. Anchoring is the point — "now + N hours" drifts a little later every run, so a
  // 2am backup gradually becomes a 3am one.
  //
  // Non-finite is checked explicitly: `Math.max(1, NaN)` is NaN, not 1, so a NaN interval
  // would step by NaN, produce an Invalid Date, and leave the job permanently unschedulable
  // rather than falling back to something sane.
  const hours = Number(s.everyHours);
  const stepMs = (Number.isFinite(hours) && hours >= 1 ? Math.trunc(hours) : 1) * 3_600_000;
  const next = startOfDay(from);
  next.setMinutes(atMinute);
  while (next.getTime() <= from.getTime()) next.setTime(next.getTime() + stepMs);
  return next;
}

/**
 * How long to wait before retrying a failed run: 5 minutes doubling to a cap of an hour.
 *
 * Backoff rather than a fixed delay because the common causes differ in how long they
 * last. A NAS rebooting is back in minutes; a disconnected drive is back when somebody
 * plugs it in. Retrying every minute for either is just noise in the log.
 */
export function retryDelayMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.trunc(consecutiveFailures));
  return Math.min(60 * 60_000, 5 * 60_000 * 2 ** (n - 1));
}

/**
 * When to try again after a failure — or null when the job has used up its retries and
 * should simply wait for its next scheduled slot.
 */
export function nextRetry(
  s: Schedule,
  maxRetries: number,
  consecutiveFailures: number,
  from: Date = new Date(),
): Date | null {
  if (maxRetries <= 0 || consecutiveFailures > maxRetries) return null;
  const candidate = new Date(from.getTime() + retryDelayMs(consecutiveFailures));
  const scheduled = nextRun(s, from);
  // If the schedule would come round sooner than the backoff anyway, use it — a retry
  // should never delay a job past its own next run.
  return candidate.getTime() < scheduled.getTime() ? candidate : null;
}
