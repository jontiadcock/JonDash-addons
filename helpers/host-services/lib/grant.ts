import {
  createGrant,
  grantSupport,
  listGrants,
  previewGrantName,
  removeGrant,
  runGrant as coreRunGrant,
  type GrantFailure,
} from "@/lib/elevation";
import type { Verb } from "./names";

/**
 * The bridge to core's grant manager (OPS-18, shipped in JonDash 1.7.1-beta.1).
 *
 * **Everything privileged goes through `@/lib/elevation`, never the binary directly.** That
 * is HELPERS-DESIGN rule 7, and the reason is auditing: core resolves the path, maps exit
 * codes and logs every call — including the declined and failed ones. A helper that spawns
 * `jondash-grant.exe` itself works perfectly and appears nowhere in the log, which is the
 * worst combination available.
 *
 * A grant is a Scheduled Task under `\JonDash\` running one fixed command with highest
 * privileges. Creating one prompts for elevation ONCE and the grant then persists, so
 * unattended automation works and a restart of JonDash or the machine changes nothing.
 *
 * The rule the design rests on, from ../ELEVATION.md: **a granted action must be entirely
 * self-contained and must never read what to do from anywhere.** The task stores a fixed
 * service and verb, and `schtasks /run` cannot pass arguments, so what can happen without a
 * prompt is fixed at the instant the admin approved it — enforced by Windows, not by us.
 */

/** Why elevation is impossible here. Named separately so callers can switch on it. */
export type ElevationReason = "no-interactive-session" | "grant-manager-missing" | "unsupported-platform";

/**
 * A prompt nobody answered. Distinct from `cancelled-at-uac` because they mean opposite
 * things: declining is a decision, timing out is an absence of one. Retrying after a
 * time-out is reasonable; retrying after a decline is nagging.
 */
export type TimedOut = { status: "timed-out" };

export type ElevationSupport = { ok: true; platform: "windows" | "linux" } | { ok: false; reason: ElevationReason };

/**
 * `cancelled-at-uac`, `unavailable` and `failed` stay separate on purpose. They mean
 * different things to a caller: "not now" invites a retry, "there is no grant" needs an
 * admin to create one, and "it broke" needs the detail. Collapsing them into a boolean is
 * how a module ends up retrying a decision a person already made.
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
      // Core now refuses to grant what it cannot record. Reported verbatim rather than
      // softened: "we would not do this because it could not be logged" is the useful
      // sentence, and hiding it would undo the fix.
      return { status: "failed", detail: message };
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
 */
export async function removeGrants(taskBase: string, userId?: string | null): Promise<GrantOutcome> {
  const r = await removeGrant({ id: taskBase, userId: userId ?? null });
  return r.ok ? { status: "ok" } : toOutcome(r.reason, r.message);
}

/**
 * What Windows actually has granted, read from the OS rather than from our own rows.
 *
 * Worth surfacing to an admin: it cannot drift from reality, so an orphan left by a failed
 * uninstall shows up here even though nothing in our tables mentions it.
 */
export async function readGrants(): Promise<{ name: string; command: string; enabled: boolean }[]> {
  const r = await listGrants();
  return r.ok ? r.value.map((g) => ({ name: g.name, command: g.command, enabled: g.enabled })) : [];
}

/**
 * Run an already-granted action. **This does not elevate and does not prompt** — it asks
 * the OS to run a task authorised earlier, which is the whole point of the model.
 *
 * Now goes through core (1.7.1-beta.2) rather than spawning `schtasks /run` ourselves.
 * Spawning it directly was never an escalation — running a task cannot create a capability,
 * and without an existing grant it simply fails — but it put *the moment a service actually
 * restarts* outside the audit log built to record privileged actions. Granting was logged and
 * using was not, which is the wrong half.
 *
 * **Returns when the task has been STARTED, not when the service has finished changing
 * state.** A stop can take seconds. Callers that need the real outcome must poll the service;
 * treating this as "the service is now stopped" would be a lie.
 */
export async function runGrant(taskBase: string, verb: Verb, userId?: string | null): Promise<GrantOutcome> {
  const r = await coreRunGrant({ name: `${taskBase}-${verb}`, userId: userId ?? null });
  return r.ok ? { status: "ok" } : toOutcome(r.reason, r.message);
}
