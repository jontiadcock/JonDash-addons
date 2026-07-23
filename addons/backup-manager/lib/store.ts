import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import { nextRun, parseDays, type Schedule } from "./schedule";

/** Every read and write in one place. `db.table()` resolves the real `mod_…` name. */
type Db = NonNullable<ModuleContext["db"]>;

export type Job = {
  id: string;
  name: string;
  sourceRootId: string;
  sourceSubpath: string;
  destRootId: string;
  destSubpath: string;
  mode: "sync" | "snapshot";
  excludeCsv: string;
  everyHours: number;
  atMinute: number;
  enabled: number;
  nextRunAt: string | null;

  /** 'interval' (every N hours) or 'daily' (at a time, on chosen days). */
  scheduleKind: "interval" | "daily";
  /** Daily only. CSV of 0-6, 0 = Sunday. Empty means every day. */
  daysCsv: string;

  /** 0 disables retrying; a failure then simply waits for the next scheduled slot. */
  maxRetries: number;
  /** Drives the backoff, cleared on any success. Also "how long has this been broken?". */
  consecutiveFailures: number;

  /** Grandfather-father-son retention. Snapshot mode only, and only when `pruneEnabled`. */
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  /** Retention DELETES, so it is opted into per job rather than defaulted on. */
  pruneEnabled: number;

  notifyEmail: string;
  notifyWebhook: string;
  /** Alert if no run has SUCCEEDED in this many hours. 0 disables. */
  staleAfterHours: number;
  lastNotifiedAt: string | null;

  createdAt: string;
};

export type Run = {
  id: string;
  jobId: string;
  helperRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  state: string;
  filesCopied: number;
  bytesCopied: number;
  skippedCount: number;
  errorCount: number;
  prunedCount: number;
  message: string | null;
};

/** The retention policy in the shape the helper expects. */
export function policyOf(job: Job) {
  return {
    keepDaily: job.keepDaily,
    keepWeekly: job.keepWeekly,
    keepMonthly: job.keepMonthly,
    keepYearly: job.keepYearly,
  };
}

const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

export async function listJobs(db: Db): Promise<Job[]> {
  return db.query<Job>(`SELECT * FROM ${db.table("jobs")} ORDER BY name`);
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  const rows = await db.query<Job>(`SELECT * FROM ${db.table("jobs")} WHERE id = ?`, id);
  return rows[0] ?? null;
}

export async function saveJob(db: Db, job: Job): Promise<void> {
  await db.run(
    `INSERT INTO ${db.table("jobs")}
       (id, name, sourceRootId, sourceSubpath, destRootId, destSubpath, mode, excludeCsv,
        everyHours, atMinute, enabled, nextRunAt,
        scheduleKind, daysCsv, maxRetries, consecutiveFailures,
        keepDaily, keepWeekly, keepMonthly, keepYearly, pruneEnabled,
        notifyEmail, notifyWebhook, staleAfterHours, lastNotifiedAt, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, sourceRootId=excluded.sourceRootId, sourceSubpath=excluded.sourceSubpath,
       destRootId=excluded.destRootId, destSubpath=excluded.destSubpath, mode=excluded.mode,
       excludeCsv=excluded.excludeCsv, everyHours=excluded.everyHours, atMinute=excluded.atMinute,
       enabled=excluded.enabled, nextRunAt=excluded.nextRunAt,
       scheduleKind=excluded.scheduleKind, daysCsv=excluded.daysCsv,
       maxRetries=excluded.maxRetries,
       keepDaily=excluded.keepDaily, keepWeekly=excluded.keepWeekly,
       keepMonthly=excluded.keepMonthly, keepYearly=excluded.keepYearly,
       pruneEnabled=excluded.pruneEnabled, notifyEmail=excluded.notifyEmail,
       notifyWebhook=excluded.notifyWebhook, staleAfterHours=excluded.staleAfterHours`,
    job.id, job.name, job.sourceRootId, job.sourceSubpath, job.destRootId, job.destSubpath,
    job.mode, job.excludeCsv, job.everyHours, job.atMinute, job.enabled, job.nextRunAt,
    job.scheduleKind, job.daysCsv, job.maxRetries, job.consecutiveFailures,
    job.keepDaily, job.keepWeekly, job.keepMonthly, job.keepYearly, job.pruneEnabled,
    job.notifyEmail, job.notifyWebhook, job.staleAfterHours, job.lastNotifiedAt, job.createdAt,
  );
}

export async function deleteJob(db: Db, id: string): Promise<void> {
  await db.run(`DELETE FROM ${db.table("runs")} WHERE jobId = ?`, id);
  await db.run(`DELETE FROM ${db.table("jobs")} WHERE id = ?`, id);
}

/**
 * Jobs whose time has come. The scheduler helper has no notion of time of day — it ticks —
 * so the timing lives here, in data the admin can edit, and each tick asks this.
 */
