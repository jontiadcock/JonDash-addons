import {
  createGrant,
  grantSupport,
  listGrants,
  previewGrantName,
  removeAllGrants,
  removeGrant,
  runGrant as coreRunGrant,
  type GrantFailure,
} from "@/lib/elevation";
import type { Verb } from "./names";

/**
 * The bridge to core's grant manager.
 *
 * ⚠ Everything privileged goes through `@/lib/elevation`, never the binary directly —
 * HELPERS-DESIGN rule 7. Core logs every call, including declined and failed ones; a helper
 * that spawns `jondash-grant.exe` itself works perfectly and appears nowhere in the log.
 *
 * A grant is a Scheduled Task under `\JonDash\` running one fixed command with highest
 * privileges — one elevation prompt, then it persists across restarts. ⚠ Per ../ELEVATION.md
 * it must be entirely self-contained: the task stores a fixed service and verb, and
 * `schtasks /run` cannot pass arguments, so what can run unprompted is enforced by Windows.
 */

/** Why elevation is impossible here. Named separately so callers can switch on it. */
export type ElevationReason = "no-interactive-session" | "grant-manager-missing" | "unsupported-platform";

/**
 * A prompt nobody answered. Distinct from `cancelled-at-uac` because they mean opposite
 * things: declining is a decision, timing out is an absence of one. Retrying after a
 * time-out is reasonable; retrying after a decline is nagging.
 */
export type TimedOut = { status: "timed-out" };

/** REFS helpers/host-services/api.ts */
export type ElevationSupport = { ok: true; platform: "windows" | "linux" } | { ok: false; reason: ElevationReason };

/**
 * `cancelled-at-uac`, `unavailable` and `failed` stay separate on purpose. They mean
 * different things to a caller: "not now" invites a retry, "there is no grant" needs an
 * admin to create one, and "it broke" needs the detail. Collapsing them into a boolean is
 * how a module ends up retrying a decision a person already made.
 * REFS helpers/host-services/lib/allowlist.ts
 */
export type GrantOutcome =
  | { status: "ok" }
  | { status: "cancelled-at-uac" }
  | { status: "timed-out" }
  | { status: "unavailable"; reason: ElevationReason }
  | { status: "failed"; detail: string };

/**
 * Core's failure vocabulary is richer than ours; this is the only place that translates.
 *
 * Every case is written out rather than leaning on `default`, so adding a reason in core
 * surfaces here as a compile error instead of being silently folded into "failed" — which is
 * exactly how `timed-out` would have stayed invisible. A ten-minute wait reported as a
 * failure was the mystery behind one unexplained result in the first integration run.
 */
function toOutcome(reason: GrantFailure, message: string): GrantOutcome {
  switch (reason) {
    case "declined":
      return { status: "cancelled-at-uac" };
    case "timed-out":
      return { status: "timed-out" };
    case "not-installed":
      return { status: "unavailable", reason: "grant-manager-missing" };
    case "no-interactive-desktop":
      return { status: "unavailable", reason: "no-interactive-session" };
    case "unsupported-platform":
      return { status: "unavailable", reason: "unsupported-platform" };
    case "not-audited":
      // Core now refuses to grant what it cannot record. Reported verbatim, unsoftened: "we
      // would not do this because it could not be logged" is the useful sentence.
      return { status: "failed", detail: message };
    // Package reasons, added when core grew an install API — cannot occur on this helper's calls,
    // but listed rather than defaulted so the next addition breaks the build, not "failed".
    case "package-not-found":
    case "no-package-manager":
    case "invalid-request":
    case "failed":
      return { status: "failed", detail: message };
  }
}

/**
 * Can this installation create grants?
 *
 * Needs no capability — a module must be able to explain itself on a headless box without
 * having been granted anything.
 *
 * Note the asymmetry, which is easy to get backwards: CREATING a grant needs an interactive
 * desktop because that is where UAC prompts; USING one does not. A headless install can run
 * grants made earlier but cannot make new ones.
 * REFS helpers/host-services/api.ts · helpers/host-services/ui/settings-panel.tsx
 */
export function capability(): ElevationSupport {
  const s = grantSupport();
  if (s.available) return { ok: true, platform: "windows" };
  const mapped = toOutcome(s.reason, s.message);
  return { ok: false, reason: mapped.status === "unavailable" ? mapped.reason : "grant-manager-missing" };
}

