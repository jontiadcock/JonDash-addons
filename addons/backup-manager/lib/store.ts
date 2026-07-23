import "server-only";
import type { ModuleContext } from "@/lib/modules/types";

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
        keepDaily, keepWeekly, keepMonthly, keepYearly, pruneEnabled,
        notifyEmail, notifyWebhook, staleAfterHours, lastNotifiedAt, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, sourceRootId=excluded.sourceRootId, sourceSubpath=excluded.sourceSubpath,
       destRootId=excluded.destRootId, destSubpath=excluded.destSubpath, mode=excluded.mode,
       excludeCsv=excluded.excludeCsv, everyHours=excluded.everyHours, atMinute=excluded.atMinute,
       enabled=excluded.enabled, nextRunAt=excluded.nextRunAt,
       keepDaily=excluded.keepDaily, keepWeekly=excluded.keepWeekly,
       keepMonthly=excluded.keepMonthly, keepYearly=excluded.keepYearly,
       pruneEnabled=excluded.pruneEnabled, notifyEmail=excluded.notifyEmail,
       notifyWebhook=excluded.notifyWebhook, staleAfterHours=excluded.staleAfterHours`,
    job.id, job.name, job.sourceRootId, job.sourceSubpath, job.destRootId, job.destSubpath,
    job.mode, job.excludeCsv, job.everyHours, job.atMinute, job.enabled, job.nextRunAt,
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

/**
 * The next time this job should run: today at `atMinute` if that is still ahead, else
 * `everyHours` from that point. Computed rather than "now + interval" so a job set for
 * 02:00 stays at 02:00 instead of drifting later every night.
 */
export function computeNextRun(job: Pick<Job, "everyHours" | "atMinute">, from = new Date()): string {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(0, job.atMinute, 0, 0);
  const stepMs = Math.max(1, job.everyHours) * 3_600_000;
  while (next.getTime() <= from.getTime()) next.setTime(next.getTime() + stepMs);
  return next.toISOString();
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

export async function recentRuns(db: Db, limit = 25): Promise<Run[]> {
  return db.query<Run>(`SELECT * FROM ${db.table("runs")} ORDER BY startedAt DESC LIMIT ?`, limit);
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
