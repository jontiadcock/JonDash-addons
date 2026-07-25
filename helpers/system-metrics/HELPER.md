# System metrics helper

**Status: SHIPPED. `0.0.1` on stable, `0.0.2-beta.1` on beta. Requires JonDash 1.5.2** (the release
that added `ctx.can()` enforcement, which this helper uses to refuse a module that didn't declare its
capability).

Reads read-only telemetry about the machine JonDash runs on — CPU, memory, disk usage, uptime and,
where the hardware exposes them, temperatures — and hands it to a module as plain numbers.

- **Helper id:** `system-metrics`
- **First consumer:** `host-vitals` (the "is my box OK" dashboard tile)
- **Grants:** one capability, `system-metrics:read`, shown in red on the consent screen. It is
  read-only — there is no verb here that changes anything on the host.

---

## The problem it solves

A module is sandboxed: no `node:os`, no `node:fs`, no `/proc`. So a module **cannot** find out how
much memory the server has, whether a disk is nearly full, or how long it's been up — the very things
a homelab dashboard most wants to show. Those reads are exactly what a module is forbidden.

This helper does the reads and returns structured numbers. The module renders them; it never touches
the host.

## What it grants — and what it can never do

| Capability | Shown to the admin as |
| ---------- | --------------------- |
| `system-metrics:read` | "See this server's CPU, memory, disk usage, uptime and temperature." |

**One capability, read-only, by design.** There is no `write`, no `run`, no "read this arbitrary
file". The helper returns *numbers it gathered*, never a path's contents and never a handle to the
host. A module holding this helper learns how full the disk is; it cannot learn what is on it. That
single restriction is why the consent line is honest.

## How a consumer uses it

Declare the helper and the capability, then import the one public entry point and call it. The
capability needs **`minAppVersion: "1.5.2-beta.1"`**.

In `module.ts`:

```ts
const mod: ModuleDefinition = {
  // …
  permissions: ["system-metrics:read"],
  helpers: [{ id: "system-metrics", minVersion: "0.0.1-beta.1" }],
  minAppVersion: "1.5.2-beta.1",
};
```

Anywhere server-side in the module (a widget, a page, an action):

```ts
import systemMetrics from "@/helpers/system-metrics/api";

export default async function Widget({ ctx }: ModuleWidgetProps) {
  const m = await systemMetrics(ctx).read();
  if (!m) return <p>Host metrics are not available.</p>; // capability not granted
  return <p>Memory {Math.round(m.memory.usedPct)}% of {gib(m.memory.totalBytes)} GiB</p>;
}
```

`@/helpers/system-metrics/api` is the **only** path a module may import from this helper; the verifier
refuses any deeper one, and permits even this one only for a module that declared
`helpers: ["system-metrics"]`.

The **types come from the same entry point** — import them alongside the default, never from an
internal path:

```ts
import systemMetrics, { type Snapshot, type DiskUsage } from "@/helpers/system-metrics/api";
```

### What `read()` returns

`read(opts?: CollectOptions): Promise<Snapshot | null>`.

- **`null`** — the calling module did not declare `system-metrics:read`. (On a supported host that is
  the only reason it is null; the reads themselves do not fail.)
- Otherwise a **`Snapshot`**, taken fresh at call time:

```ts
type Snapshot = {
  host:   { hostname: string; platform: string; arch: string; uptimeSec: number };
  cpu:    { model: string; cores: number; usedPct: number;
            load1: number | null; load5: number | null; load15: number | null;
            speedMhz?: number | null;   // 0.0.2
            perCore?: number[] };       // 0.0.2 — busy % per core, in core order
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
  disks:  { mount: string; totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number }[];
  temps:  { label: string; celsius: number }[];
  takenAt: string; // ISO-8601

  // Added in 0.0.2. Each is present only if its group was collected.
  swap?:      { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number } | null;
  diskIo?:    { device: string; readBytesPerSec: number; writeBytesPerSec: number }[];
  network?:   { name: string; addresses: string[]; mac: string | null }[];
  networkIo?: { name: string; rxBytesPerSec: number; txBytesPerSec: number }[];
  fans?:      { label: string; rpm: number }[];
  battery?:   { percent: number | null; status: string } | null;
};
```

Every `*Pct` is 0–100. Byte counts are whole bytes and rates are **bytes per second** — the helper
never formats, so the consumer chooses its own units. Call `read()` again for fresh numbers; the helper
holds no state and caches nothing, so it is safe to poll from a widget on a timer.

### Collecting only what you will show (0.0.2)

Some groups cost real time — anything rate-based has to sample, wait, and sample again. Pass `collect`
to gather only what you need:

```ts
const m = await systemMetrics(ctx).read({
  collect: ["cpu", "memory", "disks", "swap"],   // everything else is never sampled
});
```

```ts
type CollectOptions = {
  collect?: MetricGroup[];  // omit for all of them
  sampleMs?: number;        // rate window; clamped to 50–1000, default 120
};

type MetricGroup =
  | "cpu" | "cpuCores" | "memory" | "swap" | "disks" | "diskIo"
  | "network" | "networkIo" | "temps" | "fans" | "battery";
```

