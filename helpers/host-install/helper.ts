import type { HelperDefinition } from "@/lib/helpers/types";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { uninstallPackage } from "@/lib/elevation";

/**
 * Host install helper — installs and removes software, with the administrator approving every
 * single time.
 *
 * **Why this is a separate helper from `host-services`, and must stay separate:** a module
 * inherits every capability of every helper it declares. Folding installing into
 * `host-services` would make `service-control`'s consent screen say "can install software on
 * your machine" for a module that only restarts Plex — permanently, and for every future
 * consumer. A genuinely different power needs a different helper, not a wider one.
 *
 * The elevation models differ too, and that difference is the rule in `../ELEVATION.md`:
 * a service action is FIXED, so it can be granted once; a package name is VARIABLE, so there
 * is nothing to bake into a grant and every install must be approved as it happens.
 *
 * **This is weaker than grants, and the docs must not pretend otherwise.** A grant runs one
 * fixed command that cannot take arguments. An installer runs the vendor's code as
 * administrator by definition. The bound here is "anything in the winget catalogue" — real,
 * but far broader — so JonDash's own screen, showing the package id verbatim, is the only
 * place the admin can actually see what they are agreeing to. UAC names
 * `jondash-elevate.exe` and nothing else.
 */
const helper: HelperDefinition = {
  id: "host-install",
  name: "Install software",
  description:
    "Installs and removes software on this server using Windows' own package manager, with your permission each time. JonDash only ever offers to remove software it installed itself.",
  version: "0.0.2-beta.1",
  // The package API (installPackage / uninstallPackage / packageState) arrived in
  // 1.7.1-beta.7. The PRE-RELEASE, not a bare "1.7.1": semver ranks a pre-release below its
  // release, so "1.7.1" would be refused on every 1.7.1 beta — the builds beta users run.
  minAppVersion: "1.7.1-beta.7",

  /**
   * Two capabilities, split for honesty. Checking whether something is installed is a
   * read; installing it is running a vendor's code as administrator. They do not belong in
   * one sentence, and a consumer that only needs the first should not have to disclose the
   * second.
   *
   * The manage label deliberately says "with your permission each time" — unlike
   * `host-services`, that is a property of the capability rather than a setting, because
   * there is no grant model here to switch off.
   */
  provides: [
    {
      permission: "host-install:read",
      describe: () => "See whether a piece of software is installed on this server",
    },
    {
      permission: "host-install:manage",
      describe: () =>
        "Install and remove software on this server — you approve each one, and see its name before it runs",
    },
  ],

  migrations: "./migrations",

  /**
   * **Ask, rather than decide.** Removing software automatically would be destructive in a way
   * no audit entry excuses; removing nothing silently leaves the admin unaware they still have
   * software JonDash put there. So the question is put to the person while they are on the
   * screen — which is what `uninstallQuestions` is for.
   *
   * Defaults to **off**, and only ever offers packages JonDash installed. Ten is core's cap;
   * anything beyond that is summarised rather than listed, since an uninstall screen with
   * fifteen tickboxes is one nobody reads.
   */
  uninstallQuestions: async () => {
    const rows = await prisma.$queryRawUnsafe<{ packageId: string; label: string | null }[]>(
      `SELECT packageId, label FROM ${helperTableName("host-install", "installed")} ORDER BY installedAt`,
    );
    return rows.slice(0, 10).map((r) => ({
      id: `remove:${r.packageId}`,
      label: `Also remove ${r.label ?? r.packageId}?`,
      detail:
        "JonDash installed this. Removing it runs the uninstaller as administrator, and anything it " +
        "owns — containers, volumes, settings — goes with it.",
      default: false,
    }));
  },

  /**
   * Only what was ticked, and nothing else.
   *
   * `answers` is namespaced to this helper, and an unticked or unasked question is **absent
   * rather than false** — so this reads `=== true` instead of trusting a lookup to be present.
   * A missing key must never be read as consent.
   */
  onUninstall: async (ctx, answers) => {
    const rows = await prisma.$queryRawUnsafe<{ packageId: string }[]>(
      `SELECT packageId FROM ${helperTableName("host-install", "installed")}`,
    );
    if (rows.length === 0) return;

    const wanted = rows.filter((r) => answers[`remove:${r.packageId}`] === true).map((r) => r.packageId);
    const kept = rows.filter((r) => !wanted.includes(r.packageId)).map((r) => r.packageId);

    for (const packageId of wanted) {
      const r = await uninstallPackage(packageId, { userId: null });
      await ctx.audit(
        r.ok ? "host-install.uninstall.removed" : "host-install.uninstall.FAILED",
        r.ok ? packageId : `${packageId} — ${r.message}. It is still installed.`,
      );
    }

    if (kept.length > 0) {
      await ctx.audit("host-install.uninstall", `left installed at your request: ${kept.join(", ")}`);
    }
  },

  /** Uninstalling a package raises a UAC prompt, so this hook has to outlive the 5s default. */
  uninstallMayPrompt: true,
};

export default helper;
