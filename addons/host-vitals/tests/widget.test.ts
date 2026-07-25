import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModuleContext } from "@/lib/modules/types";
import HostVitalsWidget from "../ui/widget";

/**
 * The dashboard tile must draw its own card — the dashboard supplies a grid cell and nothing
 * else, so a widget without `card p-4` renders as loose text with no name. This asserts the
 * rendered markup, because that failure typechecks and builds cleanly (it once shipped to
 * stable in another module). The `system-metrics` helper is real in the testbed, so
 * `can: () => true` exercises the genuine read path against this host.
 */

function ctx(granted: boolean): ModuleContext {
  const grants = granted ? (["system-metrics:read"] as const) : ([] as const);
  return {
    moduleId: "host-vitals",
    user: null,
    grants: [...grants],
    can: (p) => grants.includes(p as (typeof grants)[number]),
    settings: { get: async () => undefined, set: async () => {}, all: async () => ({}) },
    store: { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
  } as unknown as ModuleContext;
}

async function render(granted: boolean): Promise<string> {
  const el = await HostVitalsWidget({ ctx: ctx(granted) });
  return el ? renderToStaticMarkup(el) : "";
}

describe("host vitals tile", () => {
  it("draws its own card and names itself, even when metrics are unavailable", async () => {
    const html = await render(false); // capability not granted → read() returns null
    expect(html).toMatch(/class="card p-4"/);
    expect(html).toContain("Host vitals");
    expect(html).toContain("not available");
  });

  it("draws a card, a verdict and a link when metrics are available", async () => {
    const html = await render(true); // real read of this host
    expect(html).toMatch(/class="card p-4"/);
    expect(html).toContain("Host vitals");
    expect(html).toContain('href="/m/host-vitals"');
    // The verdict line is always one of these three.
    expect(html).toMatch(/All healthy|Getting busy|nearly full|Memory is tight/);
  });
});
