import type { ModuleDefinition } from "@/lib/modules/types";
import McpWidget from "./ui/widget";
import McpPage from "./page";

/**
 * AI assistant access — the carrier for the `mcp` helper.
 *
 * **Thin on purpose.** A helper cannot be installed directly (the installer auto-installs them as
 * dependencies and offers no control to add one), so a module has to exist for the helper to arrive
 * at all. Everything that matters — the endpoint, the keys, the tools, the settings — belongs to the
 * helper, where no module can reach it.
 *
 * What this module earns its place with is visibility: a tile and a page answering "is an assistant
 * connected to my server, and what has it been doing", without being able to change any of it.
 */
const mcpServer: ModuleDefinition = {
  id: "mcp-server",
  name: "AI assistant access",
  description:
    "Lets an AI assistant read and manage this server using a key you create. Shows whether it is switched on and which keys exist; the keys themselves are managed under Admin → Permissions.",
  version: "0.0.1-beta.1",
  // Follows the helper's floor — a module that pulls a helper in must not install where that
  // helper cannot work. The helper needs service accounts (1.7.3-beta.1) and passes its id to
  // `resolveBindableAccount` (1.7.3-beta.2).
  minAppVersion: "1.7.3-beta.2",

  /**
   * **`mcp:read` only, and never `mcp:act`.**
   *
   * This module shows status. It cannot mint a key, change what an assistant may do, or switch the
   * endpoint on — those are administrator actions on JonDash's own screen. HELPERS-DESIGN rule 8:
   * the module-facing API carries read and request, never add, remove or approve.
   *
   * Declaring `mcp:act` would be the module claiming the power to let an assistant change things,
   * which is precisely the shape that had to be removed from `host-services` and `filesystem`.
   */
  permissions: ["mcp:read"],

  helpers: [{ id: "mcp", minVersion: "0.0.1-beta.1" }],

  /** Who can reach the machine, and what an assistant may do to it, is admin-level information. */
  adminOnly: true,

  DashboardWidget: McpWidget,
  Page: McpPage,
};

export default mcpServer;
