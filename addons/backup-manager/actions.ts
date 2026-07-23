"use server";
import { moduleAction } from "@/lib/modules/api";
import { revalidatePath } from "next/cache";
import filesystem from "@/helpers/filesystem/api";
import { MODULE_ID, ADMIN_PATH, MODULE_PATH } from "./lib/constants";
import { formatDays, parseDays } from "./lib/schedule";
import {
  computeNextRun,
  deleteJob,
  getJob,
  getRun,
  policyOf,
  saveJob,
  setAllEnabled,
  setConcurrency,
  setDigestEmail,
  type Job,
} from "./lib/store";
import { runJob } from "./module";

/**
 * Everything that changes something.
 *
 * `moduleAction` is a FACTORY: it wraps a handler and returns the action, so each export
 * below is the wrapped function rather than a call to it. The wrapper asserts same-origin,
 * refuses if the module is disabled, and builds a context scoped to exactly the permissions
 * this module declared.
 *
 * All of these are used from plain server-rendered `<form action={…}>`, so each takes only
 * FormData and returns nothing. Outcomes are read from the page, not from a return value —
 * no client JavaScript, and no state that can fall out of step with the database.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const int = (f: FormData, k: string, dflt: number) => {
  const n = Number(f.get(k));
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : dflt;
};
const bool = (f: FormData, k: string) => (f.get(k) ? 1 : 0);

/** Assess a folder WITHOUT saving it — the warning an admin reads before committing. */
export const assessPathAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const a = filesystem(ctx).assessPath(str(form, "path"));
  await ctx.store?.set(
    "lastAssess",
    JSON.stringify(
      a.ok
        ? {
            path: a.path,
            level: a.risk.level,
            headline: a.risk.headline,
            reasons: a.risk.reasons,
            advice: a.risk.advice,
            canBeDestination: a.canBeDestination,
            destinationReason: a.destinationReason,
          }
        : { error: a.reason },
    ),
  );
  revalidatePath(ADMIN_PATH);
});

/** Allow a folder. Refusals are audited by the helper itself, so nothing is silent. */
export const addRootAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const res = await filesystem(ctx).addRoot({ path: str(form, "path"), label: str(form, "label") });
  await ctx.store?.set("lastRoot", res.ok ? `Allowed ${res.root.path}` : `Refused: ${res.reason}`);
  revalidatePath(ADMIN_PATH);
});

export const removeRootAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  await filesystem(ctx).removeRoot(str(form, "rootId"));
  revalidatePath(ADMIN_PATH);
});

/** Prove a location works BEFORE relying on it nightly. Does real I/O, on demand only. */
export const testLocationAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const r = await filesystem(ctx).testLocation(str(form, "path"));
  await ctx.store?.set("lastTest", `${r.ok ? "OK" : "Failed"} — ${r.message} (${r.elapsedMs}ms)`);
  revalidatePath(ADMIN_PATH);
});

