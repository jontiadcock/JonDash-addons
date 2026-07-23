#!/usr/bin/env node
/**
 * Publish gate: did this helper keep the promise its version number makes?
 *
 * Core made breakage *declarable* (`breakingFrom` in the manifest) and *detectable* (it can
 * name the modules an update will stop working). Nothing verifies the declaration is true.
 * A helper can quietly drop an export from `api.ts`, publish as a patch, and every consuming
 * module breaks at build time on somebody else's machine — the manifest cheerfully saying
 * nothing broke. This closes that.
 *
 * Run before tagging:
 *
 *   node scripts/check-helper-surface.mjs filesystem
 *
 * It compares the exported surface of `helpers/<id>/api.ts` at HEAD against the same file at
 * the last published tag, and fails if something a consumer could be using has gone without
 * `breakingFrom` being set to the version now being published.
 *
 * ## On the parser, honestly
 *
 * This repo has no package.json and no dependencies — it is content, not a project — so the
 * TypeScript compiler API is not available and this reads the file textually. That is a real
 * limitation, so the rule here is **conservative**: anything it cannot parse confidently is
 * reported as a problem rather than passed over. A gate that fails loudly on odd syntax is
 * useful; one that silently sees no exports and reports success is worse than none at all.
 *
 * What it deliberately does NOT check: type compatibility. A parameter changing from `string`
 * to `number` keeps the same name and slips through. Catching that needs real type checking —
 * which the core repo can do, since it typechecks helpers in place.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const helperId = process.argv[2];
if (!helperId) {
  console.error("usage: node scripts/check-helper-surface.mjs <helperId>");
  process.exit(2);
}

const REPO = path.resolve(import.meta.dirname, "..");
const API_PATH = `helpers/${helperId}/api.ts`;

/** Replace comments and string bodies with spaces so brace counting can't be fooled. */
function neutralise(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += quote; i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The body between the brace at `open` and its match. Null when unbalanced. */
function braceBody(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Member names declared directly inside a type body — nested shapes are not members. */
function topLevelMembers(body) {
  const names = new Set();
  let depth = 0;
  let atStart = true;
  let token = "";

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[" || c === "<") { depth++; continue; }
    if (c === "}" || c === ")" || c === "]" || c === ">") { depth = Math.max(0, depth - 1); continue; }

    if (depth === 0) {
      if (c === ";" || c === "," || c === "\n") { atStart = true; token = ""; continue; }
      if (atStart) {
        if (/\s/.test(c)) continue;
        // A member name runs up to `?`, `:` or `(`.
        if (/[A-Za-z_$]/.test(c) || (token && /[\w$]/.test(c))) { token += c; continue; }
        if ((c === ":" || c === "?" || c === "(") && token) { names.add(token); atStart = false; token = ""; continue; }
        atStart = false;
        token = "";
      }
    }
  }
  return names;
}

/** The exported surface of one `api.ts`: top-level export names, plus each exported type's members. */
function surfaceOf(rawSrc, label) {
  const src = neutralise(rawSrc);
  const names = new Set();
  const types = new Map();

  for (const m of src.matchAll(/^\s*export\s+(?:declare\s+)?(type|interface|const|function|async function|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[2]);
  }
  if (/^\s*export\s+default\b/m.test(src)) names.add("default");

  for (const m of src.matchAll(/^\s*export\s+(type|interface)\s+([A-Za-z_$][\w$]*)[^={;]*(=\s*)?\{/gm)) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    const body = braceBody(src, open);
    if (body === null) {
      console.error(`  ! could not parse the body of '${m[2]}' in ${label} — treating as a failure rather than guessing`);
      process.exitCode = 1;
      continue;
    }
    types.set(m[2], topLevelMembers(body));
  }

  if (names.size === 0) {
    console.error(`  ! found no exports at all in ${label}. Refusing to call that "no breakage".`);
    process.exitCode = 1;
  }
  return { names, types };
}

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

/** The newest existing tag for this helper, by version order. */
function lastPublishedTag() {
  let tags;
  try {
    tags = git("tag", "--list", `${helperId}/v*`).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  if (!tags.length) return null;
  return tags.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
}

// ---------------------------------------------------------------------------

const current = fs.readFileSync(path.join(REPO, API_PATH), "utf8");
const tag = lastPublishedTag();

console.log(`Helper surface check — ${helperId}`);
if (!tag) {
  console.log("  no previous tag; nothing to compare against. First publish is never a break.");
  process.exit(process.exitCode ?? 0);
}
console.log(`  comparing HEAD against ${tag}`);

let previousSrc;
try {
  previousSrc = git("show", `${tag}:${API_PATH}`);
} catch {
  console.log(`  ${tag} has no ${API_PATH} — the API is new since then, which cannot remove anything.`);
  process.exit(process.exitCode ?? 0);
}

const before = surfaceOf(previousSrc, tag);
const after = surfaceOf(current, "HEAD");

const removedNames = [...before.names].filter((n) => !after.names.has(n));
const addedNames = [...after.names].filter((n) => !before.names.has(n));

const removedMembers = [];
for (const [typeName, members] of before.types) {
  const now = after.types.get(typeName);
  if (!now) continue; // the type itself went — already caught as a removed name
  for (const m of members) if (!now.has(m)) removedMembers.push(`${typeName}.${m}`);
}

for (const n of addedNames) console.log(`  + ${n}`);
for (const n of removedNames) console.log(`  - ${n}   (REMOVED)`);
for (const m of removedMembers) console.log(`  - ${m}   (REMOVED)`);

const breaking = removedNames.length + removedMembers.length;
if (breaking === 0) {
  console.log("  nothing removed — this release is backwards compatible.");
  process.exit(process.exitCode ?? 0);
}

// Something a consumer could be using has gone. The manifest must say so.
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "addons.json"), "utf8"));
const entry = (manifest.helpers ?? []).find((h) => h.id === helperId);
if (!entry) {
  console.error(`\n  ${breaking} removal(s), and '${helperId}' isn't in addons.json at all.`);
  process.exit(1);
}
if (entry.breakingFrom !== entry.version) {
  console.error(
    `\n  ${breaking} removal(s) from the API, but addons.json declares breakingFrom=${
      entry.breakingFrom ?? "(unset)"
    } for version ${entry.version}.`,
  );
  console.error(`  Set "breakingFrom": "${entry.version}" on the ${helperId} entry, or put the removed exports back.`);
  process.exit(1);
}

console.log(`\n  ${breaking} removal(s), correctly declared as breakingFrom=${entry.breakingFrom}.`);
process.exit(process.exitCode ?? 0);
