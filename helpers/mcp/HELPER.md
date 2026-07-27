# MCP helper

**Status: BUILT. `0.0.1` passed a penetration test and shipped to stable; `0.0.2-beta.1` adds
server lifecycle and is on beta, awaiting a re-test.**

Lets an AI agent read and manage this JonDash install, over the Model Context Protocol, **as a
service account you choose**. The agent gets exactly that account's reach and nothing more.

- **Helper id:** `mcp`
- **Version:** `0.0.3-beta.1`
- **`minAppVersion`:** `1.7.3-beta.2` — service accounts (beta.1) plus the helper id that
  `resolveBindableAccount` takes (beta.2). The **pre-release**, not a bare `1.7.3`: semver ranks a
  pre-release below its release, so `"1.7.3"` would be refused on exactly the builds beta users run.
- **First consumer:** `mcp-server` — a thin module carrying this helper, with a status widget and page.
- **Grants:** three capabilities — `mcp:read`, `mcp:act` and `mcp:admin`.
- **Needs from core:** the *transport and auth* need nothing — that is the point of the design. The
  one dependency is service accounts, since a key may bind to nothing else. See *Keys* below.

---

## Why this is a helper and not a separate server

The MCP server was originally scoped as an **external process** talking to JonDash over a new
`/api/v1` with bearer tokens — which is why it needed core to build scoped API tokens (drafted as
SEC-06) and why it sat blocked for days on one working tool.

Moving it inside JonDash as a helper deletes that dependency entirely. A helper runs in-process at
boot, so it already holds the database, the module registry, the updater and every other helper's
internals. There is no boundary to authenticate across, so there is no API to build.

**The authentication does not disappear — it moves one layer out.** The agent is still external, so
the connection *it* makes needs a key. But the helper can read core's real RBAC in-process, so it
only has to own key issuance rather than a whole authorization system.

### What this costs, stated honestly

- **Blast radius.** The AI-facing surface now runs inside the app process with full database access.
  A bug in this helper's auth is a full compromise, where a separate process would have been limited
  to what its scoped token allowed. This is the strongest argument against this design and it is
  accepted deliberately.
- **No stdio transport.** The zero-config MCP path — the client spawns the server as a subprocess —
  cannot work from inside a running web server. This is HTTP only, so every consumer manages a key.
- Helpers are **not verifier-scanned**. Nothing mechanical checks this code. That is true of every
  helper, and it matters more here than anywhere else in the repo.

---

## The security model

### Two gates, and neither alone is sufficient

Every call is checked twice:

1. **The key's mode** — *read only*, *read and act*, or *read, act and manage the server*, chosen
   when the key is minted. Three rungs of a ladder: a key reaches its own and everything below.
2. **The bound account's RBAC** — read from core's own tables, at call time, for that tool.

The mode can only ever **narrow**. It never grants what the user lacks:

| Bound account | Key mode | `list_sessions` | `revoke_session` | `restart_server` |
| ------------- | -------- | --------------- | ---------------- | ----------------- |
| `sec-review` (sessions.manage) | read only | yes | **no** | **no** |
| `sec-review` | read and act | yes | yes | **no** |
| `sec-review` | admin | yes | yes | **no** — no `settings.manage` |
| `ops-bot` (settings.manage) | admin | **no** | **no** | yes |
| `bot-readonly` (no permissions) | admin | **no** | **no** | **no** |

The last row is the one to test: promoting a key to "act" must never become a privilege-escalation
path.

### What an unauthenticated caller learns: nothing

- **The tool list is behind auth.** MCP normally lets a client enumerate tools before doing anything;
  here it cannot. An unauthenticated caller cannot discover what this install can do.
- **One response for every failure.** Missing key, malformed key, revoked key, valid key for a
  disabled user — identical body, identical status, identical timing. Nothing distinguishes "wrong
  key" from "no such key".
