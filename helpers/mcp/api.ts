import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import type { HelperApiFor } from "@/lib/helpers/types";
import { getPort, isEnabled, isNetworkExposed, listKeys } from "./lib/keys";
import { isListening } from "./lib/transport";
import { allTools } from "./lib/tools";

/**
 * The ENTIRE surface a module may reach — status, and nothing else. No mutator here, ever.
 *
 * ⚠ HELPERS-DESIGN rule 8 — `host-services` and `filesystem` both once let a bounded module edit
 * its own confinement. Minting a key is worse: it hands out a credential.
 *
 * Absent, and must stay absent:
 *  - Minting, revoking or re-moding a key — that is Admin → Addons → Shared capabilities.
 *  - The key itself or its hash — `keyCount` is a number; even the display hint stays out.
 *  - Switching the endpoint on, or changing where it listens.
 *  - Anything an assistant read — tool output goes to the agent that asked, never a module.
 */

export type McpStatus = {
  /** An administrator has switched it on. Not the same as listening. */
  enabled: boolean;
  /** A port is actually bound right now. False when enabled with no keys. */
  listening: boolean;
  /** True when reachable beyond this machine — worth surfacing prominently. */
  exposed: boolean;
  port: number;
  keyCount: number;
  /** When any key was last used, so a tile can say "active 4 minutes ago". */
  lastUsedAt: string | null;
  /** How many tools an assistant could call. Shape of the surface, not its contents. */
  toolCount: number;
};

export type McpApi = {
  /** Whether assistant access is on, and how it is reachable. Needs `mcp:read`. */
  status(): Promise<McpStatus>;
};

/**
 * `ctx.can()` is advisory rather than forge-proof — a module can spread its context and hand back a
 * doctored one. Checked anyway at the top of the call: it is the difference between a module
 * accidentally exceeding what it declared and one deliberately doing so, and only the latter
 * survives this. Since nothing here is a mutator, the blast radius of a forged context is a status
 * object.
 */
function granted(ctx: ModuleContext, permission: DeclaredPermission): boolean {
  if (typeof ctx.can !== "function") return true;
  return ctx.can(permission);
}

const OFF: McpStatus = {
  enabled: false,
  listening: false,
  exposed: false,
  port: 0,
  keyCount: 0,
  lastUsedAt: null,
  toolCount: 0,
};

const api: HelperApiFor<McpApi> = (ctx: ModuleContext) => ({
  async status() {
    // Refused reads as "off" rather than throwing: a widget that cannot see the status should
    // render the safe answer, not an error card on somebody's dashboard.
    if (!granted(ctx, "mcp:read")) return OFF;

    const [enabled, exposed, port, keys] = await Promise.all([
      isEnabled(),
      isNetworkExposed(),
      getPort(),
      listKeys(),
    ]);

    const lastUsed = keys
      .map((k) => k.lastUsedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop();

    return {
      enabled,
      listening: isListening(),
      exposed,
      port,
      keyCount: keys.length,
      lastUsedAt: lastUsed ?? null,
      toolCount: allTools().length,
    };
  },
});

/** REFS addons/mcp-server/page.tsx · addons/mcp-server/ui/widget.tsx */
export default api;
