import type { HelperDefinition } from "@/lib/helpers/types";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { listRootPaths } from "./lib/roots";
import { DEFAULT_RETENTION, pruneLogs } from "./lib/logfile";
import { acceptSuggestion, addRoot, declineSuggestion, removeRoot, setRetention } from "./lib/admin";
import { rootScopeFor } from "./lib/scopes";
import SettingsPanel from "./ui/settings-panel";

/**
 * What consent screens are allowed to know about this helper's configuration. Core cannot
 * read `hlp_filesystem_*` directly — that separation is deliberate — so it asks, and this
 * decides what to hand over: **only the approved folder paths**, never run history, who
 * approved what, or the log directory.
 *
 * Core bounds this call at two seconds and swallows anything thrown, so a helper can never
 * take a consent screen down while describing itself — but this returns `{}` on failure
 * anyway, since generic wording beats a screen that renders nothing.
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

  // Retention applies when a run starts; an idle server would otherwise never prune, so
  // boot is the second chance. Reads the table directly — `api.ts` needs a module context.
  try {
    const rows = await ctx.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${ctx.db.table("settings")} WHERE key IN ('log.keepDays', 'log.keepRuns')`,
    );
    const get = (k: string, dflt: number) => {
      /* Check absence before coercing: 0 is a legitimate stored value ("keep forever"), and
         `Number(null)` is also 0, so coercing first would misread "unset" as "none". A
         missing row happens to give `undefined` here, not `null` — relying on that
         distinction is how the same bug comes back, so both are checked explicitly below. */
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
 * ⚠ NO file primitives. No call returns a file's bytes, and none ever may: a
 * `readFile(path)` here would let any module holding it read `.data/secrets.json` — the
 * master encryption key — and the verifier's filesystem ban would become decorative.
 * Modules name an operation; this helper performs it. Full contract in HELPER.md.
 *
 * Everything is confined to a ROOT: an absolute path an administrator has explicitly
 * approved, stored here rather than in the consuming module, so a module cannot widen its
 * own reach — which is what makes the consent wording literally true.
 */
const helper: HelperDefinition = {
  id: "filesystem",
  name: "Files and folders",
  description:
    "Lets a module copy and archive folders to another location — a network share, an external drive — within the folders you allow. JonDash's own secrets are never copied.",
  version: "0.0.10",
  /* Cannot go lower: `SettingsPanel`/`onSettingsSubmit` (needed since the folder editor moved
     off the module-facing API) and `unbounded.option` (the "exclude JonDash's own data"
     switch) both require it. HELPERS-DESIGN rule 11: an optional field is optional to OMIT,
     never to ADD — declaring one against an older core fails to compile, so a lower floor
     here would be a failed build, not a plainer screen. */
  minAppVersion: "1.7.2-beta.2",

  /**
   * Which of the three capabilities get LISTED is core's decision, not these functions': the
   * pre-install screen rolls up every one this helper provides, the post-install page only
   * what the module declared. `describe` supplies the wording for both, naming real approved
   * folders once `readConfig` (above) has populated `config`.
   *
   * ⚠ Each capability gets its OWN "everything" switch rather than one shared by the helper —
   * read anywhere must not imply delete anywhere. `rootScopeFor` builds the three; the "exclude
   * JonDash's own data" carve-out they all respect is `lib/admin.ts › jondashProtected`.
   *
   * REFS helpers/filesystem/lib/scopes.ts › rootScopeFor() · helpers/filesystem/lib/admin.ts
   */
  provides: [
    {
      permission: "filesystem:read",
      describe: (config) => `Look at files and folders in ${where(config)}`,
      label: "Read files",
      // Reading is where the data leaves. Media is dull; a folder of documents is not, and the
      // admin chooses which this is when they approve a root.
      risk: "medium",
      scope: rootScopeFor("read"),
    },
    {
      permission: "filesystem:write",
      describe: (config) => `Create and change files in ${where(config)}`,
      label: "Create and change files",
      risk: "high",
      scope: rootScopeFor("write"),
    },
    {
      permission: "filesystem:delete",
      describe: (config) => `Delete files in ${where(config)}`,
      label: "Delete files",
      // Its own line rather than folded into write, and its own risk: this is the one that
      // destroys data an admin cannot get back.
      risk: "high",
      scope: rootScopeFor("delete"),
    },
  ],

  migrations: "./migrations",

  readConfig,

  onBoot: reconcileInterruptedRuns,

  SettingsPanel,

  /**
   * The only way the approved folders and the retention policy can change.
   *
   * Core resolves `ctx.user` from the session and renders the form itself, so no module is in
   * the path — which is the whole point: this must never sit on `api.ts`, where a module
   * bounded by approved folders could approve its own (see `suggestRoot`'s note there).
   *
   * Returns refusals rather than throwing. Core catches and audits a throw, so throwing is
   * safe, but an admin can act on "that folder does not exist" and cannot act on a stack trace.
   *
   * REFS helpers/filesystem/api.ts › suggestRoot()
   */
  onSettingsSubmit: async (ctx, payload) => {
    const op = String(payload.op ?? "");

    switch (op) {
      case "addRoot": {
        const r = await addRoot({
          path: String(payload.path ?? ""),
          label: String(payload.label ?? ""),
          addedBy: ctx.user.id,
        });
        if (!r.ok) return { ok: false, error: r.reason };
        // The warning rides back on success — "you have just allowed something broad" is only
        // useful at the moment it becomes true.
        return { ok: true, message: `Approved ${r.root.path}.${r.risk ? ` ${r.risk}` : ""}` };
      }

      case "removeRoot": {
        const gone = await removeRoot(String(payload.id ?? ""));
        return { ok: true, message: gone ? `Removed ${gone.path}.` : "Already gone." };
      }

      case "accept": {
        const r = await acceptSuggestion(String(payload.id ?? ""), String(payload.label ?? "") || undefined);
        if (!r.ok) return { ok: false, error: r.reason };
        return { ok: true, message: `Approved ${r.root.path}.${r.risk ? ` ${r.risk}` : ""}` };
      }

      case "decline":
        await declineSuggestion(String(payload.id ?? ""));
        return { ok: true, message: "Declined." };

      case "retention": {
        const { policy, removed } = await setRetention({
          keepDays: Number(payload.keepDays),
          keepRuns: Number(payload.keepRuns),
        });
        const kept = `keep ${policy.keepDays || "unlimited"} days, ${policy.keepRuns || "unlimited"} runs`;
        return { ok: true, message: `Saved — ${kept}. ${removed} log${removed === 1 ? "" : "s"} removed.` };
      }

      default:
        return { ok: false, error: "Unknown action." };
    }
  },
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
