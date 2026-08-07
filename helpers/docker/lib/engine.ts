import http from "node:http";
import { platform } from "node:os";

/**
 * The only place that talks to the Docker engine.
 *
 * ⚠ The socket is root-equivalent — anything that can reach it can start a container mounting
 * the host filesystem as root. Two rules follow, and neither may be relaxed:
 *
 * 1. The path is fixed here, never supplied by a caller — a caller-chosen socket is a
 *    caller-chosen daemon, including one they just started themselves.
 * 2. Every request is built here from an allowed endpoint and a validated id — no module can
 *    name a path, a method or a body, leaving no shape for "just this once" to be smuggled in.
 */

/**
 * Where the engine listens. Windows named pipe, or the Unix socket.
 * REFS helpers/docker/api.ts
 */
export function socketPath(): string {
  return platform() === "win32" ? "\\\\.\\pipe\\docker_engine" : "/var/run/docker.sock";
}

/**
 * Container ids as the engine gives them: hex, or a name. Bounded and anchored so an id can
 * never traverse into another endpoint — `abc/../../images/prune` must not be expressible.
 */
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** REFS helpers/docker/api.ts · helpers/docker/tests/shape.test.ts */
export function isValidId(id: string): boolean {
  return ID.test(id);
}

export type EngineError = { reason: "not-running" | "no-access" | "timeout" | "failed"; detail: string };

/** Reads: long enough for a busy daemon, short enough that a page cannot hang on it. */
const TIMEOUT_MS = 8000;
/** `stats` samples twice a second apart, so it needs its own longer bound. */
const SLOW_TIMEOUT_MS = 15_000;
/**
 * Actions get far longer, because **`docker stop` is slow by design**: the engine sends
 * SIGTERM, waits a grace period — 10 seconds by default — and only then SIGKILLs. A restart
 * is that plus a start. The first live test reported "the Docker engine did not respond in
 * time" on almost every stop, because an 8s bound expired while Docker was still politely
 * waiting for the container. The containers had stopped correctly; only the report was wrong.
 *
 * 60s covers the default grace plus a slow image. A container with a longer configured
 * `stop_grace_period` can still exceed it — hence the wording of the timeout message, which
 * says the engine was still working rather than that the action failed.
 */
const ACTION_TIMEOUT_MS = 60_000;

type Result<T> = { ok: true; value: T } | { ok: false; error: EngineError };

/**
 * One request to the engine. Private on purpose — everything above builds its own path from a
 * fixed template, so nothing outside this file ever chooses one.
 */
type Speed = "read" | "slow" | "action";
const timeoutFor = (s: Speed) => (s === "action" ? ACTION_TIMEOUT_MS : s === "slow" ? SLOW_TIMEOUT_MS : TIMEOUT_MS);

function call(path: string, method: "GET" | "POST", speed: Speed = "read"): Promise<Result<{ status: number; body: Buffer }>> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: socketPath(), path, method, timeout: timeoutFor(speed) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ ok: true, value: { status: res.statusCode ?? 0, body: Buffer.concat(chunks) } }));
      },
    );

    req.on("timeout", () => {
      req.destroy();
      // Worded carefully: giving up on waiting isn't the same as the action failing — a slow
      // stop usually does complete a moment later, and a false "failed" is worse than a wait.
      resolve({
        ok: false,
        error: {
          reason: "timeout",
          detail:
            speed === "action"
              ? "Docker is still working on that — it is taking longer than expected. Refresh in a moment to see the result."
              : "The Docker engine did not respond in time.",
        },
      });
    });

    req.on("error", (e: NodeJS.ErrnoException) => {
      // These three are worth telling apart, because the fix differs completely: install or
      // start Docker, versus add your account to docker-users, versus something is broken.
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        resolve({ ok: false, error: { reason: "not-running", detail: "The Docker engine is not running." } });
      } else if (e.code === "EACCES" || e.code === "EPERM") {
        resolve({
          ok: false,
          error: { reason: "no-access", detail: "JonDash is not allowed to talk to the Docker engine." },
        });
      } else {
        resolve({ ok: false, error: { reason: "failed", detail: e.message } });
      }
    });

    req.end();
  });
}

async function json<T>(path: string, speed: Speed = "read"): Promise<Result<T>> {
  const r = await call(path, "GET", speed);
  if (!r.ok) return r;
  if (r.value.status === 404) return { ok: false, error: { reason: "failed", detail: "Not found." } };
  if (r.value.status >= 400) {
    return { ok: false, error: { reason: "failed", detail: engineMessage(r.value.body) } };
  }
  try {
    return { ok: true, value: JSON.parse(r.value.body.toString("utf8")) as T };
  } catch {
    return { ok: false, error: { reason: "failed", detail: "The engine sent something unreadable." } };
  }
}

