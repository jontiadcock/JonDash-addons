# Host vitals

Shows how the server JonDash runs on is doing — CPU load, memory, how full each disk is, uptime and,
where the hardware reports them, temperatures. A dashboard tile for the glance, a page for the detail.

- **Module id:** `host-vitals`
- **Version:** see [`addons.json`](../../addons.json) on this branch — stable on `main`, beta on `beta`. Deliberately not restated here: it drifts the moment a version is published, and both docs that carried it were stale.
- **Minimum JonDash version:** `1.8.0-beta.14` — the **pre-release**, deliberately. Semver ranks it
  below `1.8.0`, so a bare `"1.8.0"` would be refused on every 1.8.0 beta. `beta.14` is the exact build
  in which the dashboard frame became a CSS `@container`; on anything older the widget's container
  queries never match, so its detail list could never appear. (The older floor of `1.5.2-beta.1` — the
  release whose `ctx.can()` the `system-metrics` helper uses — is still met, just no longer the
  binding one.)
- **Permissions requested:** `system-metrics:read` — one line, read-only.
- **Helper required:** `system-metrics` (pinned to at least `0.0.1-beta.1`) — installed automatically
  with the module. It does the privileged host reads; this module only renders them.
- **Visibility:** admins only (`adminOnly: true`) — hostname and disk layout are admin-level.

---

## What it shows

- **A dashboard tile** leading with a verdict — *All healthy*, *Getting busy*, or the specific problem
  (*C:\ is nearly full — 94%*, *Memory is tight*). Deliberately pessimistic: the thing that needs
  attention is what a glance should surface, not a count. Below it: CPU, memory, every disk **fullest
  first**, swap, network, battery and uptime — each row shading itself by how full it is.

  **It resizes properly.** Since JonDash 1.8.0 you can make a widget anything from 1×1 to full width,
  and the frame clips rather than scrolls, so this tile shows only what actually fits: at 1×1 just the
  verdict, and from two units up the detail list, which flows into extra columns when the tile is wide
  and short. Nothing spills, at any size. One honest limit — the frame lets a widget measure its width
  but not its height, so a tile only *one* unit wide shows the verdict alone even if you make it very
  tall. Give it two units of width and everything appears.
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
| 0.0.6-beta.2 | **Fixes the layout mechanism `beta.1` shipped.** The detail list used flex column-wrap, which starts a new column whenever it runs out of *height* with no regard for remaining *width* — so on some sizes the columns ran off the side of the card and text was sliced at the edge. It is now CSS multi-column, which derives the column count *from* the width, so columns always fit and anything that doesn’t is cleanly out of sight rather than half-cut. `break-inside-avoid` stops a row splitting across a column boundary. Re-verified across 14 sizes and shapes: nothing is cut at any of them. |
| 0.0.6-beta.1 | **The tile now fits any size the user gives it (JonDash 1.8.0 B5/B6).** It had the worst version of the problem in the whole add-on set — up to ten label/value rows, three disks hard-coded with `.slice(0, 3)`, and fixed padding — so at 1×1 almost all of it was invisible. Now: core's two container thresholds decide *what kind* of content appears, the detail list uses `flex-col flex-wrap` so rows flow into extra columns when the tile is wide and short (the frame reports width but never height, so this adapts without a query), and rows are in priority order with disks sorted **fullest first**, because if anything is clipped it should be the least urgent thing. The usage bars moved from a separate line into a shading behind each row, which is what makes every row exactly one line tall — the old 46px memory block was the one thing that still spilled out of a 6×1 tile. Verified live at 1×1 through 9×9 plus 6×1, 12×1 and 1×6: no row falls outside the card at any size. `minAppVersion` rises to `1.8.0-beta.14`. |
| 0.0.2-beta.1 | Adds swap, per-core CPU, clock speed, network interfaces and throughput, disk read/write rates, fan speeds and battery — each with its own switch, and switching one off means it is not gathered rather than just hidden. Sizes now read GB/TB instead of GiB/TiB. The tile also warns when the host is swapping heavily or running low on battery. Several of the new readings are Linux-only and say so on the page. |
| 0.0.1 | First release. Verdict-led dashboard tile and a detail page: CPU, memory, per-disk usage, uptime, and best-effort temperatures. Read-only, stores nothing. |
