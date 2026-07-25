# Docker helper

**Status: SPEC — not built.** Awaiting the owner's approval of this document, and a decision on how it
gets tested (see *Testing* at the bottom — there is no Docker engine on the development machine).

Lets a module see and control the containers on this server's Docker engine, so a module can be a
container dashboard without JonDash ever handing a module the Docker socket.

- **Helper id:** `docker`
- **First consumer:** `docker-manager` — "Hyper-V, but for Docker": a grid of container tiles with
  state, live CPU/memory, start/stop/restart and a log view.
- **Requires:** JonDash **1.5.2-beta.1** (for `ctx.can()` enforcement).
- **Grants:** three capabilities, each its own line on the consent screen, all shown in red.

---

## The one fact that shapes this entire design

> **Access to the Docker socket is equivalent to root on the host.** Anyone who can talk to it can
> start a container that mounts `/` and reads or writes anything — including `.data/secrets.json`.

So this helper's job is not "expose Docker to modules". It is to expose a **small, fixed set of
operations** and never the socket itself. Two rules follow, and neither may ever be relaxed:

1. **No pass-through.** There is no call that takes an endpoint, a path, a query or a request body
   from the module. A module names an operation and a container; the helper builds every request. If a
   `request(path, body)` call ever appears here, this helper has become a root shell with extra steps.
2. **No `exec`, ever.** Running a command inside a container is arbitrary code execution, and in most
   setups it is root. It is excluded permanently, not "until v2".

## Capabilities

| Capability | Shown to the admin as |
| ---------- | --------------------- |
| `docker:read` | "See the containers on this server — their names, images, state and resource use" |
| `docker:logs` | "Read container logs, which often contain passwords, keys and personal data" |
| `docker:manage` | "Start, stop and restart containers on this server" |

**Three, not two — and logs is the one people would get wrong.** Seeing *that* a container is running
is a mild disclosure. Reading everything it has ever printed is not: application logs routinely contain
connection strings, API keys dumped at startup, tokens in URLs, and customer data. A module holding
`docker:logs` **and** `network:outbound` could ship all of that off the machine. Splitting it out means
an admin gets to say yes to a container dashboard without saying yes to that, and the label says what
is actually at stake rather than "read logs".

`docker:manage` deliberately covers **only** start/stop/restart. It is not a general write capability
and must not grow into one — see *What it deliberately does not do*.

## How a consumer uses it

```ts
import docker, { type Container } from "@/helpers/docker/api";

const d = docker(ctx);
const containers = await d.list();          // needs docker:read
await d.restart(containers[0].id);          // needs docker:manage
const tail = await d.logs(id, { tail: 200 }); // needs docker:logs
```

Declare all three only if you use all three:

```ts
permissions: ["docker:read", "docker:logs", "docker:manage"],
helpers: [{ id: "docker", minVersion: "0.0.1-beta.1" }],
minAppVersion: "1.5.2-beta.1",
```

Types come from the same entry point — never from an internal path:

```ts
import docker, { type Container, type ContainerStats, type EngineStatus } from "@/helpers/docker/api";
```

## The API

```ts
type DockerApi = {
  /** Is the engine reachable, and what is it? Never throws — this is the "is Docker there?" call. */
  status(): Promise<EngineStatus>;

  /** Every container, running or not. Cheap. Needs docker:read. */
  list(): Promise<Container[]>;

  /** Live CPU and memory for specific containers. SLOW — see the note below. Needs docker:read. */
  stats(ids: string[]): Promise<Record<string, ContainerStats | null>>;

  /** Recent log lines, newest last. Needs docker:logs. */
  logs(id: string, opts?: { tail?: number }): Promise<string[]>;

  /** Needs docker:manage. Each resolves when the engine has accepted the change. */
  start(id: string): Promise<ActionResult>;
  stop(id: string): Promise<ActionResult>;
  restart(id: string): Promise<ActionResult>;
};

type EngineStatus =
  | { ok: true; version: string; containers: number; socket: string }
  | { ok: false; reason: string; socket: string };

type Container = {
  id: string;              // full id; use it for every other call
  name: string;            // leading "/" stripped
  image: string;
  state: "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "removing";
  status: string;          // the engine's own phrasing, e.g. "Up 3 days (healthy)"
  health: "healthy" | "unhealthy" | "starting" | "none";
  createdAt: string;       // ISO-8601
  ports: { private: number; public: number | null; protocol: string }[];
  /** From Compose labels, when the container was started by Compose. */
  project: string | null;
  service: string | null;
};

type ContainerStats = {
  cpuPct: number;          // 0–100 across all cores
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPct: number;
};

type ActionResult = { ok: true } | { ok: false; reason: string };
```

