/**
 * Screenshot gate. Run before every push, beside `check-manifest.mjs`.
 *
 * **Why this exists as a hard failure.** Core parses screenshot entries with a `continue` — an entry
 * it dislikes is skipped in silence. The module still installs, the manifest still validates, and the
 * image simply never appears, with nothing said in any log or any UI. So every rule core applies has
 * to fail loudly *here*, because it will never fail anywhere else.
 *
 * Rules checked, against core 1.8.2 `lib/modules/sources.ts` and `app/api/modules/screenshot/route.ts`:
 *
 * | Rule | Where it comes from |
 * | ---- | ------------------- |
 * | at most 4 per module | `MAX_SCREENSHOTS` |
 * | `png` `jpg` `jpeg` `webp` | `SCREENSHOT_FILE_RE` |
 * | **flat filename, no directory** | see below |
 * | file present in the module folder | core resolves it against the pinned tag |
 * | at most 1 MB | `MAX_BYTES` in the serving route |
 * | caption at most 80 characters | core truncates silently past that |
 *
 * **The flat-filename rule is ours, and stricter than core's.** Core allows one subdirectory *from
 * 1.8.1*; 1.8.0 is filename-only. Every add-on here declares `minAppVersion` at or below 1.8.0, so a
 * `screenshots/` folder would show nothing at all on those installs. When the floors rise past 1.8.1,
 * relax `FLAT_ONLY` — not before.
 *
 * The width check is a warning rather than an error: core enforces nothing about resolution, but a
 * shot under 1280px renders soft in the browse gallery, which was true of the first set captured.
 */
import fs from "node:fs";
import path from "node:path";

const FLAT_ONLY = /^[a-z0-9][a-z0-9._-]{0,63}\.(png|jpg|jpeg|webp)$/i;
const MAX_SCREENSHOTS = 4;
const MAX_BYTES = 1024 * 1024;
const MIN_WIDTH = 1280;

const manifest = JSON.parse(fs.readFileSync("addons.json", "utf8"));
const errors = [];
const warnings = [];
let checked = 0;

/** PNG width lives at byte 16 of the IHDR chunk; other formats are not measured. */
function pngWidth(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return buf.readUInt32BE(16);
}

for (const entry of manifest.modules ?? []) {
  const shots = entry.screenshots;
  if (!Array.isArray(shots) || shots.length === 0) {
    warnings.push(`${entry.id}: no screenshots — nothing is shown in Browse before installing`);
    continue;
  }
  if (shots.length > MAX_SCREENSHOTS) {
    errors.push(`${entry.id}: ${shots.length} screenshots — core keeps only the first ${MAX_SCREENSHOTS}`);
  }

  for (const shot of shots) {
    checked++;
    const file = typeof shot?.file === "string" ? shot.file.trim() : "";

    if (!FLAT_ONLY.test(file)) {
      errors.push(
        `${entry.id}: "${file}" is not a flat filename — core 1.8.0 drops it in silence and the image never appears`,
      );
      continue;
    }

    const onDisk = path.join(entry.path ?? `addons/${entry.id}`, file);
    if (!fs.existsSync(onDisk)) {
      errors.push(`${entry.id}: "${file}" is declared but not in the module folder — a 404 for every user`);
      continue;
    }

    const buf = fs.readFileSync(onDisk);
    if (buf.length > MAX_BYTES) {
      errors.push(`${entry.id}: "${file}" is ${Math.round(buf.length / 1024)}KB — core refuses anything over 1MB`);
    }

    const width = pngWidth(buf);
    if (width !== null && width < MIN_WIDTH) {
      warnings.push(`${entry.id}: "${file}" is only ${width}px wide — renders soft in Browse; 1280+ is the agreed bar`);
    }

    const caption = typeof shot.caption === "string" ? shot.caption : "";
    if (caption.length > 80) {
      errors.push(`${entry.id}: caption on "${file}" is ${caption.length} chars — core truncates at 80`);
    }
  }
}

for (const w of warnings) console.log(`  warning — ${w}`);
for (const e of errors) console.log(`  ERROR — ${e}`);

console.log(
  `\n${checked} screenshot(s) checked across ${(manifest.modules ?? []).length} modules.` +
    (errors.length ? `\n${errors.length} error(s). Fix before publishing.` : "\nOK."),
);
process.exit(errors.length ? 1 : 0);
