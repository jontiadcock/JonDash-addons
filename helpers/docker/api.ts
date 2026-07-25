import type { DeclaredPermission, ModuleContext } from "@/lib/modules/types";
import type { HelperApiFor } from "@/lib/helpers/types";
import { act, containers, isValidId, logs as rawLogs, socketPath, stats as rawStats, version, VERBS, type Verb } from "./lib/engine";
import { toContainer, toLines, toStats, type Container, type ContainerStats } from "./lib/shape";

/**
 * The entire surface a module may reach.
 *
 * **The engine socket is root-equivalent** — anything that can reach it can start a container
 * mounting the host filesystem as root. So this exposes operations, never the socket, and the
 * two rules from HELPER.md hold here:
 *
 * 1. **No pass-through.** A module never names an endpoint, a path, a method or a body. It
 *    names a container id and a verb from a fixed list; every request is built inside
 *    `engine.ts`.
 * 2. **No `exec`, ever.** Running a command inside a container is arbitrary code execution,
 *    and in most real setups it is as root on the host. The call does not exist and must not
 *    be added — if a console is ever wanted it is a different capability, declared in red, and
 *    a deliberate decision rather than a convenience.
 *
 * Also absent: creating or removing containers, and every image and volume operation.
 */

export type { Container, ContainerStats, ContainerState } from "./lib/shape";
export type { Verb } from "./lib/engine";
export { VERBS };

export type EngineStatus =
  | { ok: true; version: string; apiVersion: string; containers: number; socket: string }
  | {
      ok: false;
      /** `not-running` and `no-access` are separated because the fix is completely different:
       *  start Docker, versus add this account to `docker-users`. */
      reason: "not-running" | "no-access" | "timeout" | "failed";
      detail: string;
      socket: string;
    };

export type ActionResult = { ok: true } | { ok: false; reason: string };

export type DockerApi = {
  /** Is the engine reachable? **Needs no capability** — a module must be able to say
   *  "Docker isn't running" without having been granted anything. Never throws. */
  status(): Promise<EngineStatus>;
  /** Every container, running or not. Cheap. Needs `docker:read`. */
  list(): Promise<Container[]>;
  /** Live CPU and memory. SLOW — about a second. Needs `docker:read`. */
  stats(ids: string[]): Promise<Record<string, ContainerStats | null>>;
  /** Recent log lines, newest last. Needs `docker:logs`. */
  logs(id: string, opts?: { tail?: number }): Promise<string[]>;
  /** Start, stop, restart, pause or unpause. Needs `docker:manage`. */
  act(id: string, verb: Verb): Promise<ActionResult>;
};

function granted(ctx: ModuleContext, permission: DeclaredPermission): boolean {
  if (typeof ctx.can !== "function") return true;
  return ctx.can(permission);
}

/** How many containers we will sample at once. `stats` takes ~1s each regardless of count
 *  because Docker samples twice; unbounded parallelism against the daemon is rude. */
const STATS_CONCURRENCY = 8;

const api: HelperApiFor<DockerApi> = (ctx: ModuleContext) => ({
  async status() {
    const socket = socketPath();
    const [v, c] = await Promise.all([version(), containers()]);
    if (!v.ok) return { ok: false, reason: v.error.reason, detail: v.error.detail, socket };
    return {
      ok: true,
      version: v.value.Version,
      apiVersion: v.value.ApiVersion,
      containers: c.ok ? c.value.length : 0,
      socket,
    };
  },

  async list() {
    // Empty answer, never data, when the capability is missing — and the same when the engine
    // is down, so a module renders "nothing here" rather than crashing on a machine without
    // Docker.
    if (!granted(ctx, "docker:read")) return [];
    const r = await containers();
    return r.ok ? r.value.map(toContainer) : [];
  },

  async stats(ids: string[]) {
    const out: Record<string, ContainerStats | null> = {};
    if (!granted(ctx, "docker:read")) return out;

    const wanted = ids.filter(isValidId).slice(0, 100);
    for (let i = 0; i < wanted.length; i += STATS_CONCURRENCY) {
      const batch = wanted.slice(i, i + STATS_CONCURRENCY);
      const results = await Promise.all(batch.map(async (id) => [id, await rawStats(id)] as const));
      for (const [id, r] of results) out[id] = r.ok ? toStats(r.value) : null;
    }
    return out;
  },

  async logs(id: string, opts?: { tail?: number }) {
    // Logs are their own capability because of what is IN them: connection strings, tokens,
    // personal data. Seeing that a container is running is not the same as reading what it
    // printed, and they should not share a consent line.
    if (!granted(ctx, "docker:logs")) return [];
    const tail = Math.min(2000, Math.max(1, Math.trunc(opts?.tail ?? 200)));
    const r = await rawLogs(id, tail);
    return r.ok ? toLines(r.value, tail) : [];
  },

  async act(id: string, verb: Verb) {
    if (!granted(ctx, "docker:manage")) {
      return { ok: false, reason: "This module has not been granted permission to control containers." };
    }
    if (!VERBS.includes(verb)) return { ok: false, reason: "That is not an action this helper performs." };

    const r = await act(id, verb);
    if (r.ok) {
      await ctx.audit?.("docker.act", `${verb} ${id.slice(0, 12)}`);
      return { ok: true };
    }
    return { ok: false, reason: r.error.detail };
  },
});

export default api;
