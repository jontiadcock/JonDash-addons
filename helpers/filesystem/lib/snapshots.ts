/**
 * Snapshot retention — Grandfather-Father-Son.
 *
 * This module decides which backups get destroyed. It is pure: no I/O, no dates read from
 * the clock unless handed one, every input explicit. That is deliberate, because the cost
 * of a wrong answer here is somebody's only copy of something.
 *
 * ## The rule that matters most
 *
 * **A folder is only ever a candidate if its name is EXACTLY the timestamp format the copy
 * engine generates.** `2026-07-23-10-15-06`, and nothing else. Not "starts with a date",
 * not "looks datey" — an exact match on the full name.
 *
 * That is what stops this deleting a user's own folder that happens to live in the same
 * place. If an admin points a snapshot job at a directory that already has their files in
 * it, those files are invisible to this code: unparseable names aren't returned as
 * snapshots, so they can never be selected for removal. The strictness IS the safety.
 *
 * ## How GFS works here
 *
 * Four tiers, each keeping the most recent snapshot from each of the last N periods:
 *
 *   daily    the last N distinct days
 *   weekly   the last N distinct ISO weeks
 *   monthly  the last N distinct calendar months
 *   yearly   the last N distinct years
 *
 * A snapshot kept by any tier is kept. The tiers overlap heavily near the present and thin
 * out going back, which is the whole point: fine detail recently, coarse history for a long
 * time, at a fraction of the disk.
 *
 * Within a period the NEWEST snapshot wins — "the last backup of that month" is the one
 * worth keeping, since it reflects the most of that month's work.
 */

export type Snapshot = {
  /** The folder name, exactly as on disk. */
  name: string;
  /** When it was taken, parsed from the name. */
  at: Date;
};

export type GfsPolicy = {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
};

/**
 * A week of dailies, a month of weeklies, a year of monthlies. Yearly off by default —
 * it is the tier people most often enable without meaning to keep data for a decade.
 */
export const DEFAULT_GFS: GfsPolicy = { keepDaily: 7, keepWeekly: 4, keepMonthly: 12, keepYearly: 0 };

/** The exact shape `resolveDestination` produces: YYYY-MM-DD-HH-MM-SS. */
const SNAPSHOT_NAME = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/;

/**
 * A snapshot folder name to the moment it was taken, or null if this isn't one of ours.
 *
 * Null is the safe answer and the common one: anything this cannot parse is someone else's
 * folder, and will never be offered for deletion.
 */
export function parseSnapshotName(name: string): Date | null {
  const m = SNAPSHOT_NAME.exec(name);
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  // The copy engine stamps from an ISO string, so these are UTC parts.
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));

  // Round-trip check: catches 2026-02-30 and friends, which Date would silently roll over
  // into March rather than rejecting.
  if (
    at.getUTCFullYear() !== y ||
    at.getUTCMonth() !== mo - 1 ||
    at.getUTCDate() !== d ||
    at.getUTCHours() !== h ||
    at.getUTCMinutes() !== mi ||
    at.getUTCSeconds() !== s
  ) {
    return null;
  }
  return at;
}

/** Names that are snapshots, paired with their moment. Everything else is dropped. */
export function toSnapshots(names: string[]): Snapshot[] {
  const out: Snapshot[] = [];
  for (const name of names) {
    const at = parseSnapshotName(name);
    if (at) out.push({ name, at });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime()); // newest first
}

const pad = (n: number) => String(n).padStart(2, "0");

const dayKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
const yearKey = (d: Date) => String(d.getUTCFullYear());

/**
 * ISO-8601 week key. Weeks start Monday and belong to the year containing their Thursday,
 * which is why this can't just divide by seven: the last days of December frequently belong
 * to week 1 of the following year, and getting that wrong silently merges two weeks into
 * one bucket and deletes a backup that should have been kept.
 */
function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // the Thursday of this week
  const isoYear = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${pad(week)}`;
}

export type Kept = { snapshot: Snapshot; because: string };

export type RetentionPlan = {
  /** Snapshots to keep, each with the tier that saved it — so a log can explain itself. */
  keep: Kept[];
  /** Snapshots that may be removed. Never includes the newest. */
  remove: Snapshot[];
};

/**
 * Decide what survives.
 *
 * `snapshots` need not be sorted. The newest is ALWAYS kept regardless of policy — a
 * retention setting of all zeros must still leave you with a backup, because a policy that
 * can empty the destination is a policy one typo away from destroying everything.
 */
export function selectForRetention(snapshots: Snapshot[], policy: GfsPolicy): RetentionPlan {
  const sorted = [...snapshots].sort((a, b) => b.at.getTime() - a.at.getTime()); // newest first
  if (sorted.length === 0) return { keep: [], remove: [] };

  /** The reason each kept snapshot survived, by name. First tier to claim it wins. */
  const reasons = new Map<string, string>();

  // Non-negotiable, and first so it is the reason reported.
  reasons.set(sorted[0].name, "the most recent backup");

  const applyTier = (count: number, key: (d: Date) => string, label: string) => {
    if (count <= 0) return;
    const seen = new Set<string>();
    for (const snap of sorted) {
      // Sorted newest-first, so the first snapshot seen for a period is that period's most
      // recent — "the last backup of that month".
      const k = key(snap.at);
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > count) break; // past the N most recent periods
      if (!reasons.has(snap.name)) reasons.set(snap.name, `${label} ${k}`);
    }
  };

  applyTier(policy.keepDaily, dayKey, "daily");
  applyTier(policy.keepWeekly, weekKey, "weekly");
  applyTier(policy.keepMonthly, monthKey, "monthly");
  applyTier(policy.keepYearly, yearKey, "yearly");

  const keep: Kept[] = [];
  const remove: Snapshot[] = [];
  for (const snap of sorted) {
    const because = reasons.get(snap.name);
    if (because) keep.push({ snapshot: snap, because });
    else remove.push(snap);
  }
  return { keep, remove };
}

/** One line an admin can read: "keeping 7 daily, 4 weekly, 12 monthly". */
export function describePolicy(p: GfsPolicy): string {
  const parts = [
    p.keepDaily > 0 ? `${p.keepDaily} daily` : "",
    p.keepWeekly > 0 ? `${p.keepWeekly} weekly` : "",
    p.keepMonthly > 0 ? `${p.keepMonthly} monthly` : "",
    p.keepYearly > 0 ? `${p.keepYearly} yearly` : "",
  ].filter(Boolean);
  return parts.length ? `keeping ${parts.join(", ")}` : "keeping only the most recent backup";
}
