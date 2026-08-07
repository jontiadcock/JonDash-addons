import type { HelperDefinition } from "@/lib/helpers/types";
import {
  listKeys,
  mintKey,
  revokeKey,
  revokeKeysForAccount,
  setEnabled,
  setKeyMode,
  setNetworkExposed,
  setPort,
  setShutdownAllowed,
} from "./lib/keys";
import { isBindableAccount } from "./lib/authorize";
import { dispatch } from "./lib/dispatch";
import { startListener, stopListener } from "./lib/transport";
import { allTools } from "./lib/tools";
import SettingsPanel from "./ui/settings-panel";
// Imported for side effect: registering a tool happens at module load, so these must be pulled in
// before anything calls the registry. Nothing is exported from them.
import "./lib/tools-read";
import "./lib/tools-act";
import "./lib/tools-admin";

/**
 * MCP helper — lets an AI assistant read and manage this install, as an account you choose.
 *
 * Runs in-process at boot with the database, the registry and the updater already in hand, so
 * there is no auth boundary to cross. ⚠ The cost: this is an AI-facing network surface inside the
 * app process, gated only by its own auth code — helpers are not verifier-scanned. See HELPER.md.
 *
 * Nothing listens until an administrator switches it on AND a key exists — installing this opens
 * no port, enforced in `startListener`, not merely intended.
 */

/**
 * `onBoot` must register and return — it blocks the server becoming ready, and a helper that throws
 * must never be why the dashboard won't start.
 *
 * `listen()` is non-blocking, so starting the endpoint costs nothing here. The whole body is
 * wrapped: a port already in use, a corrupt setting, anything at all — the endpoint stays down and
 * JonDash comes up. Failing to start an assistant is an inconvenience; failing to start JonDash is
 * an outage.
 */
async function boot(): Promise<void> {
  try {
    await startListener(dispatch);
  } catch {
    // Deliberately silent here: core isolates and logs a throwing helper, and there is no admin
    // watching boot. The settings page reports the endpoint as not listening, which is the truth.
  }
}

