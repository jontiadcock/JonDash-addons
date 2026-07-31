import type { KeyMode } from "./keys";

/**
 * The authorization decision, in one place — `authorize()` and the escalation test both call
 * this, so the test proves the real code rather than a copy of the table.
 *
 * Plain data in, no I/O or context, so it is trivially testable and cannot be made to pass by
 * mocking.
 *
 * ⚠ The mode NARROWS, never widens: with `accountHasPermission: false` and a permission
 * required, every mode/tool-kind combination must refuse.
 */
export type Decision = "allow" | "refuse";

/**
 * What a tool does, in increasing order of what it can cost you.
 *
 * - `read` — returns information, changes nothing.
 * - `act` — changes state inside JonDash: a session, a module, a tile. Undoable from the UI.
 * - `admin` — acts on the SERVER ITSELF: restart, shut down, apply an update, switch channel,
 *   write a backup. The distinction is not "more dangerous", it is **who has to be present to
 *   undo it**. Every `act` tool can be reversed by someone at the dashboard; an `admin` tool can
 *   take the dashboard away.
 * REFS helpers/mcp/lib/authorize.ts · helpers/mcp/lib/tools.ts ·
 *      helpers/mcp/tests/escalation.test.ts
 */
export type ToolKind = "read" | "act" | "admin";

/** The ladder. A key may reach its own rung and everything below it, never above. */
const RANK: Record<KeyMode, number> = { read: 0, act: 1, admin: 2 };
const NEEDS: Record<ToolKind, number> = { read: 0, act: 1, admin: 2 };

export type DecisionInput = {
  /** The presented key's mode. */
  mode: KeyMode;
  /** Whether the tool being called reads, acts, or acts on the server. */
  toolKind: ToolKind;
  /** Whether the BOUND ACCOUNT holds the permission the tool requires. */
  accountHasPermission: boolean;
  /** False for tools available to any valid key, e.g. `get_server_status`. */
  permissionRequired: boolean;
};

/**
 * Does this mode reach this rung? Exported so callers can tell WHY a refusal happened without
 * repeating the ladder — the refusal log distinguishes "wrong mode" from "missing permission", and
 * that distinction is worth keeping accurate for the admin reading the tripwire.
 * REFS helpers/mcp/lib/authorize.ts
 */
export const modeAllows = (mode: KeyMode, kind: ToolKind): boolean => NEEDS[kind] <= RANK[mode];

/**
 * REFS helpers/mcp/lib/authorize.ts · helpers/mcp/lib/tools.ts ·
 *      helpers/mcp/tests/escalation.test.ts
 */
export function decide(input: DecisionInput): Decision {
  // Gate 1 — the mode, as a ladder rather than a pair of ifs: a new tool kind must be given a
  // rank, so an unranked one refuses rather than falls through.
  if (NEEDS[input.toolKind] > RANK[input.mode]) return "refuse";

  // Gate 2 — the account's real permissions, which mode cannot bypass: `admin` mode on an account
  // without `settings.manage` still cannot restart anything.
  if (input.permissionRequired && !input.accountHasPermission) return "refuse";

  return "allow";
}
