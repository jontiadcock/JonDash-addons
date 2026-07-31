/**
 * Package ids — the only variable that reaches an elevated process.
 *
 * Core validates these too, and refuses anything malformed. This is deliberately a second
 * copy: it turns "winget rejected your input" after a UAC prompt into a clear refusal
 * *before* one appears, and it is the check that keeps our own request queue clean. Two
 * checks that agree cost nothing; the one that matters is core's, because it is the one
 * standing between the string and the administrator's credentials.
 */

/** Matches core's grammar. Kept identical on purpose — a looser rule here would queue
 *  requests that can only ever fail at the prompt. */
const ID = /^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,127}$/;

export type IdVerdict = { ok: true; id: string } | { ok: false; reason: string };

/**
 * **A leading `-` is the interesting one.** `winget install --some-flag` reads an argument
 * starting with a dash as a FLAG, not a package name, so an id like `--override` is how a
 * pass-through gets smuggled in wearing a package name. The first character is therefore
 * restricted separately from the rest, which is why the pattern above has two classes rather
 * than one with a length bound.
 * REFS helpers/host-install/api.ts · helpers/host-install/tests/packages.test.ts
 */
export function validatePackageId(raw: string): IdVerdict {
  const id = raw.trim();
  if (!id) return { ok: false, reason: "No package was named." };
  if (id.length > 128) return { ok: false, reason: "That package name is too long." };
  if (id.startsWith("-")) {
    return { ok: false, reason: "A package name cannot start with a dash — that would be read as an option." };
  }
  if (!ID.test(id)) {
    return {
      ok: false,
      reason: "A package name may only contain letters, numbers, dots, underscores, plus and dashes.",
    };
  }
  return { ok: true, id };
}

/**
 * Well-known ids, so the UI can offer the common thing without the admin typing an id they
 * cannot verify. Not an allowlist — anything valid may be requested — just the shortcuts.
 *
 * Deliberately short. A long curated list ages badly and starts to look like an endorsement
 * of software we have not checked.
 * REFS helpers/host-install/api.ts · helpers/host-install/tests/packages.test.ts
 */
export const KNOWN: { id: string; label: string; note: string }[] = [
  {
    id: "Docker.DockerDesktop",
    label: "Docker Desktop",
    note: "Needs WSL2 and a restart. Installs the engine the Docker module talks to.",
  },
];