const helper: HelperDefinition = {
  id: "mcp",
  name: "AI assistant access",
  description:
    "Lets an AI assistant read and manage this server — see your services, check for updates, review sign-ins — using a key you create and can revoke. It can only do what the account you pick can do.",
  version: "0.0.4",
  // Needs beta.2, not just beta.1's service accounts (SEC-07): `resolveBindableAccount` only
  // gained the helper-id argument it's called with on every request in beta.2.
  minAppVersion: "1.7.3-beta.2",

  /**
   * Two capabilities, because a capability with a looking-at-it form and a doing-something-to-it
   * form declares both (HELPERS-DESIGN rule 9). A module wanting to show endpoint status must not
   * have to disclose the power to change things.
   *
   * **Neither describes the real risk, and that is a known limitation of the consent model.** These
   * say what the helper lends a MODULE. The risk here is an external endpoint, which no module
   * capability expresses — so the warning lives on the settings page and in HELPER.md, and
   * "installed" deliberately does not mean "listening".
   */
  provides: [
    {
      permission: "mcp:read",
      describe: () => "See whether AI assistant access is switched on, and which keys exist",
      label: "See assistant access status",
      // Status only — no key material, no tool output. A module holding this learns whether the
      // endpoint is on, not what an agent can do through it.
      risk: "low",
    },
    {
      permission: "mcp:act",
      describe: () => "Let an AI assistant change things, within the permissions of the account its key uses",
      label: "Allow assistants to make changes",
      // An assistant acting on the install. Bounded by its account, but this is the line between
      // watching and doing.
      risk: "high",
    },
    {
      permission: "mcp:admin",
      describe: () => "Let an AI assistant restart this server, apply JonDash updates and write backups",
      label: "Allow assistants to restart and update this server",
      /**
       * **Its own capability, because the consent screen has to say the true thing.**
       *
       * Rolled into `mcp:act`, this would have read "make changes" — which describes disabling a
       * module and restarting the machine identically. They are not the same decision: everything
       * under `act` can be undone by a person at the dashboard, and everything under `admin` takes
       * the dashboard away while it happens. Shutting down is excluded even from this, and needs a
       * separate switch on the settings page.
       */
      risk: "high",
    },
  ],

  migrations: "./migrations",

  onBoot: boot,

  SettingsPanel,

  /**
   * The only way any of this changes. Core renders the form and resolves `ctx.user` from the
   * session, so no module is in the path — the same shape as every other helper here.
   *
   * Refusals are returned rather than thrown: core catches and audits a throw, but an admin can act
   * on "that is not a service account" and cannot act on a stack trace.
   */
  onSettingsSubmit: async (ctx, payload) => {
    const op = String(payload.op ?? "");

    switch (op) {
      case "enabled": {
        const on = payload.value === true;
        await setEnabled(on);
        // Applied immediately rather than at the next restart — an admin switching this off
        // expects the port closed now, not eventually.
        if (on) await startListener(dispatch);
        else await stopListener();
        return { ok: true, message: on ? "Switched on." : "Switched off — the port is closed." };
      }

      case "shutdown-allowed": {
        // The only tool an administrator has to switch on by hand. Everything else an `admin` key
        // can do comes back on its own; this one needs somebody at the machine.
        const on = payload.value === true;
        await setShutdownAllowed(on);
        return {
          ok: true,
          message: on
            ? "An assistant can now shut this server down. Nothing remote can start it again — someone has to run the launcher on this machine."
            : "Switched off. An assistant can restart the server but not shut it down.",
        };
      }

      case "exposed": {
        const on = payload.value === true;

        /**
         * ⚠ Opening this to the network without HTTPS is refused, not merely warned about — a
         * sniffed key is a *working* key, carrying whatever the bound account holds.
         *
         * Override allowed rather than an absolute bar: plain HTTP on a LAN you trust is a
         * legitimate choice, and one confirmation is the difference between choosing it and
         * stumbling into it.
         */
        if (on && !payload.confirm) {
          const { readNetworkConfig } = await import("@/lib/tls/network-config.mjs");
          if (readNetworkConfig().mode === "off") {
            return {
              ok: false,
              error:
                "HTTPS is off, so a key would cross your network in clear text — anyone who can " +
                "see the traffic could reuse it, with everything the account behind it can do. " +
                "Turn on HTTPS under Admin → Network & HTTPS, or confirm on this page to open it anyway.",
            };
          }
        }

        await setNetworkExposed(on);
        // Rebind, because the address is fixed when the socket opens.
        await stopListener();
        await startListener(dispatch);
        return {
          ok: true,
          message: on
            ? "Now reachable from your network."
            : "Back to this machine only.",
        };
      }

      case "port": {
        if (!(await setPort(Number(payload.value)))) return { ok: false, error: "That port is not one of the options." };
        await stopListener();
        await startListener(dispatch);
        return { ok: true, message: `Now on port ${Number(payload.value)}.` };
      }

      case "mint": {
        const accountId = String(payload.accountId ?? "");
        // Re-checked here even though the dropdown only offers service accounts: the form is a
        // suggestion, and this is the gate.
        if (!(await isBindableAccount(accountId))) {
          return { ok: false, error: "That is not a service account. A key can never act as a person." };
        }
        // Unrecognised reads as the LEAST privileged mode. A malformed form must never mint
        // something more powerful than was asked for.
        const mode = payload.mode === "admin" ? "admin" : payload.mode === "act" ? "act" : "read";
        const { key } = await mintKey({
          label: String(payload.label ?? "").trim(),
          accountId,
          mode,
          createdBy: ctx.user.id,
        });
        // The key itself rides back in `message` — the one time it is ever readable. The panel
        // shows it and drops it; only a hash was stored.
        await startListener(dispatch);
        return { ok: true, message: key };
      }

      case "mode": {
        const next = payload.value === "admin" ? "admin" : payload.value === "act" ? "act" : "read";
        await setKeyMode(String(payload.id ?? ""), next);
        return { ok: true, message: "Changed." };
      }

      case "revoke": {
        await revokeKey(String(payload.id ?? ""));
        // Revoking the last key closes the port: a listener with nothing able to authenticate is
        // a surface with no purpose.
        const remaining = await listKeys();
        if (remaining.length === 0) await stopListener();
        return { ok: true, message: "Revoked. It stops working immediately." };
      }

      default:
        return { ok: false, error: "Unknown action." };
    }
  },

  /**
   * Hygiene, explicitly NOT the safety property.
   *
   * Core documents it that way and agreed to; recorded here too so nobody later designs against it.
   * Keys bound to a deleted account already fail closed on every call, because `authorize()`
   * re-resolves the account each time. This just removes the dead rows so the settings page does
   * not list a key pointing at nothing.
   *
   * If this never fired, nothing would be insecure — the list would merely be untidy.
   */
  onIdentityRemoved: async (ctx, accountId) => {
    const n = await revokeKeysForAccount(accountId);
    if (n > 0) {
      await ctx.audit?.("mcp.keys.revoked", `${n} key(s) dropped: their account was removed`);
    }
  },

  /**
   * Stop listening before the files go. Without this the port would stay bound until the next
   * restart, with no code behind it and nothing in the UI admitting it exists.
   */
  onUninstall: async (ctx) => {
    await stopListener();
    await ctx.audit("mcp.uninstall", `endpoint stopped; ${allTools().length} tools unregistered`);
  },
};

export default helper;
