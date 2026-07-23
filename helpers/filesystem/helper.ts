import type { HelperDefinition } from "@/lib/helpers/types";
import { listRootPaths } from "./lib/roots";

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
    "Lets a module copy and archive folders to another location — a network share, an external drive — within the folders you allow.",
  version: "0.0.1-beta.1",
  // Helper-named capabilities arrived in 1.5.1. The pre-release, not a bare "1.5.1":
  // semver ranks a pre-release below its release, so "1.5.1" would be refused on every
  // 1.5.1 beta — the builds beta-channel users actually run.
  minAppVersion: "1.5.1-beta.1",

  /**
   * Three lines rather than one, deliberately. Every module declaring this helper
   * inherits ALL of these on its consent screen whether it uses them or not, so splitting
   * costs nothing — and "delete" is far too important to be folded into "write".
   *
   * `describe` runs once the helper is installed and can name the real folders. Before
   * that, at browse time, the static labels in addons.json are what an admin reads.
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
