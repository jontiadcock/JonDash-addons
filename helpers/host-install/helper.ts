import type { HelperDefinition } from "@/lib/helpers/types";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { uninstallPackage } from "@/lib/elevation";

/**
 * Host install helper — installs and removes software, with the administrator approving every
 * single time.
 *
 * ⚠ Kept separate from `host-services`, permanently — a module inherits every capability of
 * every helper it declares, so merging them would give `service-control` "can install
 * software" forever. Elevation differs too: a service action is FIXED and grantable once; a
 * package name is VARIABLE and approved live every time (`../ELEVATION.md`).
 * ⚠ Weaker than a grant — say so, don't pretend otherwise. An installer runs the vendor's code
 * as administrator over the whole winget catalogue; JonDash's own screen, showing the package
 * id verbatim, is the only place the admin actually sees what they're agreeing to.
 */
const helper: HelperDefinition = {
  id: "host-install",
  name: "Install software",
  description:
    "Installs and removes software on this server using Windows' own package manager, with your permission each time. JonDash only ever offers to remove software it installed itself.",
  version: "0.0.5",
  // Raised by CORE-10's optional `label`/`risk` (an older core fails to compile, TS2353). Must
  // stay the PRE-RELEASE string — a bare "1.7.2" would be refused on every 1.7.2 beta build.
  minAppVersion: "1.7.2-beta.1",

  /**
   * Two capabilities, split for honesty: checking whether something is installed is a read,
   * installing it is running a vendor's code as administrator, and a consumer that only needs
   * the first shouldn't have to disclose the second. The manage label says "with your
   * permission each time" as a property of the capability, not a setting — unlike
   * `host-services`, there is no grant model here to switch off.
   */

  /**
   * ⚠ No `scope`, no `unbounded` — same reason `host-services:control` has no unbounded: there
   * is nothing to make one out of. Every install is approved individually as it runs, package
   * name on screen with a UAC prompt behind it; the bound IS the per-request approval, not a
   * stored list. A package allowlist here would just describe a gate the request flow already
   * applies one request at a time.
   */
  provides: [
    {
      permission: "host-install:read",
      describe: () => "See whether a piece of software is installed on this server",
      label: "See installed software",
      risk: "low",
    },
    {
      permission: "host-install:manage",
      describe: () =>
        "Install and remove software on this server — you approve each one, and see its name before it runs",
      label: "Install and remove software",
      // Installing software is arbitrary code execution with the admin's blessing. Nothing
      // ranks above this.
      risk: "high",
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
