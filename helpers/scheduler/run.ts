import "server-only";
import { prisma } from "@/lib/db";
import type { HelperBootContext } from "@/lib/helpers/types";
import type { ModuleSchedule } from "@/lib/modules/types";
import { getEnabledModules } from "@/lib/modules/registry";
import { systemModuleContext } from "@/lib/modules/context";

/**
 * The scheduler's engine. A helper is first-party, so unlike a module it may read core
 * directly — that's what lets it collect every module's declared schedules itself rather
 * than requiring modules to register at boot.
 */

/** Nothing runs more often than this, however a module declares it. */
const MIN_INTERVAL_MS = 15_000;
/** Spread first runs so ten modules don't all fire the instant the server starts. */
const STAGGER_MS = 2_000;
/**
 * How often to look for schedules that aren't running yet.
 *
 * Enabling a module does NOT restart the server — it only writes a database row — so a
 * boot-time snapshot of jobs goes stale the moment somebody switches a module on. Without
 * this, enabling a module leaves its background work dead until the next restart, which is
 * the same "silently does nothing" failure this helper exists to remove.
 */
const RECONCILE_MS = 30_000;

type Job = { moduleId: string; schedule: ModuleSchedule };

const timers: ReturnType<typeof setInterval>[] = [];
const running = new Set<string>();
/** Jobs that already have a timer, so reconciling doesn't start a second one. */
const registered = new Set<string>();

function jobId(moduleId: string, key: string): string {
  return `${moduleId}:${key}`;
}

/** Is the module still switched on? Cheap enough at these intervals (15s floor). */
async function isEnabled(moduleId: string): Promise<boolean> {
  try {
    const row = await prisma.module.findUnique({ where: { id: moduleId }, select: { enabled: true } });
    return !!row?.enabled;
  } catch {
    return false; // can't tell => don't run someone's background work
  }
}

async function lastRunAt(ctx: HelperBootContext, id: string): Promise<number | null> {
  if (!ctx.db) return null;
  const rows = await ctx.db.query<{ lastRunAt: string }>(
    `SELECT lastRunAt FROM ${ctx.db.table("runs")} WHERE id = ?`,
    id,
  );
  const t = rows[0]?.lastRunAt ? Date.parse(rows[0].lastRunAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

async function recordRun(ctx: HelperBootContext, id: string, ok: boolean, error?: string): Promise<void> {
  if (!ctx.db) return;
  await ctx.db.run(
    `INSERT INTO ${ctx.db.table("runs")} (id, lastRunAt, lastOk, lastError) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET lastRunAt = excluded.lastRunAt, lastOk = excluded.lastOk, lastError = excluded.lastError`,
    id,
    new Date().toISOString(),
    ok ? 1 : 0,
    error?.slice(0, 500) ?? null,
  );
}

/**
 * Run one job. A schedule that throws must not stop the timer or affect any other
 * module's work — a broken monitor should keep trying, not silently stop.
 */
async function runJob(ctx: HelperBootContext, job: Job): Promise<void> {
  const id = jobId(job.moduleId, job.schedule.key);
  // A long run must not overlap itself; skip this tick instead of piling up.
  if (running.has(id)) return;

  // Disabling a module does NOT restart the server, so its timer outlives it. Checked
  // per tick rather than trusting the boot-time snapshot: otherwise a disabled module's
  // job throws inside systemModuleContext on every tick and the isolated-failure
  // handling faithfully logs it forever. Silent skip — a switched-off module doing
  // nothing is correct, not an error. Re-enabling resumes it with no restart needed.
  if (!(await isEnabled(job.moduleId))) return;

  running.add(id);
  try {
    const moduleCtx = await systemModuleContext(job.moduleId);
    await job.schedule.run(moduleCtx);
    await recordRun(ctx, id, true);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[scheduler] ${id} failed:`, message);
    await recordRun(ctx, id, false, message).catch(() => {});
  } finally {
    running.delete(id);
  }
}

/** Every schedule declared by a module that is currently enabled. */
async function currentJobs(): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const state of await getEnabledModules()) {
    for (const schedule of state.def.schedules ?? []) {
      jobs.push({ moduleId: state.def.id, schedule });
    }
  }
  return jobs;
}

/**
 * Give one job a timer. `staggerMs` spreads first runs at boot; a job picked up later by
 * reconciling starts promptly, because somebody has just switched it on and waiting a
 * full interval to do anything would look broken.
 */
async function scheduleJob(ctx: HelperBootContext, job: Job, staggerMs: number): Promise<void> {
  const id = jobId(job.moduleId, job.schedule.key);
  if (registered.has(id)) return;
  registered.add(id);

  const every = Math.max(MIN_INTERVAL_MS, Math.floor(job.schedule.everyMs));

  // If it was already due while the server was down, run it shortly after boot rather
  // than waiting a full interval — the whole point of persisting last-run.
  const last = await lastRunAt(ctx, id).catch(() => null);
  const overdue = last === null || Date.now() - last >= every;
  const firstDelay = job.schedule.skipOnBoot || !overdue ? every : staggerMs;

  setTimeout(() => {
    void runJob(ctx, job);
    const timer = setInterval(() => void runJob(ctx, job), every);
    // Node would keep the process alive for these; the server owns its own lifetime.
    timer.unref?.();
    timers.push(timer);
  }, firstDelay).unref?.();
}

/**
 * Pick up schedules that have no timer yet — a module enabled since the last pass.
 *
 * Only ADDS. A module switched off is already handled per tick in `runJob`, and
 * uninstalling restarts the server, so nothing here needs to tear a timer down.
 */
async function reconcile(ctx: HelperBootContext): Promise<void> {
  try {
    for (const job of await currentJobs()) await scheduleJob(ctx, job, STAGGER_MS);
  } catch (e) {
    console.error("[scheduler] reconcile failed:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Start the scheduler.
 *
 * Called from the helper boot phase, which blocks the server becoming ready — so this
 * only ever *registers* timers. The catch-up decision is cheap (one read per job) but
 * the work itself is always deferred onto a timer.
 *
 * Note there is no early return when nothing is scheduled yet: on a fresh install no
 * module declares a schedule, and giving up would leave this process unable to ever run
 * one — the first module enabled afterwards would sit idle until the next restart.
 */
export async function startScheduler(ctx: HelperBootContext): Promise<void> {
  const jobs = await currentJobs();

  let stagger = STAGGER_MS;
  for (const job of jobs) {
    await scheduleJob(ctx, job, stagger);
    stagger += STAGGER_MS;
  }

  // Enabling a module doesn't restart the server, so keep looking for new work.
  const watcher = setInterval(() => void reconcile(ctx), RECONCILE_MS);
  watcher.unref?.();
  timers.push(watcher);

  await ctx.audit("started", `${jobs.length} scheduled job(s)`);
}

/** Stop everything — used by tests; the server exiting is the normal end. */
export function stopScheduler(): void {
  for (const t of timers.splice(0)) clearInterval(t);
  registered.clear();
}
