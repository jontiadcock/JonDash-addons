import "server-only";
import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import {
  snapshot,
  ALL_GROUPS,
  type Battery,
  type CollectOptions,
  type DiskIo,
  type DiskUsage,
  type MetricGroup,
  type NetworkInterface,
  type NetworkIo,
  type Snapshot,
  type Swap,
} from "./lib/collect";

/**
 * The ONLY surface a consuming module may import — `@/helpers/system-metrics/api`. The verifier
 * permits it solely for a module that declared `helpers: ["system-metrics"]` and refuses any
 * deeper path, so the internals below are free to change without breaking a consumer.
 *
 * ⚠ There is one call, and it is read-only. It returns *numbers gathered from the host* — never
 * a path's contents, never a handle to the machine. That is what keeps the consent line honest
 * and stops this becoming a way to read `.data/secrets.json`.
 * REFS helpers/system-metrics/HELPER.md — the guarantees this file must keep.
 */

// Re-exported so a module gets every type from the entry point it is allowed to import,
// never from `./lib/collect` (which the verifier would refuse).
export type {
  Battery,
  CollectOptions,
  DiskIo,
  DiskUsage,
  MetricGroup,
  NetworkInterface,
  NetworkIo,
  Snapshot,
  Swap,
};
export { ALL_GROUPS };

export type SystemMetricsApi = {
  /**
   * A fresh reading of the host, or `null` if the calling module did not declare
   * `system-metrics:read`. On a supported host `null` means only that — the reads
   * themselves don't fail. Safe to poll; the helper caches nothing.
   *
   * Pass `collect` to gather only the groups you will actually show. A group left out is
   * never sampled, which is the difference between a metric being hidden and a metric not
   * being taken at all. Omit the argument for everything.
   */
  read(opts?: CollectOptions): Promise<Snapshot | null>;
};

/**
 * The capability gate. Present since core 1.5.2 (`minAppVersion` rules out anything older);
 * the `typeof` guard means a core that somehow lacks it fails open to reading rather than
 * throwing on every call — a read-only helper has nothing to protect by failing closed.
 */
function granted(ctx: ModuleContext, permission: DeclaredPermission): boolean {
  if (typeof ctx.can !== "function") return true;
  return ctx.can(permission);
}

const api = (ctx: ModuleContext): SystemMetricsApi => ({
  async read(opts) {
    if (!granted(ctx, "system-metrics:read")) return null;
    return snapshot(opts);
  },
});

/**
 * The factory every consumer calls as `systemMetrics(ctx)`.
 *
 * ⚠ Widening this surface widens what every consumer can read from the host — update the
 * capability label in `helper.ts` in the same commit so the consent screen stays honest.
 * REFS addons/host-vitals/page.tsx · addons/host-vitals/ui/widget.tsx
 *      helpers/system-metrics/helper.ts › provides — the label that must track this surface.
 */
export default api;
