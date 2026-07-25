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
  version: "0.0.1-beta.6",
  // Matches the helper's floor, and for the same reason: on 1.7.1-beta.1 an elevated action
  // could proceed without being recorded, so the audit guarantee this module relies on was
  // not actually there. The PRE-RELEASE, not a bare "1.7.1" — semver ranks a pre-release
  // below its release, so "1.7.1" would be refused on every 1.7.1 beta, the builds beta
  // users run.
  minAppVersion: "1.7.1-beta.7",

  /**
   * Both helper capabilities. They render red on the consent screen — core assumes the worst
   * of a permission it did not define — and that is the right colour: this module can stop
   * services on the machine JonDash runs on.
   */
  /**
   * Three, and the third is the one that matters.
   *
   * `:configure` says this module decides what goes on the allowlist. It exists because the
   * power did: until `0.0.1-beta.4` this module could add entries while its consent screen
   * mentioned only controlling them, which is a privilege-escalation path rather than an
   * oversight. Declaring it does not make that power smaller — it makes it visible, so an
   * admin agrees to it knowingly instead of discovering it later.
   *
   * It is temporary. When JonDash can host a helper's own settings page, the editor moves
   * there and this line is deleted.
   */
  permissions: ["host-services:read", "host-services:control", "host-services:configure"],

  /** Pinned to the version that introduced the API this module calls. */
  helpers: [{ id: "host-services", minVersion: "0.0.1-beta.6" }],

  /** Which services exist on the host, and the power to stop them, is admin information. */
  adminOnly: true,

  DashboardWidget: ServiceControlWidget,
  Page: ServiceControlPage,

  /**
   * The allowlist UI lives here **for now, and it is the wrong owner.**
   *
   * The allowlist is HELPER configuration: it survives this module being uninstalled, along
   * with the OS grants it represents. Hosting its only screen inside a module means
   * uninstalling the module leaves standing privileges on the machine with nowhere to see or
   * revoke them — exactly the orphan the helper's own spec warns about.
   *
   * Core reserves a per-helper settings slot at Admin → Helpers ("Reserved for helper
   * settings once the contract carries them"), which is where this belongs. When
   * `HelperDefinition` carries a settings panel, this moves there and the helper's `admin.*`
   * API is deleted outright — modules would then have no mutator at all.
   */
  SettingsPanel: ServiceControlSettings,
};

export default serviceControl;
