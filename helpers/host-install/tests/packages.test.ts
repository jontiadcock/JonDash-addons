import { describe, expect, it } from "vitest";
import { validatePackageId, KNOWN } from "../lib/packages";

describe("validatePackageId", () => {
  it("accepts real winget ids", () => {
    for (const id of ["Docker.DockerDesktop", "Microsoft.PowerShell", "7zip.7zip", "Mozilla.Firefox.ESR", "a+b"]) {
      expect(validatePackageId(id)).toEqual({ ok: true, id });
    }
  });

  it("REFUSES a leading dash — winget would read it as a flag", () => {
    // The subtle one. `--override` looks like a package name to careless code and is a
    // pass-through wearing a disguise.
    for (const bad of ["--override", "-e", "--custom", "--manifest"]) {
      const v = validatePackageId(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/dash/i);
    }
  });

  it("refuses anything that could break out of a single argument", () => {
    for (const bad of ["a b", "a&b", "a|b", "a;b", "a>b", 'a"b', "a'b", "a`b", "a\\b", "a/b", "a$b", "a\nb"]) {
      expect(validatePackageId(bad).ok).toBe(false);
    }
  });

  it("refuses empty and over-long names", () => {
    expect(validatePackageId("").ok).toBe(false);
    expect(validatePackageId("   ").ok).toBe(false);
    expect(validatePackageId("A".repeat(129)).ok).toBe(false);
    expect(validatePackageId("A".repeat(128)).ok).toBe(true);
  });

  it("trims surrounding whitespace rather than refusing it", () => {
    expect(validatePackageId("  Docker.DockerDesktop  ")).toEqual({ ok: true, id: "Docker.DockerDesktop" });
  });

  it("gives a reason a person can act on, never a regex", () => {
    const v = validatePackageId("bad name");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).not.toMatch(/\[|\]|\^|\\/);
  });
});

describe("KNOWN shortcuts", () => {
  it("only lists ids that pass validation", () => {
    for (const k of KNOWN) expect(validatePackageId(k.id).ok).toBe(true);
  });

  it("says what installing it actually entails", () => {
    for (const k of KNOWN) expect(k.note.length).toBeGreaterThan(10);
  });
});
