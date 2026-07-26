import type { addEntry, removeEntry } from "./allowlist";

/**
 * Sentences for a refused add or remove.
 *
 * Lives here rather than in `helper.ts` so both the CORE-10 scopes and the settings panel use
 * the same words — two places explaining the same refusal differently is how an admin ends up
 * believing they are two different problems.
 *
 * Every branch names the thing to DO. "Invalid name" tells someone they are stuck; "that name
 * has no usable characters" tells them why and what to change.
 */

export function explainAdd(r: Exclude<Awaited<ReturnType<typeof addEntry>>, { ok: true }>): string {
  switch (r.reason) {
    case "duplicate":
      return "That service is already on the list.";
    case "unusable-name":
      return "That name has no characters that can be used.";
    case "name-clash":
      // Names the entry in the way, because "pick another name" is useless advice when the
      // service name is not yours to choose.
      return `Windows would give this the same permission name as "${r.detail}". Remove that entry first if this is the one you want.`;
    case "grant-refused": {
      const o = r.outcome;
      if (o.status === "cancelled-at-uac") return "You dismissed the Windows permission prompt.";
      if (o.status === "timed-out") return "The permission prompt was not answered in time.";
      if (o.status === "unavailable") return "This installation cannot grant that permission.";
      // Narrowed via the discriminant rather than reaching for `.detail` on the union — `ok`
      // has no such field, and TypeScript is right to say so.
      return o.status === "failed" ? o.detail : "The permission could not be granted.";
    }
  }
}

/** A remove fails only when the OS refuses to give the permission back. */
export function explainRemove(r: Awaited<ReturnType<typeof removeEntry>>): string {
  const o = r.outcome;
  if (!o) return "That service could not be removed.";
  if (o.status === "cancelled-at-uac") return "You dismissed the Windows permission prompt, so nothing changed.";
  if (o.status === "timed-out") return "The permission prompt was not answered in time, so nothing changed.";
  if (o.status === "failed") return o.detail;
  return "The Windows permission could not be revoked, so the service was left on the list.";
}
