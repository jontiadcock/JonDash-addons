import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalise, assertUsableAsDestination } from "../lib/paths";
import { probeLocation } from "../lib/probe";

const WIN = process.platform === "win32";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fs-helper-probe-"));
}

describe("validation never touches the network", () => {
  it("judges an unreachable UNC path instantly and identically every time", () => {
    // The bug: `realpath` on a UNC path makes Windows try to reach the server, so the
    // same call took 187ms or 5s depending on DNS caching — and changed its answer.
    // Validation must be textual. 20 iterations well inside one network timeout.
    if (!WIN) return;
    const p = String.raw`\\nas-that-does-not-exist-42\backups`;
    const started = Date.now();
    const verdicts = Array.from({ length: 20 }, () => canonicalise(p));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500);
    const first = JSON.stringify(verdicts[0]);
    for (const v of verdicts) expect(JSON.stringify(v)).toBe(first);
    expect(verdicts[0].ok).toBe(true); // shape is fine; whether it EXISTS is probe's job
  });

  it("still resolves local symlinks, which is what the write-side rule needs", () => {
    if (WIN) return; // symlink creation needs privilege on Windows
    const tmp = scratch();
    const link = path.join(tmp, "link-to-etc");
    try {
      fs.symlinkSync("/etc", link, "dir");
    } catch {
      return;
    }
    expect(assertUsableAsDestination(link, "/opt/jondash").ok).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("probeLocation — the explicit Test button", () => {
  it("confirms a real folder it can write to, and leaves nothing behind", async () => {
    const tmp = scratch();
    const before = fs.readdirSync(tmp);
    const r = await probeLocation(tmp);
    expect(r.ok).toBe(true);
    expect(r.exists).toBe(true);
    expect(r.writable).toBe(true);
    // The write test must not litter the destination.
    expect(fs.readdirSync(tmp)).toEqual(before);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("says a missing folder is missing, and how to fix it", async () => {
    const missing = path.join(scratch(), "not-created-yet");
    const r = await probeLocation(missing);
    expect(r.ok).toBe(false);
    expect(r.exists).toBe(false);
    expect(r.message).toMatch(/doesn't exist/i);
  });

  it("refuses a file where a folder was expected", async () => {
    const tmp = scratch();
    const f = path.join(tmp, "a-file.txt");
    fs.writeFileSync(f, "x");
    const r = await probeLocation(f);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/file, not a folder/i);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a malformed path without ever touching the disk", async () => {
    // Narrowed in 0.0.2. This used to assert that a SYSTEM directory was refused before
    // any I/O — but a source may now be anywhere, so probing `C:\Windows` and reporting
    // that it exists is the correct new answer. What must still short-circuit is a path
    // that isn't a path: there is nothing to reach out to on its behalf.
    for (const bad of ["not-absolute", "", "  "]) {
      const r = await probeLocation(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.exists, bad).toBe(false);
    }
  });

  it("now REPORTS on a system directory rather than refusing it", async () => {
    const r = await probeLocation(WIN ? "C:\\Windows" : "/etc", { wantWritable: false });
    expect(r.exists).toBe(true);
  });

  it("gives up on an unreachable share instead of hanging", async () => {
    if (!WIN) return;
    const r = await probeLocation(String.raw`\\nas-that-does-not-exist-42\backups`, {
      timeoutMs: 1500,
    });
    expect(r.ok).toBe(false);
    // Either the OS failed fast or our timeout fired; both are acceptable, hanging is not.
    expect(r.elapsedMs).toBeLessThan(8000);
    expect(r.message.length).toBeGreaterThan(0);
  }, 15000);
});