- **Constant-time comparison** of the key hash, so timing does not leak how much of a key was right.
- **A temporary block, per source.** Twenty failures inside a minute and that source is refused
  `429` with a `Retry-After` until the window passes — before parsing, before any database access,
  so a caller who has already failed twenty times stops being able to spend this server's time.
  Only *failures* count, so a client holding a correct key can never throttle itself however busy it
  is. The block applies to a valid key from that source too: one that a valid key walks through
  would not slow guessing at all.

  > **This was claimed here and not implemented until `0.0.1-beta.3`.** The pentest found 500
  > concurrent bad keys answered instantly (F1). The `blocked` refusal reason and its
  > "Too many attempts — temporarily blocked" label both existed, and no code ever set them. It now
  > uses core's own `rateLimit()` — the sliding window already behind login and account actions —
  > rather than a second implementation of the same idea living in an add-on.

  **What this does not cover, stated plainly:** a flood using a *valid* key is not throttled. The
  pentest drove 400,000 requests without crashing the server (no restarts, full recovery in
  seconds), but ~11% were dropped and worst-case latency reached 8s while it ran. Throttling a
  legitimate agent's own key is a worse failure than that degradation, so it is deliberately not
  done.
- **Every refusal is audited.** That log is the tripwire.

### Keys

- Minted on the helper's settings page. **Only a hash is stored**; the key is shown once.
- **Each key binds to a SERVICE ACCOUNT, and only a service account.** Never a person's account.
- Each key carries a mode (read / read+act / admin) alongside its bound account.

> **Shipped by core in 1.7.3-beta.1 (SEC-07), which is why this helper's floor is that release.**
> Service accounts are identities that hold permissions but can never be logged into.
>
> The alternative was to allow binding to an ordinary user now and restrict later. That was rejected
> because it would break every key already minted, on a security boundary — and because an agent
> bound to a person's account means that identity is also a live login surface, the audit log reads
> as the person, and revoking the agent locks out the human. Never allowing it is cheaper than taking
> it away. The audit rows bear this out: every `mcp.*` entry names the agent's own identity, so no
> human is ever recorded as having done something an assistant did.
>
> **A service account must not satisfy "at least one admin exists"**, or deleting the last human
> admin while an unreachable account keeps the check happy locks the owner out permanently.
>
> The gate is `resolveBindableAccount`, called on **every** request rather than at mint time — so an
> account that stops being a service account fails closed, not just a deleted one. Core stamps
> `lastUsedAt` / `lastUsedByHelper` from that same call, which is how an admin tells a live service
> account from a forgotten one.
- Revoking deletes the row and takes effect on the next call — no cache, no grace period.
- A key is never written to the audit log, never logged, never echoed back.

### Where it listens

- **Nothing listens until it is switched on.** A fresh install binds no port at all. "Installed" and
  "listening" are different states, and the settings page says which one you are in.
- **`127.0.0.1` by default.** An agent needs shell on this machine, which is already the harder thing
  to obtain.
- **Port is chosen from a dropdown, defaulting to 3030.** A list rather than a free-text field: it
  keeps the choice away from ports JonDash and its testbeds already use, and a typo'd port that
  silently binds nothing is worse than no choice at all.
- **Opening it to the network is opt-in, and refused without HTTPS unless explicitly confirmed** —
  a bearer key over plain HTTP on a LAN is sniffable, and a sniffed key is a *working* key carrying
  everything its account holds.

  > **This said "blocking, not advisory" and was advisory** until `0.0.1-beta.3`. The code returned
  > the sentence "Turn on HTTPS if you have not" and opened the port anyway; during the pentest the
  > key crossed the LAN in clear text (F2). The refusal now lives in `onSettingsSubmit`, so it holds
  > however the form is submitted — the settings page asks first purely so the reason arrives before
  > the refusal rather than after it.

  The override is deliberate (owner, 2026-07-27): plain HTTP on a trusted LAN is a legitimate
  choice, and one confirmation is the difference between choosing it and stumbling into it.

### The off switch — three independent conditions, all required

Historically `bootHelpers()` ran every installed helper's `onBoot` **regardless of whether the
consuming module was enabled** (verified against 1.7.2-beta.2, still true at 1.7.3-beta.2). For every
other helper that is correct — a helper only acts when a module calls it, so a disabled module means
a dormant helper by definition. This one was the first that is different: it listens on a port
whether a module ever calls it or not, so switching the add-on off left the endpoint open with
nothing on screen saying otherwise.

