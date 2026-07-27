import { audit } from "@/lib/audit";
import { getUpdateStatus, clearUpdateStatusCache, requestUpdateRestart } from "@/lib/update";
import { requestServerRestart, requestServerShutdown } from "@/lib/server-control";
import { readChannel, writeChannel } from "@/lib/update-channel";
import { serializeBackup } from "@/lib/backup";
import { register } from "./tools";
import { isShutdownAllowed } from "./keys";

/**
 * Tools that act on the SERVER rather than on data inside it.
 *
 * **Separate file because the blast radius is different, not because there are a lot of them.**
 * Everything in `tools-act.ts` can be undone by a person at the dashboard. Everything here can
 * take the dashboard away for a while — and one of them can take it away until somebody walks to
 * the machine. That difference deserves to be visible in the file layout.
 *
 * All of these require a key in `admin` mode **and** `settings.manage` on the bound account. Both,
 * every time. Promoting a key to `admin` grants nothing an account without `settings.manage` could
 * not already do; the mode narrows, exactly as it does for `act`.
 *
 * ## What is deliberately NOT here, and never will be
 *
 * Core exposes plenty more that this could reach. These are refused permanently, and the reason is
 * one sentence: **an agent must never be able to widen its own reach, or remove the record of what
 * it did.**
 *
 *  - **Granting a role or a permission** (`setUserRolesAction`, the Permissions actions). An agent
 *    that can grant a role can grant one to its own service account, and every gate in this helper
 *    becomes decoration. This is the single most important exclusion in the file.
 *  - **Credentials and MFA** — creating users, resetting access, disabling or deleting an account.
 *    The owner's absolute line is never losing access to their own install.
 *  - **Restoring a backup.** The one operation that writes old data over current data.
 *  - **Clearing the audit log.** The refusal log and the audit trail are how anyone finds out an
 *    agent misbehaved. Anti-forensics is not a feature.
 *  - **Network and HTTPS settings.** Can sever remote access to the machine it is running on.
 */

register({
  name: "check_for_updates",
  description:
    "Whether a JonDash update is available, and what it is: the current version, the version it would move to, the release type and a short summary. Checks only — applies nothing.",
  kind: "read",
  permission: "settings.manage",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    // `force` deliberately not exposed. The result is cached for three minutes and a model asked
    // "are there updates?" twice in a conversation would otherwise hammer the release feed.
    const s = await getUpdateStatus();
    return {
      updateAvailable: s.updateAvailable,
      current: s.current,
      latest: s.latest,
      channel: s.channel,
      release: s.release,
      supported: s.supported,
      lastFailure: s.failure,
      reason: s.reason ?? null,
    };
  },
});

register({
  name: "list_module_updates",
  description:
    "Which installed add-ons have a newer version available, and what version that is. Read-only — it cannot install or update anything.",
  kind: "read",
  permission: "modules.manage",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    const { getModuleUpdateStatus } = await import("@/lib/modules/updates");
    const s = await getModuleUpdateStatus();
    const pending = (s.modules ?? []).filter((m) => m.updateAvailable);
    return {
      updatesAvailable: pending.length,
      modules: pending.map((m) => ({
        id: m.id,
        installed: m.installedVersion,
        latest: m.latestVersion,
        channel: m.channel,
        blocked: m.blockedReason ?? null,
      })),
      /**
       * **Reporting only, and deliberately so.** Installing or updating an add-on is the one
       * documented route from "trusted admin" to code running in this process — it is how the
       * penetration test's own flag would have been reachable, and it is the residual risk the
       * report named. An assistant that could install a module could install one declaring
       * `filesystem:write` and then be running arbitrary first-party-shaped code.
       *
       * It also approves permissions on the owner's behalf: core deliberately never auto-applies a
       * module update that ADDS a permission, and an agent doing it would be answering the consent
       * question nobody asked it.
       */
      note: "Apply these from Admin → Addons. An assistant deliberately cannot install or update add-ons.",
    };
  },
});

register({
  name: "apply_update",
  description:
    "Apply the available JonDash update and restart into it. You MUST pass the exact version from check_for_updates as `version` — if it no longer matches, this refuses rather than installing something else. The dashboard is briefly unreachable. A failed update is rolled back automatically.",
  kind: "admin",
  permission: "settings.manage",
  inputSchema: {
    type: "object",
    properties: {
      version: {
        type: "string",
        description: "The exact version from check_for_updates, e.g. \"1.8.0\". Confirms what you intend to install.",
      },
    },
    required: ["version"],
  },
  run: async (args, identity) => {
    const asked = String(args.version ?? "").trim();
    if (!asked) throw new Error("Give the version you mean to install, from check_for_updates.");

    // Re-read rather than trusting a status the model may have fetched several turns ago.
    clearUpdateStatusCache();
    const s = await getUpdateStatus(true);

    if (!s.supported) throw new Error("This build cannot update itself. Update it the way it was installed.");
    if (!s.updateAvailable || !s.latest) return `Already up to date on ${s.current}. Nothing to apply.`;

    /**
     * **The confirmation that makes this tool safe to offer at all.**
     *
     * Without it the sequence is "check, describe 1.8.0 to the operator, get a yes, apply whatever
     * is newest now" — and between those steps the release can move. The operator approved a
     * version, so that is the version this installs or none at all. It also converts the ordinary
     * race into a clear refusal rather than a surprise.
     */
    if (s.latest !== asked) {
      throw new Error(
        `You asked to install ${asked} but the available release is now ${s.latest}. ` +
          `Nothing has been applied. Run check_for_updates again and confirm the new version.`,
      );
    }

    await audit("mcp.update.apply", {
      userId: identity.accountId,
      detail: `${s.current} -> ${s.latest} (${s.release?.type ?? "unknown"}, ${s.release?.criticality ?? "unknown"})`,
    });

    // Exits the process on a timer; the supervisor restarts into the new version. Nothing after
    // this line is guaranteed to run, so the audit row is written first.
    requestUpdateRestart();
    return `Applying ${s.current} → ${s.latest}. JonDash is restarting and will be unreachable for a moment. If it fails it rolls back on its own.`;
  },
});