`ALL_GROUPS` is exported if you want the full list to build a settings screen from.

**A group left out is not gathered at all** — that is the difference between a metric being hidden and
a metric not being taken. It matters for a user who has switched something off deliberately.

**All the rate-based groups share one wait.** `cpu`, `cpuCores`, `diskIo` and `networkIo` take their
"before" readings together, sleep once, then take their "after" readings — so asking for all four costs
the same wall-clock as asking for one (~120ms). Ask for none of them and the call is effectively
instant.

**`cpu` is always in the result even if you leave it out**, because a snapshot without a CPU figure
would be strange. What changes is the cost and the meaning: collected, `usedPct` is a live sample;
not collected, it is the average since boot, which costs nothing. The other 0.0.1 fields behave the
same way — `disks` and `temps` come back as `[]` when not collected, so a 0.0.1-era consumer that
passes no options sees exactly what it always did.

### Fields that are empty on some hosts — expected, not an error

**Read this before building a UI on any of it: several groups are Linux-only.** The helper never
invents a number, so a consumer must handle each of these being absent.

| Group | Linux | Windows | macOS |
| ----- | ----- | ------- | ----- |
| `cpu`, `memory`, `disks`, `network`, `cpu.perCore`, `cpu.speedMhz` | ✅ | ✅ | ✅ |
| `cpu.load1/5/15` | ✅ | **`null`** | ✅ |
| `swap` | ✅ | **`null`** | `null` |
| `temps`, `fans` | ✅ (where sensors exist) | **`[]`** | `[]` |
| `diskIo`, `networkIo` | ✅ | **`[]`** | `[]` |
| `battery` | ✅ (where present) | **`null`** | `null` |

**Why Windows is thin:** everything above comes from `/proc` and `/sys`, which Windows has no
equivalent of. Matching it there needs WMI or performance counters — a spawned process on every
render, which is too slow for a widget — or a native dependency, which this helper deliberately
doesn't have. **Reporting nothing is the honest option**, and better than a plausible-looking zero.

- **`cpu.load1/5/15` are `null` on Windows.** Load average is a Unix concept; Node reports zeros
  there, and this helper turns those into `null` so a module can hide the row rather than show a fake
  `0.00`. `cpu.usedPct` is measured on every platform and is the number to lead with.
- **`disks` lists real mounted filesystems only** — pseudo-filesystems (proc, tmpfs, overlay, …) are
  skipped, so the list is what a person would call "my drives", not the kernel's view.
- **`diskIo` lists whole devices, not partitions** (`sda`, `nvme0n1`), since a partition's traffic is
  already counted in its parent. Loop, ram and device-mapper devices are skipped.
- **`fans` omits a fan reading 0 RPM** — a stopped or absent fan is noise, not information.
- **`network` omits loopback**, and `mac` is `null` where the interface has no real address.

## What you can rely on

| Guarantee | How it holds |
| --------- | ------------ |
| **Read-only.** No call changes anything on the host. | There is no write verb in the API at all. |
| **No secrets, ever.** JonDash's own keys/DB are never read or returned. | The helper reads sizes and counts, never file contents. |
| **A denied module gets `null`, not data.** | `read()` checks `ctx.can("system-metrics:read")` first. |
| **A missing sensor is empty, not a crash.** | Every group degrades to `[]`/`null`; a `read()` never throws for something a platform lacks. |
| **Fresh every call, no caching.** | Each `read()` samples live; safe to poll. |
| **A group you don't collect is never sampled.** | `collect` gates the reads themselves, not the output. |
| **Asking for more rate-based groups doesn't cost more time.** | They share one sampling window. |

## What it deliberately does not do

- **No history.** It returns *now*. A module that wants a trend records snapshots in its own store —
  keeping the helper stateless (no tables, no migrations) and its blast radius nil.
- **No process list, no per-process stats.** That is a different, larger capability with real privacy
  weight; if it is ever wanted it is a *different* helper, not a wider `read()`.
- **No arbitrary file or path reads.** The one thing that would turn "host stats" into "exfiltrate the
  database". Never added.
- **No writes, no control.** Restarting a service or clearing a cache is not telemetry. A control
  helper, if ever built, is separate and dangerous-by-default.

## First consumer

`host-vitals` — an admin-only dashboard tile leading with a verdict (all healthy / a disk is filling /
memory is tight), plus a page with every disk and any temperatures. It declares only
`system-metrics:read`.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.2-beta.1 | Adds swap, per-core CPU, CPU clock speed, network interfaces, network throughput, disk read/write rates, fan speeds and battery/UPS state. Adds `read({ collect })` so a group a user switched off is **never sampled**, not merely hidden — and all the rate-based groups share one sampling window, so asking for four costs what one used to. **Additive: nothing was removed or changed**, so a 0.0.1 consumer calling `read()` with no arguments behaves exactly as before. Most of the new groups are Linux-only; see the platform table. |
| 0.0.1 | First release. `read()` → a full snapshot: host, CPU (with per-platform load average), memory, mounted disks, best-effort temperatures. Read-only, stateless, dependency-free. |
