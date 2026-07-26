# Host vitals

Shows how the server JonDash runs on is doing — CPU load, memory, how full each disk is, uptime and,
where the hardware reports them, temperatures. A dashboard tile for the glance, a page for the detail.

- **Module id:** `host-vitals`
- **Version:** see [`addons.json`](../../addons.json) on this branch — stable on `main`, beta on `beta`. Deliberately not restated here: it drifts the moment a version is published, and both docs that carried it were stale.
- **Minimum JonDash version:** `1.5.2-beta.1` — the **pre-release**, deliberately. Semver ranks it
  below `1.5.2`, so a bare `"1.5.2"` would be refused on every 1.5.2 beta. 1.5.2 is the release whose
  `ctx.can()` the `system-metrics` helper uses to enforce its capability.
- **Permissions requested:** `system-metrics:read` — one line, read-only.
- **Helper required:** `system-metrics` (pinned to at least `0.0.1-beta.1`) — installed automatically
  with the module. It does the privileged host reads; this module only renders them.
- **Visibility:** admins only (`adminOnly: true`) — hostname and disk layout are admin-level.

---

## What it shows

- **A dashboard tile** leading with a verdict — *All healthy*, *Getting busy*, or the specific problem
  (*C:\ is nearly full — 94%*, *Memory is tight*). Deliberately pessimistic: the thing that needs
  attention is what a glance should surface, not a count. Below it: CPU load, a memory bar, the busiest
  disks and uptime.
- **A page** at `/m/host-vitals` with the full picture — every disk, the load average where the
  platform reports one, and any temperature sensors.

## How it works, and what it can touch

A module is sandboxed and **cannot** read `node:os`, the filesystem or `/proc` — so it cannot find out
the server's memory or disk usage on its own. The **`system-metrics` helper** does those reads and
returns plain numbers; this module renders them.

That helper is **read-only** — it reports sizes, counts and temperatures and has no verb that changes
anything on the host, and none that returns a file's contents. So this module can tell you a disk is
94% full; it cannot tell you what is on it, and it cannot touch JonDash's own database or keys.

## What you can switch off

Each optional vital has a switch in **Admin → Addons → Host vitals**:

| Setting | Default | Notes |
| ------- | ------- | ----- |
| Swap / page file | on | Linux only |
| Per-core CPU | off | A row per core — useful on a small box, noisy on a big one |
| Network interfaces | on | Shows this machine's IP and MAC addresses |
| Network throughput | on | Linux only |
| Disk read/write rates | off | Linux only |
| Temperatures | on | Linux only, where sensors exist |
| Fan speeds | off | Linux only, where sensors exist |
| Battery / UPS | off | Linux only, where a battery exists |

**Switching one off means it is not gathered — not merely hidden.** The module hands the helper a list
of exactly what to collect, built from these switches, so a reading you turned off is never taken. That
matters for the ones that cost time to sample (CPU, network and disk rates) and for anyone who simply
doesn't want their addresses read.

**CPU, memory and disks have no switch.** They cost nothing to read and they are the point of the
module; a vitals tile that can hide all three is an empty card.

## Settings and data

The switches above are the only stored state — plain module settings, no tables and no migrations. It
keeps **no history**: every render reads live. Uninstalling leaves nothing behind, and because the
helper is stateless too, removing the last module that uses `system-metrics` leaves no data either.

## Sizes: GB and TB

Sizes are shown with **binary maths and GB/TB labels** — the same convention Windows Explorer and
`df -h` use — so JonDash agrees with the tools you would check it against. One consequence worth
knowing: a drive sold as "2 TB" reads as **1.8 TB** here, exactly as it does in Explorer, because
manufacturers count in powers of 1000 and operating systems count in powers of 1024. Memory is
unaffected: RAM genuinely is binary, so "32 GB" is precisely right.

## Readings that are empty on some hosts

Not bugs — the module says so plainly rather than showing a fake value. **Most of the newer readings
come from Linux's `/proc` and `/sys`, which Windows and macOS have no equivalent of:**

| Reading | Linux | Windows / macOS |
| ------- | ----- | --------------- |
| CPU, memory, disks, network interfaces, per-core, clock speed | ✅ | ✅ |
| Load average | ✅ | hidden |
| Swap, disk rates, network throughput, temperatures, fans, battery | ✅ | "not available on this platform" |

Matching them on Windows would need a spawned process on every render or a native dependency; the
helper has neither, and reporting nothing is more honest than a plausible-looking zero.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.2-beta.1 | Adds swap, per-core CPU, clock speed, network interfaces and throughput, disk read/write rates, fan speeds and battery — each with its own switch, and switching one off means it is not gathered rather than just hidden. Sizes now read GB/TB instead of GiB/TiB. The tile also warns when the host is swapping heavily or running low on battery. Several of the new readings are Linux-only and say so on the page. |
| 0.0.1 | First release. Verdict-led dashboard tile and a detail page: CPU, memory, per-disk usage, uptime, and best-effort temperatures. Read-only, stores nothing. |
