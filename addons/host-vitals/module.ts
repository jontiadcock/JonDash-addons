import type { ModuleDefinition } from "@/lib/modules/types";
import HostVitalsWidget from "./ui/widget";
import HostVitalsPage from "./page";
import { TOGGLES } from "./lib/groups";

/**
 * Host vitals — a dashboard tile and page showing how the server ITSELF is doing: CPU,
 * memory, disk usage, uptime, temperatures and more.
 *
 * The module performs no host access; it cannot. Every number comes from the
 * `system-metrics` helper, which does the privileged reads a module is forbidden and returns
 * plain numbers. This module only renders them. It keeps no history — each render reads
 * live — so it has no tables and no migrations; its only stored state is which vitals you
 * want shown.
 */
const hostVitals: ModuleDefinition = {
  id: "host-vitals",
  name: "Host vitals",
  description:
    "Shows how this server is doing — CPU, memory, how full each disk is, uptime and temperatures — as a dashboard tile and a page.",
  version: "0.0.6-beta.1",
  // The `system-metrics` capability is enforced by `ctx.can()`, which arrived in JonDash
  // 1.5.2. The pre-release, not a bare "1.5.2": semver ranks a pre-release below its release,
  // so "1.5.2" would be refused on every 1.5.2 beta — the builds beta users run.
  minAppVersion: "1.7.2-beta.1",

  /**
   * The only permission is the helper's read capability. It renders red on the consent
   * screen (core assumes the worst of a helper-provided permission), and it is honest: this
   * module can see the server's vitals and change nothing.
   */
  permissions: ["system-metrics:read"],

  /**
   * `system-metrics` supplies the reads. Pinned to the version that introduced `read()`, so
   * the break-analysis on Admin → Updates is correct for this module; the floor is honest
   * documentation, not a guard (JonDash does not refuse an install against an older helper).
   */
  helpers: [{ id: "system-metrics", minVersion: "0.0.1-beta.1" }],

  /** Host telemetry — hostname, disk layout — is admin-level information. */
  adminOnly: true,

  /**
   * One switch per optional vital. Turning one off means it is **not gathered**, not merely
   * hidden — the module hands the helper a `collect` list built from exactly these, so a
   * metric you switched off is never sampled. Generated from `TOGGLES` so the settings
   * screen, the collect list and the UI can never drift apart.
   *
   * CPU, memory and disks have no switch: they cost nothing to read and are the whole point
   * of the module.
   */
  settings: TOGGLES.map((t) => ({
    key: t.key,
    label: t.label,
    type: "boolean" as const,
    default: t.default,
    help: t.help,
  })),

  DashboardWidget: HostVitalsWidget,
  Page: HostVitalsPage,
};

export default hostVitals;
