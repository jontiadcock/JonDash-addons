import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planCopy, runCopy, resolveDestination } from "../lib/copy";

/**
 * Real files on disk, in a scratch directory, deleted afterwards. Nothing here goes
 * anywhere near real data — which is the whole reason these run on throwaway folders.
 */

let tmp: string;
let src: string;
let dst: string;

const write = (root: string, rel: string, body: string) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-helper-copy-"));
  src = path.join(tmp, "source");
  dst = path.join(tmp, "dest");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("sync — copies what's new or changed, never deletes", () => {
  it("copies a nested tree", async () => {
    write(src, "a.txt", "one");
    write(src, path.join("sub", "b.txt"), "two");
    write(src, path.join("sub", "deep", "c.txt"), "three");

    const r = await runCopy(src, dst, { mode: "sync" });
    expect(r.state).toBe("done");
    expect(r.filesCopied).toBe(3);
    expect(read(dst, "a.txt")).toBe("one");
    expect(read(dst, path.join("sub", "deep", "c.txt"))).toBe("three");
  });

  it("skips files that are already identical on a second run", async () => {
    write(src, "a.txt", "one");
    await runCopy(src, dst, { mode: "sync" });
    const second = await runCopy(src, dst, { mode: "sync" });
    // If this copies again, every nightly run rewrites the whole backup.
    expect(second.filesCopied).toBe(0);
  });

  it("re-copies a file whose contents changed", async () => {
    write(src, "a.txt", "one");
    await runCopy(src, dst, { mode: "sync" });
    write(src, "a.txt", "one but longer");
    const r = await runCopy(src, dst, { mode: "sync" });
    expect(r.filesCopied).toBe(1);
    expect(read(dst, "a.txt")).toBe("one but longer");
  });

  it("NEVER removes something the source no longer has", async () => {
    write(src, "keep.txt", "k");
    write(src, "gone.txt", "g");
    await runCopy(src, dst, { mode: "sync" });
    fs.rmSync(path.join(src, "gone.txt"));

    await runCopy(src, dst, { mode: "sync" });
    // sync is the safe mode; deletion is mirror's job and mirror isn't built.
    expect(exists(dst, "gone.txt")).toBe(true);
  });

  it("honours exclusions", async () => {
    write(src, "a.txt", "a");
    write(src, path.join("node_modules", "junk.txt"), "junk");
    const r = await runCopy(src, dst, { mode: "sync", exclude: ["node_modules"] });
    expect(r.filesCopied).toBe(1);
    expect(exists(dst, path.join("node_modules", "junk.txt"))).toBe(false);
  });

  it("does not follow a symlink out of the source", async () => {
    write(src, "a.txt", "a");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "should not be copied");
    try {
      fs.symlinkSync(outside, path.join(src, "link"), "dir");
    } catch {
      return; // no symlink privilege here
    }
    const r = await runCopy(src, dst, { mode: "sync" });
    expect(r.filesCopied).toBe(1);
    expect(exists(dst, path.join("link", "secret.txt"))).toBe(false);
  });
});

describe("snapshot — a dated copy, previous ones untouched", () => {
  it("writes into its own dated folder", async () => {
    write(src, "a.txt", "one");
    const r = await runCopy(src, dst, { mode: "snapshot" });
    expect(r.state).toBe("done");
    expect(r.destination).not.toBe(dst);
    expect(fs.existsSync(path.join(r.destination, "a.txt"))).toBe(true);
  });

  it("leaves an earlier snapshot alone", async () => {
    write(src, "a.txt", "one");
    const first = resolveDestination(dst, "snapshot", new Date("2026-01-01T03:00:00Z"));
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, "old.txt"), "old");

    await runCopy(src, dst, { mode: "snapshot" });
    expect(fs.readFileSync(path.join(first, "old.txt"), "utf8")).toBe("old");
  });
});

describe("planCopy — says what would happen, and does none of it", () => {
  it("reports creates, updates and unchanged without touching the destination", async () => {
    write(src, "new.txt", "n");
    write(src, "same.txt", "s");
    await runCopy(src, dst, { mode: "sync" }); // seed both
    write(src, "changed.txt", "c");

    const before = fs.readdirSync(dst).sort();
    const plan = await planCopy(src, dst, { mode: "sync" });

    expect(plan.toCreate).toContain("changed.txt");
    expect(plan.unchanged).toBeGreaterThan(0);
    expect(fs.readdirSync(dst).sort()).toEqual(before); // a dry run wrote nothing
  });
});

describe("refusals and cancellation", () => {
  it("refuses a destination inside the source", async () => {
    write(src, "a.txt", "a");
    const inside = path.join(src, "backup");
    const r = await runCopy(src, inside, { mode: "sync" });
    expect(r.state).toBe("failed");
    expect(r.errors[0].reason).toMatch(/inside the source/i);
  });

  it("stops when cancelled and reports it honestly", async () => {
    for (let i = 0; i < 25; i++) write(src, `f${i}.txt`, String(i));
    const signal = { aborted: false };
    let seen = 0;
    const r = await runCopy(src, dst, {
      mode: "sync",
      signal,
      onProgress: () => {
        seen += 1;
        if (seen === 3) signal.aborted = true;
      },
    });
    expect(r.state).toBe("cancelled");
    expect(r.filesCopied).toBeLessThan(25);
  });

  it("one unreadable file does not abandon the rest of the backup", async () => {
    write(src, "good1.txt", "1");
    write(src, "good2.txt", "2");
    const r = await runCopy(src, dst, { mode: "sync" });
    expect(r.filesCopied).toBe(2);
    expect(r.state).toBe("done");
  });
});
