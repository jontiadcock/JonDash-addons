import type { ModuleDefinition } from "@/lib/modules/types";
import HealthWidget from "./widget";
import HealthPage from "./page";
import { MODULE_ID } from "./lib/types";
import { SETTING_FIELDS } from "./lib/settings";
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
    "Watches your services with HTTP, TCP, ping, DNS and certificate checks, records uptime and response times, and alerts by email or webhook when something goes down.",
  version: "0.0.5",
  // The `scheduler` helper and `schedules` arrived in 1.5.0. Named as the PRE-RELEASE:
  // semver ranks `1.5.0-beta.4` below `1.5.0`, so a bare "1.5.0" would be refused on
  // every 1.5.0 beta — the builds beta-channel users are actually running.
  minAppVersion: "1.5.0",

  // network:outbound — contact the targets and notification endpoints you configure.
  // crypto:use       — encrypt channel credentials (webhook URLs, bot tokens) at rest.
  // email:send       — send outage emails through the mailer you already set up.
  // audit:write      — record configuration changes and failed alert deliveries.
  permissions: ["network:outbound", "crypto:use", "email:send", "audit:write"],

  // Until the framework can scope a module's UI to service groups, everything here is
  // admin-only: monitor targets and failure details are infrastructure information.
  adminOnly: true,

  settings: SETTING_FIELDS,

  /** Shown beside the module name; inherits the theme colour. */
  icon: HealthIcon,

  /** Adding and changing checks happens here, in Admin -> Modules, below the settings
   *  fields above. The module's own pages stay read-only. */
  SettingsPanel: HealthSettingsPanel,
  DashboardWidget: HealthWidget,
  Page: HealthPage,
  migrations: "./migrations",

  /** Everything this module needs beyond its own code. Declaring the helper is required:
   *  `schedules` without it is a mistake the installer catches. */
  helpers: ["scheduler"],

  /**
   * Background work is DECLARED, never started. The helper runs these from server start,
   * checks this module is still enabled on every tick, and never lets a slow run overlap
   * itself. That is the whole point of the migration: monitoring that is alive at 03:00
   * with nobody watching, rather than starting whenever somebody opens the dashboard.
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

  // No onDisable/onUninstall: there is no timer to tear down any more. The helper checks
  // enabled state per tick, so switching this module off stops its work by itself, and
  // switching it back on resumes without a restart.
};

export default healthMonitor;
