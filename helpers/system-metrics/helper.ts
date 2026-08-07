import type { HelperDefinition } from "@/lib/helpers/types";

/**
 * System metrics helper — reads read-only host telemetry (CPU, memory, disks, uptime,
 * best-effort temperatures) that a sandboxed module cannot read for itself.
 *
 * The whole helper is one read-only capability. It has no tables, no migrations, no boot
 * phase and no configuration: every call samples the host live and returns numbers. That
 * statelessness is deliberate — nothing to persist means nothing to leak and nothing to
 * reconcile at boot. See HELPER.md for the full contract; the API is in `api.ts`.
 */
const helper: HelperDefinition = {
  id: "system-metrics",
  name: "System metrics",
  description:
    "Reads this server's CPU, memory, disk usage, uptime and (where available) temperatures, so a module can show them. Read-only — it changes nothing on the host.",
  version: "0.0.5",
  /**
   * ⚠ `label` and `risk` are optional in the type but not in practice: omitting them fails to
   * compile on a 1.7.1 clone (TS2353), and a helper compiles into the app, so an older core
   * gets a failed build rather than a plainer screen.
   * ⚠ The PRE-RELEASE tag matters here, not a bare "1.7.2": semver ranks a pre-release below
   * its release, so "1.7.2" would be refused on every 1.7.2 beta.
   */
  minAppVersion: "1.7.2-beta.1",

  /**
   * One capability, read-only, always rendered red (core assumes the worst of a
   * helper-provided permission — correctly). There is no config to name specifics from, so
   * `describe` returns a static, honest sentence rather than taking `readConfig`.
   */
  provides: [
    {
      permission: "system-metrics:read",
      describe: () => "See this server's CPU, memory, disk usage, uptime and temperature.",
      label: "See system health",
      risk: "low",
      /* No scope: the readings are the whole machine or nothing — there is no per-item set to
         approve. And no paired acting capability, because this helper cannot act at all; it is
         read-only by construction, so it is unpaired correctly rather than by omission. */
    },
  ],
};

export default helper;