**Core closed that in 1.7.3-beta.4** — `onBoot` now runs only for a helper some *enabled* module
depends on, while migrations still run for every *installed* helper so a re-enabled module never
meets a layout its helper wasn't written against.

**The check below stays regardless, and that is deliberate.** HELPERS-DESIGN rule 12: *"You should
still fail closed yourself rather than assume core got there first."* The two cannot fight — both
can only ever refuse to open a socket, never open one — and this helper's floor is `1.7.3-beta.2`,
so it must still be correct on a core that predates the fix.

So the listener binds only when **all three** hold, and every one of them is checked in
`startListener` rather than merely intended:

1. **Switched on** here, on this helper's settings page. A fresh install binds no port at all.
2. **At least one key exists.** A listener nothing can authenticate to is a surface with no purpose,
   so revoking the last key closes the port immediately.
3. **At least one enabled add-on depends on this helper.** Without this, an admin who switched
   "AI assistant access" off in Addons had done nothing whatsoever — and the screen they used said
   nothing to the contrary. Someone reasonably believes they closed the door.

The third is phrased over *dependents*, not over the id `mcp-server`, so it stays true if this helper
is ever carried by something else. It can only ever refuse to start: no arrangement of module state
can open an endpoint that (1) and (2) would not already have allowed.

Because it is recoverable it is also honest about itself — the settings page distinguishes "off",
"on but no keys", and "on but the add-on is disabled", and names the screen that fixes the last one.
The helper stays listed under Shared capabilities either way, because core lists a helper by whether
a module *depends* on it, not by whether that module is enabled.

Uninstalling remains the last resort, not the only one.

---

## Capabilities

| Capability | Shown to the admin as |
| ---------- | --------------------- |
| `mcp:read` | See what an AI agent can read from this install |
| `mcp:act` | Allow assistants to make changes |
| `mcp:admin` | Allow assistants to restart and update this server |

Two rather than one, per HELPERS-DESIGN rule 9: a capability with a looking-at-it form and a
doing-something-to-it form declares both, so nobody grants the destructive half to obtain the
harmless one.

> **The consent screen cannot describe the real risk here, and that is a known limitation.** Consent
> describes what a helper lends *modules*. This helper's risk is an external endpoint, which no
> module capability expresses. The warning therefore lives on the settings page and in this document,
> and "installed" deliberately does not mean "listening".

### What the module can do with these

`mcp-server` declares **`mcp:read` only**, and uses it for a status widget and page: whether the
endpoint is on, which keys exist, when each was last used. It cannot mint a key, change the binding,
or turn the listener on. That is HELPERS-DESIGN rule 8 — the module-facing API carries read and
request, never add, remove or approve.

---

## Tools

Inherited from the MCP session's catalogue, which survives the change of transport unaltered.

**Read (6 tools) — mode `read` or `act`**

| Tool | Requires of the bound account | Returns |
| ---- | ----------------------------- | ------- |
| `get_server_status` | — | version, uptime, started-at |
| `list_services` | — | title, url, source |
| `list_modules` | modules.manage | id, name, version, enabled, channel |
| `list_sessions` | sessions.manage | user, ip, last seen |
| `query_audit_log` | audit.view | filtered, paginated, hard cap 100 rows |
| `list_users` | users.manage | display name (email only as a fallback), role, status, whether 2FA is on, whether it is a service account |

**A tool's `description` is read by the model, so it is part of the contract, not a comment.**
`get_server_status` once advertised the release channel and update-availability it does not return —
which is how an assistant ends up confidently answering a question from data it never received.
Keep every description to what `run` actually returns.

**Never returned by any read tool:** password hashes, TOTP secrets, recovery codes, session tokens,
API keys, or the contents of `.data/secrets.json`. Not "filtered out" — **never selected**. Every
read tool names its columns in a Prisma `select`, so a secret is not fetched and then dropped; it
never leaves the database. A filter can be forgotten on the day someone adds a field.

**Act (2 tools) — mode `act` only**

