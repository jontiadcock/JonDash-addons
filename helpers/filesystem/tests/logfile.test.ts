import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunLog, listLogs, readLog, pruneLogs, logsFootprint, logDir } from "../lib/logfile";

/**
 * Logs exist because the helper now SKIPS things rather than refusing the job. A skip
 * nobody can enumerate is indistinguishable from a bug, and a backup missing files you
 * were never told about is discovered at restore time — far too late.
 *
 * `logDir()` is derived from `process.cwd()`, so these tests move the process into a
 * scratch directory rather than mocking the module.
 */

let tmp: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-logs-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const header = (runId: string) => ({
  runId,
  moduleId: "backup-manager",
  mode: "sync",
  source: "D:\\Data",
  destination: "\\\\nas\\backups",
});

describe("RunLog", () => {
  it("records what was copied, skipped and failed", async () => {
    const log = await RunLog.open(header("run-one"));
    expect(log).not.toBeNull();
    log!.copied("invoice.txt", 120);
    log!.skipped(".data", "JonDash's master encryption key");
    log!.failed("locked.dat", "EBUSY");
    await log!.close({ state: "done", filesCopied: 1, bytesCopied: 120, skipped: 1, errors: 1 });

    const text = (await readLog("run-one"))!;
    expect(text).toContain("invoice.txt");
    expect(text).toContain("SKIPPED  .data — JonDash's master encryption key");
    expect(text).toContain("ERROR    locked.dat");
    expect(text).toContain("backup-manager");
    expect(text).toContain("Result        done");
  });

  it("puts the warnings the admin accepted in the header", async () => {
    const log = await RunLog.open({ ...header("run-warn"), warnings: ["high: this is an entire drive"] });
    await log!.close({ state: "done", filesCopied: 0, bytesCopied: 0, skipped: 0, errors: 0 });
    expect(await readLog("run-warn")).toContain("entire drive");
  });

  it("says so when the key could not be resolved, rather than implying full protection", async () => {
    const log = await RunLog.open({ ...header("run-nokey"), keyUnresolved: true });
    await log!.close({ state: "done", filesCopied: 0, bytesCopied: 0, skipped: 0, errors: 0 });
    expect(await readLog("run-nokey")).toMatch(/could not be read/i);
  });

  it("refuses a run id that would escape the log directory", async () => {
    // `readLog` is reachable from a page URL, so the id is untrusted. A viewer that would
    // read ../../.data/secrets.json hands back the very thing this helper protects.
    for (const bad of ["../../secrets", "..\\..\\secrets", "a/b", "", "with space"]) {
      expect(await RunLog.open(header(bad))).toBeNull();
      expect(await readLog(bad)).toBeNull();
    }
  });
});

describe("retention", () => {
  const write = async (runId: string, ageDays: number) => {
    const log = await RunLog.open(header(runId));
    await log!.close({ state: "done", filesCopied: 0, bytesCopied: 0, skipped: 0, errors: 0 });
    const file = path.join(logDir(), `${runId}.log`);
    const when = new Date(Date.now() - ageDays * 86_400_000);
    await fsp.utimes(file, when, when);
  };

  it("removes logs older than keepDays", async () => {
    await write("fresh", 1);
    await write("stale", 40);
    const { removed } = await pruneLogs({ keepDays: 30, keepRuns: 0 });
    expect(removed).toBe(1);
    expect((await listLogs()).map((l) => l.runId)).toEqual(["fresh"]);
  });

  it("keeps only the most recent keepRuns", async () => {
    await write("oldest", 3);
    await write("middle", 2);
    await write("newest", 1);
    await pruneLogs({ keepDays: 0, keepRuns: 2 });
    const ids = (await listLogs()).map((l) => l.runId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("newest");
    expect(ids).not.toContain("oldest");
  });

  it("applies both rules together", async () => {
    await write("a", 1);
    await write("b", 2);
    await write("c", 99);
    await pruneLogs({ keepDays: 30, keepRuns: 1 });
    expect((await listLogs()).map((l) => l.runId)).toEqual(["a"]);
  });

  it("keeps everything when both rules are disabled", async () => {
    await write("x", 500);
    await write("y", 900);
    const { removed } = await pruneLogs({ keepDays: 0, keepRuns: 0 });
    expect(removed).toBe(0);
    expect(await listLogs()).toHaveLength(2);
  });

  it("survives a missing log directory", async () => {
    expect(await listLogs()).toEqual([]);
    expect(await pruneLogs({ keepDays: 30, keepRuns: 5 })).toEqual({ removed: 0 });
    expect(await logsFootprint()).toEqual({ count: 0, bytes: 0 });
  });

  it("reports what the logs cost on disk", async () => {
    await write("sized", 0);
    const { count, bytes } = await logsFootprint();
    expect(count).toBe(1);
    expect(bytes).toBeGreaterThan(0);
  });
});

/**
 * A browser caught this, not a unit test: a fresh install reported "keeping unlimited days"
 * when the defaults are 30/50. `Number(null)` is 0 — and 0 is itself a legitimate stored
 * value meaning "keep forever" — so coercing before testing for absence silently turned
 * "never configured" into "no retention at all". The parse is duplicated in `api.ts` and
 * `helper.ts`, so the rule is pinned here rather than in either of them.
 */
describe("reading a stored retention value", () => {
  const parse = (v: string | null | undefined, dflt: number) => {
    if (v === undefined || v === null || String(v).trim() === "") return dflt;
    const parsed = Number(v);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : dflt;
  };

  it("falls back to the default when nothing has been stored", () => {
    expect(parse(null, 30)).toBe(30);
    expect(parse(undefined, 30)).toBe(30);
    expect(parse("", 30)).toBe(30);
    expect(parse("   ", 30)).toBe(30);
  });

  it("honours a stored 0 as 'keep forever' rather than treating it as unset", () => {
    expect(parse("0", 30)).toBe(0);
  });

  it("keeps a real stored value", () => {
    expect(parse("7", 30)).toBe(7);
  });

  it("falls back on nonsense rather than storing NaN", () => {
    expect(parse("abc", 30)).toBe(30);
    expect(parse("-5", 30)).toBe(30);
  });
});
