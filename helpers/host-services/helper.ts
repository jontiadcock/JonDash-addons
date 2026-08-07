import type { HelperDefinition } from "@/lib/helpers/types";
import { addEntry, listServiceLabels, readConfig, removeEntry, setUnattended } from "./lib/allowlist";
import { decline, execute } from "./lib/requests";
import { readGrants, revokeEverything } from "./lib/grant";
import { controlScope, readScope } from "./lib/scopes";
import { explainAdd } from "./lib/wording";
import SettingsPanel from "./ui/settings-panel";

/**
 * Last chance to take back what this helper gave the operating system. Grants outlive JonDash
 * by design, so once the helper is pruned nothing is left that knows they exist. Owner:
 * *"when the module is removed, I don't want a random task present."*
 *
 * Fast path costs nothing: `readGrants()` needs no elevation, so an install that never
 * approved a service returns in milliseconds. Revoking a live grant is the slow path, which
 * needs elevation — hence `uninstallMayPrompt` below.
 *
 * ⚠ A declined or timed-out revocation stays loud: it writes an INCOMPLETE entry naming the
 * tasks and both ways to remove them, since nothing else will know once this returns.
 */
async function revokeGrantsOnUninstall(
  ctx: Parameters<NonNullable<HelperDefinition["onUninstall"]>>[0],
  answers: Record<string, boolean>,
): Promise<void> {
  const existing = await readGrants();
  if (existing.length === 0) {
    await ctx.audit("host-services.uninstall", "no grants to revoke");
    return;
  }

  // Absent is not false, and neither is consent — the question defaults to ON, so a missing
  // answer must not silently mean "keep the permissions". Hence `=== false`, not a falsy check.
  if (answers.revoke === false) {
    await ctx.audit(
      "host-services.uninstall",
      `left ${existing.length} grant(s) in place at your request: ${existing.map((g) => g.name).join(", ")}. ` +
        `Remove them in Task Scheduler under \\JonDash\\ if you change your mind.`,
    );
    return;
  }

  const names = existing.map((g) => g.name).join(", ");
  const outcome = await revokeEverything();

  if (outcome.status === "ok") {
    await ctx.audit("host-services.uninstall", `revoked ${existing.length} grant(s): ${names}`);
    return;
  }

  // Never report a clean uninstall while privileges remain on the machine — the wording below
  // names the tasks and both ways to remove them, since no JonDash screen will know of them.
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
 * Host services helper — lets a module start, stop and restart services an administrator has
 * explicitly listed, and nothing else. Both safeguards are admin-owned config, not caller
 * arguments: a module can NAME a service on the allowlist but never add one, and each grant is
 * a Scheduled Task with the service and verb baked in, so `schtasks /run` (which takes no args)
 * makes Windows — not this code — enforce what can run unprompted. Removing an entry prompts
 * again, since withdrawing a standing privilege is itself an administrator action.
 *
 * ⚠ NOT proven, and must not be claimed: whether the task's security descriptor stops a
 * standard user *editing* a grant. Until tested, treat a grant as narrow and permanent, not
 * tamper-proof. See HELPER.md and ../ELEVATION.md for the model this applies.
 */
const helper: HelperDefinition = {
  id: "host-services",
  name: "Host services",
  description:
    "Lets a module see and control the services you list — a Windows service, a systemd unit — so a dashboard can restart something without you opening a terminal. Only the services you add, and only start, stop and restart.",
  version: "0.0.6",
  /**
   * ⚠ Hard floor, not a preference — this build is the first with `SettingsPanel` /
   * `onSettingsSubmit`, and it also clears every earlier floor this helper has needed
   * (`@/lib/elevation`, audit-before-acting, `runGrant`, `uninstallQuestions`).
   *
   * A pre-release value, not a bare "1.7.2": semver ranks a pre-release below its release, so
   * "1.7.2" would refuse every 1.7.2 beta, including the one with the feature.
   *
   * ⚠ Raised for CORE-10: the `label`/`risk`/`scope` fields are optional in the contract, so
   * omitting them still installs on an older core, but DECLARING them does not — a core below
   * this floor fails to build (helpers compile into the app) — re-verify before lowering it.
   */
  minAppVersion: "1.7.2-beta.1",

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
      label: "See service status",
      // Names and run states of software installed here. Worth disclosing, but it changes
      // nothing on the machine — reserving "high" for what actually can.
      risk: "low",
      scope: readScope,
    },
    {
      permission: "host-services:control",
      describe: (config) => `Start, stop and restart ${which(config)}`,
      label: "Start and stop services",
      // Stopping the wrong service takes this machine off the network, off remote access, or
      // takes JonDash itself down. That is the definition of high.
      risk: "high",
      scope: controlScope,
    },
    /*
     * ⚠ No third capability, ever again. `host-services:configure` existed briefly because the
     * allowlist editor had nowhere else to live but a module's own settings panel — which meant
     * the MODULE supplied the service name being approved, so it could display "Add Plex" and
     * submit `sshd`. Declaring the power made the consent screen honest without making the
     * arrangement right: the thing being bounded could still edit its own boundary.
     *
     * The editor now lives in `ui/settings-panel.tsx`, reachable only through core (see
     * `onSettingsSubmit` below). Generalised as HELPERS-DESIGN Rule 8: a helper's module-facing
     * API must contain no mutators for admin-owned configuration — read and request, never add,
     * remove or approve.
     */
  ],

  migrations: "./migrations",

  readConfig,

  SettingsPanel,

  /**
   * Everything that changes the allowlist, in one place, reachable only through core.
   *
   * Core has already asserted same-origin and `modules.manage` before this runs, and builds
   * `ctx.user` from the resolved session — so unlike the old module-supplied context, it is
   * not something a caller can fabricate. There is deliberately no permission check of our
   * own here: adding one would suggest this is reachable by some other route, and it is not.
   *
   * Throwing is safe — core catches, audits and shows it — but a refusal the admin can act on
   * is better returned than thrown.
   */
  onSettingsSubmit: async (ctx, payload) => {
    const op = String(payload.op ?? "");
    const userId = ctx.user.id;

    switch (op) {
      case "add": {
        const serviceName = String(payload.serviceName ?? "").trim();
        if (!serviceName) return { ok: false, error: "Name a service." };
        const r = await addEntry({
          serviceName,
          label: String(payload.label ?? "").trim() || undefined,
          canControl: payload.readOnly !== true,
          addedBy: userId,
        });
        if (!r.ok) return { ok: false, error: explainAdd(r) };
        // The risk warning rides back on success, because "you have just allowed something
        // that can lock you out" is only useful at the moment it becomes true.
        return { ok: true, message: `Added ${r.entry.serviceName}.${r.risk.level === "none" ? "" : ` ${r.risk.message}`}` };
      }

      case "remove": {
        const r = await removeEntry(String(payload.id ?? ""));
        return r.ok ? { ok: true, message: "Removed." } : { ok: false, error: "Could not withdraw the permission." };
      }

      case "unattended": {
        const on = payload.value === true;
        await setUnattended(String(payload.id ?? ""), on);
        return {
          ok: true,
          message: on
            ? "That service can now be controlled without asking you first."
            : "That service will ask for your approval each time.",
        };
      }

      case "approve": {
        const outcome = await execute(String(payload.id ?? ""), userId);
        if (outcome.status === "approved") {
          return outcome.ok ? { ok: true, message: "Done." } : { ok: false, error: `It ran but failed: ${outcome.detail}` };
        }
        if (outcome.status === "cancelled-at-uac") {
          return { ok: false, error: "You dismissed the Windows permission prompt, so nothing happened." };
        }
        return { ok: false, error: outcome.status === "failed" ? outcome.detail : "That request is no longer waiting." };
      }

      case "decline": {
        await decline(String(payload.id ?? ""), userId);
        return { ok: true, message: "Declined." };
      }

      default:
        return { ok: false, error: "Unknown action." };
    }
  },

  /**
   * Revoking a grant raises a UAC prompt, so this hook needs to outlive the 5s default. It is
   * for waiting on a person, not for slow code — the empty case still returns in about 190ms
   * because reading grants needs no elevation.
   */
  uninstallMayPrompt: true,

  /**
   * Asked rather than assumed, now that core can put a question on the uninstall screen.
   *
   * Defaults to **on**, which is the opposite of `host-install`'s and deliberately so: a grant
   * is a standing Windows permission that exists only to serve JonDash. Nobody else wants it,
   * and leaving one behind is the orphan the elevation design forbids. Installed software is
   * the admin's and might be in use; a permission to restart Plex is not.
   *
   * Only asked when there is something to revoke — reading grants needs no elevation, so the
   * empty case adds a question to nobody's screen.
   */
  uninstallQuestions: async () => {
    const grants = await readGrants();
    if (grants.length === 0) return [];
    return [
      {
        id: "revoke",
        label: `Withdraw the ${grants.length} Windows permission${grants.length === 1 ? "" : "s"} JonDash holds?`,
        detail:
          "These let JonDash start and stop services without asking. Leaving them means they stay on " +
          "this machine with nothing in JonDash to show them. Windows will ask you to confirm.",
        default: true,
      },
    ];
  },

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
