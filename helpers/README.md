# Helpers

**Live as of JonDash 1.5.0.** Two helpers are published on both channels: `scheduler` (needs JonDash
1.5.0) and `filesystem` (needs 1.5.2).

A **helper** is first-party shared capability that modules can depend on. Where a module is written by
anyone and is deliberately fenced in, a helper is written by the JonDash project and is trusted to do
things modules are forbidden from doing — spawning processes, raw sockets, privileged network work,
running code at server start.

That is the whole point. It means a new capability can arrive without waiting for a core release, and
without loosening what an arbitrary third-party module is allowed to do.

## The rules

- **First-party only.** Helpers live here, in the official addons repository, and are installable only
  from the official source. This is enforced by the installer, not by convention — otherwise anyone
  could publish a `helpers/` folder and inherit the privilege.
- **Auto-installed as dependencies.** A module declares the helpers it needs; installing the module
  pulls them in as one visible batch. Users never install, import or remove a helper directly.
- **One version per channel, kept current, and it does not break its API.** There is still no
  dependency resolution and no version ranges to solve — a helper is versioned and tagged like an
  add-on (`<id>/v<version>`), and its channel is inherited from the module that pulled it in, so an
  install only ever holds one. What keeps that safe is a promise rather than a solver: both sides of
  the contract belong to the same project, so a helper does not remove or change what it already
  exposes. A module may state `{ id, minVersion }` to record the floor it was written against; JonDash
  uses that (with the helper's `breakingFrom`) to warn which modules an update would break. It does
  **not** refuse an install against an older helper, so treat `minVersion` as honest documentation,
  not a guard.
- **Capabilities roll up into the consuming module's consent screen.** If a module depends on a helper
  that can write files, the module's approval screen says so, in terms of what actually happens to the
  machine. Consent must not be bypassable by proxy.
- **Auto-install, but conservative removal.** Files are removed when nothing depends on a helper any
  more; **data is kept**. A helper that owns data must not lose it because the last dependent was
  uninstalled.
- **Narrow, purpose-built APIs — never a general escape hatch.** A helper exposing something like
  `run(command)` would make the module verifier ceremonial: every restriction on modules becomes one
  helper call away, and modules regain arbitrary execution by proxy. When a consumer needs something
  the API doesn't cover, the answer is a new narrow call, not a general one.

## Read-only to users

Helpers appear in a read-only Helpers list showing each one and which modules depend on it. There is
no install, import or remove button. A user's control over a helper is their control over the modules
that need it.

## What's here

| Helper | What it gives a module | Capabilities it names | Spec |
| ------ | ---------------------- | --------------------- | ---- |
| `scheduler` | Periodic work that runs from server start, declared rather than started | none — adds nothing to a consent screen | [scheduler/HELPER.md](scheduler/HELPER.md) |
| `filesystem` | Copying and archiving folders to another location, within folders an admin approved | `filesystem:read`, `filesystem:write`, `filesystem:delete` | [filesystem/HELPER.md](filesystem/HELPER.md) |

`filesystem` was built the way the rules above ask for: its API was driven by what its first real
consumer (`backup-manager`) genuinely needed, decided *before* the API was designed — otherwise the
test proves only that the helper matches itself. It exposes no file primitives at all. There is no
call that returns the bytes of a file, and there must never be one, because that single call would
make the module verifier's ban on filesystem access decorative.
