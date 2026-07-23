#!/usr/bin/env node
/**
 * Pre-flight for the installer's verifier.
 *
 * Written after `backup-manager@0.1.1-beta.1` shipped **uninstallable**: a test file inside
 * the module imported `@/lib/db`, `@/lib/modules/migrate`, `node:fs` and `process.env`, and
 * a module's whole folder ships — **the verifier scans every file in it, tests included**.
 * Everything typechecked, linted and built; the module simply refused to install.
 *
 * This is a PRE-FILTER, not a replacement. The authority is core's `verifyModuleFiles`, and
 * the only way to be sure is to run it in a testbed:
 *
 *     cp scripts/_verify.mts <jondash>/ && cd <jondash>
 *     npx tsx _verify.mts <moduleId> "perm1,perm2"
 *
 * This script exists so the common mistakes are caught in one second, without a testbed.
 * It deliberately errs toward reporting: a false alarm costs a look, a miss costs a release.
 *
 *     node scripts/check-module-files.mjs             # every module in addons/
 *     node scripts/check-module-files.mjs backup-manager
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDONS = path.join(ROOT, "addons");

/** Mirrors lib/modules/verify.ts. If core changes its rules, this needs the same change. */
const ALLOWED_CORE_IMPORTS = ["@/lib/modules/types", "@/lib/modules/api"];

const RULES = [
  { re: /\bfrom\s+["']node:fs["']|\brequire\(\s*["']node:fs["']|\bfrom\s+["']fs["']/, msg: "direct filesystem access — a module's data belongs in ctx.db / ctx.store" },
  { re: /\bprocess\.env\b/, msg: "reads process environment — configuration belongs in the module's settings" },
  { re: /\bchild_process\b/, msg: "child_process is banned" },
  { re: /\beval\s*\(/, msg: "eval( is banned" },
  { re: /\bnew\s+Function\s*\(/, msg: "new Function( is banned" },
  { re: /@prisma\/client/, msg: "imports @prisma/client — use ctx.db" },
  { re: /\.\.\/\.\.\/lib\//, msg: "reaches into core with a relative path" },
];

const ALLOWED_FILE_TYPES = new Set([
  ".ts", ".tsx", ".sql", ".md", ".json", ".css", ".txt", ".svg",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
]);

/**
 * Strip comments before matching.
 *
 * Core's verifier does not flag a banned construct that only appears in a comment — checked
 * against the real `verifyModuleFiles`. Without this, documenting a rule trips the rule: the
 * warning added to the template's example test, which merely NAMES `process.env`, was reported
 * as reading it. A gate that fires on its own documentation teaches people to ignore the gate.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // Line comments, but not the `//` in a URL like https://example.com.
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir, prefix = "", out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rel, out);
    else out.push({ rel, full });
  }
  return out;
}

/** Every `@/...` import in the file, so a disallowed core import is named exactly. */
function coreImports(text) {
  const found = new Set();
  for (const m of text.matchAll(/from\s+["'](@\/[^"']+)["']/g)) found.add(m[1]);
  for (const m of text.matchAll(/import\s*\(\s*["'](@\/[^"']+)["']\s*\)/g)) found.add(m[1]);
  return [...found];
}

const only = process.argv[2];
const ids = fs
  .readdirSync(ADDONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((id) => !only || id === only);

let problems = 0;

for (const id of ids) {
  const dir = path.join(ADDONS, id);
  if (!fs.existsSync(path.join(dir, "module.ts"))) continue;

  // Which helpers this module declares — those unlock `@/helpers/<id>/api`.
  const moduleSrc = fs.readFileSync(path.join(dir, "module.ts"), "utf8");
  const declaredHelpers = new Set(
    [...moduleSrc.matchAll(/id:\s*["']([a-z0-9-]+)["']|["']([a-z0-9-]+)["']/g)]
      .flatMap((m) => [m[1], m[2]])
      .filter(Boolean),
  );

  const files = walk(dir);
  const issues = [];

  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase();
    if (!ALLOWED_FILE_TYPES.has(ext)) {
      issues.push(`${f.rel}: file type ${ext || "(none)"} is not allowed in a module`);
      continue;
    }
    if (![".ts", ".tsx"].includes(ext)) continue;

    const text = stripComments(fs.readFileSync(f.full, "utf8"));
    for (const r of RULES) if (r.re.test(text)) issues.push(`${f.rel}: ${r.msg}`);

    for (const imp of coreImports(text)) {
      if (ALLOWED_CORE_IMPORTS.includes(imp)) continue;
      const helper = imp.match(/^@\/helpers\/([a-z0-9-]+)\/api$/);
      if (helper && declaredHelpers.has(helper[1])) continue;
      issues.push(
        `${f.rel}: imports "${imp}" — a module may only import ${ALLOWED_CORE_IMPORTS.join(" or ")}`,
      );
    }
  }

  const label = issues.length ? "FAIL" : "ok  ";
  console.log(`${label}  ${id.padEnd(16)} ${files.length} files`);
  for (const i of issues) console.log(`        ${i}`);
  problems += issues.length;
}

if (problems > 0) {
  console.error(
    `\n${problems} problem(s). This module would be REFUSED at install.\n` +
      `Remember: tests inside a module SHIP and are scanned. A test that needs core internals\n` +
      `belongs in the repo-level tests/ folder, not in addons/<id>/tests/.`,
  );
  process.exit(1);
}
console.log("\nOK — nothing here would be refused at install (confirm with the real verifier).");
