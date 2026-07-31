import type { HelperDefinition } from "@/lib/helpers/types";
import { startScheduler } from "./run";

/**
 * Scheduler helper (MOD-08).
 *
 * Runs the periodic work modules DECLARE via `schedules`. It exists because a module
 * cannot reliably run anything on its own: module code only executes when something
 * renders it, so a monitor restarted at 03:00 does nothing until someone opens the
 * dashboard — least reliable exactly when it matters most.
 *
 * Needs no permission: scheduling isn't dangerous, and every job runs with the declaring
 * module's own scoped context, so a schedule can never do more than that module was
 * granted.
 */
const helper: HelperDefinition = {
  id: "scheduler",
  name: "Scheduler",
  description: "Runs modules' declared background work on time, starting when the server starts.",
  version: "0.0.4-beta.1",
  /**
   * ⚠ The PRE-RELEASE tag matters, not a bare "1.5.0": semver ranks a pre-release below its
   * release, so a bare "1.5.0" would exclude every 1.5.0 beta — the builds this helper's users
   * actually run.
   * ⚠ Same value on BOTH channels, deliberately: a helper's channel is inherited from the
   * module that pulls it in, so a beta-app user can end up holding the stable build. 0.0.2
   * broke this (bare form on stable, while this very comment said otherwise) — 0.0.3 is the fix.
   */
  minAppVersion: "1.5.0-beta.1",
  provides: [], // nothing to consent to — it grants a module no new capability
  migrations: "./migrations",
  async onBoot(ctx) {
    // Registers timers and returns; the first run happens on the tick, not here, because
    // boot blocks the server becoming ready.
    await startScheduler(ctx);
  },
};

export default helper;
