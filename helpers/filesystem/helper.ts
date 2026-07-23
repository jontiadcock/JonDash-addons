import type { HelperDefinition } from "@/lib/helpers/types";
import { listRootPaths } from "./lib/roots";
import { DEFAULT_RETENTION, pruneLogs } from "./lib/logfile";

/**
 * A run still marked `running` when the server boots can only mean one thing: the process
 * stopped mid-copy. It must never be left to look like a backup that finished. This is the
 * source of truth a consumer reconciles against, so healing it here heals every consumer.
 */
async function reconcileInterruptedRuns(ctx: Parameters<NonNullable<HelperDefinition["onBoot"]>>[0]): Promise<void> {
  if (!ctx.db) return;
  await ctx.db.run(
    `UPDATE ${ctx.db.table("runs")} SET state = 'interrupted', finishedAt = ? WHERE state = 'running'`,
    new Date().toISOString(),
  );

  // Retention is normally applied when a run starts. A server that sits idle for months
  // would otherwise never prune, so boot is the second chance. Read straight from the
  // settings table rather than through `api.ts`, which needs a module context there is
  // none of at boot.
  try {
    const rows = await ctx.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${ctx.db.table("settings")} WHERE key IN ('log.keepDays', 'log.keepRuns')`,
    );
    const get = (k: string, dflt: number) => {
      // Explicitly absent-first: 0 is a legitimate stored value ("keep forever"), and
      // `Number(null)` is 0, so coercing before checking would read "never configured" as
      // "no retention". It happens to work here because a missing row gives `undefined`,
      // not `null` — but relying on that distinction is how the same bug comes back.
      const raw = rows.find((r) => r.key === k)?.value;
      if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : dflt;
    };
    await pruneLogs({
      keepDays: get("log.keepDays", DEFAULT_RETENTION.keepDays),
      keepRuns: get("log.keepRuns", DEFAULT_RETENTION.keepRuns),
    });
  } catch {
    // Boot must never fail because housekeeping did. The next run prunes instead.
  }
}

/**
 * Filesystem helper — lets a module copy, mirror and archive folders, and nothing else.
 *
 * It exposes NO file primitives. There is no call that returns the bytes of a file, and
 * there must never be one: a `readFile(path)` here would let any module holding this
 * helper read `.data/secrets.json` — the master encryption key — and the verifier's ban
 * on filesystem access would become decorative. Modules name an operation; this helper
 * performs it. See HELPER.md for the full contract.
 *
 * Everything it touches is confined to a ROOT: an absolute path an administrator has
 * explicitly approved, stored here rather than in the consuming module, so a module
 * cannot widen its own reach. That is what makes the consent wording literally true.
 */
const helper: HelperDefinition = {
  id: "filesystem",
  name: "Files and folders",
  description:
    "Lets a module copy and archive folders to another location — a network share, an external drive — within the folders you allow. JonDash's own secrets are never copied.",
  version: "0.0.2-beta.1",
  // Unchanged at 0.0.2. This is what the helper needs to RUN, and its runtime requirements
  // haven't moved — helper-named capabilities arrived in 1.5.1 and nothing since is needed.
  // (Delivering an UPDATE to an existing install is a separate matter, waiting on the
  // helper update mechanism the core session is building.) The pre-release, not a bare
  // "1.5.1": semver ranks a pre-release below its release, so "1.5.1" would be refused on
  // every 1.5.1 beta — the builds beta-channel users actually run.
  minAppVersion: "1.5.1-beta.1",

  /**
   * Three lines rather than one, deliberately — "delete" is far too important to be folded
   * into "write".
   *
   * Note, corrected after live testing: core renders one consent line per permission the
   * MODULE declared, not one per capability this helper provides. A module asking only for
   * `filesystem:read` shows the admin a single line. These `describe` functions supply the
   * wording; they do not decide what is listed.
   *
   * `describe` receives the helper's config, which core does not yet populate — it calls
   * `helperCapabilityLabels()` with no argument — so `where()` currently always says "the
   * folders you allow". Harmless and honest; it will start naming real folders for free if
   * core ever passes config through.
   */
  provides: [
    {
      permission: "filesystem:read",
      describe: (config) => `Look at files and folders in ${where(config)}`,
    },
    {
      permission: "filesystem:write",
      describe: (config) => `Create and change files in ${where(config)}`,
    },
    {
      permission: "filesystem:delete",
      describe: (config) => `Delete files in ${where(config)}`,
    },
  ],

  migrations: "./migrations",

  onBoot: reconcileInterruptedRuns,
};

/**
 * "the locations you allow" until roots exist, then the actual folders. Naming real
 * directories is the point of `describe` taking config — an admin should be able to read
 * the consent screen and recognise their own machine.
 */
function where(config: Record<string, unknown>): string {
  const roots = listRootPaths(config);
  if (roots.length === 0) return "the folders you allow";
  if (roots.length <= 2) return roots.join(" and ");
  return `${roots.slice(0, 2).join(", ")} and ${roots.length - 2} more`;
}

export default helper;
