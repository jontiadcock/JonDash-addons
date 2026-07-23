import { describe, it, expect } from "vitest";
import {
  DEFAULT_GFS,
  describePolicy,
  parseSnapshotName,
  selectForRetention,
  toSnapshots,
  type GfsPolicy,
} from "../lib/snapshots";

/**
 * These tests decide whether somebody keeps their backups.
 *
 * Every case asserts what is KEPT as hard as what is removed, because the failure that
 * matters here is silent: a retention bug doesn't throw, it just quietly leaves you with
 * fewer copies than you believed you had, and you find out on the day you need one.
 */

const NONE: GfsPolicy = { keepDaily: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 0 };

describe("parseSnapshotName — the strictness IS the safety", () => {
  it("accepts exactly the format the copy engine generates", () => {
    const at = parseSnapshotName("2026-07-23-10-15-06");
    expect(at).not.toBeNull();
    expect(at!.toISOString()).toBe("2026-07-23T10:15:06.000Z");
  });

  it("refuses anything that is not exactly that shape", () => {
    // Each of these is somebody's own folder, sitting in the destination. Returning a date
    // for any of them would make it eligible for deletion.
    for (const name of [
      "2026-07-23",                 // date only
      "2026-07-23-10-15",           // no seconds
      "2026-07-23-10-15-06-extra",  // suffixed
      "backup-2026-07-23-10-15-06", // prefixed
      "2026-07-23-10-15-06 ",       // trailing space
      "Photos",
      "2026 tax return",
      "",
      "....",
    ]) {
      expect(parseSnapshotName(name), name).toBeNull();
    }
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    // Date would silently turn Feb 30th into March 2nd, inventing a snapshot moment that
    // never happened and mis-bucketing it.
    expect(parseSnapshotName("2026-02-30-10-00-00")).toBeNull();
    expect(parseSnapshotName("2026-13-01-10-00-00")).toBeNull();
    expect(parseSnapshotName("2026-07-23-25-00-00")).toBeNull();
  });

  it("accepts a real leap day", () => {
    expect(parseSnapshotName("2024-02-29-00-00-00")).not.toBeNull();
    expect(parseSnapshotName("2026-02-29-00-00-00")).toBeNull(); // 2026 is not a leap year
  });
});

describe("toSnapshots", () => {
  it("keeps only real snapshots and drops everything else", () => {
    const got = toSnapshots(["2026-07-23-10-00-00", "Holiday photos", "2026-07-22-10-00-00", "notes.txt"]);
    expect(got.map((s) => s.name)).toEqual(["2026-07-23-10-00-00", "2026-07-22-10-00-00"]);
  });

  it("returns newest first", () => {
    const got = toSnapshots(["2026-07-21-10-00-00", "2026-07-23-10-00-00", "2026-07-22-10-00-00"]);
    expect(got.map((s) => s.name)).toEqual([
      "2026-07-23-10-00-00",
      "2026-07-22-10-00-00",
      "2026-07-21-10-00-00",
    ]);
  });
});

describe("selectForRetention — the newest is never removed", () => {
  it("keeps the newest even when every tier is zero", () => {
    const snaps = toSnapshots(["2026-07-23-10-00-00", "2026-07-22-10-00-00", "2026-07-21-10-00-00"]);
    const plan = selectForRetention(snaps, NONE);
    expect(plan.keep.map((k) => k.snapshot.name)).toEqual(["2026-07-23-10-00-00"]);
    expect(plan.keep[0].because).toMatch(/most recent/i);
    expect(plan.remove).toHaveLength(2);
  });

  it("keeps the newest even from a single snapshot", () => {
    const plan = selectForRetention(toSnapshots(["2026-07-23-10-00-00"]), NONE);
    expect(plan.keep).toHaveLength(1);
    expect(plan.remove).toHaveLength(0);
  });

  it("handles an empty destination without inventing work", () => {
    expect(selectForRetention([], DEFAULT_GFS)).toEqual({ keep: [], remove: [] });
  });
});

describe("selectForRetention — daily tier", () => {
  it("keeps the last backup of each of the last N days", () => {
    // Three per day for four days; keepDaily 2 should keep the newest of each of the two
    // most recent days and nothing else.
    const names: string[] = [];
    for (const day of ["20", "21", "22", "23"]) {
      for (const hour of ["08", "12", "20"]) names.push(`2026-07-${day}-${hour}-00-00`);
    }
    const plan = selectForRetention(toSnapshots(names), { ...NONE, keepDaily: 2 });

    expect(plan.keep.map((k) => k.snapshot.name).sort()).toEqual([
      "2026-07-22-20-00-00",
      "2026-07-23-20-00-00",
    ]);
    expect(plan.remove).toHaveLength(10);
  });

  it("keeps the LAST of a day, not the first", () => {
    const plan = selectForRetention(
      toSnapshots(["2026-07-23-02-00-00", "2026-07-23-23-00-00", "2026-07-23-12-00-00"]),
      { ...NONE, keepDaily: 1 },
    );
    expect(plan.keep.map((k) => k.snapshot.name)).toEqual(["2026-07-23-23-00-00"]);
  });
});

