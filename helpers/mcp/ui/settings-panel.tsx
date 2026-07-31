import type { HelperSettingsContext } from "@/lib/helpers/types";
import { bindableAccounts, carrierEnabled, httpsEnabled, keyRows, recentRefusals, explainRefusal } from "../lib/admin";
import { ALLOWED_PORTS, getPort, isEnabled, isNetworkExposed, isShutdownAllowed } from "../lib/keys";
import { isListening } from "../lib/transport";
import PanelClient from "./panel-client";

/**
 * The settings page, on JonDash's own screen.
 *
 * **A server component that loads, wrapping a client component that renders** — core passes only
 * `ctx`, so a client component would have no route to this data at all. `host-services` shipped
 * that mistake and its page read "nothing approved yet" however many services were approved.
 *
 * Everything dangerous is here rather than in the module: minting a key, changing the binding,
 * switching the listener on. A module holding `mcp:read` sees status and nothing else.
 * REFS helpers/mcp/helper.ts
 */
export default async function McpSettings({ ctx }: { ctx: HelperSettingsContext }) {
  const [keys, accounts, refusals, enabled, exposed, port, carrier, https, shutdownAllowed] = await Promise.all([
    keyRows(),
    bindableAccounts(),
    recentRefusals(),
    isEnabled(),
    isNetworkExposed(),
    getPort(),
    carrierEnabled(),
    httpsEnabled(),
    isShutdownAllowed(),
  ]);

  return (
    <PanelClient
      helperId={ctx.helperId}
      enabled={enabled}
      // Enabled and LISTENING are different: enabled with no keys binds no port, a state a fresh
      // install is in. The page says which — not something an admin should have to infer.
      listening={isListening()}
      // Switched on with keys and STILL not listening is the one state an admin cannot work out
      // for themselves — the reason is on a different screen entirely.
      carrierEnabled={carrier}
      // So the page can ask before opening a clear-text port, rather than refusing after. The
      // server still refuses either way — this only decides whether the admin is asked first.
      httpsEnabled={https}
      shutdownAllowed={shutdownAllowed}
      exposed={exposed}
      port={port}
      ports={[...ALLOWED_PORTS]}
      keys={keys}
      accounts={accounts.map((a) => ({ id: a.id, name: a.displayName, role: a.role, status: a.status }))}
      refusals={refusals.map((r) => ({ ...r, explained: explainRefusal(r.reason) }))}
    />
  );
}
