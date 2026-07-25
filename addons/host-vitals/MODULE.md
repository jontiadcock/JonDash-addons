# Host vitals

Shows how the server JonDash runs on is doing — CPU load, memory, how full each disk is, uptime and,
where the hardware reports them, temperatures. A dashboard tile for the glance, a page for the detail.

- **Module id:** `host-vitals`
- **Version:** `0.0.1-beta.1`
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

## Settings and data

**None.** Every render reads live from the helper, so there is nothing to configure and nothing stored
— no settings, no tables, no migrations. Uninstalling the module leaves nothing behind, and (because
the helper is stateless too) removing the last module that uses `system-metrics` leaves no data either.

## Fields that are empty on some hosts

Not bugs — the module hides them rather than showing a fake value:

- **Load average** is Unix-only; on Windows the tile shows CPU % without it.
- **Temperatures** need hardware sensors; on Windows, and on VMs without thermal zones, the page says
  so plainly rather than inventing a reading.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.1-beta.1 | First release. Verdict-led dashboard tile and a detail page: CPU, memory, per-disk usage, uptime, and best-effort temperatures. Read-only, stores nothing. |
