import { assertUsableAsSource, type PathVerdict } from "./paths";

/**
 * Roots — the admin-approved locations this helper may touch.
 *
 * A root is stored on the HELPER, never on the consuming module, so a module cannot widen
 * its own reach: every operation names a root by id and the helper resolves it. That is
 * what lets the consent screen honestly say "the folders you allow".
 *
 * NOTE: this file is the CONFIG-shaped read side, used only by `describe()` for the
 * consent sentence. The live roots — the ones operations actually resolve against — are
 * rows in `hlp_filesystem_roots`, owned by `api.ts`.
 */

export type Root = {
  id: string;
  /** Canonical absolute path, as validated by `assertUsableAsSource`. */
  path: string;
  /** What the admin called it, e.g. "NAS backups". */
  label: string;
};

/** Roots as stored in the helper's configuration. Unknown shapes yield nothing. */
export function listRoots(config: Record<string, unknown>): Root[] {
  const raw = config?.roots;
  if (!Array.isArray(raw)) return [];
  const out: Root[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const p = typeof o.path === "string" ? o.path : "";
    if (!id || !p) continue;
    out.push({ id, path: p, label: typeof o.label === "string" && o.label ? o.label : p });
  }
  return out;
}

/** Just the paths, for the consent sentence. */
export function listRootPaths(config: Record<string, unknown>): string[] {
  return listRoots(config).map((r) => r.path);
}

/**
 * Validate a path an admin has offered as a new root. Returns the canonical form, or a
 * refusal carrying a reason they can act on. Never narrows a bad path to a working one.
 *
 * Source rules: since 0.0.2 a root may be as broad as a whole drive. Breadth is warned
 * about (`risk.ts`) and the secrets inside are excluded by identity (`secrets.ts`), rather
 * than the folder being refused.
 */
export function validateRootPath(input: string): PathVerdict {
  return assertUsableAsSource(input);
}
