#!/usr/bin/env node
/**
 * **Do the docs still describe what the code does?** Run before every push.
 *
 * Owner's rule, 2026-07-27: *"before each push, you should be ensuring documentation is up to
 * date."* This is that rule as a gate rather than a reminder, because the reminder version already
 * failed — `mcp 0.0.2` shipped to stable with six new tools and a whole new key level, while
 * `CONNECTING.md`, the guide written specifically so somebody could use it, still described the
 * eight tools of `0.0.1` on both channels.
 *
 * It also missed a doc that was *wrong* rather than merely incomplete: `query_audit_log` was
 * documented as needing `audit.read`, a permission core does not define. Anyone granting exactly
 * what the guide said would have found the tool never appeared.
 *
 * ## What it checks, and why only these
 *
 * Enumerable surfaces only — the ones where "the doc lists things, the code has things, compare the
 * sets" is decidable. Prose cannot be checked this way and is not attempted; that is the deep-clean
 * skill's job.
 *
 *  1. Every tool a helper registers is named in that helper's `HELPER.md`.
 *  2. ...and in the user-facing guide of any module that carries it, if one exists.
 *  3. Every capability the manifest says a helper `provides` is named in its `HELPER.md`.
 *  4. No doc names a tool that no longer exists — the stale-mention direction, which is worse,
 *     because a reader will try it.
 *
 * Exit 1 on any mismatch. **Never edit a doc to satisfy this without reading it** — the fix is
 * usually a paragraph, not a word.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

/** Tool names a helper registers, read from its `register({ name: "..." })` calls. */
function registeredTools(helperDir) {
  const libDir = path.join(helperDir, "lib");
  if (!fs.existsSync(libDir)) return [];
  const names = new Set();
  for (const f of fs.readdirSync(libDir)) {
    if (!/^tools.*\.ts$/.test(f)) continue;
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    for (const m of src.matchAll(/register\(\{\s*\n?\s*name:\s*"([a-z_]+)"/g)) names.add(m[1]);
  }
  return [...names];
}

/** Every doc that ships with a module, so a guide is found whatever it is called. */
function moduleDocs(moduleDir) {
  if (!fs.existsSync(moduleDir)) return [];
  return fs
    .readdirSync(moduleDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(moduleDir, f));
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "addons.json"), "utf8"));
console.log(`Docs check — ${path.basename(ROOT)} (${manifest.channel} channel)\n`);

for (const entry of manifest.helpers ?? []) {
  const helperDir = path.join(ROOT, "helpers", entry.id);
  const helperDoc = path.join(helperDir, "HELPER.md");
  const where = `helper ${entry.id}`;

  if (!fs.existsSync(helperDoc)) {
    fail(where, "no HELPER.md");
    continue;
  }
  const doc = fs.readFileSync(helperDoc, "utf8");

  // 3 — declared capabilities must be documented, or an admin approving one has nothing to read.
  for (const cap of entry.provides ?? []) {
    if (!doc.includes(cap.id)) fail(where, `HELPER.md never mentions the capability "${cap.id}"`);
  }

  const tools = registeredTools(helperDir);
  if (tools.length === 0) {
    console.log(`  ${entry.id.padEnd(16)} no tool registry — capability check only`);
    continue;
  }

  // 1 — every registered tool is described where the author looks.
  const missing = tools.filter((t) => !doc.includes(t));
  if (missing.length) fail(where, `HELPER.md does not mention ${missing.length} registered tool(s): ${missing.join(", ")}`);

  // 2 — and in the guide the USER reads, on every module that carries this helper.
  for (const mod of manifest.modules ?? []) {
    const carries = (mod.helpers ?? []).some((h) => (typeof h === "string" ? h : h.id) === entry.id);
    if (!carries) continue;
    for (const docPath of moduleDocs(path.join(ROOT, "addons", mod.id))) {
      const text = fs.readFileSync(docPath, "utf8");
      // Only guides that already enumerate tools are held to enumerating all of them. A MODULE.md
      // that never mentions a tool is describing something else, and forcing a list into it would
      // make it worse.
      const enumerates = tools.filter((t) => text.includes(t)).length;
      if (enumerates === 0) continue;
      const absent = tools.filter((t) => !text.includes(t));
      if (absent.length) {
        fail(
          `module ${mod.id}`,
          `${path.basename(docPath)} lists ${enumerates}/${tools.length} of ${entry.id}'s tools — missing: ${absent.join(", ")}`,
        );
      }
    }
  }

  // 4 — the stale direction: a doc naming a tool that no longer exists.
  const allDocs = [helperDoc, ...(manifest.modules ?? []).flatMap((mod) => moduleDocs(path.join(ROOT, "addons", mod.id)))];
  const known = new Set(tools);
  for (const docPath of allDocs) {
    const text = fs.readFileSync(docPath, "utf8");
    for (const m of text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
      const named = m[1];
      // Only judge names that look like this helper's tools — same prefix vocabulary — so a code
      // identifier in prose is not mistaken for a removed tool.
      if (!/^(get|list|query|set|revoke|apply|create|check|restart|shutdown)_/.test(named)) continue;
      if (!known.has(named)) {
        fail(`doc ${path.relative(ROOT, docPath)}`, `names "${named}", which no helper registers`);
      }
    }
  }

  console.log(`  ${entry.id.padEnd(16)} ${tools.length} tools, ${(entry.provides ?? []).length} capabilities`);
}

console.log();
if (errors.length) {
  for (const e of errors) console.error(`  ERROR — ${e}`);
  console.error(`\n${errors.length} problem(s). The docs do not match the code — fix before pushing.`);
  process.exit(1);
}
console.log("OK — every registered tool and capability is documented.");