export async function dueJobs(db: Db, now = new Date()): Promise<Job[]> {
  return db.query<Job>(
    `SELECT * FROM ${db.table("jobs")}
      WHERE enabled = 1 AND (nextRunAt IS NULL OR nextRunAt <= ?)
      ORDER BY nextRunAt`,
    now.toISOString(),
  );
}

/** A job's schedule in the shape `lib/schedule.ts` works with. */
export function scheduleOf(job: Pick<Job, "scheduleKind" | "everyHours" | "atMinute" | "daysCsv">): Schedule {
  return {
    kind: job.scheduleKind === "daily" ? "daily" : "interval",
    everyHours: job.everyHours,
    atMinute: job.atMinute,
    days: parseDays(job.daysCsv ?? ""),
  };
}

/**
 * The next time this job should run.
 *
 * The arithmetic lives in `lib/schedule.ts` — pure, and tested there rather than here,
 * because "every weeknight at 2am" crossing a month end is exactly the kind of thing that
 * looks right and silently isn't.
 */
export function computeNextRun(
  job: Pick<Job, "scheduleKind" | "everyHours" | "atMinute" | "daysCsv">,
  from = new Date(),
): string {
  return nextRun(scheduleOf(job), from).toISOString();
}

export async function markRun(db: Db, jobId: string, nextRunAt: string): Promise<void> {
  await db.run(`UPDATE ${db.table("jobs")} SET nextRunAt = ? WHERE id = ?`, nextRunAt, jobId);
}

export async function startRun(db: Db, id: string, jobId: string, helperRunId: string | null): Promise<void> {
  await db.run(
    `INSERT INTO ${db.table("runs")} (id, jobId, helperRunId, startedAt, state) VALUES (?, ?, ?, ?, 'running')`,
    id, jobId, helperRunId, new Date().toISOString(),
  );
}

/** A job's own no-overlap guard: is one of its runs still going? Stops a slow backup that
 *  outlasts its interval from being started a second time on the next tick. */
export async function runningRunForJob(db: Db, jobId: string): Promise<Run | null> {
  const rows = await db.query<Run>(
    `SELECT * FROM ${db.table("runs")} WHERE jobId = ? AND state = 'running' LIMIT 1`,
    jobId,
  );
  return rows[0] ?? null;
}

/** Runs this module thinks are still going and can ask the helper about. */
export async function runsAwaitingReconcile(db: Db): Promise<Run[]> {
  return db.query<Run>(
    `SELECT * FROM ${db.table("runs")} WHERE state = 'running' AND helperRunId IS NOT NULL`,
  );
}

export type RunOutcome = {
  state: string;
  filesCopied: number;
  bytesCopied: number;
  skippedCount?: number;
  errorCount?: number;
  message: string | null;
};

export async function finishRun(db: Db, id: string, outcome: RunOutcome): Promise<void> {
  await db.run(
    `UPDATE ${db.table("runs")}
        SET finishedAt = ?, state = ?, filesCopied = ?, bytesCopied = ?,
            skippedCount = ?, errorCount = ?, message = ?
      WHERE id = ?`,
    new Date().toISOString(), outcome.state, outcome.filesCopied, outcome.bytesCopied,
    outcome.skippedCount ?? 0, outcome.errorCount ?? 0, outcome.message, id,
  );
}

/** Retention is applied after the copy, so its count lands on the run separately. */
export async function recordPruned(db: Db, id: string, prunedCount: number): Promise<void> {
  await db.run(`UPDATE ${db.table("runs")} SET prunedCount = ? WHERE id = ?`, prunedCount, id);
}

/** When this job last finished successfully — the basis of the "nothing has run" alert. */
export async function lastSuccessAt(db: Db, jobId: string): Promise<string | null> {
  const rows = await db.query<{ startedAt: string }>(
    `SELECT startedAt FROM ${db.table("runs")}
      WHERE jobId = ? AND state = 'done' ORDER BY startedAt DESC LIMIT 1`,
    jobId,
  );
  return rows[0]?.startedAt ?? null;
}

/** Stops a permanently broken job emailing on every tick. */
export async function markNotified(db: Db, jobId: string): Promise<void> {
  await db.run(
    `UPDATE ${db.table("jobs")} SET lastNotifiedAt = ? WHERE id = ?`,
    new Date().toISOString(), jobId,
  );
}

/** A run ended. Track the streak, because it decides both retries and alert wording. */
export async function recordOutcome(db: Db, jobId: string, ok: boolean): Promise<number> {
  if (ok) {
    await db.run(`UPDATE ${db.table("jobs")} SET consecutiveFailures = 0 WHERE id = ?`, jobId);
    return 0;
  }
  await db.run(
    `UPDATE ${db.table("jobs")} SET consecutiveFailures = consecutiveFailures + 1 WHERE id = ?`,
    jobId,
  );
  const rows = await db.query<{ n: unknown }>(
    `SELECT consecutiveFailures AS n FROM ${db.table("jobs")} WHERE id = ?`,
    jobId,
  );
  return num(rows[0]?.n);
}

