import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planPrune, runPrune } from "../lib/prune";
import { DEFAULT_GFS, type GfsPolicy } from "../lib/snapshots";

/**
 * The only code in this helper that destroys anything, so these tests are written to catch
 * over-deletion rather than under-deletion. Every case asserts what SURVIVED, because a
 * prune that removes too much leaves no evidence of what it took.
 */

const NONE: GfsPolicy = { keepDaily: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 0 };

let tmp: string;
let dest: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-prune-"));
  dest = path.join(tmp, "backups");
  await fsp.mkdir(dest, { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A snapshot folder with a file inside, so removal has to be recursive to work. */
const makeSnapshot = async (name: string) => {
  await fsp.mkdir(path.join(dest, name, "nested"), { recursive: true });
  await fsp.writeFile(path.join(dest, name, "nested", "file.txt"), name);
};

const present = () => fs.readdirSync(dest).sort();

describe("planPrune — what it will and will not consider", () => {
  it("never considers a folder that isn't exactly a snapshot name", async () => {
    // The case that matters: an admin points a snapshot job at a folder that already has
    // their own files in it.
    await makeSnapshot("2026-07-23-02-00-00");
    await makeSnapshot("2026-07-22-02-00-00");
    await fsp.mkdir(path.join(dest, "Holiday photos"), { recursive: true });
    await fsp.mkdir(path.join(dest, "2026-07-21"), { recursive: true }); // date-like, not ours
    await fsp.writeFile(path.join(dest, "notes.txt"), "mine");

    const r = await planPrune(dest, NONE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.plan.remove.map((s) => s.name)).toEqual(["2026-07-22-02-00-00"]);
    expect(r.plan.ignored.sort()).toEqual(["2026-07-21", "Holiday photos", "notes.txt"]);
  });

  it("refuses a destination the write rules reject", async () => {
    const r = await planPrune(process.cwd(), NONE); // the install directory
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/JonDash|system/i);
  });

  it("reports a folder it cannot read rather than assuming it is empty", async () => {
    const r = await planPrune(path.join(tmp, "does-not-exist"), NONE);
    expect(r.ok).toBe(false);
  });

  it("does not follow a symlink that is named like a snapshot", async () => {
    if (process.platform === "win32") return; // symlink creation needs privilege
    const victim = path.join(tmp, "someone-elses-data");
    await fsp.mkdir(victim, { recursive: true });
    await fsp.writeFile(path.join(victim, "important.txt"), "do not delete");
    await makeSnapshot("2026-07-23-02-00-00");
    try {
      fs.symlinkSync(victim, path.join(dest, "2026-07-22-02-00-00"), "dir");
    } catch {
      return;
    }

    const r = await planPrune(dest, NONE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.remove).toHaveLength(0);
    expect(r.plan.ignored).toContain("2026-07-22-02-00-00");
    expect(fs.existsSync(path.join(victim, "important.txt"))).toBe(true);
  });

  it("says nothing to do when the folder holds no snapshots at all", async () => {
    await fsp.mkdir(path.join(dest, "just my stuff"), { recursive: true });
    const r = await planPrune(dest, DEFAULT_GFS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.remove).toHaveLength(0);
  });
});

describe("runPrune — it removes, and only what it planned", () => {
  it("removes old snapshots recursively and keeps the newest", async () => {
    for (const n of ["2026-07-23-02-00-00", "2026-07-22-02-00-00", "2026-07-21-02-00-00"]) {
      await makeSnapshot(n);
    }
    const r = await runPrune(dest, NONE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.result.removed.sort()).toEqual(["2026-07-21-02-00-00", "2026-07-22-02-00-00"]);
    expect(r.result.errors).toHaveLength(0);
    expect(present()).toEqual(["2026-07-23-02-00-00"]);
    // Recursive: the nested file went with it.
    expect(fs.existsSync(path.join(dest, "2026-07-22-02-00-00"))).toBe(false);
  });

  it("NEVER removes the last remaining snapshot", async () => {
    await makeSnapshot("2026-07-23-02-00-00");
    const r = await runPrune(dest, NONE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.removed).toHaveLength(0);
    expect(present()).toEqual(["2026-07-23-02-00-00"]);
  });

  it("leaves the admin's own folders completely untouched", async () => {
    await makeSnapshot("2026-07-23-02-00-00");
    await makeSnapshot("2026-01-01-02-00-00");
    await fsp.mkdir(path.join(dest, "Tax 2025"), { recursive: true });
    await fsp.writeFile(path.join(dest, "Tax 2025", "return.pdf"), "important");
    await fsp.writeFile(path.join(dest, "readme.txt"), "mine");

    await runPrune(dest, NONE);

    expect(fs.existsSync(path.join(dest, "Tax 2025", "return.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "readme.txt"))).toBe(true);
  });

  it("applies GFS across a long history without emptying the destination", async () => {
    // Two years of dailies.
    const names: string[] = [];
    for (let i = 0; i < 400; i++) {
      const d = new Date(Date.UTC(2026, 6, 23) - i * 86_400_000);
      const p = (n: number) => String(n).padStart(2, "0");
      names.push(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-02-00-00`);
    }
    for (const n of names) await fsp.mkdir(path.join(dest, n), { recursive: true });

    const r = await runPrune(dest, DEFAULT_GFS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const left = present();
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(30);
    expect(left).toContain("2026-07-23-02-00-00"); // the newest survived
    expect(r.result.removed.length + left.length).toBe(400); // nothing lost or invented
  });

  it("refuses the whole operation rather than acting on a bad destination", async () => {
    const r = await runPrune(process.cwd(), NONE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/JonDash|system/i);
  });

  it("stops when cancelled, leaving the rest in place", async () => {
    for (const n of ["2026-07-23-02-00-00", "2026-07-22-02-00-00", "2026-07-21-02-00-00"]) {
      await makeSnapshot(n);
    }
    const r = await runPrune(dest, NONE, { signal: { aborted: true } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.removed).toHaveLength(0);
    expect(present()).toHaveLength(3);
  });

  it("takes a POLICY, and offers no way to name a path to delete", () => {
    // Not a runtime assertion so much as a design one: if anybody ever adds a parameter
    // that accepts paths, this comment and the signature below stop agreeing.
    expect(runPrune.length).toBeLessThanOrEqual(3); // (destination, policy, opts)
  });
});
