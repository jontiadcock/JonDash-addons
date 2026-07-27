import type { KeyMode } from "./keys";

/**
 * The authorization decision, in one place.
 *
 * **Extracted so the test exercises the real thing.** The first version of the escalation test
 * carried its own copy of this table, which meant it proved the table was correct while proving
 * nothing about the code that runs — precisely the failure that shipped an empty settings panel
 * earlier in this project. `authorize()` calls this; the test calls this; there is one table.
 *
 * It takes plain data rather than a database row on purpose: no I/O, no context, so it is trivially
 * testable and cannot be made to pass by mocking.
 *
 * > **The mode NARROWS. It never widens.** With `accountHasPermission: false` and a permission
 * > required, every combination of mode and tool kind must refuse.
 */
export type Decision = "allow" | "refuse";

export type DecisionInput = {
  /** The presented key's mode. */
  mode: KeyMode;
  /** Whether the tool being called reads or acts. */
  toolKind: "read" | "act";
  /** Whether the BOUND ACCOUNT holds the permission the tool requires. */
  accountHasPermission: boolean;
  /** False for tools available to any valid key, e.g. `get_server_status`. */
  permissionRequired: boolean;
};

export function decide(input: DecisionInput): Decision {
  // Gate 1 — the key's own mode. A read key can never reach an acting tool, however privileged
  // the account behind it is.
  if (input.toolKind === "act" && input.mode !== "act") return "refuse";

  // Gate 2 — the account's real permissions. This is the one that cannot be bypassed by
  // choosing a different mode, which is what makes promotion to `act` safe.
  if (input.permissionRequired && !input.accountHasPermission) return "refuse";

  return "allow";
}