describe("selectForRetention — weekly tier and ISO weeks", () => {
  it("keeps one per ISO week for the last N weeks", () => {
    const names = [
      "2026-07-23-10-00-00", // Thu, week 30
      "2026-07-20-10-00-00", // Mon, week 30
      "2026-07-16-10-00-00", // Thu, week 29
      "2026-07-09-10-00-00", // Thu, week 28
      "2026-07-02-10-00-00", // Thu, week 27
    ];
    const plan = selectForRetention(toSnapshots(names), { ...NONE, keepWeekly: 3 });
    expect(plan.keep.map((k) => k.snapshot.name).sort()).toEqual([
      "2026-07-09-10-00-00",
      "2026-07-16-10-00-00",
      "2026-07-23-10-00-00",
    ]);
  });

  it("puts a year-end date in the ISO week it actually belongs to", () => {
    // 2025-12-29 (Mon) through 2026-01-04 (Sun) are all ISO week 2026-W01. Treating the
    // December dates as belonging to 2025 would merge two real weeks into one bucket and
    // delete a backup that should have survived.
    const plan = selectForRetention(
      toSnapshots(["2026-01-02-10-00-00", "2025-12-30-10-00-00", "2025-12-24-10-00-00"]),
      { ...NONE, keepWeekly: 2 },
    );
    const kept = plan.keep.map((k) => k.snapshot.name).sort();
    // Newest of W01 (Jan 2nd, since Dec 30th is the same ISO week), plus the previous week.
    expect(kept).toEqual(["2025-12-24-10-00-00", "2026-01-02-10-00-00"]);
    expect(plan.remove.map((s) => s.name)).toEqual(["2025-12-30-10-00-00"]);
  });
});

describe("selectForRetention — monthly and yearly tiers", () => {
  it("keeps the last backup of each of the last N months", () => {
    const names = [
      "2026-07-31-10-00-00",
      "2026-07-01-10-00-00",
      "2026-06-30-10-00-00",
      "2026-05-31-10-00-00",
      "2026-04-30-10-00-00",
    ];
    const plan = selectForRetention(toSnapshots(names), { ...NONE, keepMonthly: 3 });
    expect(plan.keep.map((k) => k.snapshot.name).sort()).toEqual([
      "2026-05-31-10-00-00",
      "2026-06-30-10-00-00",
      "2026-07-31-10-00-00",
    ]);
  });

  it("keeps a yearly when asked, and nothing older", () => {
    const names = ["2026-07-01-10-00-00", "2025-12-31-10-00-00", "2024-12-31-10-00-00", "2023-12-31-10-00-00"];
    const plan = selectForRetention(toSnapshots(names), { ...NONE, keepYearly: 3 });
    expect(plan.keep.map((k) => k.snapshot.name).sort()).toEqual([
      "2024-12-31-10-00-00",
      "2025-12-31-10-00-00",
      "2026-07-01-10-00-00",
    ]);
    expect(plan.remove.map((s) => s.name)).toEqual(["2023-12-31-10-00-00"]);
  });
});

describe("selectForRetention — tiers combine, they don't compete", () => {
  it("a snapshot claimed by several tiers is kept once, with the first reason", () => {
    const plan = selectForRetention(toSnapshots(["2026-07-23-10-00-00"]), DEFAULT_GFS);
    expect(plan.keep).toHaveLength(1);
    expect(plan.keep[0].because).toMatch(/most recent/i);
  });

  it("thins out going back: dense recently, sparse in history", () => {
    // A daily backup for two years. GFS should leave roughly daily+weekly+monthly, not 730.
    const names: string[] = [];
    for (let i = 0; i < 730; i++) {
      const d = new Date(Date.UTC(2026, 6, 23) - i * 86_400_000);
      const p = (n: number) => String(n).padStart(2, "0");
      names.push(
        `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-02-00-00`,
      );
    }
    const plan = selectForRetention(toSnapshots(names), DEFAULT_GFS);

    expect(plan.keep.length).toBeLessThan(30); // 7 daily + 4 weekly + 12 monthly, overlapping
    expect(plan.keep.length).toBeGreaterThanOrEqual(12);
    expect(plan.keep.length + plan.remove.length).toBe(730); // nothing lost or invented

    // The newest survives, and something from about a year ago does too.
    expect(plan.keep[0].snapshot.name).toBe("2026-07-23-02-00-00");
    const oldestKept = plan.keep.at(-1)!.snapshot.at;
    expect(Date.UTC(2026, 6, 23) - oldestKept.getTime()).toBeGreaterThan(300 * 86_400_000);
  });

  it("every snapshot is either kept or removed — never both, never neither", () => {
    const names: string[] = [];
    for (let i = 0; i < 200; i++) {
      const d = new Date(Date.UTC(2026, 6, 23) - i * 43_200_000); // twice a day
      const p = (n: number) => String(n).padStart(2, "0");
      names.push(
        `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}-00-00`,
      );
    }
    const all = toSnapshots(names);
    const plan = selectForRetention(all, DEFAULT_GFS);
    const keptNames = new Set(plan.keep.map((k) => k.snapshot.name));
    const removedNames = new Set(plan.remove.map((s) => s.name));

    expect(keptNames.size + removedNames.size).toBe(all.length);
    for (const name of keptNames) expect(removedNames.has(name)).toBe(false);
  });

  it("does not care what order it was given them in", () => {
    const names = ["2026-07-21-10-00-00", "2026-07-23-10-00-00", "2026-07-22-10-00-00"];
    const forwards = selectForRetention(toSnapshots(names), { ...NONE, keepDaily: 2 });
    const backwards = selectForRetention(toSnapshots([...names].reverse()), { ...NONE, keepDaily: 2 });
    expect(forwards.keep.map((k) => k.snapshot.name)).toEqual(backwards.keep.map((k) => k.snapshot.name));
  });
});

describe("describePolicy", () => {
  it("reads as a sentence", () => {
    expect(describePolicy(DEFAULT_GFS)).toBe("keeping 7 daily, 4 weekly, 12 monthly");
    expect(describePolicy({ ...NONE, keepDaily: 3 })).toBe("keeping 3 daily");
  });

  it("is honest when the policy keeps almost nothing", () => {
    expect(describePolicy(NONE)).toMatch(/only the most recent/i);
  });
});
