import { describe, expect, it } from "vitest";
import { normaliseItemText, pluralise, MAX_ITEM_LENGTH } from "../lib/text";

/**
 * Tests ship with the module, and the installer's verifier scans them like any other file.
 *
 * So a test may NOT import `prisma`, `@/lib/db`, `@/lib/crypto` or the framework's
 * internals, may not touch `node:fs`, and may not read `process.env` — even though a test
 * feels like a safe place for all of them.
 *
 * **The consequence is the whole module, not the test.** One offending line and the module
 * fails verification and cannot be installed at all — while still typechecking, linting,
 * building and passing under Vitest. Nothing you normally run models the verifier. This has
 * already cost one published release (`backup-manager@0.1.1-beta.1`), so it is worth taking
 * literally.
 *
 * Test your own pure logic here. Anything needing a real database or the app's internals is
 * a maintainer's test of JonDash, not part of your module, and belongs outside the module
 * folder entirely.
 */

describe("normaliseItemText", () => {
  it("keeps ordinary text unchanged", () => {
    expect(normaliseItemText("Buy milk")).toBe("Buy milk");
  });

  it("collapses whitespace and trims", () => {
    expect(normaliseItemText("  too    much   space  ")).toBe("too much space");
  });

  it("strips control characters, so nothing can forge extra lines", () => {
    const sneaky = ["real", "injected"].join(String.fromCharCode(13, 10));
    expect(normaliseItemText(sneaky)).toBe("real injected");
  });

  it("caps very long input", () => {
    const long = "x".repeat(MAX_ITEM_LENGTH + 500);
    expect(normaliseItemText(long)!.length).toBeLessThanOrEqual(MAX_ITEM_LENGTH + 1);
  });

  it("rejects empty, whitespace-only and non-string input", () => {
    expect(normaliseItemText("")).toBeNull();
    expect(normaliseItemText("   ")).toBeNull();
    expect(normaliseItemText(null)).toBeNull();
    expect(normaliseItemText(42)).toBeNull();
  });
});

describe("pluralise", () => {
  it("uses the singular for exactly one", () => {
    expect(pluralise(1, "item")).toBe("1 item");
  });

  it("uses the plural for everything else", () => {
    expect(pluralise(0, "item")).toBe("0 items");
    expect(pluralise(7, "item")).toBe("7 items");
  });

  it("accepts an irregular plural", () => {
    expect(pluralise(2, "entry", "entries")).toBe("2 entries");
  });
});
