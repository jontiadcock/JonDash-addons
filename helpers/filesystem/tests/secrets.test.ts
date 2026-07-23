import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRegistry, identityOf, contentReason, identityReason } from "../lib/secrets";
import { runCopy } from "../lib/copy";

/**
 * The heart of the 0.0.2 redesign, and the tests that justify it.
 *
 * The helper no longer refuses to look at JonDash's folder — it copies around the secrets
 * inside it. That trade is only defensible if the exclusion genuinely holds, so these tests
 * assert the OUTCOME (the secret is not at the destination) rather than the predicate.
 * A test that only checked `identityReason()` would still pass if the copy engine forgot
 * to call it.
 *
 * The case that matters most is the one a path-based rule gets wrong: a secret that has
 * been MOVED. If that test ever goes green for the wrong reason, the redesign has bought
 * nothing.
 */

const KEY = "a".repeat(64);

let tmp: string;
let app: string;
let data: string;
let dest: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-secrets-"));
  app = path.join(tmp, "app");
  data = path.join(app, ".data");
  dest = path.join(tmp, "dest");
  await fsp.mkdir(data, { recursive: true });
  await fsp.mkdir(dest, { recursive: true });

  // An ordinary file that must survive, so a test passing because NOTHING copied is caught.
  await fsp.writeFile(path.join(app, "readme.txt"), "just a readme");
  await fsp.writeFile(path.join(data, "secrets.json"), JSON.stringify({ encryptionKey: KEY }));

  saved.JONDASH_DATA_DIR = process.env.JONDASH_DATA_DIR;
  saved.DATABASE_URL = process.env.DATABASE_URL;
  saved.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  process.env.JONDASH_DATA_DIR = data;
  delete process.env.DATABASE_URL;
  delete process.env.ENCRYPTION_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const copied = (rel: string) => fs.existsSync(path.join(dest, rel));

describe("the registry finds what is actually secret, not what is conventionally named", () => {
  it("recognises the data folder and the key file inside it", async () => {
    const reg = await loadRegistry(app);
    const dataStat = await fsp.stat(data);
    const keyStat = await fsp.stat(path.join(data, "secrets.json"));

    expect(identityReason(reg, dataStat)).toBeTruthy();
    expect(identityReason(reg, keyStat)).toBeTruthy();
    expect(reg.keyUnresolved).toBe(false);
  });

  it("does not recognise an ordinary file", async () => {
    const reg = await loadRegistry(app);
    const ordinary = await fsp.stat(path.join(app, "readme.txt"));
    expect(identityReason(reg, ordinary)).toBeNull();
  });

  it("resolves the database from DATABASE_URL, wherever that points", async () => {
    const db = path.join(tmp, "moved-database.db");
    await fsp.writeFile(db, "sqlite bytes");
    process.env.DATABASE_URL = `file:${db}`;

    const reg = await loadRegistry(app);
    expect(identityReason(reg, await fsp.stat(db))).toMatch(/database/i);
  });
});

describe("a copy never carries JonDash's secrets off the machine", () => {
  it("skips the whole data folder while copying everything else", async () => {
    const reg = await loadRegistry(app);
    const res = await runCopy(app, dest, { mode: "sync", registry: reg });

    expect(copied("readme.txt")).toBe(true);
    expect(copied(path.join(".data", "secrets.json"))).toBe(false);
    expect(fs.existsSync(path.join(dest, ".data"))).toBe(false);
    expect(res.skippedCount).toBeGreaterThan(0);
    expect(res.skipped.some((s) => /encryption key|data folder/i.test(s.reason))).toBe(true);
  });

  it("STILL excludes the key after it has been moved somewhere unexpected", async () => {
    // The case a path-based deny-list gets wrong. The admin relocated the data directory;
    // JonDash knows where it went, so the exclusion must follow it — with no code here
    // naming the new location.
    const relocated = path.join(app, "some", "unexpected", "place");
    await fsp.mkdir(relocated, { recursive: true });
    await fsp.rename(path.join(data, "secrets.json"), path.join(relocated, "secrets.json"));
    await fsp.rm(data, { recursive: true, force: true });
    process.env.JONDASH_DATA_DIR = relocated;

    const reg = await loadRegistry(app);
    await runCopy(app, dest, { mode: "sync", registry: reg });

    expect(copied("readme.txt")).toBe(true);
    expect(copied(path.join("some", "unexpected", "place", "secrets.json"))).toBe(false);
  });

  it("excludes a verbatim COPY of the key, which has a different file identity", async () => {
    // Tier 1 cannot see this one: copying a file gives it a new identity. Tier 2 catches
    // it by content, which is the whole reason tier 2 exists.
    const backup = path.join(app, "secrets.json.bak");
    await fsp.copyFile(path.join(data, "secrets.json"), backup);

    const reg = await loadRegistry(app);
    const original = await fsp.stat(path.join(data, "secrets.json"));
    const duplicate = await fsp.stat(backup);
    expect(identityOf(original)).not.toBe(identityOf(duplicate)); // proves tier 1 is blind here

    await runCopy(app, dest, { mode: "sync", registry: reg });
    expect(copied("secrets.json.bak")).toBe(false);
  });

  it("excludes any file that merely CONTAINS the key's value", async () => {
    // How a key most often escapes: not a copied file, a pasted value.
    await fsp.writeFile(path.join(app, "notes.txt"), `reminder — the key is ${KEY}, don't lose it`);

    const reg = await loadRegistry(app);
    const res = await runCopy(app, dest, { mode: "sync", registry: reg });

    expect(copied("notes.txt")).toBe(false);
    expect(res.skipped.some((s) => /master encryption key/i.test(s.reason))).toBe(true);
  });

  it("finds the key when it comes from the environment rather than a file", async () => {
    await fsp.rm(path.join(data, "secrets.json"), { force: true });
    process.env.ENCRYPTION_KEY = KEY.toUpperCase();
    await fsp.writeFile(path.join(app, "leak.txt"), `key=${KEY}`);

    const reg = await loadRegistry(app);
    expect(reg.keyUnresolved).toBe(false);
    await runCopy(app, dest, { mode: "sync", registry: reg });
    expect(copied("leak.txt")).toBe(false);
  });

  it("reports honestly when the key cannot be resolved at all", async () => {
    // The caller surfaces this in the log header. Silently protecting less than the admin
    // expects is the failure mode worth shouting about.
    await fsp.rm(path.join(data, "secrets.json"), { force: true });
    const reg = await loadRegistry(app);
    expect(reg.keyUnresolved).toBe(true);
  });

  it("leaves ordinary content completely alone", async () => {
    const reg = await loadRegistry(app);
    expect(contentReason(reg, Buffer.from("an ordinary document about backups"))).toBeNull();
  });
});

describe("without a registry the engine copies everything — so callers must pass one", () => {
  it("copies the key when no registry is supplied", async () => {
    // Not a recommendation: a guard rail. If this ever starts passing a secret through in
    // the API path, the difference is that `api.ts` forgot to load a registry.
    await runCopy(app, dest, { mode: "sync" });
    expect(copied(path.join(".data", "secrets.json"))).toBe(true);
  });
});
