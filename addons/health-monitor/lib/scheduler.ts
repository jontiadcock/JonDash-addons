import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import { checkMonitor } from "./engine";
import { dueMonitors, rollupAndPrune } from "./store";
import { readSettings } from "./settings";

/**
 * The work the scheduler helper runs. A module's code loads only when something imports it, so
 * this file can't own its own timer — a `setInterval` in a widget or page render would mean
 * nothing runs until someone opens the dashboard, and stops silently on an unwatched restart.
 *
 * The `scheduler` helper declares this work instead (`module.ts` → `schedules`) and runs it from
 * server start; what's left here is deciding what's due, running it, and keeping history tidy.
 */

/**
 * The scan interval, fixed. The shortest per-monitor interval offered is 30s, so looking
 * every 15s honours every choice; a monitor's own interval is what decides when it runs.
 * REFS addons/health-monitor/module.ts
 */
export const SCAN_EVERY_MS = 15_000;

/**
 * How often history is compacted and pruned. Cheap, and nowhere near time-critical.
 * REFS addons/health-monitor/module.ts
 */
export const MAINTENANCE_EVERY_MS = 3_600_000;

/** Bounds one pass, so a large backlog can't monopolise a tick. */
const MAX_BATCHES_PER_TICK = 5;

/**
 * Kept on `globalThis` so a re-evaluated bundle can't run two passes at once. Needed because
 * the helper only guarantees scheduled ticks don't overlap each other — it doesn't know about
 * `catchUp`, which an admin action calls directly, so this guard is what covers both paths.
 */
type SchedulerState = { running: boolean };
const KEY = "__jondash_health_monitor_scheduler__";

function state(): SchedulerState {
  const g = globalThis as unknown as Record<string, SchedulerState | undefined>;
  if (!g[KEY]) g[KEY] = { running: false };
  return g[KEY]!;
}

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
  return checked;
}

/**
 * One pass: run whatever is due. Skipped rather than queued if a pass is already in
 * flight, so a slow batch can't stack on itself.
 * REFS addons/health-monitor/module.ts
 */
export async function tick(ctx: ModuleContext): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    await runDue(ctx);
  } catch {
    // A failed pass must not stop the schedule; the next one tries again.
  } finally {
    s.running = false;
  }
}

/**
 * Compact old results into hourly summaries and drop anything past its retention.
 * Separate from the poll: it has nothing to do with noticing an outage, and folding it
 * into the fast tick meant a time-check on every single pass.
 * REFS addons/health-monitor/module.ts
 */
export async function runMaintenance(ctx: ModuleContext): Promise<void> {
  const db = ctx.db;
  if (!db) return;
  const settings = await readSettings(ctx);
  await rollupAndPrune(db, settings.rollupAfterDays, settings.retentionDays);
}

/**
 * Run anything overdue right now, for an explicit admin action — adding a monitor should
 * show a result immediately rather than after the next tick. Not used by the schedule.
 * REFS addons/health-monitor/actions.ts · addons/health-monitor/module.ts
 */
export async function catchUp(ctx: ModuleContext): Promise<void> {
  await tick(ctx);
}