export const saveJobAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const name = str(form, "name");
  const sourceRootId = str(form, "sourceRootId");
  const destRootId = str(form, "destRootId");
  if (!name || !sourceRootId || !destRootId) return;

  const id = str(form, "id");
  const existing = id ? await getJob(ctx.db, id) : null;

  const job: Job = {
    id: id || crypto.randomUUID(),
    name,
    sourceRootId,
    sourceSubpath: str(form, "sourceSubpath"),
    destRootId,
    destSubpath: str(form, "destSubpath"),
    mode: str(form, "mode") === "snapshot" ? "snapshot" : "sync",
    excludeCsv: str(form, "excludeCsv"),
    everyHours: Math.min(720, Math.max(1, int(form, "everyHours", 24))),
    atMinute: Math.min(1439, int(form, "atMinute", 120)),
    enabled: bool(form, "enabled"),
    nextRunAt: null,

    scheduleKind: str(form, "scheduleKind") === "daily" ? "daily" : "interval",
    // Checkboxes named `days` — absent entirely when none are ticked, which correctly means
    // "every day". Normalised through parseDays so nothing odd reaches the database.
    daysCsv: formatDays(parseDays(form.getAll("days").map(String).join(","))),
    maxRetries: Math.min(10, int(form, "maxRetries", 0)),
    // Preserved: editing a job's settings must not reset how broken it currently is, or the
    // backoff starts again from five minutes on every save.
    consecutiveFailures: existing?.consecutiveFailures ?? 0,

    keepDaily: int(form, "keepDaily", 7),
    keepWeekly: int(form, "keepWeekly", 4),
    keepMonthly: int(form, "keepMonthly", 12),
    keepYearly: int(form, "keepYearly", 0),
    pruneEnabled: bool(form, "pruneEnabled"),

    notifyEmail: str(form, "notifyEmail"),
    notifyWebhook: str(form, "notifyWebhook"),
    staleAfterHours: int(form, "staleAfterHours", 0),
    // Preserved across an edit, so changing a setting doesn't re-open the alert floodgate
    // on a job that is already known to be broken.
    lastNotifiedAt: existing?.lastNotifiedAt ?? null,

    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  job.nextRunAt = computeNextRun(job);

  await saveJob(ctx.db, job);
  await ctx.audit?.(
    "backup.job.save",
    `${job.name} (${job.mode}${job.pruneEnabled ? ", retention on" : ""})`,
  );
  // Confirm in words. The form lives inside a <details>, and a server re-render resets that
  // element's open state — so without this the section simply folds shut and you are left
  // guessing whether anything happened.
  await ctx.store?.set("lastJobSave", `Saved “${job.name}”. Next run ${job.enabled ? job.nextRunAt : "— paused"}.`);
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
});

export const deleteJobAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const id = str(form, "id");
  const job = await getJob(ctx.db, id);
  await deleteJob(ctx.db, id);
  await ctx.audit?.("backup.job.delete", job?.name ?? id);
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
});

/** Run one now. Starts it and returns; the result appears once the helper finishes and the
 *  next tick reconciles — the same code path as the schedule, so both behave identically. */
export const runNowAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  await runJob(ctx, str(form, "id"));
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
});

/**
 * What retention WOULD remove for this job, having removed nothing.
 *
 * Deliberately available whether or not retention is enabled — seeing the answer is how an
 * admin decides whether to turn it on.
 */
export const previewPruneAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const job = await getJob(ctx.db, str(form, "id"));
  if (!job) return;

  const r = await filesystem(ctx).planPrune(job.destRootId, policyOf(job), job.destSubpath || undefined);
  await ctx.store?.set(
    "lastPrunePreview",
    JSON.stringify(
      r.ok
        ? {
            job: job.name,
            keep: r.plan.keep,
            remove: r.plan.remove.map((s) => s.name),
            ignored: r.plan.ignored,
          }
        : { job: job.name, error: r.reason },
    ),
  );
  revalidatePath(ADMIN_PATH);
});

/** Read one run's log back, for reading in place or copying out. */
export const viewLogAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const text = await filesystem(ctx).logText(str(form, "runId"));
  await ctx.store?.set("lastLog", text ?? "That log has been removed by the log retention policy.");
  revalidatePath(MODULE_PATH);
});

/**
 * Stop a backup that is currently running.
 *
 * The helper checks the abort flag between files, so a huge file in progress still
 * finishes rather than leaving a half-written one at the destination. The run then
 * reconciles as `cancelled` on the next tick, like any other outcome — cancelling is not a
 * failure and must not be reported as one.
 */
export const cancelRunAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const run = await getRun(ctx.db, str(form, "runId"));
  if (!run?.helperRunId) return;
  filesystem(ctx).cancel(run.helperRunId);
  await ctx.audit?.("backup.run.cancel", run.jobId);
  revalidatePath(MODULE_PATH);
  revalidatePath(ADMIN_PATH);
});

/**
 * A dry run of the BACKUP itself — what it would copy, having copied nothing.
 *
 * Distinct from the retention preview, which is about what would be deleted. This is the
 * question people actually ask before trusting a new job: "is it going to pick up what I
 * think it will?"
 */
