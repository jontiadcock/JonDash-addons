# AI assistant access

Lets an AI assistant read and manage this server through the Model Context Protocol, using a key you
create and can revoke at any time.

- **Module id:** `mcp-server`
- **Version:** see [`addons.json`](../../addons.json) on this branch — stable on `main`, beta on `beta`. Deliberately not restated here: it drifts the moment a version is published.
- **Requires:** JonDash `1.8.0-beta.14` or newer, and the `mcp` helper (installed automatically). That floor is the exact build in which the dashboard frame became a CSS `@container` — the tile sizes itself against it, and on anything older its labels could never appear. (The older floor of `1.7.3-beta.2`, which the `mcp` helper needs, is still met.)
- **Permissions:** `mcp:read` only — deliberately **not** `mcp:act` or `mcp:admin`. See below.

> **Connecting an assistant: [CONNECTING.md](./CONNECTING.md)** — the technical guide. Endpoint,
> headers, the handshake, every tool, the refusal shape, security notes and troubleshooting.

---

## What this module is for

**It is a window, not a control panel.** Everything that matters — the endpoint, the keys, what an
assistant may do — belongs to the `mcp` helper and is managed on JonDash's own screen under
**Admin → Addons → Shared capabilities**. This module exists because a helper cannot be installed
directly: the installer brings helpers in as dependencies and offers no control to add one, so
something has to carry it.

What it earns its place with is visibility. A dashboard tile and a page answering the question you
actually have — *is an assistant connected to my server right now, and what can it not do?* — without
being able to change any of it.

---

## Why it cannot let an assistant do anything

This module declares `mcp:read` and never `mcp:act` or `mcp:admin`.

That is HELPERS-DESIGN rule 8: **a module-facing API carries read and request, never add, remove or
approve.** Minting a credential is the sharpest possible case of that rule, so `api.ts` on the helper
side exposes status and has no mutator at all — there is no call this module could make to create a
key, change what an assistant is allowed to do, or switch the endpoint on, whatever it asked for.

Declaring `mcp:act` would be this module claiming the power to let an assistant change things, and
`mcp:admin` the power to let one restart or update the server. That
is the exact shape that had to be removed from `host-services` and `filesystem`, and it does not come
back here.

**Consent shows both capabilities anyway, and that is correct.** A module earns its import by
declaring the *helper*, not the permission, so installing this discloses everything the helper can
lend — including `mcp:act` and `mcp:admin`, which this module does not use. The disclosure is
deliberately the
helper's whole capability set rather than the subset one module happens to touch.

---

## Installing this opens nothing

Worth being explicit, because "installed" and "listening" are different states and the gap is the
whole safety story:

- Installing this module binds **no port**.
- The endpoint starts only when an administrator switches it on **and** at least one key exists.
- It listens on `127.0.0.1` unless someone deliberately opens it to the network.
- Switching **this module** off closes the endpoint too — the helper refuses to listen when no
  enabled add-on depends on it. Re-enabling brings it back.

Turning the endpoint on, minting keys and revoking them are all administrator actions on the helper's
settings page. This module cannot reach any of them.

---

## What you see

**Dashboard tile** — whether an assistant can currently reach this server, and how many keys exist.

**Page** — the same, plus what an assistant fundamentally cannot do here (sign out an administrator,
change credentials or MFA, run commands, read files, apply updates, delete data), and a link to the
settings that control it.

---

## Version history

| Version | What changed |
| ------- | ------------ |
| `0.0.2-beta.2` | **Fills the card instead of huddling in its top-left corner.** The previous beta was measured only for overflow, and an empty card overflows nothing — so a large tile showed a few rows across the top and left most of itself blank. Two mechanisms were wrong before this one: flex `flex-wrap` ran columns off the side of the card, and CSS `columns` fixed that but *balances*, spreading a handful of rows one-per-column across the top. It is now a grid whose rows are `1fr`, so they stretch to use the height, flowing into another column only once the height is spent. Measured fill went from about 10% to 86–96% of the card on large tiles, with nothing cut at any normal size. The verdict now scales with the tile, capped against height the same way, so a large card leads with the state rather than a 14px line. |
| `0.0.2-beta.1` | **The tile now fits any size the user gives it (JonDash 1.8.0 B5/B6).** The dashboard became a grid of square units you can size from 1×1 upward, and the frame clips rather than scrolls, so the tile now shows only what genuinely fits: at 1×1 a single figure, from ~6rem the name and summary, from ~8rem the detail list. Rows are one line each and flow into extra columns when the tile is wide and short, and they are in priority order so anything clipped is always the least urgent thing. `minAppVersion` rises to `1.8.0-beta.14` — the exact build where the dashboard frame became a CSS `@container`; on anything older the container queries never match and the labels could never appear. Four short lines, so this one mostly survived already — but **“open to your network” must stay legible at every size**, so the 1×1 form is the word `LAN` in the danger colour rather than a neutral “on”. A security state the user shrank into invisibility is the worst possible failure for this tile. |
| `0.0.1-beta.2` | The dashboard tile drew no card, so it rendered as loose text — a nameless box reading "Off", with no way to click through. Also corrected the menu this points you at: the controls are under **Admin → Addons → Shared capabilities**, not Permissions. Both found by loading the dashboard after a real install; the build was green throughout. |
| `0.0.1-beta.1` | First release, alongside `mcp` helper `0.0.1-beta.1`. |
