import { describe, it, expect } from "vitest";
import os from "node:os";
import { snapshot } from "../lib/collect";

/**
 * Runs against the REAL host — no mocks. It asserts the *shape and invariants* of a reading,
 * not specific numbers (those differ per machine), so it is a genuine live exercise of the
 * collection code wherever it runs. Uses only node built-ins, so it needs no database.
 */

describe("snapshot", () => {
  it("returns a well-formed reading of this host", async () => {
    const s = await snapshot();

    expect(s.host.hostname).toBeTruthy();
    expect(s.host.platform).toBe(os.platform());
    expect(s.host.uptimeSec).toBeGreaterThan(0);
    expect(typeof s.takenAt).toBe("string");
  });

  it("reports CPU load as a percentage in range, with real core data", async () => {
    const s = await snapshot();
    expect(s.cpu.cores).toBeGreaterThan(0);
    expect(s.cpu.model).toBeTruthy();
    expect(s.cpu.usedPct).toBeGreaterThanOrEqual(0);
    expect(s.cpu.usedPct).toBeLessThanOrEqual(100);
  });

  it("nulls load average on Windows and keeps it a number elsewhere", async () => {
    const s = await snapshot();
    if (os.platform() === "win32") {
      expect(s.cpu.load1).toBeNull();
    } else {
      expect(typeof s.cpu.load1).toBe("number");
    }
  });

  it("reports memory that adds up and a sane percentage", async () => {
    const s = await snapshot();
    expect(s.memory.totalBytes).toBeGreaterThan(0);
    expect(s.memory.usedBytes + s.memory.freeBytes).toBe(s.memory.totalBytes);
    expect(s.memory.usedPct).toBeGreaterThanOrEqual(0);
    expect(s.memory.usedPct).toBeLessThanOrEqual(100);
  });

  it("lists at least one real disk, each with a valid usage percentage", async () => {
    const s = await snapshot();
    expect(s.disks.length).toBeGreaterThan(0);
    for (const d of s.disks) {
      expect(d.mount).toBeTruthy();
      expect(d.totalBytes).toBeGreaterThan(0);
      expect(d.usedPct).toBeGreaterThanOrEqual(0);
      expect(d.usedPct).toBeLessThanOrEqual(100);
    }
  });

  it("returns temps as an array (possibly empty — no sensors is not an error)", async () => {
    const s = await snapshot();
    expect(Array.isArray(s.temps)).toBe(true);
    for (const t of s.temps) {
      expect(t.label).toBeTruthy();
      expect(typeof t.celsius).toBe("number");
    }
  });
});
