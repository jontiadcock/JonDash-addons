import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import { checkMonitor } from "./engine";
import { dueMonitors, rollupAndPrune } from "./store";
import { readSettings } from "./settings";

/**
 * The work the scheduler helper runs.
 *
 * This module used to own a timer. It doesn't any more: a module's code is only loaded
 * when something imports it, so a `setInterval` started from a widget or page render
 * meant nothing was monitored until somebody opened the dashboard. Restart at 03:00 with
 * nobody looking and the monitoring simply stopped — precisely when it matters most.
 *
 * The `scheduler` helper declares that work instead (see `module.ts` → `schedules`), and
 * runs it from server start. What's left here is the work itself, which was always the
 * module's business: decide what's due, run it, and keep the history tidy.
 *
 * The helper guarantees scheduled ticks never overlap. It cannot know about `catchUp`,
 * which an admin action calls directly — so the overlap guard below stays, covering both.
 */

/** The scan interval, fixed. The shortest per-monitor interval offered is 30s, so looking
 *  every 15s honours every choice; a monitor's own interval is what decides when it runs. */
export const SCAN_EVERY_MS = 15_000;

/** How often history is compacted and pruned. Cheap, and nowhere near time-critical. */
export const MAINTENANCE_EVERY_MS = 3_600_000;

/** Bounds one pass, so a large backlog can't monopolise a tick. */
const MAX_BATCHES_PER_TICK = 5;

/** Kept on `globalThis` so a re-evaluated bundle can't run two passes at once. */
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
 */
export async function catchUp(ctx: ModuleContext): Promise<void> {
  await tick(ctx);
}
