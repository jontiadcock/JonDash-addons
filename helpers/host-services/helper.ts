import type { HelperDefinition } from "@/lib/helpers/types";
import { addEntry, listServiceLabels, readConfig, removeEntry, setUnattended } from "./lib/allowlist";
import { decline, execute } from "./lib/requests";
import { readGrants, revokeEverything } from "./lib/grant";
import SettingsPanel from "./ui/settings-panel";

/** Wording for a refused add. Separate so the panel gets a sentence, not a code. */
function explainAdd(r: Exclude<Awaited<ReturnType<typeof addEntry>>, { ok: true }>): string {
  switch (r.reason) {
    case "duplicate":
      return "That service is already on the list.";
    case "unusable-name":
      return "That name has no characters that can be used.";
    case "name-clash":
      // Names the entry in the way, because "pick another name" is useless advice when the
      // service name is not yours to choose.
      return `Windows would give this the same permission name as "${r.detail}". Remove that entry first if this is the one you want.`;
    case "grant-refused": {
      const o = r.outcome;
      if (o.status === "cancelled-at-uac") return "You dismissed the Windows permission prompt.";
      if (o.status === "timed-out") return "The permission prompt was not answered in time.";
      if (o.status === "unavailable") return "This installation cannot grant that permission.";
      // Narrowed via the discriminant rather than reaching for `.detail` on the union — `ok`
      // has no such field, and TypeScript is right to say so.
      return o.status === "failed" ? o.detail : "The permission could not be granted.";
    }
  }
}

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
 * **The slow path is allowed to wait, via `uninstallMayPrompt`.** Revoking needs elevation and
 * elevation waits on a human, so the 5s default could never cover it. Setting that flag raises
 * the budget to the elevation timeout, and the hook already runs *inside* the uninstall the
 * admin just clicked — they are at the screen, so the prompt has obvious provenance.
 *
 * The failure path still has to be loud, because an orphaned grant nobody knows about is
 * exactly what this hook exists to prevent: a declined or timed-out revocation writes an
 * INCOMPLETE entry naming the tasks and both ways to remove them, since once this returns
 * there is no JonDash screen left that knows they exist.
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

  // Absent is not false, and neither is consent. The question defaults to ON, so a screen that
  // failed to render it must not silently mean "keep the permissions" — but an explicit
  // untick must be honoured. Hence `=== false` rather than a falsy check.
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
 * **Working end to end since JonDash 1.7.1-beta.7** (OPS-18). Proven on a real machine: one
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
  version: "0.0.2",
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
  // 1.7.1-beta.**9**, the first build with `SettingsPanel` / `onSettingsSubmit` — checked
  // tag by tag rather than assumed, because beta.7 and beta.8 do not have them and this
  // release does not work without them.
  //
  // The PRE-RELEASE, not a bare "1.7.1": semver ranks a pre-release below its release, so
  // "1.7.1" would refuse every 1.7.1 beta — including beta.9, which has the feature.
  minAppVersion: "1.7.1-beta.9",

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
    /*
     * There is no third capability, and there must not be one again.
     *
     * `host-services:configure` existed briefly (0.0.1 stable) because the allowlist editor
     * had nowhere to live but a consuming module's settings panel, which meant the module
     * supplied the service name being approved — it could display "Add Plex" and submit
     * `sshd`. Declaring the power made the consent screen honest without making the
     * arrangement right: the thing being bounded could still edit its own boundary.
     *
     * JonDash 1.7.1 gave helpers their own settings page, so the editor moved to
     * `ui/settings-panel.tsx` and the capability was deleted. **Rule 8 of HELPERS-DESIGN
     * now states it generally: a helper's module-facing API must contain no mutators for
     * admin-owned configuration — read and request, never add, remove or approve.**
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
