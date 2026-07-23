import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModuleContext } from "@/lib/modules/types";
import BackupWidget from "../ui/widget";

/**
 * The dashboard tile draws its own card, and this test exists because it once did not.
 *
 * `WidgetFrame` gives a widget a grid cell and a Customise button and nothing else — no
 * card, no padding, no heading. Every widget supplies its own. This one shipped without,
 * so on a real dashboard it rendered as loose text on the page background, next to
 * health-monitor's properly framed tile, with nothing saying which module it belonged to.
 *
 * It typechecked, linted and built cleanly the whole time, which is exactly why the check
 * has to be on the rendered markup rather than on the code compiling.
 */

/** Just enough of ctx.db for the widget: `table` for names, `query` for canned rows. */
function stubCtx(rows: Record<string, unknown[]>): ModuleContext {
  return {
    moduleId: "backup-manager",
    db: {
      table: (n: string) => `mod_backup_manager_${n}`,
      query: async (sql: string) => {
        if (/FROM mod_backup_manager_jobs/.test(sql)) return rows.jobs ?? [];
        if (/FROM mod_backup_manager_runs/.test(sql)) return rows.runs ?? [];
        return [];
      },
      run: async () => {},
    },
  } as unknown as ModuleContext;
}

const job = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  name: "Nightly photos",
  enabled: 1,
  mode: "snapshot",
  ...over,
});

/** The component is an async Server Component, so await it and render what it returns. */
async function render(ctx: ModuleContext): Promise<string> {
  const el = await BackupWidget({ ctx });
  return el ? renderToStaticMarkup(el) : "";
}

describe("dashboard tile", () => {
  it("draws its own card when there are no backups yet", async () => {
    const html = await render(stubCtx({ jobs: [] }));
    expect(html).toContain("No backups set up yet.");
    // The regression: this state used to render as a bare div.
    expect(html).toMatch(/class="card p-4"/);
  });

  it("draws its own card when there are backups", async () => {
    const html = await render(stubCtx({ jobs: [job()], runs: [] }));
    expect(html).toMatch(/class="card p-4"/);
  });

  it("names itself, so a dashboard of tiles says which module this is", async () => {
    const html = await render(stubCtx({ jobs: [] }));
    expect(html).toContain(">Backups<");
  });

  it("offers a way into the module from both states", async () => {
    const empty = await render(stubCtx({ jobs: [] }));
    const full = await render(stubCtx({ jobs: [job()], runs: [] }));
    for (const html of [empty, full]) {
      expect(html).toContain('href="/m/backup-manager"');
    }
  });

  it("leads with a verdict rather than a count", async () => {
    // Enabled but never run is deliberately NOT reported as healthy.
    const html = await render(stubCtx({ jobs: [job()], runs: [] }));
    expect(html).toMatch(/needs a look/);
  });
});