export const previewBackupAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const job = await getJob(ctx.db, str(form, "id"));
  if (!job) return;

  const r = await filesystem(ctx).plan({
    sourceRootId: job.sourceRootId,
    sourceSubpath: job.sourceSubpath || undefined,
    destRootId: job.destRootId,
    destSubpath: job.destSubpath || undefined,
    mode: job.mode,
    exclude: job.excludeCsv ? job.excludeCsv.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  });

  await ctx.store?.set(
    "lastBackupPreview",
    JSON.stringify(
      r.ok
        ? {
            job: job.name,
            destination: r.plan.destination,
            create: r.plan.toCreate.length,
            update: r.plan.toUpdate.length,
            unchanged: r.plan.unchanged,
            bytes: r.plan.totalBytes,
            // A sample, not the lot: a drive-wide source would otherwise put a hundred
            // thousand paths through the store and onto the page.
            sample: [...r.plan.toCreate, ...r.plan.toUpdate].slice(0, 12),
            skipped: r.plan.skipped.slice(0, 12),
          }
        : { job: job.name, error: r.reason },
    ),
  );
  revalidatePath(ADMIN_PATH);
});

/**
 * Move around inside an approved folder, for choosing a sub-folder without typing it.
 *
 * The browse position lives in the module's own store rather than the URL, because this
 * renders inside the admin settings panel, which has no route of its own to hang state on.
 * `browse` returns names and sizes only — never file contents — so nothing sensitive
 * crosses into this module by looking.
 */
export const browseAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const rootId = str(form, "rootId");
  const subpath = str(form, "subpath");
  // "" is a legitimate destination: it means the root itself.
  await ctx.store?.set("browse", JSON.stringify({ rootId, subpath }));
  revalidatePath(ADMIN_PATH);
});

/** Copy an existing job as a starting point, rather than retyping every field. */
export const cloneJobAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const src = await getJob(ctx.db, str(form, "id"));
  if (!src) return;

  const copy: Job = {
    ...src,
    id: crypto.randomUUID(),
    name: `${src.name} (copy)`,
    // A clone starts paused and clean. Duplicating a job usually means changing something
    // before it should run, and inheriting a failure streak would misreport the new one.
    enabled: 0,
    nextRunAt: null,
    consecutiveFailures: 0,
    lastNotifiedAt: null,
    createdAt: new Date().toISOString(),
  };
  copy.nextRunAt = computeNextRun(copy);

  await saveJob(ctx.db, copy);
  await ctx.audit?.("backup.job.clone", `${src.name} → ${copy.name}`);
  await ctx.store?.set("lastJobSave", `Copied “${src.name}”. The copy is paused until you turn it on.`);
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
});

/** Stop or start everything at once — for "we're moving the NAS this weekend". */
export const setAllEnabledAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const on = str(form, "enabled") === "1";
  await setAllEnabled(ctx.db, on);
  await ctx.audit?.("backup.jobs.bulk", on ? "all backups resumed" : "all backups paused");
  await ctx.store?.set("lastJobSave", on ? "All backups resumed." : "All backups paused.");
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
});

/** How many backups may copy at once. A property of the disk, not of any one job. */
export const setConcurrencyAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const n = await setConcurrency(ctx.db, int(form, "concurrency", 1));
  await ctx.audit?.("backup.settings.concurrency", String(n));
  await ctx.store?.set("lastConcurrency", `Saved — up to ${n} backup${n === 1 ? "" : "s"} at once.`);
  revalidatePath(ADMIN_PATH);
});

/** Where the weekly summary goes. Empty turns it off. */
export const setDigestAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  if (!ctx.db) return;
  const email = str(form, "digestEmail");
  await setDigestEmail(ctx.db, email);
  await ctx.audit?.("backup.settings.digest", email || "(off)");
  await ctx.store?.set(
    "lastDigest",
    email ? `Weekly summary will go to ${email}.` : "Weekly summary turned off.",
  );
  revalidatePath(ADMIN_PATH);
});

/** How long RUN LOGS are kept. Distinct from GFS retention, which is about the backups. */
export const setLogRetentionAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const res = await filesystem(ctx).setRetention({
    keepDays: int(form, "keepDays", 30),
    keepRuns: int(form, "keepRuns", 50),
  });
  await ctx.store?.set("lastLogRetention", `Saved. Removed ${res.removed} old log(s).`);
  revalidatePath(ADMIN_PATH);
});
