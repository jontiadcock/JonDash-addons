import type { ModuleDefinition } from "@/lib/modules/types";
import ServiceControlWidget from "./ui/widget";
import ServiceControlPage from "./page";
import ServiceControlSettings from "./ui/settings-panel";

/**
 * Service control — see and control the services you have approved, from the dashboard.
 *
 * The module touches no service itself; it cannot. Every read and every action goes through
 * the `host-services` helper, which owns the allowlist and the OS grants. This module only
 * renders what the helper reports and asks it to act.
 *
 * **What it can never do, by construction:** name a service that is not on the allowlist,
 * add itself to that list, run a command, or discover what services exist on the machine.
 * Those are properties of the helper's API, not promises made here.
 *
 * It has no tables and no migrations — every piece of state that matters (the allowlist, the
 * request queue) belongs to the helper, because it outlives this module. Uninstalling this
 * module must not take an admin's approved services with it.
 */
const serviceControl: ModuleDefinition = {
  id: "service-control",
  name: "Service control",
  description:
    "Start, stop and restart the services you approve — a Windows service, a systemd unit — from your dashboard, without opening a terminal.",
  version: "0.0.3-beta.1",
  // Matches the helper's floor: beta.9 is the first build with helper settings pages, which
  // is where the allowlist editor now lives. The PRE-RELEASE, not a bare "1.7.1" — semver
  // ranks a pre-release below its release, so "1.7.1" would refuse every 1.7.1 beta,
  // including beta.9, which has the feature.
  minAppVersion: "1.7.1-beta.9",

  /**
   * Both helper capabilities. They render red on the consent screen — core assumes the worst
   * of a permission it did not define — and that is the right colour: this module can stop
   * services on the machine JonDash runs on.
   */
  /**
   * Two, and `host-services:configure` is **gone** — it existed for one release because this
   * module hosted the allowlist editor, which let it choose what went on the list it was only
   * meant to use. JonDash 1.7.1 gave helpers their own settings page, so the editor moved to
   * Admin → Helpers and the capability was deleted rather than left disclosed.
   */
  permissions: ["host-services:read", "host-services:control"],

  /** Pinned to the version that introduced the API this module calls. */
  helpers: [{ id: "host-services", minVersion: "0.0.3-beta.1" }],

  /** Which services exist on the host, and the power to stop them, is admin information. */
  adminOnly: true,

  DashboardWidget: ServiceControlWidget,
  Page: ServiceControlPage,

  /**
   * **Read-only, and the allowlist editor is not here.**
   *
   * This panel shows what this module can see through the helper — the approved services and
   * the requests it has raised — and offers no way to change any of it. The editor lives at
   * Admin → Helpers → Host services, rendered by JonDash with no module in the path.
   *
   * That split is the security property, not a layout choice. The allowlist is *helper*
   * configuration: it outlives this module, along with the OS grants it represents. While the
   * editor lived here, this module supplied the service name being approved — it could display
   * "Add Plex" and submit `sshd`, and the Windows prompt names JonDash rather than the service.
   * The thing being bounded could edit its own boundary.
   */
  SettingsPanel: ServiceControlSettings,
};

export default serviceControl;
