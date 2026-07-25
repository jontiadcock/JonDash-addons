import type { HelperDefinition } from "@/lib/helpers/types";
import { listServiceLabels, readConfig } from "./lib/allowlist";
import { readGrants, revokeEverything } from "./lib/grant";

/**
 * Last chance to take back what this helper gave the operating system.
 *
 * Grants outlive JonDash by design — that is the whole point of granting once — so when the
 * helper is pruned there is nothing left that knows they exist. Owner: *"when the module is
 * removed, I don't want a random task present."*
 *
 * **The fast path is the common one and costs nothing.** `readGrants()` needs no elevation, so
 * an install that never approved a service returns in milliseconds and never prompts. Only a
 * machine with live grants pays for the slow path.
 *
 * **The slow path cannot fit the 5s budget, and that is not something this code can fix.**
 * Revoking a grant needs elevation, and elevation waits on a human answering a UAC prompt —
 * core's own timeout for that is ten minutes. So when grants exist this hook will normally be
 * cut off mid-prompt, the files will be removed anyway, and the grants will survive. Reported
 * to core rather than papered over; what is done here is to make that outcome *loud* instead
 * of silent, because an orphaned grant nobody knows about is the failure this hook exists to
 * prevent.
 */
async function revokeGrantsOnUninstall(ctx: Parameters<NonNullable<HelperDefinition["onUninstall"]>>[0]): Promise<void> {
  const existing = await readGrants();
  if (existing.length === 0) {
    await ctx.audit("host-services.uninstall", "no grants to revoke");
    return;
  }

  const names = existing.map((g) => g.name).join(", ");
  const outcome = await revokeEverything();

  if (outcome.status === "ok") {
    await ctx.audit("host-services.uninstall", `revoked ${existing.length} grant(s): ${names}`);
    return;
  }

  // Never report a clean uninstall when privileges remain on the machine. The wording names
  // the tasks and both ways to remove them, because after this returns there is no JonDash
  // screen left that knows about them.
  const why =
    outcome.status === "cancelled-at-uac"
      ? "the permission prompt was declined"
      : outcome.status === "timed-out"
        ? "the permission prompt was not answered in time"
        : outcome.status === "unavailable"
          ? `elevation unavailable (${outcome.reason})`
          : outcome.detail;

  await ctx.audit(
    "host-services.uninstall.INCOMPLETE",
    `GRANTS REMAIN — ${why}. Still present: ${names}. ` +
      `Remove them with "bin\\jondash-grant.exe --remove --all" or in Task Scheduler under \\JonDash\\.`,
  );
}

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
 * **Working end to end since JonDash 1.7.1-beta.4** (OPS-18). Proven on a real machine: one
 * approval when a service is added, then start and stop with no further prompt, verified by
 * reading the service's actual state either side. Removing an entry prompts again, because
 * withdrawing a standing privilege is itself an administrator action.
 *
 * **What is NOT proven, and must not be claimed:** whether the task's security descriptor
 * stops a standard user *editing* a grant. It is coded that way and neither session has
 * tested it. Until someone does, a grant is a narrow permanent capability — not a
 * tamper-proof one.
 */
const helper: HelperDefinition = {
  id: "host-services",
  name: "Host services",
  description:
    "Lets a module see and control the services you list — a Windows service, a systemd unit — so a dashboard can restart something without you opening a terminal. Only the services you add, and only start, stop and restart.",
  version: "0.0.1-beta.3",
  /**
   * 1.7.1-beta.**2**, not beta.1, and the reason is a guarantee rather than a feature.
   *
   * beta.1 shipped `@/lib/elevation`, so the imports resolve there — but on beta.1 an
   * elevated action could still proceed when its audit entry failed to write. This helper
   * tells administrators that every elevated action is recorded, and on beta.1 that sentence
   * is not true. Declaring the lower floor would install against a build where the promise
   * quietly does not hold, which is worse than refusing to install at all.
   *
   * beta.2 also adds `runGrant`, so the moment a service actually restarts is logged.
   *
   * The PRE-RELEASE, not a bare "1.7.1": semver ranks a pre-release below its release, so
   * "1.7.1" would be refused on every 1.7.1 beta — exactly the builds beta users run.
   */
  minAppVersion: "1.7.1-beta.4",

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

  onUninstall: revokeGrantsOnUninstall,
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
