// Must match `helpers/system-metrics/lib/collect.ts › MetricGroup` exactly, or `collectFor()`
// below hands the helper a group name it doesn't recognise.
import type { MetricGroup } from "@/helpers/system-metrics/api";

/**
 * Which vitals are switched on, and what that means.
 *
 * **One list drives three things** — the settings an admin sees, the `collect` list handed to
 * the helper, and what the UI renders. Keeping them in one place is what makes the promise
 * true: a metric you switch off is *not gathered*, not merely hidden. Splitting these into
 * separate lists is how a "disabled" metric quietly keeps being collected.
 *
 * `cpu`, `memory` and `disks` are not listed: they are the point of the module, they cost
 * nothing to read, and a vitals tile that can hide all three is just an empty card.
 */

export type Toggle = {
  /** Module setting key. */
  key: string;
  /** The helper group it gates. */
  group: MetricGroup;
  label: string;
  help: string;
  default: boolean;
};

/** REFS addons/host-vitals/module.ts — declares these as the module's configurable settings. */
export const TOGGLES: Toggle[] = [
  {
    key: "showSwap",
    group: "swap",
    label: "Swap / page file",
    help: "How much swap is in use. Linux only — Windows reports none.",
    default: true,
  },
  {
    key: "showCpuCores",
    group: "cpuCores",
    label: "Per-core CPU",
    help: "A busy percentage for every core. Useful on a busy box, noisy on a big one.",
    default: false,
  },
  {
    key: "showNetwork",
    group: "network",
    label: "Network interfaces",
    help: "Interface names and their addresses. Shows this machine's IP and MAC addresses.",
    default: true,
  },
  {
    key: "showNetworkIo",
    group: "networkIo",
    label: "Network throughput",
    help: "Upload and download rates per interface. Linux only.",
    default: true,
  },
  {
    key: "showDiskIo",
    group: "diskIo",
    label: "Disk read/write rates",
    help: "How hard each drive is being worked. Linux only.",
    default: false,
  },
  {
    key: "showTemps",
    group: "temps",
    label: "Temperatures",
    help: "Where the hardware reports them. Linux only.",
    default: true,
  },
  {
    key: "showFans",
    group: "fans",
    label: "Fan speeds",
    help: "Where the hardware reports them. Linux only.",
    default: false,
  },
  {
    key: "showBattery",
    group: "battery",
    label: "Battery / UPS",
    help: "Charge and charging state, if this machine has a battery. Linux only.",
    default: false,
  },
];

/** Always gathered — the module has nothing to show without them. */
const ALWAYS: MetricGroup[] = ["cpu", "memory", "disks"];

/**
 * Read the toggles and turn them into the helper's `collect` list.
 *
 * A setting that has never been saved falls back to its declared default, so a fresh install
 * shows something sensible rather than an empty card.
 * REFS addons/host-vitals/page.tsx · addons/host-vitals/tests/widget.test.ts ·
 *      addons/host-vitals/ui/widget.tsx
 */
export function collectFor(values: Record<string, unknown>): MetricGroup[] {
  const on = TOGGLES.filter((t) => {
    const v = values[t.key];
    if (v === undefined || v === null || v === "") return t.default;
    return v === true || v === "true" || v === 1 || v === "1";
  });
  return [...ALWAYS, ...on.map((t) => t.group)];
}

/** Whether one group ended up switched on — for deciding whether to render its section. */
export function isOn(groups: MetricGroup[], group: MetricGroup): boolean {
  return groups.includes(group);
}
