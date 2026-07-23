import { assertUsable, type PathVerdict } from "./paths";

/**
 * Roots — the admin-approved locations this helper may touch.
 *
 * A root is stored on the HELPER, never on the consuming module, so a module cannot widen
 * its own reach: every operation names a root by id and the helper resolves it. That is
 * what lets the consent screen honestly say "the folders you allow".
 *
 * NOTE: only the read side is implemented. Registration is deliberately still to be
 * written — see HELPER.md. `describe()` runs at enable time with the helper's config, so
 * the read path has to exist before anything can be registered against it.
 */

export type Root = {
  id: string;
  /** Canonical absolute path, as validated by `assertUsable`. */
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
 */
export function validateRootPath(input: string): PathVerdict {
  return assertUsable(input);
}