register({
  name: "set_update_channel",
  description:
    "Switch JonDash between the stable and beta release channels. Changes which updates are offered; applies nothing on its own.",
  kind: "admin",
  permission: "settings.manage",
  inputSchema: {
    type: "object",
    properties: { channel: { type: "string", description: '"stable" or "beta".' } },
    required: ["channel"],
  },
  run: async (args, identity) => {
    const wanted = String(args.channel ?? "").toLowerCase();
    if (wanted !== "stable" && wanted !== "beta") throw new Error('Channel must be "stable" or "beta".');

    const from = readChannel();
    if (from === wanted) return `Already on the ${wanted} channel.`;

    writeChannel(wanted);
    // Without this the Updates page keeps offering the old channel's release for up to three
    // minutes and the switch looks like it did nothing — core's BUG-35, worth not repeating.
    clearUpdateStatusCache();
    await audit("mcp.update.channel", { userId: identity.accountId, detail: `${from} -> ${wanted}` });
    return `Switched from ${from} to ${wanted}. Run check_for_updates to see what that offers.`;
  },
});

register({
  name: "create_backup",
  description:
    "Write a backup of this JonDash install and report its size. Encrypt it by passing a passphrase — an unencrypted backup deliberately leaves out every secret, so it cannot restore credentials.",
  kind: "admin",
  // Core has a dedicated permission for this; using settings.manage would have been close enough
  // to pass review and wrong in the way that matters — an account trusted with settings is not
  // automatically trusted with a file containing the master key.
  permission: "backups.manage",
  inputSchema: {
    type: "object",
    properties: {
      passphrase: {
        type: "string",
        description:
          "Optional. With one, the backup is encrypted and complete. Without one, secrets are omitted.",
      },
    },
  },
  run: async (args, identity) => {
    const passphrase = typeof args.passphrase === "string" && args.passphrase ? args.passphrase : null;
    const bytes = await serializeBackup(passphrase);

    // The passphrase is never audited, never returned, and never logged — it is the thing that
    // protects the archive, and an audit row an agent can read back would defeat it.
    await audit("mcp.backup.create", {
      userId: identity.accountId,
      detail: `${bytes.byteLength} bytes, ${passphrase ? "encrypted" : "unencrypted (secrets omitted)"}`,
    });

    return {
      bytes: bytes.byteLength,
      encrypted: passphrase !== null,
      note: passphrase
        ? "Encrypted, and it contains the master key — treat the file as a credential."
        : "Unencrypted, so every secret was left out. It cannot restore credentials.",
      // The archive itself is NOT returned. Handing an agent the bytes of a backup containing the
      // master key would make every other restriction here pointless.
      retrieve: "Download it from Admin → Backup. It is deliberately not returned through this tool.",
    };
  },
});

register({
  name: "restart_server",
  description:
    "Restart JonDash. It comes back on its own within about a minute and everyone stays signed in. Use it when a setting needs a restart, or something is misbehaving.",
  kind: "admin",
  permission: "settings.manage",
  inputSchema: { type: "object", properties: {} },
  run: async (_args, identity) => {
    await audit("mcp.server.restart", { userId: identity.accountId, detail: "requested by an assistant" });
    requestServerRestart();
    return "Restarting. JonDash will be back in under a minute and you will stay signed in.";
  },
});

register({
  name: "shutdown_server",
  description:
    "Shut JonDash down completely. It does NOT come back on its own — someone has to start it again on the machine itself. Off unless an administrator has enabled it.",
  kind: "admin",
  permission: "settings.manage",
  inputSchema: {
    type: "object",
    properties: {
      confirm: {
        type: "string",
        description: 'Must be exactly "shut down" — a deliberate second step, since nothing remote can undo this.',
      },
    },
    required: ["confirm"],
  },
  run: async (args, identity) => {
    /**
     * **Off by default, behind its own switch.** (Owner's call, 2026-07-27.)
     *
     * Every other tool here is recoverable: a restart returns by itself, a bad update rolls back,
     * a channel switch is one call away from being reversed. This one ends with the dashboard down
     * until a person is physically at the machine — core's own words: *"restarting then requires
     * running the launcher on the host."*
     *
     * So it is not enough that the key is `admin` and the account holds `settings.manage`. An
     * administrator has to have turned this specific tool on, on the settings page, knowing what
     * it does. An assistant misreading "shut down the docker container" cannot reach it by
     * accident.
     */
    if (!(await isShutdownAllowed())) {
      throw new Error(
        "Shutting the server down through an assistant is switched off. An administrator can enable " +
          "it under Admin → Addons → Shared capabilities → AI assistant access. It is off by default " +
          "because nothing can start JonDash again remotely.",
      );
    }

    // A typed phrase rather than a boolean: `true` is what a model passes when it is guessing at a
    // schema, and this is the one call where a guess is unrecoverable.
    if (String(args.confirm ?? "").trim().toLowerCase() !== "shut down") {
      throw new Error('To shut down, pass confirm: "shut down" exactly. Nothing has been stopped.');
    }

    await audit("mcp.server.shutdown", {
      userId: identity.accountId,
      detail: "requested by an assistant; requires a person at the machine to start it again",
    });
    requestServerShutdown();
    return "Shutting down. JonDash will NOT restart by itself — someone has to run the launcher on that machine.";
  },
});
