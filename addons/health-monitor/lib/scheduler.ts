import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import { checkMonitor } from "./engine";
import { syncConfig } from "./config";
import { dueMonitors, rollupAndPrune } from "./store";
import { readSettings } from "./settings";

/**
 * The poller.
 *
 * One timer per server process, `unref`'d so it never keeps Node alive, guarded by a
 * flag on `globalThis` so a re-evaluated module bundle can't start a second one. This
 * mirrors how the core's rate limiter sweeps its buckets — the same shape, for the same
 * single-process deployment.
 *
 * The honest limitation: a module's code is only loaded when something imports it, so
 * the timer starts on the first request that renders the widget or the page rather than
 * at boot. `catchUp()` closes that gap by running anything overdue when a page renders.
 * A scheduler owned by the app would remove the gap entirely.
 */

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastCatchUp: number;
  lastMaintenance: number;
  ctx: ModuleContext | null;
};

const KEY = "__jondash_health_monitor_scheduler__";

function state(): SchedulerState {
  const g = globalThis as unknown as Record<string, SchedulerState | undefined>;
  if (!g[KEY]) {
    g[KEY] = { timer: null, running: false, lastCatchUp: 0, lastMaintenance: 0, ctx: null };
  }
  return g[KEY]!;
}

const MAX_BATCHES_PER_TICK = 5;
const MIN_CATCHUP_GAP_MS = 5_000;
const MAINTENANCE_EVERY_MS = 3_600_000;

/** Run every monitor that is currently due, in batches of `maxConcurrent`. */
async function runDue(ctx: ModuleContext): Promise<number> {
  const db = ctx.db;
  if (!db) return 0;

  const settings = await readSettings(ctx);
  let checked = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const due = await dueMonitors(db, settings.maxConcurrent);
    if (due.length === 0) break;
    const results = await Promise.allSettled(due.map((m) => checkMonitor(ctx, m, settings)));
    checked += results.length;
    if (due.length < settings.maxConcurrent) break;
  }

  const s = state();
  if (Date.now() - s.lastMaintenance > MAINTENANCE_EVERY_MS) {
    s.lastMaintenance = Date.now();
    await rollupAndPrune(db, settings.rollupAfterDays, settings.retentionDays);
  }
  return checked;
}

/** One scheduler tick: apply any configuration change, then run what is due. */
async function tick(ctx: ModuleContext): Promise<void> {
  const s = state();
  if (s.running) return; // a slow batch must not overlap the next tick
  s.running = true;
  try {
    await syncConfig(ctx);
    await runDue(ctx);
  } catch {
    // A tick that fails must not kill the timer; the next one tries again.
  } finally {
    s.running = false;
  }
}

/**
 * Start the poller if it isn't already running. Safe to call on every render.
 *
 * The context captured here belongs to whoever's request started it; the background work
 * uses only its data capabilities, but audit entries written from a later tick are
 * attributed to that first admin. A system-scoped context would be the proper fix.
 */
export function ensureScheduler(ctx: ModuleContext, pollSeconds: number): void {
  const s = state();
  s.ctx = s.ctx ?? ctx;
  if (s.timer) return;

  const period = Math.max(5, pollSeconds) * 1000;
  const timer = setInterval(() => {
    const current = state();
    if (current.ctx) void tick(current.ctx);
  }, period);
  // Never hold the process open for a health check.
  (timer as unknown as { unref?: () => void }).unref?.();
  s.timer = timer;
}

/** Stop the poller — used when the module is disabled or uninstalled. */
export function stopScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.ctx = null;
}

/**
 * Run anything overdue right now. Throttled, because every dashboard render calls it and
 * a busy dashboard shouldn't mean a check per page view.
 *
 * `force` skips the throttle for an explicit action — enabling the module is a deliberate
 * "start monitoring", and it must not silently do nothing because somebody happened to
 * load a page five seconds earlier.
 */
export async function catchUp(ctx: ModuleContext, force = false): Promise<void> {
  const s = state();
  if (s.running) return;
  if (!force && Date.now() - s.lastCatchUp < MIN_CATCHUP_GAP_MS) return;
  s.lastCatchUp = Date.now();
  await tick(ctx);
}

/** Everything a rendering surface needs: config applied, poller running, gaps filled. */
export async function ensureRunning(ctx: ModuleContext, opts: { force?: boolean } = {}): Promise<void> {
  const settings = await readSettings(ctx);
  ensureScheduler(ctx, settings.pollSeconds);
  await catchUp(ctx, opts.force);
}
