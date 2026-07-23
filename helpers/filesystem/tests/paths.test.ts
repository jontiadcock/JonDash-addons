import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { canonicalise, contains, assertUsable, assertDistinct } from "../lib/paths";

/**
 * These tests are the reason the helper is allowed to delete anything.
 *
 * Every case here is a way someone loses data or escapes the deny-list, so they assert
 * REFUSAL as hard as they assert success — a permissive bug in this file is silent, and
 * only shows up as a missing folder.
 */

const WIN = process.platform === "win32";
const A = WIN ? "C:\\Data" : "/data";
const B = WIN ? "C:\\Backup" : "/backup";

describe("canonicalise", () => {
  it("refuses a relative path rather than resolving it against the cwd", () => {
    // path.resolve() would happily turn this into a real path somewhere unexpected.
    for (const p of ["docs", "./docs", "..\\docs", "docs/sub"]) {
      expect(canonicalise(p).ok, p).toBe(false);
    }
  });

  it("refuses empty and non-string input", () => {
    for (const p of ["", "   ", null as unknown as string, undefined as unknown as string]) {
      expect(canonicalise(p).ok).toBe(false);
    }
  });

  it("refuses a path that still escapes upward after normalising", () => {
    const p = WIN ? "C:\\Data\\..\\..\\Windows" : "/data/../../etc";
    const r = canonicalise(p);
    // Either normalising collapsed it (then assertUsable catches where it landed), or
    // a `..` survived and it is refused outright. Never silently accepted as-is.
    if (r.ok) expect(r.path).not.toContain("..");
  });

  it("strips a trailing separator but keeps a root intact", () => {
    const r = canonicalise(A + path.sep);
    expect(r.ok && r.path).toBe(A);
  });
});

describe("contains — segment-aware, not string-prefix", () => {
  it("does not treat a sibling with a shared prefix as contained", () => {
    // The bug this exists to prevent: "C:\Data".startsWith() logic says yes.
    expect(contains(A, A + "Old")).toBe(false);
    expect(contains(A, path.join(A + "Old", "file.txt"))).toBe(false);
  });

  it("recognises a real child, at any depth", () => {
    expect(contains(A, path.join(A, "x"))).toBe(true);
    expect(contains(A, path.join(A, "x", "y", "z.txt"))).toBe(true);
  });

  it("treats a path as containing itself", () => {
    expect(contains(A, A)).toBe(true);
  });

  it("is not fooled by case on platforms where paths are case-insensitive", () => {
    if (!WIN) return;
    expect(contains("C:\\Data", "c:\\data\\sub")).toBe(true);
  });
});

describe("assertUsable — the deny-list", () => {
  const install = WIN ? "C:\\Apps\\JonDash" : "/opt/jondash";

  it("refuses the JonDash install directory and everything under it", () => {
    for (const p of [install, path.join(install, ".data"), path.join(install, "prisma", "dev.db")]) {
      const r = assertUsable(p, install);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/JonDash|system/i);
    }
  });

  it("refuses a folder that CONTAINS the install directory", () => {
    // Backing up C:\Apps would sweep up JonDash — and its encryption key.
    const parent = path.dirname(install);
    const r = assertUsable(parent, install);
    expect(r.ok).toBe(false);
  });

  it("refuses a bare drive or filesystem root", () => {
    const r = assertUsable(WIN ? "C:\\" : "/", install);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/drive|folder/i);
  });

  it("refuses system directories", () => {
    const sys = WIN ? "C:\\Windows\\System32" : "/etc";
    expect(assertUsable(sys, install).ok).toBe(false);
  });

  it("accepts an ordinary folder", () => {
    const r = assertUsable(A, install);
    expect(r.ok).toBe(true);
  });

  it("accepts a UNC share but refuses a bare server name", () => {
    if (!WIN) return;
    expect(assertUsable("\\\\nas\\backups", install).ok).toBe(true);
    const bare = assertUsable("\\\\nas", install);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toMatch(/shared folder/i);
  });

  it("refuses a symlink that points into a forbidden location", () => {
    // The escape a textual deny-list misses entirely.
    if (WIN) return; // needs privilege on Windows; covered on POSIX CI
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-helper-"));
    const link = path.join(tmp, "innocent");
    try {
      fs.symlinkSync("/etc", link, "dir");
    } catch {
      return; // no permission to create symlinks here; skip rather than false-pass
    }
    const r = assertUsable(link, install);
    expect(r.ok).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("assertDistinct — overlap in either direction", () => {
  it("refuses a destination inside the source", () => {
    const r = assertDistinct(A, path.join(A, "backup"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/inside the source/i);
  });

  it("refuses a source inside the destination", () => {
    const r = assertDistinct(path.join(B, "live"), B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/inside the destination/i);
  });

  it("refuses source and destination being the same folder", () => {
    expect(assertDistinct(A, A).ok).toBe(false);
  });

  it("allows genuinely separate folders that share a prefix", () => {
    expect(assertDistinct(A, A + "Backup").ok).toBe(true);
  });
});
