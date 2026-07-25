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

describe("collect — gathering only what was asked for (0.0.2)", () => {
  it("omits a group that wasn't collected", async () => {
    const s = await snapshot({ collect: ["cpu", "memory"] });
    // The optional groups are absent entirely, not empty-but-present.
    expect(s.swap).toBeUndefined();
    expect(s.network).toBeUndefined();
    expect(s.networkIo).toBeUndefined();
    expect(s.diskIo).toBeUndefined();
    expect(s.fans).toBeUndefined();
    expect(s.battery).toBeUndefined();
    expect(s.cpu.perCore).toBeUndefined();
  });

  it("keeps the 0.0.1 fields present regardless, so an old consumer is unaffected", async () => {
    const s = await snapshot({ collect: [] });
    expect(s.host.hostname).toBeTruthy();
    expect(typeof s.cpu.usedPct).toBe("number");
    expect(s.memory.totalBytes).toBeGreaterThan(0);
    // Not collected → empty, which is a shape 0.0.1 could already return.
    expect(s.disks).toEqual([]);
    expect(s.temps).toEqual([]);
  });

  it("includes a group that WAS asked for", async () => {
    const s = await snapshot({ collect: ["network", "swap", "cpuCores"] });
    expect(Array.isArray(s.network)).toBe(true);
    expect(s.swap === null || typeof s.swap === "object").toBe(true);
    expect(Array.isArray(s.cpu.perCore)).toBe(true);
    expect(s.cpu.perCore!.length).toBe(s.cpu.cores);
    for (const p of s.cpu.perCore!) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  it("reports a CPU speed, or null where the platform doesn't say", async () => {
    const s = await snapshot({ collect: ["cpu"] });
    expect(s.cpu.speedMhz === null || s.cpu.speedMhz! > 0).toBe(true);
  });

  it("lists non-loopback interfaces with addresses", async () => {
    const s = await snapshot({ collect: ["network"] });
    for (const n of s.network!) {
      expect(n.name).toBeTruthy();
      expect(n.addresses.length).toBeGreaterThan(0);
      expect(n.name).not.toBe("lo");
    }
  });

  it("returns rate groups as arrays of non-negative rates", async () => {
    const s = await snapshot({ collect: ["diskIo", "networkIo"], sampleMs: 60 });
    expect(Array.isArray(s.diskIo)).toBe(true);
    expect(Array.isArray(s.networkIo)).toBe(true);
    for (const d of s.diskIo!) {
      expect(d.readBytesPerSec).toBeGreaterThanOrEqual(0);
      expect(d.writeBytesPerSec).toBeGreaterThanOrEqual(0);
    }
    for (const n of s.networkIo!) {
      expect(n.rxBytesPerSec).toBeGreaterThanOrEqual(0);
      expect(n.txBytesPerSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("skipping every rate group makes the call fast", async () => {
    // No sampling window means no 120ms wait. Generous bound so a slow disk can't flake it.
    const started = Date.now();
    await snapshot({ collect: ["memory", "network"] });
    expect(Date.now() - started).toBeLessThan(100);
  });
});
