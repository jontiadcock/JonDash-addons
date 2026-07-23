"use server";
import { moduleAction } from "@/lib/modules/api";
import { revalidatePath } from "next/cache";
import filesystem from "@/helpers/filesystem/api";
import { MODULE_ID, ADMIN_PATH, MODULE_PATH } from "./lib/constants";
import { computeNextRun, deleteJob, getJob, policyOf, saveJob, type Job } from "./lib/store";
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

/** How long RUN LOGS are kept. Distinct from GFS retention, which is about the backups. */
export const setLogRetentionAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const res = await filesystem(ctx).setRetention({
    keepDays: int(form, "keepDays", 30),
    keepRuns: int(form, "keepRuns", 50),
  });
  await ctx.store?.set("lastLogRetention", `Saved. Removed ${res.removed} old log(s).`);
  revalidatePath(ADMIN_PATH);
});
