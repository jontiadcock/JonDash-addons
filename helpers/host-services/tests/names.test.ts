import { describe, expect, it } from "vitest";
import { allocateBase, isSafeBase, MAX_BASE, sanitiseBase, taskNameFor } from "../lib/names";

describe("sanitiseBase", () => {
  it("keeps an ordinary service name readable", () => {
    // The whole point of not using opaque ids: an admin reading Task Scheduler should
    // recognise the service.
    expect(sanitiseBase("Plex")).toBe("Plex");
    expect(sanitiseBase("plexmediaserver.service")).toBe("plexmediaserver.service");
  });

  it("strips the Task Scheduler folder separator", () => {
    // This is the one that matters: `\` would plant a task outside the JonDash namespace.
    expect(sanitiseBase("..\\..\\Microsoft\\Windows\\Foo")).toBe("Microsoft-Windows-Foo");
    expect(sanitiseBase("evil\\task")).toBe("evil-task");
  });

  it("removes characters that could reach a shell or a path", () => {
    for (const bad of ['a&b', "a|b", "a;b", "a$b", 'a"b', "a'b", "a`b", "a/b", "a:b", "a*b", "a?b"]) {
      expect(sanitiseBase(bad)).toBe("a-b");
    }
  });

  it("collapses runs and trims separators rather than leaving them", () => {
    expect(sanitiseBase("  a   b  ")).toBe("a-b");
    expect(sanitiseBase("---a---")).toBe("a");
    expect(sanitiseBase("...a...")).toBe("a");
  });

  it("returns empty when nothing usable survives, rather than inventing a name", () => {
    // A generated fallback would be a task whose name has no relationship to the service —
    // the readability failure in a different costume.
    expect(sanitiseBase("\\\\\\")).toBe("");
    expect(sanitiseBase("   ")).toBe("");
    expect(sanitiseBase("")).toBe("");
  });

  it("caps length and never ends on a separator after truncation", () => {
    const long = sanitiseBase("A".repeat(200));
    expect(long.length).toBe(MAX_BASE);
    const awkward = sanitiseBase(`${"A".repeat(MAX_BASE - 1)}-tail`);
    expect(awkward.endsWith("-")).toBe(false);
  });
});

describe("allocateBase", () => {
  it("suffixes on collision instead of reusing a base", () => {
    // Reuse would point two allowlist entries at ONE task, so removing either would
    // silently revoke the other.
    expect(allocateBase("My Service", [])).toBe("My-Service");
    expect(allocateBase("My/Service", ["My-Service"])).toBe("My-Service-2");
    expect(allocateBase("My:Service", ["My-Service", "My-Service-2"])).toBe("My-Service-3");
  });

  it("does not manufacture a collision where none exists", () => {
    // `.` is legitimately allowed in a task name, so `My.Service` is its own base and must
    // NOT be suffixed just because `My-Service` exists — they are different services.
    expect(allocateBase("My.Service", ["My-Service"])).toBe("My.Service");
  });

  it("treats collisions case-insensitively, because Windows does", () => {
    expect(allocateBase("plex", ["Plex"])).toBe("plex-2");
  });

  it("keeps the suffixed name within the cap", () => {
    const taken = [sanitiseBase("B".repeat(200))];
    const next = allocateBase("B".repeat(200), taken);
    expect(next).not.toBeNull();
    expect(next!.length).toBeLessThanOrEqual(MAX_BASE);
    expect(next!.endsWith("-2")).toBe(true);
  });

  it("refuses rather than guessing when the name is unusable", () => {
    expect(allocateBase("\\\\", [])).toBeNull();
  });
});

describe("isSafeBase", () => {
  it("accepts what allocateBase produces and rejects what it removes", () => {
    expect(isSafeBase("Plex")).toBe(true);
    expect(isSafeBase("My-Service-2")).toBe(true);
    expect(isSafeBase("plexmediaserver.service")).toBe(true);

    expect(isSafeBase("")).toBe(false);
    expect(isSafeBase("a\\b")).toBe(false);
    expect(isSafeBase("a b")).toBe(false);
    expect(isSafeBase("-leading")).toBe(false);
    expect(isSafeBase("trailing-")).toBe(false);
    expect(isSafeBase("A".repeat(MAX_BASE + 1))).toBe(false);
  });

  it("gives the same answer every time it is asked", () => {
    // Regression: `isSafeBase` shared a `g`-flagged regex with `sanitiseBase`; `.test()` on a
    // global regex resumes from `lastIndex`, so repeated calls ALTERNATED true and false.
    for (let i = 0; i < 5; i++) {
      expect(isSafeBase("a b")).toBe(false);
      expect(isSafeBase("Plex")).toBe(true);
    }
  });

  it("agrees with sanitiseBase for arbitrary input", () => {
    // The property that matters: anything that survives sanitising is safe to hand to the
    // grant manager. A disagreement here is a hole.
    for (const s of ["Plex", "a&b", "..\\x", "  spaced  ", "dots...", "réseau", "日本語", "x".repeat(120)]) {
      const out = sanitiseBase(s);
      if (out) expect(isSafeBase(out)).toBe(true);
    }
  });
});

describe("taskNameFor", () => {
  it("namespaces every task under JonDash", () => {
    expect(taskNameFor("Plex", "restart")).toBe("JonDash\\Plex-restart");
    expect(taskNameFor("Plex", "start")).toBe("JonDash\\Plex-start");
  });
});
