/**
 * Plain helpers with no imports and no side effects.
 *
 * Worth having a file like this in your own module: logic that doesn't touch the
 * database or the network is the easiest thing to test, and this one is covered by
 * `tests/text.test.ts`. Note there is no `server-only` here, so a client component
 * could import it safely too.
 */

/** The longest an item's text may be once stored. */
export const MAX_ITEM_LENGTH = 200;

/**
 * Clean up text that came from a form before it goes anywhere near the database.
 *
 * Anything a user (or a remote service) hands you is untrusted: collapse the
 * whitespace, strip control characters, and cap the length. Returns null when there is
 * nothing left worth storing, so the caller can reject it.
 */
export function normaliseItemText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const stripped = Array.from(input)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : ch;
    })
    .join("");
  const flat = stripped.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_ITEM_LENGTH ? `${flat.slice(0, MAX_ITEM_LENGTH)}…` : flat;
}

/** "1 item" / "3 items" — the sort of thing a widget needs constantly. */
export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
