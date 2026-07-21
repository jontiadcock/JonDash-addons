import type { ModuleDefinition } from "@/lib/modules/types";
import HealthWidget from "./widget";
import HealthPage from "./page";
import { MODULE_ID } from "./lib/types";
import { SETTING_FIELDS } from "./lib/settings";
import { ensureRunning, stopScheduler } from "./lib/scheduler";
import { syncConfig } from "./lib/config";

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
  version: "0.0.1-beta.1",
  minAppVersion: "1.4.0-beta.3",

  // network:outbound — contact the targets and notification endpoints you configure.
  // crypto:use       — encrypt channel credentials (webhook URLs, bot tokens) at rest.
  // email:send       — send outage emails through the mailer you already set up.
  // audit:write      — record configuration changes and failed alert deliveries.
  permissions: ["network:outbound", "crypto:use", "email:send", "audit:write"],

  // Until the framework can scope a module's UI to service groups, everything here is
  // admin-only: monitor targets and failure details are infrastructure information.
  adminOnly: true,

  settings: SETTING_FIELDS,
  DashboardWidget: HealthWidget,
  Page: HealthPage,
  migrations: "./migrations",

  /**
   * Apply whatever configuration is already saved and start the poller straight away.
   * Without the second step nothing would be checked until somebody happened to open
   * the dashboard — enabling a monitor should be enough to start monitoring.
   */
  async onEnable(ctx) {
    await syncConfig(ctx);
    await ensureRunning({ force: true });
  },

  /** Stop polling the moment the module is switched off. */
  async onDisable() {
    stopScheduler();
  },

  /** The framework drops the tables and settings; just make sure nothing is still running. */
  async onUninstall() {
    stopScheduler();
  },
};

export default healthMonitor;
