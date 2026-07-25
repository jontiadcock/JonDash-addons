/**
 * Task naming — the boundary between a service name and an OS object name.
 *
 * A grant is a Scheduled Task called `JonDash\<taskBase>-<verb>`. Two properties matter,
 * and they pull against each other:
 *
 *  1. It must be READABLE. The whole case for granting once rather than prompting every
 *     time is that an admin can open Task Scheduler and see exactly what JonDash may do
 *     unprompted. An opaque id would be safer against name-derived trickery and would
 *     forfeit the property that justifies the design.
 *  2. It must be INERT. `\` is the Task Scheduler folder separator, so an unsanitised name
 *     is a path-escape attempt — `..\..\Microsoft\Windows\Foo` would plant a task outside
 *     our namespace.
 *
 * So: keep the meaning, remove the power. Characters outside the safe set are REPLACED,
 * never escaped — escaping preserves the dangerous character somewhere in the pipeline and
 * relies on every later stage decoding it identically.
 *
 * Core refuses to touch anything outside `JonDash\` as a second layer. Both checks should
 * exist; neither should be removed because the other does.
 */

/**
 * The only characters that may reach a task name. Deliberately narrower than NTFS allows.
 *
 * TWO regexes on purpose, and they must stay separate. `.test()` on a `g`-flagged regex is
 * STATEFUL — it resumes from `lastIndex` and so alternates between true and false on
 * repeated calls with the same input. Sharing one pattern between `replace` and `test` made
 * `isSafeBase` return false negatives depending on call order, which is the worst kind of
 * failure in a check that exists as a backstop: it passes in testing and lapses in
 * production. Caught by its own test.
 */
const UNSAFE_RUN = /[^A-Za-z0-9._-]+/g; // for replacing
const UNSAFE_ANY = /[^A-Za-z0-9._-]/; // for testing — no `g`, no state

/** Windows caps task names well above this; 64 keeps the Task Scheduler list readable. */
export const MAX_BASE = 64;

export type Verb = "start" | "stop" | "restart";

export const VERBS: Verb[] = ["start", "stop", "restart"];

export function isVerb(v: string): v is Verb {
  return (VERBS as string[]).includes(v);
}

/**
 * Reduce a service name to something safe to appear in a task name.
 *
 * Returns an empty string when nothing usable survives — the caller decides what to do
 * about that, rather than this silently inventing a name. A generated fallback here would
 * mean a task whose name has no relationship to the service it controls, which is the
 * readability failure in a different costume.
 */
export function sanitiseBase(serviceName: string): string {
  return serviceName
    .replace(UNSAFE_RUN, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, MAX_BASE)
    .replace(/[-._]+$/g, "");
}

/**
 * Allocate a base that no existing entry is using.
 *
 * Collisions are real without being exotic: `My.Service` and `My Service` both reduce to
 * `My-Service`. Suffixing is the only safe resolution — reusing a base would point two
 * allowlist entries at ONE Scheduled Task, so removing either entry would silently revoke
 * the other, or worse, leave a live grant with no entry to audit it against.
 */
export function allocateBase(serviceName: string, taken: Iterable<string>): string | null {
  const base = sanitiseBase(serviceName);
  if (!base) return null;

  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(base.toLowerCase())) return base;

  for (let n = 2; n <= 99; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_BASE - suffix.length) + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}

/** The full task name a grant is created and run under. */
export function taskNameFor(taskBase: string, verb: Verb): string {
  return `JonDash\\${taskBase}-${verb}`;
}

/**
 * Is this string safe to hand to the grant manager as a task base?
 *
 * Belt and braces: everything reaching the OS goes through `allocateBase`, but this is
 * asserted again at the point of use. The cost is nothing and the failure it guards against
 * — a name reaching the OS by some path that skipped sanitising — is the expensive one.
 */
export function isSafeBase(s: string): boolean {
  return s.length > 0 && s.length <= MAX_BASE && !UNSAFE_ANY.test(s) && !/^[-._]|[-._]$/.test(s);
}
