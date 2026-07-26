# AI assistant access

Lets an AI assistant read and manage this server through the Model Context Protocol, using a key you
create and can revoke at any time.

- **Module id:** `mcp-server`
- **Version:** `0.0.1-beta.1`
- **Requires:** JonDash `1.7.3-beta.2` or newer, and the `mcp` helper (installed automatically).
- **Permissions:** `mcp:read` — and deliberately **not** `mcp:act`. See below.

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

This module declares `mcp:read` and never `mcp:act`.

That is HELPERS-DESIGN rule 8: **a module-facing API carries read and request, never add, remove or
approve.** Minting a credential is the sharpest possible case of that rule, so `api.ts` on the helper
side exposes status and has no mutator at all — there is no call this module could make to create a
key, change what an assistant is allowed to do, or switch the endpoint on, whatever it asked for.

Declaring `mcp:act` would be this module claiming the power to let an assistant change things. That
is the exact shape that had to be removed from `host-services` and `filesystem`, and it does not come
back here.

**Consent shows both capabilities anyway, and that is correct.** A module earns its import by
declaring the *helper*, not the permission, so installing this discloses everything the helper can
lend — including `mcp:act`, which this module does not use. The disclosure is deliberately the
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
| `0.0.1-beta.1` | First release, alongside `mcp` helper `0.0.1-beta.1`. |
