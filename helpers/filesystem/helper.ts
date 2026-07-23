import type { HelperDefinition } from "@/lib/helpers/types";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { listRootPaths } from "./lib/roots";
import { DEFAULT_RETENTION, pruneLogs } from "./lib/logfile";

/**
 * What consent screens are allowed to know about this helper's configuration.
 *
 * Core cannot read `hlp_filesystem_*` — that separation is deliberate — so it asks, and
 * this decides what to hand over. **Only the approved folder paths, and nothing else.** Not
 * run history, not who approved what, not the log directory. The single question a consent
 * screen is answering is "which folders would this let a module touch?", so that is the
 * only thing that travels.
 *
 * Core bounds this at two seconds and swallows anything thrown, because a helper must never
 * be able to take a consent screen down while describing itself. This is one indexed read,
 * nowhere near that, but it returns `{}` on failure rather than relying on core's net —
 * falling back to generic wording is strictly better than a screen that renders nothing.
 */
async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ id: string; path: string; label: string }[]>(
      `SELECT id, path, label FROM ${helperTableName("filesystem", "roots")} ORDER BY label`,
    );
    return { roots: rows };
  } catch {
    return {};
  }
}

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
  version: "0.0.4",
  // Raised for 0.0.3: `ctx.can()` and `HelperDefinition.readConfig` arrived in 1.5.2, and
  // this release uses both. Declaring 1.5.1 would install on a build where enforcement
  // silently does nothing, which is the quiet weakening this release exists to remove.
  //
  // The PRE-RELEASE, not a bare "1.5.2": semver ranks a pre-release below its release, so
  // "1.5.2" would be refused on every 1.5.2 beta — the builds beta-channel users run.
  minAppVersion: "1.5.2-beta.1",

  /**
   * Three lines rather than one, deliberately — "delete" is far too important to be folded
   * into "write".
   *
   * Which lines get LISTED is core's decision, not these functions'. The pre-install browse
   * screen rolls up every capability this helper provides; the post-install module page
   * lists only what the module itself declared. `describe` supplies the wording for both.
   *
   * Since 1.5.2 core populates `config` from `readConfig` above, so these name the real
   * approved folders rather than saying "the folders you allow". They still fall back to
   * that wording when nothing is approved yet — which is both true and the state an admin
   * is usually in when first reading a consent screen.
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

  readConfig,

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