| Tool | Requires | Refuses, even with the permission |
| ---- | -------- | --------------------------------- |
| `revoke_session` | sessions.manage | a **human administrator's** session |
| `set_module_enabled` | modules.manage | its own carrier, `mcp-server` |

Both were shipped in the same release as the reads, on the owner's decision (2026-07-26). The
original plan was reads first, so the auth could be attacked before anything could change state.
Testing them together means the act path never got to rely on "nobody can reach it yet" as a safety
margin — which is why the escalation case is tested from an **ADMIN** service account, where RBAC
permits everything and only the helper's own rules can refuse.

The lockout guard is deliberately blunt: **not** "is this the owner's current session", which is not
knowable from here, but *any* administrator who is not a service account. A rule that has to guess is
one that fails on the day it matters. An agent that can lock the owner out of their own install is
the one outcome the owner has named as never acceptable.

**Admin (6 tools) — `admin` mode only, added in 0.0.2**

| Tool | Account must hold | Notes |
| ---- | ----------------- | ----- |
| `check_for_updates` | settings.manage | *read* — names the target version, type, criticality and summary |
| `list_module_updates` | modules.manage | *read* — reporting only; an assistant cannot install or update an add-on |
| `apply_update` | settings.manage | must pass the exact version from `check_for_updates`, or it refuses |
| `set_update_channel` | settings.manage | stable ↔ beta |
| `create_backup` | **backups.manage** | never returns the archive |
| `restart_server` | settings.manage | comes back on its own, sessions kept |
| `shutdown_server` | settings.manage | **off unless separately enabled** — see below |

> **`applies an update` used to be in the permanent-exclusion list below. The owner reversed that on
> 2026-07-27**, and the reversal is recorded rather than quietly edited out: shipping a doc that says
> "never" and code that does it is worse than either alone.

**The line between `act` and `admin` is not "more dangerous" — it is who has to be present to undo
it.** Everything under `act` can be reversed by a person at the dashboard. Everything under `admin`
takes the dashboard away while it happens.

`shutdown_server` is the exception even to that: core's supervisor treats a shutdown as a clean stop
and the launcher window closes, so *"restarting then requires running the launcher on the host"*.
Nothing remote can undo it. So it needs **all four** of: an `admin` key, `settings.manage`, an
administrator having switched it on for this install, and the literal string `"shut down"` as an
argument — a typed phrase rather than a boolean, because `true` is what a model passes when it is
guessing at a schema.

**Deliberately absent, and these genuinely are permanent** — the rule is that **an agent must never
be able to widen its own reach, or erase the record of what it did**:

- **Granting a role or a permission.** An agent that can grant a role can grant one to its own
  service account, and every gate here becomes decoration. The single most important exclusion.
- **Installing or updating an add-on.** The documented route from "trusted admin" to code running
  in this process — the residual risk the penetration test named. It also answers a consent question
  nobody asked it, since core deliberately never auto-applies an update that adds a permission.
- **Credentials and MFA** — creating users, resetting access, disabling or deleting an account.
- **Restoring a backup** — the one operation that writes old data over current data.
- **Clearing the audit log** — anti-forensics is not a feature.
- **Network and HTTPS settings** — can sever remote access to the machine it runs on.
- Running a command, or reading a file.

**Two capabilities core exposes that this could reach but cannot:** managing dashboard tiles and
managing users are server actions guarded by `assertSameOrigin()`, so a helper has no route to them
at all. Not a decision — a fact about the surface.

**Module-contributed tools** are designed for and not in v1. The MCP session's requirement stands: it
must be discovery-based, never a hardcoded per-module list.

---

## What you can rely on

Only what has actually been driven against a running install — 1.7.3-beta.2, endpoint on 3030,
40 live checks across three scripts. Nothing here is asserted from reading the code.

