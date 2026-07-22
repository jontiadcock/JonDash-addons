import type { ModuleDefinition } from "@/lib/modules/types";
import TemplateWidget from "./widget";
import TemplatePage from "./page";
import { MODULE_ID } from "./lib/constants";

/**
 * The one required file: it default-exports a ModuleDefinition, and that is the whole
 * contract between your module and JonDash. The core never imports anything else of
 * yours directly.
 *
 * This template is a complete, working module kept deliberately small — one setting,
 * one table, one widget, one page, and a form that writes through a Server Action.
 * Copy the folder, follow the rename checklist in MODULE.md, then delete the parts you
 * don't need.
 */
const template: ModuleDefinition = {
  /** Stable, lowercase-kebab, and identical to the folder name. Changing it later
   *  orphans the module's data, so choose it once. */
  id: MODULE_ID,

  /** Shown in the admin list and when browsing a source. Be honest and specific. */
  name: "Module template (for developers)",
  description:
    "FOR DEVELOPERS — a working example to copy when building your own module. Installs to modules/template; open MODULE.md in that folder for a full guide, and AI-PROMPT.md to have an AI build one for you. Safe to install, and safe to uninstall when you're done.",

  /** Bump this to publish an update. Semver; use X.Y.Z-beta.N on the beta channel. */
  version: "0.0.1-beta.1",

  /** The oldest JonDash this module works on. Everything here needs 1.4.0. */
  minAppVersion: "1.4.0",

  /**
   * Ask for NOTHING you don't use — every entry becomes a warning the admin reads, and
   * the installer refuses a module that reaches for a capability it didn't declare.
   * This template needs none: a module always gets its own settings, its own key/value
   * store, and its own `mod_<id>_*` tables without asking.
   *
   * Add entries here only when you use the matching part of `ctx`:
   *   "network:outbound" → ctx.fetch, ctx.net       "crypto:use"  → ctx.crypto
   *   "email:send"       → ctx.email                "audit:write" → ctx.audit
   */
  permissions: [],

  /** true = only full admins see the widget, the page and the settings. */
  adminOnly: false,

  /**
   * The framework renders these as a form under Admin → Modules → your module, and
   * stores them for you. Mark anything sensitive `secret: true` and it is encrypted at
   * rest and never sent back to the browser.
   */
  settings: [
    {
      key: "heading",
      label: "Heading",
      type: "string",
      default: "Items",
      help: "Shown on the dashboard widget and at the top of the page.",
    },
  ],

  /** Optional UI. Omit either one and that part simply doesn't exist. */
  DashboardWidget: TemplateWidget,
  Page: TemplatePage,

  /** Optional. Point at a folder of NNN_name.sql files to get your own tables. */
  migrations: "./migrations",

  /**
   * Optional lifecycle hooks. Migrations have already run before onEnable.
   * On uninstall JonDash drops your `mod_<id>_*` tables and purges your settings and
   * store automatically — only add onUninstall if you have something else to tidy up,
   * such as stopping a timer.
   */
  async onEnable() {},
  async onDisable() {},
  async onUninstall() {},
};

export default template;
