/**
 * Run the REAL installer verifier over a module folder, exactly as the installer does.
 * This is the check that would have caught 0.1.1-beta.1 shipping an uninstallable module.
 */
import fs from "node:fs";
import path from "node:path";
import { verifyModuleFiles, formatIssues } from "./lib/modules/verify";

const id = process.argv[2];
const perms = (process.argv[3] ?? "").split(",").filter(Boolean);
const dir = path.resolve("modules", id);

const files: { path: string; text?: string; bytes: number }[] = [];
(function walk(d: string, prefix = "") {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, rel);
    else {
      const b = fs.readFileSync(full);
      files.push({ path: rel, text: b.toString("utf8"), bytes: b.length });
    }
  }
})(dir);

const r = verifyModuleFiles(id, files as never, perms as never);
console.log(`files scanned: ${files.length}`);
console.log("ok=" + r.ok);
console.log(r.issues.length ? formatIssues(r.issues) : "no issues");
process.exit(r.ok ? 0 : 1);
