import { describe, it, expect } from "vitest";
import {
  describeDays,
  describeSchedule,
  nextRetry,
  nextRun,
  parseDays,
  retryDelayMs,
  type Schedule,
} from "../lib/schedule";

/**
 * Scheduling decides whether a backup happens at all, and it is date arithmetic — the
 * category that reliably hides bugs behind plausible-looking output. A schedule that
 * silently never fires looks identical to one that has simply not come round yet.
 *
 * Local time throughout, matching the implementation: an admin who says 2am means 2am on
 * their machine's clock.
 */

const at = (iso: string) => new Date(iso);
const daily = (atMinute: number, days: number[] = []): Schedule => ({ kind: "daily", everyHours: 24, atMinute, days });
const interval = (everyHours: number, atMinute = 0): Schedule => ({ kind: "interval", everyHours, atMinute, days: [] });

/** Local-time helpers, so a test reads the way the feature is described. */
const localHM = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("parseDays", () => {
  it("keeps valid days, sorted and de-duplicated", () => {
    expect(parseDays("3,1,1,5")).toEqual([1, 3, 5]);
  });

  it("drops junk rather than guessing", () => {
    expect(parseDays("1,7,-2,x,,9")).toEqual([1]);
    expect(parseDays("")).toEqual([]);
  });
});

describe("describeDays", () => {
  it("names the common patterns rather than listing them", () => {
    expect(describeDays([])).toBe("every day");
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(describeDays([1, 2, 3, 4, 5])).toBe("weekdays");
    expect(describeDays([0, 6])).toBe("weekends");
  });

  it("lists anything else", () => {
    expect(describeDays([1, 4])).toBe("Mon, Thu");
  });
});

describe("nextRun — daily", () => {
  it("returns today's slot when it is still ahead", () => {
    const next = nextRun(daily(120), at("2026-07-23T01:00:00"));
    expect(localHM(next)).toBe("02:00");
    expect(next.getDate()).toBe(23);
  });

  it("rolls to tomorrow once today's slot has passed", () => {
    const next = nextRun(daily(120), at("2026-07-23T03:00:00"));
    expect(localHM(next)).toBe("02:00");
    expect(next.getDate()).toBe(24);
  });

  it("is STRICTLY after the given moment", () => {
    // Called at exactly the slot — must not return the same instant, or the job re-fires
    // on every tick forever.
    const now = at("2026-07-23T02:00:00");
    const next = nextRun(daily(120), now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getDate()).toBe(24);
  });

  it("skips to the next chosen weekday", () => {
    // 2026-07-23 is a Thursday. Weekdays-only, asked on Friday evening, should give Monday.
    const friday = at("2026-07-24T23:00:00");
    expect(friday.getDay()).toBe(5);
    const next = nextRun(daily(120, [1, 2, 3, 4, 5]), friday);
    expect(next.getDay()).toBe(1);
    expect(localHM(next)).toBe("02:00");
  });

  it("handles a single-day-a-week schedule without skipping a week", () => {
    // Sundays only, asked on Sunday after the slot → next Sunday, not today.
    const sunday = at("2026-07-26T09:00:00");
    expect(sunday.getDay()).toBe(0);
    const next = nextRun(daily(120, [0]), sunday);
    expect(next.getDay()).toBe(0);
    expect(next.getDate()).toBe(2); // the following Sunday, into August
  });

  it("crosses a month end", () => {
    const next = nextRun(daily(120), at("2026-07-31T05:00:00"));
    expect(next.getMonth()).toBe(7); // August
    expect(next.getDate()).toBe(1);
  });

  it("crosses a year end", () => {
    const next = nextRun(daily(120), at("2026-12-31T05:00:00"));
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
  });

  it("never returns something in the past, whatever day it is asked", () => {
    // The failure that matters: a schedule that yields a past time runs immediately and
    // then again, and again.
    for (let d = 0; d < 14; d++) {
      for (const mins of [0, 120, 719, 1439]) {
        const from = at("2026-07-23T00:00:00");
        from.setDate(from.getDate() + d);
        from.setMinutes(from.getMinutes() + mins);
        for (const days of [[], [1, 2, 3, 4, 5], [0], [3, 6]]) {
          const next = nextRun(daily(mins, days), from);
          expect(next.getTime(), `days=${days} from=${from.toISOString()}`).toBeGreaterThan(from.getTime());
        }
      }
    }
  });
});

describe("nextRun — interval", () => {
  it("anchors to the time of day rather than drifting", () => {
    // Every 6h from 00:00, asked at 01:00 → 06:00, not 07:00. "now + N" would drift later
    // on every single run.
    const next = nextRun(interval(6, 0), at("2026-07-23T01:00:00"));
    expect(localHM(next)).toBe("06:00");
  });

  it("steps forward until it is in the future", () => {
    const next = nextRun(interval(6, 0), at("2026-07-23T13:00:00"));
    expect(localHM(next)).toBe("18:00");
  });

  it("is strictly after, at an exact boundary", () => {
    const now = at("2026-07-23T06:00:00");
    const next = nextRun(interval(6, 0), now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(localHM(next)).toBe("12:00");
  });

  it("copes with a 24h interval like the daily case", () => {
    const next = nextRun(interval(24, 120), at("2026-07-23T03:00:00"));
    expect(localHM(next)).toBe("02:00");
    expect(next.getDate()).toBe(24);
  });

  it("refuses to loop forever on a nonsense interval", () => {
    // 0 or negative hours would be an infinite loop if not clamped.
    const now = at("2026-07-23T03:00:00");
    for (const hours of [0, -5, Number.NaN]) {
      const next = nextRun({ kind: "interval", everyHours: hours, atMinute: 0, days: [] }, now);
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("retryDelayMs", () => {
  it("doubles from five minutes", () => {
    expect(retryDelayMs(1)).toBe(5 * 60_000);
    expect(retryDelayMs(2)).toBe(10 * 60_000);
    expect(retryDelayMs(3)).toBe(20 * 60_000);
  });

  it("caps at an hour, so a long outage doesn't wander into days", () => {
    expect(retryDelayMs(10)).toBe(60 * 60_000);
    expect(retryDelayMs(100)).toBe(60 * 60_000);
  });
});

describe("nextRetry", () => {
  const s = daily(120); // 02:00 every day

  it("returns null when retries are switched off", () => {
    expect(nextRetry(s, 0, 1, at("2026-07-23T03:00:00"))).toBeNull();
  });

  it("returns null once the retries are used up", () => {
    expect(nextRetry(s, 2, 3, at("2026-07-23T03:00:00"))).toBeNull();
  });

  it("backs off after a failure", () => {
    const from = at("2026-07-23T03:00:00");
    const next = nextRetry(s, 3, 1, from)!;
    expect(next.getTime() - from.getTime()).toBe(5 * 60_000);
  });

  it("never pushes a retry PAST the job's own next run", () => {
    // Failed at 01:55 with the schedule due at 02:00 — a 5-minute backoff would land at
    // 02:00 exactly, so the schedule should just be left to do its job.
    const from = at("2026-07-23T01:55:00");
    expect(nextRetry(s, 3, 1, from)).toBeNull();
  });
});

describe("describeSchedule", () => {
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  it("reads back as a sentence", () => {
    expect(describeSchedule(daily(120, [1, 2, 3, 4, 5]), fmt)).toBe("weekdays at 02:00");
    expect(describeSchedule(interval(6, 30), fmt)).toBe("every 6h from 00:30");
  });
});