| Guarantee | How it was proven |
| --------- | ----------------- |
| An unauthenticated caller cannot list tools | Driven with no key and with a bad key: both 401, and the two responses are **byte-identical**, so a wrong key is indistinguishable from an unknown one |
| A key cannot exceed its account's RBAC | Read-key on a permissionless account was offered only the two tools needing no permission, and was refused `revoke_session` and `list_users` |
| An act key still cannot exceed its account | Act-key on an **ADMIN** service account — RBAC wide open — still refused by the helper's own rules below |
| An assistant cannot sign out a human administrator | Attempted at full privilege; refused, and the session verified still present afterwards |
| An assistant cannot disable its own carrier | Attempted; refused, module verified still enabled — while disabling a *different* module succeeded, so the refusal is the rule and not a broken tool |
| Revoking is immediate | Key deleted mid-session; the very next call refused, with no restart and no cache |
| Nothing listens until switched on **and** a key exists | Port checked closed with the module installed and enabled |
| Disabling the add-on closes the endpoint | Disabled → restart → port closed; re-enabled → restart → port back, so the rule cannot strand it. **The listener is bound at boot**, so a change to module state takes effect at the next restart, or immediately if an administrator touches the on/off switch (which rebinds there and then) |
| Actions are attributed to the agent, never a person | Every `mcp.*` audit row carries the service account's id — including the refusals, which are logged too |
| DNS-rebinding defence | A request carrying any `Origin` → 403. A forged `Host` → 403, tested over a **raw socket**, because `fetch()` silently drops a `Host` override and made this look like it was failing when it was not. Independently confirmed over the network by the pentest |
| Guessing is not free | 25 bad keys from one source: 20 × 401 then 429 with `Retry-After`; a valid key from that source is refused too while the block runs, and works again once the window passes |
| Network exposure without HTTPS is refused | Driven in the browser: the confirmation appears and no port opens, Cancel leaves it shut, confirming rebinds to `0.0.0.0`, and returning to loopback needs no confirmation |
| No secret is reachable through any read tool | Every read tool uses a Prisma `select` allow-list, so `passwordHash`, `totpSecretEnc` and `tokenHash` are never loaded rather than filtered afterwards |

### Known limitation

**Helpers are not verifier-scanned.** Nothing mechanical checks this code, and the tests above are
the author's own. That is true of every helper, and it matters more here than anywhere else in this
repo. The endpoint is deliberately off on install, and the owner's pentest is the gate on stable.

---

## Version history

| Version | What changed |
| ------- | ------------ |
| `0.0.3-beta.1` | **AB-01: changing the port left the old one listening.** The listener lived in a module-level variable and Next loads the module more than once, so the settings action was looking at a different instance than the one holding the socket — `stopListener()` found nothing to close and the old port kept serving. It is now held on `globalThis`, so there is one handle and one answer to "is there a listener?". `isListening()` was unreliable for the same reason. |
| `0.0.2-beta.1` | **Server lifecycle, on the owner's instruction.** A third key mode, `admin`, above `read` and `act`, and six tools on it: check and apply a JonDash update (naming the exact target version, and refusing if it moved between checking and applying), switch release channel, write a backup, restart, and shut down. **Shutdown is off by default behind its own switch** because nothing remote can undo it. `apply_update` reverses a "permanently absent" line in this document — deliberately, and left on the record rather than edited out. Also fixed `listFor`, which carried its own copy of the authorization rules and would have listed every admin tool to an `act` key. |
| `0.0.1-beta.3` | **Penetration tested; two documented controls turned out not to exist, and now do.** F1: per-source backoff and temporary block, via core's `rateLimit()` — the claim, the `blocked` reason and its UI label had all shipped without the code. F2: opening to the network without HTTPS is now refused in `onSettingsSubmit` unless explicitly confirmed, instead of a warning that opened the port anyway. F4: `query_audit_log`'s `contains` is a literal, case-insensitive substring rather than a SQL `LIKE` pattern. Everything security-critical held under attack — no bypass, no escalation, no lockout, no secret disclosure, no injection, no crash under 400k requests. |
| `0.0.1-beta.2` | Text only, no behaviour change: `api.ts` pointed at the wrong admin screen. The controls live under **Admin → Addons → Shared capabilities**. Republished rather than edited on the branch, because tags are immutable and an already-installed copy would otherwise keep the wrong text. |
| `0.0.1-beta.1` | First release. Streamable HTTP on 2025-11-25, 6 read tools + 2 acting tools, keys bound to service accounts only, two-gate authorization. Not yet promoted to stable — awaiting the owner's pentest. |
