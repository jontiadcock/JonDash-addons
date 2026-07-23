import type { ModuleContext, ModuleDefinition } from "@/lib/modules/types";
import filesystem from "@/helpers/filesystem/api";
import BackupPage from "./page";
import BackupSettingsPanel from "./ui/settings-panel";
import { MODULE_ID } from "./lib/constants";
import { failureAlert, send, shouldNotify, staleAlert, type Alert } from "./lib/notify";
import {
  computeNextRun,
  dueJobs,
  finishRun,
  getJob,
  lastSuccessAt,
  listJobs,
  markNotified,
  markRun,
  policyOf,
  reconcileInterrupted,
  recordPruned,
  runningRunForJob,
  runsAwaitingReconcile,
  startRun,
  type Job,
} from "./lib/store";

/**
 * Backup Manager — keeps folders copied somewhere else, on a schedule.
 *
 * It performs no file access itself; it cannot. Everything is done by the `filesystem`
 * helper, which confines every operation to a folder the administrator approved and
 * excludes JonDash's own secrets by file identity. This module decides WHAT to copy and
 * WHEN, records what happened, and shouts when something didn't.
 */
const backupManager: ModuleDefinition = {
  id: MODULE_ID,
  name: "Backup Manager",
  description:
    "Keeps folders copied to another location — a network share or an external drive — on a schedule, and tells you what it did.",
  version: "0.0.1",
  // `ctx.can()` enforcement and GFS retention arrived in filesystem 0.0.3, which needs
  // JonDash 1.5.2. The pre-release, not a bare "1.5.2" — semver ranks a pre-release below
  // its release, so a bare number is refused on every 1.5.2 beta.
  minAppVersion: "1.5.2-beta.1",

  /**
   * `filesystem:*` come from the helper, not core.
   *
   * `filesystem:delete` is here because GFS retention removes old snapshots. It is the
   * heaviest thing on this consent screen and it is honest: this module genuinely deletes.
   * Retention is off by default on every job, so nothing is removed until an admin turns it
   * on for a specific one.
   *
   * `email:send` and `network:outbound` are for failure alerts. Both are opt-in per job,
   * but the permission is declared regardless — a consent screen must describe what the
   * module CAN do, not what it happens to be configured to do today.
   */
  permissions: [
    "filesystem:read",
    "filesystem:write",
    "filesystem:delete",
    "email:send",
    "network:outbound",
    "audit:write",
  ],

  /**
   * `filesystem` is PINNED, `scheduler` is not.
   *
   * This module calls `prune`, `planPrune` and `listSnapshots`, none of which existed before
   * filesystem 0.0.3. Against 0.0.2 they are simply undefined, and the failure would land at
   * the first scheduled run — in the background, at 2am, on somebody's server.
   *
   * Be precise about what the floor buys, because it is less than it looks: core reads
   * `minVersion` to work out which modules a helper update would BREAK (paired with the
   * helper's `breakingFrom`), and surfaces that on Admin → Updates. It does not refuse an
   * install against an older helper. So this is a truthful declaration that makes that
   * warning correct for this module — not a guard. What actually keeps the pairing sane is
   * that helpers install from the same official source and channel, and now have their own
   * update path.
   *
   * `scheduler` needs no floor: this module only DECLARES schedules, which every published
   * version has supported. Stating a floor we don't require would make the break-analysis
   * wrong in the other direction.
   */
  helpers: [{ id: "filesystem", minVersion: "0.0.3-beta.1" }, "scheduler"],

  /** Backups are infrastructure: the paths alone tell you how the machine is laid out. */
  adminOnly: true,

  /**
   * The scheduler ticks; the timing lives in the jobs table.
   *
   * That is the supported way to get "every night at 2am" — `everyMs` is fixed when a
   * module is defined, so a job's own `nextRunAt` is what actually decides, and an admin can
   * edit it without a release.
   */
  schedules: [
    {
      key: "run-due",
      everyMs: 60_000,
      run: async (ctx) => {
        if (!ctx.db) return;
        // Finish anything the helper has completed since the last tick FIRST, so a job that
        // just ended stops counting as running and becomes eligible again.
        await reconcileRuns(ctx);
        await checkForStaleJobs(ctx);

        for (const job of await dueJobs(ctx.db)) {
          // Re-stamp BEFORE starting: a job that fails must not retry every single minute.
          await markRun(ctx.db, job.id, computeNextRun(job));
          await runJob(ctx, job.id);
        }
      },
    },
  ],

  Page: BackupPage,
  SettingsPanel: BackupSettingsPanel,
  migrations: "./migrations",

  /** A run still marked `running` means the server stopped mid-copy — never a good backup. */
  async onEnable(ctx) {
    if (ctx.db) await reconcileInterrupted(ctx.db);
  },
};

/**
 * Start one job — and return.
 *
 * It does NOT wait for the copy to finish: a backup can take hours, and nothing that renders
 * a page or ticks a schedule may block for that long. The helper owns the run and records
 * its outcome; `reconcileRuns` picks the result up on a later tick. The same function serves
 * the schedule and the "Run now" button, so both behave identically.
 */
