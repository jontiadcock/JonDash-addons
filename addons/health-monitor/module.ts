import type { ModuleDefinition } from "@/lib/modules/types";
import HealthWidget from "./widget";
import HealthPage from "./page";
import { MODULE_ID } from "./lib/types";
import { HealthIcon } from "./ui/icon";
import HealthSettingsPanel from "./ui/settings-panel";
import { catchUp, tick, runMaintenance, SCAN_EVERY_MS, MAINTENANCE_EVERY_MS } from "./lib/scheduler";
import { systemModuleContext } from "@/lib/modules/api";
import { importConfigJson } from "./lib/config";
import { listMonitors } from "./lib/store";

/**
 * Health monitoring — checks the services you care about on a schedule, keeps their
 * history, and raises an alert when one stops answering.
 *
 * Everything it stores lives in its own `mod_health_monitor_*` tables and its own
 * settings; it reads nothing from the core database, so removing it leaves JonDash
 * exactly as it was. See MODULE.md for the full specification and CONFIG.md for the
 * configuration format.
 */
const healthMonitor: ModuleDefinition = {
  id: MODULE_ID,
  name: "Health monitoring",
  description:
    "Watches your services with HTTP, TCP, ping, DNS, certificate and internet speed checks, records uptime and response times, and alerts by email or webhook when something goes down.",
  version: "0.1.0",
  /**
   * Named as a PRE-RELEASE (`-beta.1`) because semver ranks a pre-release below its release,
   * so a bare "1.5.0" would refuse every 1.5.0 beta — the builds beta-channel users actually
   * run. The same value applies on both channels: a module carries its own channel, so a
   * beta-app user can still hold a stable-channel addon, and a bare number would lock them
   * out of a release that runs fine for them.
   */
  minAppVersion: "1.5.0-beta.1",

  /**
   * network:outbound — contact the targets and notification endpoints you configure.
   * crypto:use       — encrypt channel credentials (webhook URLs, bot tokens) at rest.
   * email:send       — send outage emails through the mailer you already set up.
   * audit:write      — record configuration changes and failed alert deliveries.
   */
  permissions: ["network:outbound", "crypto:use", "email:send", "audit:write"],

  // Until the framework can scope a module's UI to service groups, everything here is
  // admin-only: monitor targets and failure details are infrastructure information.
  adminOnly: true,

  /**
   * ⚠ NO `settings` array, deliberately. The framework always draws declared settings ABOVE a
   * module's own panel, so declaring them put fourteen tuning fields in front of the checks
   * people actually came for. `SETTING_FIELDS` is now rendered inside the panel instead, below
   * the checks — adding a `settings` key here would silently undo that.
   *
   * REFS addons/health-monitor/ui/settings-panel.tsx › AdvancedSettings()
   *      addons/health-monitor/actions.ts › saveSettingsAction()
   */

  /** Shown beside the module name; inherits the theme colour. */
  icon: HealthIcon,

  /** Adding and changing checks happens here, in Admin -> Addons. The module's own pages
   *  stay read-only. */
  SettingsPanel: HealthSettingsPanel,
  DashboardWidget: HealthWidget,
  Page: HealthPage,
  migrations: "./migrations",

  /** Everything this module needs beyond its own code. Declaring the helper is required:
   *  `schedules` without it is a mistake the installer catches. */
  helpers: ["scheduler"],

  /**
   * Background work is DECLARED, never started: the helper runs these from server start,
   * checks this module is still enabled on every tick, and never lets a slow run overlap
   * itself — monitoring stays alive at 03:00 with nobody watching, not just when someone
   * opens the dashboard.
   *
   * Both jobs are cheap and idempotent — safe to skip, safe to run twice, and they read
   * what is due from the monitors table rather than assuming they ran on time.
   */
  schedules: [
    {
      key: "poll",
      everyMs: SCAN_EVERY_MS,
      run: async (ctx) => {
        await tick(ctx);
      },
    },
    {
      key: "maintenance",
      everyMs: MAINTENANCE_EVERY_MS,
      run: async (ctx) => {
        await runMaintenance(ctx);
      },
    },
  ],

  /**
   * Enabling should start monitoring immediately rather than at the next tick, so run a
   * pass now. The schedule itself needs no starting — the helper picks this module up
   * within its reconcile window, with no restart.
   *
   * If someone pasted a configuration into the bulk-import box before enabling, and
   * there are no monitors yet, apply it as a convenience. Existing monitors are never
   * touched here: import is otherwise an explicit action.
   */
  async onEnable(ctx) {
    if (ctx.db && (await listMonitors(ctx.db)).length === 0) {
      await importConfigJson(ctx).catch(() => undefined);
    }
    await catchUp(await systemModuleContext(MODULE_ID));
  },

  // No onDisable/onUninstall: the helper checks enabled state per tick, so switching this
  // module off stops its work by itself, and back on resumes it without a restart.
};

export default healthMonitor;
