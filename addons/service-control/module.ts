import type { ModuleDefinition } from "@/lib/modules/types";
import ServiceControlWidget from "./ui/widget";
import ServiceControlPage from "./page";
import ServiceControlSettings from "./ui/settings-panel";

/**
 * Service control — see and control the services you have approved, from the dashboard. The
 * module touches no service itself; every read and action goes through the `host-services`
 * helper, which owns the allowlist and the OS grants — this module only renders what it
 * reports and asks it to act.
 *
 * ⚠ By construction it can never name a service that is not on the allowlist, add itself to
 * that list, run a command, or discover what exists on the machine — properties of the
 * helper's API, not promises made here. No tables, no migrations: that state belongs to the
 * helper and outlives this module, so uninstalling it must not take approved services with it.
 */
const serviceControl: ModuleDefinition = {
  id: "service-control",
  name: "Service control",
  description:
    "Start, stop and restart the services you approve — a Windows service, a systemd unit — from your dashboard, without opening a terminal.",
  version: "0.0.8-beta.1",
  /**
   * ⚠ Follows `host-services`'s own floor — that helper declares CORE-10 `scope`, which fails
   * to compile below it, so a module pulling the helper into an older install takes the whole
   * app's build down too. Pre-release value, not a bare "1.7.2": semver would refuse every
   * 1.7.2 beta otherwise, including the one with the feature.
   */
  minAppVersion: "1.7.2-beta.1",

  /**
   * Both helper capabilities. They render red on the consent screen — core assumes the worst
   * of a permission it did not define — and that is the right colour: this module can stop
   * services on the machine JonDash runs on.
   */
  /**
   * Two, and `host-services:configure` is **gone** — it existed for one release because this
   * module hosted the allowlist editor, which let it choose what went on the list it was only
   * meant to use. JonDash 1.7.1 gave helpers their own settings page, so the editor moved to
   * Admin → Permissions and the capability was deleted rather than left disclosed.
   */
  permissions: ["host-services:read", "host-services:control"],

  /** Pinned to the version that introduced the API this module calls. */
  helpers: [{ id: "host-services", minVersion: "0.0.4-beta.1" }],

  /** Which services exist on the host, and the power to stop them, is admin information. */
  adminOnly: true,

  DashboardWidget: ServiceControlWidget,
  Page: ServiceControlPage,

  /**
   * ⚠ Read-only — the allowlist editor is not here. This panel shows what the module can see
   * through the helper (approved services, its own raised requests) and offers no way to change
   * any of it; the editor lives at Admin → Permissions, rendered by JonDash with no module in
   * the path.
   *
   * That split is the security property, not a layout choice: while the editor lived here, this
   * module supplied the service name being approved, so it could display "Add Plex" and submit
   * `sshd` — the thing being bounded could edit its own boundary.
   */
  SettingsPanel: ServiceControlSettings,
};

export default serviceControl;
