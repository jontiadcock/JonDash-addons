import "server-only";
import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import { snapshot, type DiskUsage, type Snapshot } from "./lib/collect";

/**
 * The ONLY surface a consuming module may import — `@/helpers/system-metrics/api`. The
 * verifier permits that import solely for a module that declared
 * `helpers: ["system-metrics"]`, and refuses any deeper path, so the internals below are
 * free to change without breaking a consumer.
 *
 * There is exactly one call, and it is read-only. It returns *numbers gathered from the
 * host* — never a path's contents, never a handle to the machine. That is what keeps the
 * consent line ("see CPU, memory, disks…") honest and stops this becoming a way to read
 * `.data/secrets.json`.
 */

// Re-exported so a module gets the shape from the api entry it's allowed to import, never
// from `./lib/collect` (which the verifier would refuse).
export type { Snapshot, DiskUsage };

export type SystemMetricsApi = {
  /**
   * A fresh reading of the host, or `null` if the calling module did not declare
   * `system-metrics:read`. On a supported host `null` means only that — the reads
   * themselves don't fail. Safe to poll; the helper caches nothing.
   */
  read(): Promise<Snapshot | null>;
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
  async read() {
    if (!granted(ctx, "system-metrics:read")) return null;
    return snapshot();
  },
});

export default api;
