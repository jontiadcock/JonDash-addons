import type { HelperDefinition } from "@/lib/helpers/types";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { listRootPaths } from "./lib/roots";
import { DEFAULT_RETENTION, pruneLogs } from "./lib/logfile";
import { acceptSuggestion, addRoot, declineSuggestion, removeRoot, setRetention } from "./lib/admin";
import { rootScopeFor } from "./lib/scopes";
import SettingsPanel from "./ui/settings-panel";

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
  version: "0.0.8",
  // Raised for 0.0.6, from 1.5.2-beta.1. `SettingsPanel` / `onSettingsSubmit` arrived in
  // 1.7.1-beta.9, and this release cannot work without them: the folder editor moved off the
  // module-facing API and there is nowhere else for it to live. Declaring the old floor would
  // install on a build with no settings page at all, leaving the roots unpopulatable — which
  // is worse than not being offered the update.
  //
  // beta.**2**, not beta.1: `unbounded.option` — the "exclude JonDash's own data" switch — was
  // added in 1.7.2-beta.2. Same rule as every other floor here and now written down as
  // HELPERS-DESIGN rule 11: an optional field is optional to OMIT, never optional to ADD.
  // Declaring one against an older core fails to compile, and a helper compiles into the app,
  // so it is a failed build rather than a plainer screen.
  minAppVersion: "1.7.2-beta.2",

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
  /**
   * ## Three capabilities, three "everything" switches, one folder list
   *
   * The owner's decision (2026-07-26), and both halves of it matter:
   *
   *  1. **"Everything" exists**, and it is not quietly carved out. Turning it on genuinely
   *     reaches every folder on the machine.
   *  2. **The carve-out is a switch of its own** — `unbounded.option`, "exclude JonDash's own
   *     data", defaulting to protected. So the sentence beside the grant is true in both
   *     states, which is what HELPERS-DESIGN rule 10 is actually asking for. Turning the
   *     protection off is what exposes `.data/secrets.json`: the AES master key that decrypts
   *     every TOTP secret and every backup, plus the database and the elevation binaries.
   *
   * **One switch per verb, not one for the helper.** Owner's rule 9: a read-only option and a
   * full one. Letting a module read anywhere must not require letting it delete anywhere, and
   * a single switch would have forced exactly that trade. `scope` being per-capability makes it
   * fall out — three scopes, three `unbounded`s, one shared `list()`.
   *
   * The protection is deliberately NOT per verb: it names a set of files rather than an action,
   * and "protected from reading but not from deletion" has no safe reading.
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
   * the path — which is the whole point. Until 0.0.5 these operations sat on `api.ts`, where a
   * module bounded by approved folders could approve its own; see the note on `suggestRoot`.
   *
   * Returns refusals rather than throwing. Core catches and audits a throw, so throwing is
   * safe, but an admin can act on "that folder does not exist" and cannot act on a stack trace.
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