/**
 * What the binary will ACTUALLY call this task.
 *
 * We sanitise names ourselves (`names.ts`) and so does the binary. Two sanitisers are two
 * copies of a contract, and core flagged that exact risk about its own exit codes — so the
 * binary is treated as the authority and its answer is what gets stored. If they ever
 * disagree, the stored name still matches the real task and `schtasks /run` keeps working;
 * without this, a silent divergence would make every action fail with "task not found".
 * REFS helpers/host-services/lib/allowlist.ts
 */
export async function resolveTaskBase(desired: string): Promise<string | null> {
  const r = await previewGrantName(desired);
  return r.ok ? r.value : null;
}

/**
 * Create the grants for one allowlist entry — all its verbs behind a SINGLE elevation.
 *
 * Batching by arguments is safe; batching by file is not, because a file is a mutable
 * instruction source. Three prompts to add one service would also train the admin to click
 * through them — the habituation ELEVATION.md warns about — and prompts two and three carry
 * no new information, since the decision being made is "may JonDash control this service".
 * REFS helpers/host-services/lib/allowlist.ts
 */
export async function createGrants(
  serviceName: string,
  taskBase: string,
  verbs: Verb[],
  by?: { label?: string; userId?: string | null },
): Promise<GrantOutcome> {
  const r = await createGrant({
    service: serviceName,
    verbs,
    id: taskBase,
    // Recorded in the task's Description, so Task Scheduler itself reads as an audit trail
    // rather than a list of names.
    by: by?.label,
    userId: by?.userId ?? null,
  });
  return r.ok ? { status: "ok" } : toOutcome(r.reason, r.message);
}

/**
 * Remove an entry's grants.
 *
 * Removing an allowlist entry and removing its grants are ONE action, never two — a list
 * entry that disappears while the OS grant survives is exactly the orphan nobody audits.
 * REFS helpers/host-services/lib/allowlist.ts
 */
export async function removeGrants(taskBase: string, userId?: string | null): Promise<GrantOutcome> {
  const r = await removeGrant({ id: taskBase, userId: userId ?? null });
  return r.ok ? { status: "ok" } : toOutcome(r.reason, r.message);
}

/**
 * Revoke every grant this helper ever created. Used only when the helper itself is being
 * removed — there is no route to this from a module.
 *
 * Reads from Windows rather than from our tables, so a grant left by a failed removal is
 * caught too. Needs elevation, and therefore a human at a prompt.
 * REFS helpers/host-services/helper.ts
 */
export async function revokeEverything(): Promise<GrantOutcome> {
  const r = await removeAllGrants({ userId: null });
  return r.ok ? { status: "ok" } : toOutcome(r.reason, r.message);
}

/**
 * What Windows actually has granted, read from the OS rather than from our own rows.
 *
 * Worth surfacing to an admin: it cannot drift from reality, so an orphan left by a failed
 * uninstall shows up here even though nothing in our tables mentions it.
 * REFS helpers/host-services/helper.ts
 */
export async function readGrants(): Promise<{ name: string; command: string; enabled: boolean }[]> {
  const r = await listGrants();
  return r.ok ? r.value.map((g) => ({ name: g.name, command: g.command, enabled: g.enabled })) : [];
}

/**
 * Run an already-granted action. ⚠ Does not elevate and does not prompt — it asks the OS to
 * run a task authorised earlier, which is the whole point of the model.
 *
 * Routed through core rather than spawning `schtasks /run` directly, for the same audit reason
 * as the rest of this file: granting was logged and using was not, which was the wrong half.
 *
 * ⚠ Returns when the task has been STARTED, not when the service has finished changing state —
 * a stop can take seconds. A caller needing the real outcome must poll the service; treating
 * this return as "stopped" would be a lie.
 * REFS helpers/host-services/lib/requests.ts
 */
export async function runGrant(taskBase: string, verb: Verb, userId?: string | null): Promise<GrantOutcome> {
  const r = await coreRunGrant({ name: `${taskBase}-${verb}`, userId: userId ?? null });
  return r.ok ? { status: "ok" } : toOutcome(r.reason, r.message);
}