export async function runJob(ctx: ModuleContext, jobId: string): Promise<void> {
  if (!ctx.db) return;

  // Don't stack a second copy of a job whose last run is still going.
  if (await runningRunForJob(ctx.db, jobId)) return;

  const job = await getJob(ctx.db, jobId);
  if (!job) return;

  const started = await filesystem(ctx).start({
    sourceRootId: job.sourceRootId,
    sourceSubpath: job.sourceSubpath || undefined,
    destRootId: job.destRootId,
    destSubpath: job.destSubpath || undefined,
    mode: job.mode,
    exclude: job.excludeCsv ? job.excludeCsv.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  });

  const runId = crypto.randomUUID();
  if (!started.ok) {
    // Refused before it began — recorded as a failed run so the reason is visible, and
    // alerted on, because "it never started" is a failure like any other.
    await startRun(ctx.db, runId, job.id, null);
    await finishRun(ctx.db, runId, {
      state: "failed",
      filesCopied: 0,
      bytesCopied: 0,
      message: started.reason,
    });
    await ctx.audit?.("backup.run.failed", `${job.name}: ${started.reason}`);
    await alert(ctx, job, failureAlert(job, started.reason));
    return;
  }

  await startRun(ctx.db, runId, job.id, started.runId);
  await ctx.audit?.("backup.run.start", job.name);
}

/**
 * Bring every run this module thinks is going into line with the helper's record — the one
 * authority that survives both the run ending and a restart.
 *
 * This replaces a blocking poll: instead of one job holding a thread for hours, each tick
 * briefly checks the ones in flight.
 */
export async function reconcileRuns(ctx: ModuleContext): Promise<void> {
  if (!ctx.db) return;
  const fs = filesystem(ctx);

  for (const run of await runsAwaitingReconcile(ctx.db)) {
    const status = run.helperRunId ? await fs.status(run.helperRunId) : null;

    if (!status) {
      // The helper has no record of it — interrupted at boot, or lost. Never a finished
      // backup.
      const message = "Interrupted — JonDash stopped while this backup was running.";
      await finishRun(ctx.db, run.id, { state: "failed", filesCopied: 0, bytesCopied: 0, message });
      await ctx.audit?.("backup.run.interrupted", run.jobId);
      const job = await getJob(ctx.db, run.jobId);
      if (job) await alert(ctx, job, failureAlert(job, message));
      continue;
    }
    if (status.state === "running") continue; // still going; leave it

    const message =
      status.state === "done" && status.errorCount > 0
        ? `Finished, but ${status.errorCount} file(s) could not be copied.`
        : status.error;

    await finishRun(ctx.db, run.id, {
      state: status.state,
      filesCopied: status.filesCopied,
      bytesCopied: status.bytesCopied,
      skippedCount: status.skippedCount,
      errorCount: status.errorCount,
      message,
    });
    await ctx.audit?.(
      "backup.run.finish",
      `${run.jobId}: ${status.state}, ${status.filesCopied} file(s), ${status.skippedCount} skipped`,
    );

    const job = await getJob(ctx.db, run.jobId);
    if (!job) continue;

    if (status.state !== "done") {
      await alert(ctx, job, failureAlert(job, message ?? `The run ended as "${status.state}".`));
      continue;
    }

    // Retention runs only after a SUCCESSFUL copy. Pruning old snapshots because a failed
    // run left the destination looking full is exactly how you lose the good ones.
    await applyRetention(ctx, job, run.id);
  }
}

/**
 * Apply this job's GFS policy, if it has one turned on.
 *
 * Guarded three ways before anything is destroyed: snapshot mode only (a `sync` job writes
 * into one folder, so there is nothing dated to thin), explicitly enabled, and only after
 * the copy it belongs to actually succeeded.
 */
async function applyRetention(ctx: ModuleContext, job: Job, runId: string): Promise<void> {
  if (!ctx.db) return;
  if (job.mode !== "snapshot" || !job.pruneEnabled) return;

  const result = await filesystem(ctx).prune(job.destRootId, policyOf(job), job.destSubpath || undefined);
  if (!result.ok) {
    // A refused prune does not fail the backup — the copy already succeeded and is intact.
    await ctx.audit?.("backup.prune.refused", `${job.name}: ${result.reason}`);
    return;
  }
  if (result.removed.length === 0) return;

  await recordPruned(ctx.db, runId, result.removed.length);
  await ctx.audit?.(
    "backup.prune.done",
    `${job.name}: removed ${result.removed.length}, kept ${result.kept}`,
  );
}

/**
 * The alarm nobody remembers to build: a job that stopped running raises nothing, because
 * nothing failed. A disabled schedule, a deleted job, a server that never came back — all
 * silent until the day you need the backup.
 */
async function checkForStaleJobs(ctx: ModuleContext): Promise<void> {
  if (!ctx.db) return;
  const now = Date.now();

  for (const job of await listJobs(ctx.db)) {
    if (!job.enabled || job.staleAfterHours <= 0) continue;
    if (!shouldNotify(job)) continue;

    const last = await lastSuccessAt(ctx.db, job.id);
    const age = last ? now - Date.parse(last) : Infinity;
    if (age < job.staleAfterHours * 3_600_000) continue;

    await alert(ctx, job, staleAlert(job, job.staleAfterHours, last));
  }
}

/** Send, record that we did, and never let it disturb the caller. */
async function alert(ctx: ModuleContext, job: Job, a: Alert): Promise<void> {
  if (!ctx.db) return;
  if (!shouldNotify(job)) return;
  try {
    const sent = await send(ctx, a);
    await markNotified(ctx.db, job.id);
    if (sent.length) await ctx.audit?.("backup.notify.sent", `${job.name}: ${sent.join(", ")}`);
  } catch {
    // Notification is best-effort by design. The run's outcome is already recorded.
  }
}

export default backupManager;
