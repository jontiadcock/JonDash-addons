import type { HelperSettingsContext } from "@/lib/helpers/types";
import { bindableAccounts, keyRows, recentRefusals, explainRefusal } from "../lib/admin";
import { ALLOWED_PORTS, getPort, isEnabled, isNetworkExposed } from "../lib/keys";
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
 */
export default async function McpSettings({ ctx }: { ctx: HelperSettingsContext }) {
  const [keys, accounts, refusals, enabled, exposed, port] = await Promise.all([
    keyRows(),
    bindableAccounts(),
    recentRefusals(),
    isEnabled(),
    isNetworkExposed(),
    getPort(),
  ]);

  return (
    <PanelClient
      helperId={ctx.helperId}
      enabled={enabled}
      // Enabled and LISTENING are different: enabled with no keys binds no port, which is the
      // state a fresh install is in. The page says which, because "on" that isn't listening is
      // exactly the sort of thing an admin should not have to infer.
      listening={isListening()}
      exposed={exposed}
      port={port}
      ports={[...ALLOWED_PORTS]}
      keys={keys}
      accounts={accounts.map((a) => ({ id: a.id, name: a.displayName, role: a.role, status: a.status }))}
      refusals={refusals.map((r) => ({ ...r, explained: explainRefusal(r.reason) }))}
    />
  );
}
