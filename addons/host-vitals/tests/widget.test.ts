import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModuleContext } from "@/lib/modules/types";
import HostVitalsWidget from "../ui/widget";
import { collectFor } from "../lib/groups";

/**
 * The dashboard tile must draw its own card — the dashboard supplies a grid cell and nothing
 * else, so a widget without `card p-4` renders as loose text with no name. This asserts the
 * rendered markup, because that failure typechecks and builds cleanly (it once shipped to
 * stable in another module). The `system-metrics` helper is real in the testbed, so
 * `can: () => true` exercises the genuine read path against this host.
 */

function ctx(granted: boolean, settings: Record<string, unknown> = {}): ModuleContext {
  const grants: string[] = granted ? ["system-metrics:read"] : [];
  return {
    moduleId: "host-vitals",
    user: null,
    grants,
    can: (p: string) => grants.includes(p),
    settings: {
      get: async (k: string) => settings[k],
      set: async () => {},
      all: async () => settings,
    },
    store: { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
  } as unknown as ModuleContext;
}

async function render(granted: boolean, settings: Record<string, unknown> = {}): Promise<string> {
  const el = await HostVitalsWidget({ ctx: ctx(granted, settings) });
  return el ? renderToStaticMarkup(el) : "";
}

describe("host vitals tile", () => {
  it("draws its own card and names itself, even when metrics are unavailable", async () => {
    const html = await render(false); // capability not granted → read() returns null
    // ⚠ Match the `card` class ALONE, never the full class string — the rest is layout and
    // changes. Asserting `card p-4` broke on the B5/B6 resize while the tile was still correct.
    expect(html).toMatch(/class="card[ "]/);
    expect(html).toContain("Host vitals");
    expect(html).toContain("not available");
  });

  it("draws a card, a verdict and a link when metrics are available", async () => {
    const html = await render(true); // real read of this host
    expect(html).toMatch(/class="card[ "]/);
    expect(html).toContain("Host vitals");
    expect(html).toContain('href="/m/host-vitals"');
    // The verdict line is always one of these.
    expect(html).toMatch(/All healthy|Getting busy|nearly full|Memory is tight|Swapping|On battery/);
  });

  it("always shows the vitals that have no switch", async () => {
    const html = await render(true, {});
    expect(html).toContain("CPU");
    expect(html).toContain("Memory");
    expect(html).toContain("Uptime");
  });

  it("uses GB/TB, never GiB/TiB", async () => {
    const html = await render(true);
    expect(html).toMatch(/\d\s(GB|TB|MB|KB)\b/);
    expect(html).not.toMatch(/GiB|TiB|MiB/);
  });
});

describe("per-metric switches", () => {
  /**
   * The promise is that switching a vital off means it is not GATHERED, not merely hidden.
   * The widget builds the helper's `collect` list from the settings, so the check that
   * matters is that the disabled group never appears in that list.
   */
  it("leaves a disabled group out of the collect list entirely", async () => {
    const groups = collectFor({ showNetwork: false, showNetworkIo: false, showSwap: false });
    expect(groups).not.toContain("network");
    expect(groups).not.toContain("networkIo");
    expect(groups).not.toContain("swap");
  });

  it("includes a group that is switched on", async () => {
    const groups = collectFor({ showNetwork: true, showDiskIo: true });
    expect(groups).toContain("network");
    expect(groups).toContain("diskIo");
  });

  it("always collects cpu, memory and disks — they have no switch", async () => {
    for (const values of [{}, { showSwap: false, showNetwork: false, showTemps: false }]) {
      const groups = collectFor(values);
      expect(groups).toContain("cpu");
      expect(groups).toContain("memory");
      expect(groups).toContain("disks");
    }
  });

  it("falls back to each switch's default when nothing has been saved", async () => {
    const groups = collectFor({});
    // Defaults: swap/network/networkIo/temps on; cpuCores/diskIo/fans/battery off.
    expect(groups).toContain("swap");
    expect(groups).toContain("temps");
    expect(groups).not.toContain("cpuCores");
    expect(groups).not.toContain("fans");
  });

  it("treats a stored string 'true' as on, since settings round-trip as text", async () => {
    expect(collectFor({ showFans: "true" })).toContain("fans");
    expect(collectFor({ showFans: "false" })).not.toContain("fans");
  });
});
