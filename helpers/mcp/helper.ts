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

/**
 * MCP helper — lets an AI assistant read and manage this install, as an account you choose.
 *
 * **Why a helper and not a separate server.** An external MCP process would have to authenticate
 * across a boundary, which is why it once needed core to build a whole API. A helper runs
 * in-process at boot with the database, the registry and the updater already in hand, so there is
 * no boundary and no API. The cost, accepted deliberately: this is an AI-facing network surface
 * inside the app process, and its own auth code is the only thing gating it — helpers are not
 * verifier-scanned. See HELPER.md.
 *
 * **Nothing listens until an administrator switches it on AND a key exists.** Installing this opens
 * no port. That is checked in `startListener`, not merely intended.
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
  version: "0.0.1-beta.1",
  // `listBindableAccounts` / `resolveBindableAccount` / `getEffectivePermissionsUncached` and the
  // `onIdentityRemoved` hook all arrived in 1.7.3-beta.1 (SEC-07). This helper cannot bind a key
  // without them, so an older core is not a degraded experience — it is a helper with nothing to
  // bind to. The PRE-RELEASE, not a bare "1.7.3": semver ranks a pre-release below its release.
  minAppVersion: "1.7.3-beta.1",

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

      case "exposed": {
        const on = payload.value === true;
        await setNetworkExposed(on);
        // Rebind, because the address is fixed when the socket opens.
        await stopListener();
        await startListener(dispatch);
        return {
          ok: true,
          message: on
            ? "Now reachable from your network. Turn on HTTPS if you have not — a key travels in clear text without it."
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
        const mode = payload.mode === "act" ? "act" : "read";
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
        await setKeyMode(String(payload.id ?? ""), payload.value === "act" ? "act" : "read");
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
