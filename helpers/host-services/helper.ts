import type { HelperDefinition } from "@/lib/helpers/types";
import { listServiceLabels, readConfig } from "./lib/allowlist";

/**
 * Host services helper — lets a module start, stop and restart services an administrator
 * has explicitly listed, and nothing else.
 *
 * The two things that make this safe are both configuration the admin owns, not arguments
 * the caller supplies:
 *
 *  1. **The allowlist.** A module can name a service; it can never add one. Being on the
 *     list IS the privilege, which is why adding an entry is the moment elevation is
 *     requested.
 *  2. **The grant is fixed at that instant.** Each entry's grants are Scheduled Tasks with
 *     the service and verb baked in, and `schtasks /run` cannot pass arguments — so what
 *     can happen without a prompt is enforced by Windows rather than by this code.
 *
 * See HELPER.md, and ../ELEVATION.md for the model this is an application of.
 *
 * **This helper is inert until core ships the grant manager (OPS-18).** Reading service
 * state works today and needs no privilege; creating grants reports
 * `grant-manager-missing` and refuses. That is deliberate — nothing here degrades to a
 * weaker form of privilege when the intended one is unavailable.
 */
const helper: HelperDefinition = {
  id: "host-services",
  name: "Host services",
  description:
    "Lets a module see and control the services you list — a Windows service, a systemd unit — so a dashboard can restart something without you opening a terminal. Only the services you add, and only start, stop and restart.",
  version: "0.0.1",
  // `ctx.can()` and `readConfig` both arrived in 1.5.2. The PRE-RELEASE, not a bare
  // "1.5.2": semver ranks a pre-release below its release, so "1.5.2" would be refused on
  // every 1.5.2 beta — exactly the builds beta-channel users run.
  minAppVersion: "1.5.2-beta.1",

  /**
   * Two lines, and the split is for honesty rather than scoping — a consuming module
   * inherits every capability of every helper it declares, so splitting costs nothing and
   * reads far more truthfully. Seeing whether something is running and being able to stop
   * it are not the same power and should not share a sentence.
   *
   * The control line deliberately does NOT promise "each one needs your approval". Whether
   * a request needs an admin click is a per-service setting the admin controls, not a
   * property of the capability, and a consent line claiming a safeguard that can later be
   * switched off is worse than one stating the power plainly. What genuinely bounds this is
   * the allowlist, which is why both lines name it.
   */
  provides: [
    {
      permission: "host-services:read",
      describe: (config) => `See whether ${which(config)} are running`,
    },
    {
      permission: "host-services:control",
      describe: (config) => `Start, stop and restart ${which(config)}`,
    },
  ],

  migrations: "./migrations",

  readConfig,
};

/**
 * "the services you list" until entries exist, then the actual services. Naming real ones is
 * the point of `describe` taking config — an admin should read the consent screen and
 * recognise their own machine.
 */
function which(config: Record<string, unknown>): string {
  const names = listServiceLabels(config);
  if (names.length === 0) return "the services you list";
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export default helper;