// ---------------------------------------------------------------- module-wide settings

/**
 * How many backups may copy at once.
 *
 * A property of the machine's disk, not of any one job: five jobs firing at 2am against one
 * spinning disk take longer in total than running them one after another, and make
 * everything else on the box unusable while they do. Default 1 — sequential — because that
 * is the safe answer and nobody is waiting.
 */
export const DEFAULT_CONCURRENCY = 1;

export async function getConcurrency(db: Db): Promise<number> {
  const rows = await db.query<{ value: string }>(
    `SELECT value FROM ${db.table("settings")} WHERE key = 'concurrency'`,
  );
  const raw = rows[0]?.value;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_CONCURRENCY;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(16, Math.trunc(n)) : DEFAULT_CONCURRENCY;
}

export async function setConcurrency(db: Db, n: number): Promise<number> {
  const safe = Number.isFinite(n) && n >= 1 ? Math.min(16, Math.trunc(n)) : DEFAULT_CONCURRENCY;
  await db.run(
    `INSERT INTO ${db.table("settings")} (key, value) VALUES ('concurrency', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(safe),
  );
  return safe;
}

/** Turn every job on or off in one go — for "we're moving the NAS this weekend". */
export async function setAllEnabled(db: Db, enabled: boolean): Promise<void> {
  await db.run(`UPDATE ${db.table("jobs")} SET enabled = ?`, enabled ? 1 : 0);
}

export async function recentRuns(db: Db, limit = 25): Promise<Run[]> {
  return db.query<Run>(`SELECT * FROM ${db.table("runs")} ORDER BY startedAt DESC LIMIT ?`, limit);
}

export async function getRun(db: Db, id: string): Promise<Run | null> {
  const rows = await db.query<Run>(`SELECT * FROM ${db.table("runs")} WHERE id = ?`, id);
  return rows[0] ?? null;
}

/** One job's own history, for its detail page. */
export async function runsForJob(db: Db, jobId: string, limit = 50): Promise<Run[]> {
  return db.query<Run>(
    `SELECT * FROM ${db.table("runs")} WHERE jobId = ? ORDER BY startedAt DESC LIMIT ?`,
    jobId,
    limit,
  );
}

/**
 * Everything currently in flight, across all jobs.
 *
 * The dashboard widget asks this on every render, which is why the runs table carries an
 * index on `state` — without it this is a full scan of every run ever recorded, on a query
 * that runs whenever anybody looks at their dashboard.
 */
export async function runningRuns(db: Db): Promise<Run[]> {
  return db.query<Run>(`SELECT * FROM ${db.table("runs")} WHERE state = 'running' ORDER BY startedAt`);
}

/** Rolled-up numbers for one job, so a summary doesn't need every row. */
export type JobStats = {
  total: number;
  failures: number;
  /** Mean duration of finished runs, in ms. Null when nothing has finished yet. */
  averageMs: number | null;
  lastSuccessAt: string | null;
};

export async function statsForJob(db: Db, jobId: string): Promise<JobStats> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN state <> 'done' AND finishedAt IS NOT NULL THEN 1 ELSE 0 END) AS failures,
       AVG(CASE WHEN finishedAt IS NOT NULL
                THEN (julianday(finishedAt) - julianday(startedAt)) * 86400000.0 END) AS averageMs
     FROM ${db.table("runs")} WHERE jobId = ?`,
    jobId,
  );
  const r = rows[0] ?? {};
  const avg = r.averageMs == null ? null : num(r.averageMs);
  return {
    total: num(r.total),
    failures: num(r.failures),
    averageMs: avg,
    lastSuccessAt: await lastSuccessAt(db, jobId),
  };
}

export async function lastRunFor(db: Db, jobId: string): Promise<Run | null> {
  const rows = await db.query<Run>(
    `SELECT * FROM ${db.table("runs")} WHERE jobId = ? ORDER BY startedAt DESC LIMIT 1`,
    jobId,
  );
  return rows[0] ?? null;
}

/**
 * A run left `running` with no finish time can only be one thing: the server stopped
 * mid-copy. It must never be reported as a good backup.
 */
export async function reconcileInterrupted(db: Db): Promise<number> {
  const rows = await db.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM ${db.table("runs")} WHERE state = 'running'`,
  );
  await db.run(
    `UPDATE ${db.table("runs")} SET state = 'failed', finishedAt = ?, message = 'Interrupted — JonDash stopped while this backup was running.' WHERE state = 'running'`,
    new Date().toISOString(),
  );
  return num(rows[0]?.n);
}
