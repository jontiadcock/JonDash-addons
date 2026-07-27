import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { enableModule, disableModule } from "@/lib/modules/manage";
import { getModuleDef } from "@/lib/modules/registry";
import { register } from "./tools";
import type { Identity } from "./authorize";

/**
 * The acting tools. Everything here changes state.
 *
 * Each needs **both** gates: a key in `act` mode, and a bound account holding the permission. The
 * dispatcher enforces both before `run` is reached — see `decide.ts`. Promoting a key to `act` can
 * never grant what its account lacks.
 *
 * ## Every action is attributed to the service account
 *
 * `audit(action, { userId: identity.accountId })` on every one, which was half the point of asking
 * core for service accounts: before them, an agent's actions were logged against whichever *person*
 * the key was bound to, and the log blamed a human for something they did not do. Now the log names
 * the agent's own identity.
 *
 * The action string is prefixed `mcp.` so an admin can filter the audit log to exactly what came in
 * through an assistant.
 */

/** Written before AND after anything destructive, so an action cannot happen unrecorded. */
async function record(identity: Identity, action: string, detail: string): Promise<void> {
  await audit(`mcp.${action}`, { userId: identity.accountId, detail });
}

register({
  name: "revoke_session",
  description:
    "Sign out one active session by its id, from list_sessions. Use it when a sign-in looks wrong — an unfamiliar location or device. The person is signed out immediately and must sign in again. It cannot sign out the session you would need to fix a mistake.",
  kind: "act",
  permission: "sessions.manage",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The session id from list_sessions." } },
    required: ["id"],
  },
  run: async (args, identity) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("Give the session id from list_sessions.");

    const session = await prisma.session.findUnique({
      where: { id },
      select: { id: true, user: { select: { id: true, email: true, displayName: true, role: true, isServiceAccount: true } } },
    });
    if (!session) throw new Error("That session no longer exists.");

    /**
     * **The lockout guard.** The owner's one absolute line is never losing access to their own
     * install, and an agent that can revoke sessions is exactly how that would happen — a
     * confused model "cleaning up suspicious sessions" signs the owner out of the machine it is
     * running on, and they cannot get back in to stop it.
     *
     * So: an agent may not revoke a HUMAN ADMIN's session. It can revoke its own kind, and it can
     * revoke ordinary users. Deliberately blunt rather than clever — "is this the owner's current
     * session" is not knowable from here, and a rule that needs to guess is one that fails on the
     * day it matters.
     */
    if (session.user.role === "ADMIN" && !session.user.isServiceAccount) {
      await record(identity, "revoke_session.refused", `refused: ${session.user.email} is an administrator`);
      throw new Error(
        "That session belongs to an administrator, and an assistant cannot sign an administrator out — " +
          "it could lock the owner out of their own install. Do it from Admin → Sessions.",
      );
    }

    const who = session.user.displayName ?? session.user.email;
    await record(identity, "revoke_session", `signing out ${who}`);
    await prisma.session.delete({ where: { id } });
    await record(identity, "revoke_session.done", `signed out ${who}`);

    return `Signed out ${who}. They will need to sign in again.`;
  },
});

register({
  name: "set_module_enabled",
  description:
    "Turn an installed add-on module on or off by its id, from list_modules. Disabling stops it running but keeps its data and settings. It does not install, update or remove anything.",
  kind: "act",
  permission: "modules.manage",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The module id from list_modules." },
      enabled: { type: "boolean", description: "true to turn on, false to turn off." },
    },
    required: ["id", "enabled"],
  },
  run: async (args, identity) => {
    const id = String(args.id ?? "");
    const enabled = args.enabled === true;
    if (!id) throw new Error("Give the module id from list_modules.");

    /**
     * **An assistant may not disable the module carrying its own helper.**
     *
     * Since `startListener` refuses to bind when no enabled add-on depends on this helper, doing so
     * would shut the endpoint down — an agent severing its own connection mid-conversation, leaving
     * an admin to work out from a dead assistant that it switched itself off. An action whose only
     * outcome is "the caller disappears" is not one worth offering.
     *
     * A person may absolutely do this; it is the documented way to close the endpoint from Addons.
     * The refusal is about who is asking, not about the change.
     */
    if (id === "mcp-server") {
      await record(identity, "set_module_enabled.refused", "refused: cannot disable its own module");
      throw new Error("This assistant cannot disable the module it runs through. Do it from Admin → Addons.");
    }

    // The same functions the admin screen calls, so enabling through an assistant and enabling
    // by hand run identical lifecycle hooks — no second code path to diverge.
    const def = getModuleDef(id);
    if (!def) throw new Error(`No module with id "${id}". Use list_modules to see them.`);

    await record(identity, "set_module_enabled", `${enabled ? "enabling" : "disabling"} ${id}`);
    if (enabled) await enableModule(def);
    else await disableModule(def);
    return `${id} is now ${enabled ? "enabled" : "disabled"}.`;
  },
});