/** The engine puts its own explanation in `{"message": "..."}`. Worth surfacing verbatim —
 *  "container already started" is more useful than anything we would invent. */
function engineMessage(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: string };
    return parsed.message ?? body.toString("utf8").slice(0, 200);
  } catch {
    return body.toString("utf8").slice(0, 200) || "The engine refused it.";
  }
}

/* ------------------------------------------------------------------ operations */

export type RawVersion = { Version: string; ApiVersion: string };

/** REFS helpers/docker/api.ts */
export async function version(): Promise<Result<RawVersion>> {
  return json<RawVersion>("/version");
}

/** REFS helpers/docker/lib/shape.ts · helpers/docker/tests/shape.test.ts */
export type RawContainer = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Labels: Record<string, string>;
  Ports: { PrivatePort: number; PublicPort?: number; Type: string }[];
};

/** REFS helpers/docker/api.ts */
export async function containers(): Promise<Result<RawContainer[]>> {
  return json<RawContainer[]>("/containers/json?all=1");
}

/** REFS helpers/docker/lib/shape.ts · helpers/docker/tests/shape.test.ts */
export type RawStats = {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number };
};

/** REFS helpers/docker/api.ts */
export async function stats(id: string): Promise<Result<RawStats>> {
  if (!isValidId(id)) return { ok: false, error: { reason: "failed", detail: "Bad container id." } };
  return json<RawStats>(`/containers/${id}/stats?stream=0&one-shot=false`, "slow");
}

/**
 * Logs, demultiplexed.
 *
 * A non-TTY container's log stream is framed: an 8-byte header per chunk, where byte 0 is the
 * stream and bytes 4-7 are a big-endian length. Returning it raw shows control bytes in the
 * middle of lines — it looks like corruption and gets reported as one.
 * REFS helpers/docker/api.ts
 */
export async function logs(id: string, tail: number): Promise<Result<string>> {
  if (!isValidId(id)) return { ok: false, error: { reason: "failed", detail: "Bad container id." } };
  const n = Math.min(2000, Math.max(1, Math.trunc(tail)));
  const r = await call(`/containers/${id}/logs?stdout=1&stderr=1&timestamps=0&tail=${n}`, "GET");
  if (!r.ok) return r;
  if (r.value.status >= 400) return { ok: false, error: { reason: "failed", detail: engineMessage(r.value.body) } };
  return { ok: true, value: demux(r.value.body) };
}

/** REFS helpers/docker/tests/shape.test.ts */
export function demux(body: Buffer): string {
  // A TTY container's stream has no framing at all, so a buffer that doesn't start with a
  // plausible header is passed through rather than mangled.
  if (body.length < 8 || body[0] > 2 || body[1] !== 0 || body[2] !== 0 || body[3] !== 0) {
    return body.toString("utf8");
  }
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= body.length) {
    const len = body.readUInt32BE(i + 4);
    const end = i + 8 + len;
    if (len < 0 || end > body.length) break; // truncated frame — keep what we have
    out.push(body.subarray(i + 8, end));
    i = end;
  }
  return out.length > 0 ? Buffer.concat(out).toString("utf8") : body.toString("utf8");
}

/** REFS helpers/docker/api.ts */
export type Verb = "start" | "stop" | "restart" | "pause" | "unpause";

/** The complete set of things that may be done to a container. There is no `exec`, no
 *  `create`, no `remove`, and no image or volume endpoint — those calls do not exist here. */
/** REFS helpers/docker/api.ts · helpers/docker/tests/shape.test.ts */
export const VERBS: Verb[] = ["start", "stop", "restart", "pause", "unpause"];

/** REFS helpers/docker/api.ts */
export async function act(id: string, verb: Verb): Promise<Result<true>> {
  if (!isValidId(id)) return { ok: false, error: { reason: "failed", detail: "Bad container id." } };
  if (!VERBS.includes(verb)) return { ok: false, error: { reason: "failed", detail: "Unknown action." } };

  const r = await call(`/containers/${id}/${verb}`, "POST", "action");
  if (!r.ok) return r;
  // 204 = done, 304 = already in that state. Both are success as far as a person is concerned:
  // pressing Stop on a stopped container should not read as an error.
  if (r.value.status === 204 || r.value.status === 304) return { ok: true, value: true };
  return { ok: false, error: { reason: "failed", detail: engineMessage(r.value.body) } };
}
