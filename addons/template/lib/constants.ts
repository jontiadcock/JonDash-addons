/**
 * Values shared across the module. No imports, no `server-only` — safe everywhere.
 *
 * Keeping the id in one constant means renaming the module touches this file rather
 * than a dozen string literals. It still has to match the folder name and the `id` in
 * `module.ts` exactly; see the rename checklist in MODULE.md.
 */

export const MODULE_ID = "template";

/** Where this module's own pages live. */
export const MODULE_PATH = `/m/${MODULE_ID}`;
