# Service control

Start, stop and restart the services an administrator has approved — a Windows service, a systemd
unit — from the dashboard, without opening a terminal.

- **Module id:** `service-control`
- **Version:** see [`addons.json`](../../addons.json) on this branch — stable on `main`, beta on
  `beta`. Deliberately not restated here; a version in prose goes stale the moment one is published.
- **Minimum JonDash version:** stated in `module.ts` and the manifest, and it is always the
  **pre-release** form. Semver ranks a pre-release below its release, so a bare `"1.7.2"` would be
  refused on every 1.7.2 beta — i.e. by exactly the people on the beta channel.
- **Permissions requested:** `host-services:read`, `host-services:control`. Both render red on the
  consent screen, and that is the right colour: this module can stop services on the machine JonDash
  runs on.
- **Helper required:** `host-services`, installed automatically with the module.
- **Visibility:** admins only (`adminOnly: true`) — which services exist, and the power to stop them,
  is admin-level information.

---

## What it does

- **A dashboard tile** listing the approved services with their live state, and buttons for the ones
  approved for control.
- **A page** at `/m/service-control` with the same list plus the explanations — why a service has no
  buttons, what a pending request means, and what the machine can actually do.

## What it cannot do, by construction

This module touches no service itself; it cannot. Every read and every action goes through the
`host-services` helper, and the helper's module-facing API has no mutator at all.

- **It cannot name a service that is not on the allowlist.** `list()` returns approved entries and
  `request()` takes an *id from that list*. An unknown id and a read-only one return the identical
  refusal, so the list cannot be probed by trying ids.
- **It cannot add itself to that list.** Approving a service happens in JonDash's own UI, under
  Admin → Addons → Shared capabilities, where `ctx.user` comes from the session and no module is in the path.
- **It cannot discover what services exist.** There is no enumerate call on the helper's API.
- **It cannot run a command.** Three verbs against a list; this is not a shell.

### Why the editor is not in this module

It was, for one release, and that was the defect. The module supplied the service name being
approved — so it could display "Add Plex" and submit `sshd`, and the Windows permission prompt names
the JonDash binary rather than the service, so nothing on screen caught the substitution. **The thing
being bounded could edit its own boundary.**

That is now HELPERS-DESIGN rule 8, stated generally: a helper's module-facing API carries read and
request, never add, remove or approve.

## Asking for a service

A module may *suggest* one. `suggest(name, reason)` records a request and does nothing else — an
administrator sees it under Admin → Addons → Shared capabilities and decides. Declines are remembered, because a
module that re-asks after every refusal trains someone to click yes without reading.

## Two capabilities, not one

`host-services:read` and `host-services:control` are separate so that seeing a service's state never
requires the power to stop it. Each has its own approved list: a service can be approved read-only,
in which case it appears here with its state and no buttons.

An administrator may also allow "see every service", which widens what this module can *see* to
everything on the machine — the page says so when that is on. It never widens what it can control;
everything outside the approved list comes back marked uncontrollable.

## Requests and unattended actions

By default an action raises a request an administrator approves. Per service, they may instead allow
it to run **without asking** — automation is the point (a health check restarting a hung service at
3am cannot wait for a person) but it is never a default, and never something this module can set.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.6-beta.2 | **Fills the card instead of huddling in its top-left corner.** The previous beta was measured only for overflow, and an empty card overflows nothing — so a large tile showed a few rows across the top and left most of itself blank. Two mechanisms were wrong before this one: flex `flex-wrap` ran columns off the side of the card, and CSS `columns` fixed that but *balances*, spreading a handful of rows one-per-column across the top. It is now a grid whose rows are `1fr`, so they stretch to use the height, flowing into another column only once the height is spent. Measured fill went from about 10% to 86–96% of the card on large tiles, with nothing cut at any normal size. |
| 0.0.6-beta.1 | **The tile now fits any size the user gives it (JonDash 1.8.0 B5/B6).** The dashboard became a grid of square units you can size from 1×1 upward, and the frame clips rather than scrolls, so the tile now shows only what genuinely fits: at 1×1 a single figure, from ~6rem the name and summary, from ~8rem the detail list. Rows are one line each and flow into extra columns when the tile is wide and short, and they are in priority order so anything clipped is always the least urgent thing. `minAppVersion` rises to `1.8.0-beta.14` — the exact build where the dashboard frame became a CSS `@container`; on anything older the container queries never match and the labels could never appear. **`.slice(0, 6)` is gone.** Stopped services now sort first. The start/stop buttons appear from ~14rem and every row has a fixed minimum height, so rows stay even whether or not a service can be controlled — uneven rows made the column flow ragged. A 24-row cap remains as a guard against an allowlist with hundreds of entries; how many you see still follows the tile. |
