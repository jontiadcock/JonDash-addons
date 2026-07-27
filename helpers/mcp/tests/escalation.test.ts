import { describe, it, expect } from "vitest";
import type { KeyMode } from "../lib/keys";
import { decide } from "../lib/decide";

/**
 * **The gate on whether this helper ships.**
 *
 * The security property is one sentence: *the key's mode can only ever NARROW what its bound
 * account can do — it can never widen it.* If promoting a key to `act` grants anything the account
 * lacks, the helper is a privilege-escalation path and must not be published.
 *
 * These tests exercise the decision table directly rather than through HTTP, so they can run
 * before the listener exists and cannot be accidentally satisfied by a transport-layer check that
 * a later refactor removes.
 *
 * The real end-to-end assertion — the same table driven over MCP JSON-RPC against a live
 * install — is in the live-test plan in HELPER.md and is not replaced by this file.
 */

/**
 * `decide` is imported from `../lib/decide`, **not redefined here.**
 *
 * The first draft of this file carried its own copy of the table. It passed, and proved nothing
 * about the code that actually runs — the same shape as the settings panel that typechecked while
 * rendering empty. `authorize()` calls this exact function, so these assertions bind the real
 * decision path.
 *
 * What `authorize()` adds around it — verifying the key, and re-resolving the bound account —
 * can only ever turn an allow into a refusal, never the reverse.
 */

describe("the mode narrows, it never widens", () => {
  it("REFUSES an act-key whose account lacks the permission", () => {
    // The one that matters. If this ever returns "allow", the helper is an escalation path.
    expect(
      decide({ mode: "act", toolKind: "act", accountHasPermission: false, permissionRequired: true }),
    ).toBe("refuse");
  });

  it("refuses a read-key an acting tool, even when the account could do it", () => {
    expect(
      decide({ mode: "read", toolKind: "act", accountHasPermission: true, permissionRequired: true }),
    ).toBe("refuse");
  });

  it("allows an act-key whose account genuinely holds the permission", () => {
    expect(
      decide({ mode: "act", toolKind: "act", accountHasPermission: true, permissionRequired: true }),
    ).toBe("allow");
  });

  it("refuses a read-key a read tool its account cannot do", () => {
    expect(
      decide({ mode: "read", toolKind: "read", accountHasPermission: false, permissionRequired: true }),
    ).toBe("refuse");
  });

  it("allows a read-key a read tool its account can do", () => {
    expect(
      decide({ mode: "read", toolKind: "read", accountHasPermission: true, permissionRequired: true }),
    ).toBe("allow");
  });

  it("allows an unpermissioned tool to any valid key", () => {
    expect(
      decide({ mode: "read", toolKind: "read", accountHasPermission: false, permissionRequired: false }),
    ).toBe("allow");
  });
});

describe("no combination of mode and tool kind grants a missing permission", () => {
  it("holds across the whole table", () => {
    const modes: KeyMode[] = ["read", "act"];
    const kinds: ("read" | "act")[] = ["read", "act"];

    for (const mode of modes) {
      for (const toolKind of kinds) {
        const outcome = decide({
          mode,
          toolKind,
          accountHasPermission: false,
          permissionRequired: true,
        });
        // Exhaustive rather than illustrative: with the permission absent, EVERY cell must
        // refuse. A single "allow" here is the bug this file exists to catch.
        expect(outcome, `mode=${mode} toolKind=${toolKind}`).toBe("refuse");
      }
    }
  });
});
