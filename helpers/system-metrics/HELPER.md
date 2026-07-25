# System metrics helper

**Status: building — `0.0.1-beta.1`, beta channel. Requires JonDash 1.5.2** (the release that added
`ctx.can()` enforcement, which this helper uses to refuse a module that didn't declare its
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

`read(): Promise<Snapshot | null>`.

- **`null`** — the calling module did not declare `system-metrics:read`. (On a supported host that is
  the only reason it is null; the reads themselves do not fail.)
- Otherwise a **`Snapshot`**, taken fresh at call time:

```ts
type Snapshot = {
  host:   { hostname: string; platform: string; arch: string; uptimeSec: number };
  cpu:    { model: string; cores: number; usedPct: number;
            load1: number | null; load5: number | null; load15: number | null };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
  disks:  { mount: string; totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number }[];
  temps:  { label: string; celsius: number }[];
  takenAt: string; // ISO-8601
};
```

Every `*Pct` is 0–100. Byte counts are whole bytes. Call `read()` again for fresh numbers — the helper
holds no state and caches nothing, so it is safe to poll from a widget on a timer.

### Fields that are empty on some hosts — expected, not an error

- **`cpu.load1/5/15` are `null` on Windows.** Load average is a Unix concept; Node reports zeros on
  Windows, and this helper turns those into `null` so a module can hide the row rather than show a
  fake `0.00`. `cpu.usedPct` is measured on every platform and is the number to lead with.
- **`temps` is `[]` when the host exposes no sensors** — always on Windows for now, and on Linux
  hardware/VMs without thermal zones. Treat temperatures as a bonus, never a given.
- **`disks` lists real mounted filesystems only** — pseudo-filesystems (proc, tmpfs, overlay, …) are
  skipped, so the list is what a person would call "my drives", not the kernel's view.

## What you can rely on

| Guarantee | How it holds |
| --------- | ------------ |
| **Read-only.** No call changes anything on the host. | There is no write verb in the API at all. |
| **No secrets, ever.** JonDash's own keys/DB are never read or returned. | The helper reads sizes and counts, never file contents. |
| **A denied module gets `null`, not data.** | `read()` checks `ctx.can("system-metrics:read")` first. |
| **A missing sensor is empty, not a crash.** | Temps/load degrade to `[]`/`null`; a `read()` never throws for a field a platform lacks. |
| **Fresh every call, no caching.** | Each `read()` samples live; safe to poll. |

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
| 0.0.1-beta.1 | First release. `read()` → a full snapshot: host, CPU (with per-platform load average), memory, mounted disks, best-effort temperatures. Read-only, stateless, dependency-free. |