**A call whose capability was not granted returns the empty answer, never data** — `list()` returns
`[]`, `logs()` returns `[]`, an action returns `{ ok: false, reason }` naming the permission to declare.
`status()` needs no capability: a module must be able to say "Docker isn't running" without being
granted anything.

### `stats()` is slow, and the module must treat it that way

Docker computes CPU percentage by sampling twice about a second apart. **A `stats()` call therefore
takes roughly a second, however many containers you ask about** (they are fetched in parallel, with a
cap). It is fine on a page the admin opened; it is **not** fine on every dashboard render.

`list()` is the cheap call and is what a grid should be built on. Ask for `stats()` deliberately.

## What you can rely on

| Guarantee | How it holds |
| --------- | ------------ |
| **No pass-through.** A module can never name an endpoint, path or body. | The API takes ids and options only; every request is built here. |
| **Container ids are validated before use.** | Each id must match `/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/` — so an id can never traverse into another endpoint. |
| **No `exec`, no container creation, no image or volume operations.** | Those calls do not exist. |
| **A denied capability yields nothing, not partial data.** | Each call checks `ctx.can()` first and returns the empty answer. |
| **An absent engine is a status, not a crash.** | `status()` returns `{ ok: false, reason }`; every other call degrades to empty. |
| **Every action is audited** under the calling module's id, with the container name. | `ctx.audit` on each start/stop/restart. |

## What it deliberately does not do

- **No `exec` into a container.** Permanent. It is remote code execution, usually as root.
- **No creating, removing or renaming containers**, no `docker run`. A dashboard that can delete the
  thing it is monitoring is a different, much more dangerous product.
- **No image operations** — no pull, build, tag or prune. Pulling is arbitrary code fetched from the
  internet and then run.
- **No volume or network operations.** Deleting a volume destroys data with no undo.
- **No Compose up/down.** It reads Compose *labels* to group containers; it does not drive Compose.
- **No arbitrary endpoint access**, now or ever. See rule 1 at the top.
- **No writing to a container's stdin.**

If a future consumer genuinely needs one of these, it is a **new capability with its own consent
line**, argued on its own merits — not a quiet widening of `docker:manage`.

## Connecting to the engine

Default socket, by platform:

| Platform | Path |
| -------- | ---- |
| Linux / macOS | `/var/run/docker.sock` |
| Windows | `\\.\pipe\docker_engine` |

Overridable with the standard **`DOCKER_HOST`** environment variable for a non-default socket path
(`unix:///…`). **`tcp://` is deliberately not supported**: an unencrypted TCP Docker socket is a
well-known way to hand the host to the network, and a helper that quietly enabled it would be
undoing the admin's own firewall.

No configuration is stored — the helper has no tables and no migrations, so there is nothing to
persist and nothing to leak.

## Testing — the open question

**There is no Docker engine on the development machine** (no CLI, no named pipe, engine not
responding), so the connected-engine path cannot be exercised the way `system-metrics` was. What can
be proven without one:

- The **absent-engine path**, genuinely — that is the machine's real state, and it is the first thing
  a user with a broken Docker setup will hit.
- **Capability enforcement**, id validation, URL construction and response parsing, against a **fixture
  engine**: a local HTTP server replaying real Docker Engine API responses. This exercises every line
  of the client except the socket hop itself.
- Typecheck, lint, the installer verifier, and the consent screen.

What cannot: that the request shapes match a *real* engine's, and that the parsing survives real-world
variety. **Both need a live daemon**, and that gap must not be papered over — a helper this privileged
should not claim more than it has demonstrated.

## Version history

| Version | Notes |
| ------- | ----- |
| — | Spec only; nothing published. |
