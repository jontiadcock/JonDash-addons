import { describe, expect, it } from "vitest";
import { normaliseItemText, pluralise, MAX_ITEM_LENGTH } from "../lib/text";

/**
 * Tests ship with the module, and the installer's verifier scans them like any other
 * file — so a test may NOT import `prisma`, `@/lib/db`, `@/lib/crypto` or the
 * framework's internals, even though a test seems like a safe place for it. Test your
 * own pure logic here; anything that needs a real database belongs in a scratch project
 * outside the module.
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
