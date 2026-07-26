# MCP helper

**Status: SPEC — not built.** Awaiting the owner's approval of this document.

Lets an AI agent read and manage this JonDash install, over the Model Context Protocol, **as a
JonDash user you choose**. The agent gets exactly that user's reach and nothing more.

- **Helper id:** `mcp`
- **First consumer:** `mcp-server` — a thin module carrying this helper, with a status widget and page.
- **Grants:** two capabilities, `mcp:read` and `mcp:act`.
- **Needs from core:** the *transport and auth* need nothing — that is the point of the design. But
  **service accounts are a hard blocker on shipping**, because a key may bind to nothing else. See
  *Keys* below.

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

1. **The key's mode** — *read only* or *read and act*, chosen when the key is minted.
2. **The bound user's RBAC** — read from core's own tables, at call time, for that tool.

The mode can only ever **narrow**. It never grants what the user lacks:

| Bound user | Key mode | `list_sessions` | `revoke_session` |
| ---------- | -------- | --------------- | ---------------- |
| `sec-review` (sessions.manage) | read only | yes | **no** |
| `sec-review` | read and act | yes | yes |
| `bot-readonly` (no session perms) | read and act | **no** | **no** |

The last row is the one to test: promoting a key to "act" must never become a privilege-escalation
path.

### What an unauthenticated caller learns: nothing

- **The tool list is behind auth.** MCP normally lets a client enumerate tools before doing anything;
  here it cannot. An unauthenticated caller cannot discover what this install can do.
- **One response for every failure.** Missing key, malformed key, revoked key, valid key for a
  disabled user — identical body, identical status, identical timing. Nothing distinguishes "wrong
  key" from "no such key".
- **Constant-time comparison** of the key hash, so timing does not leak how much of a key was right.
- **Backoff, then a temporary block, per source.** A key is high-entropy, but online guessing should
  not be free.
- **Every refusal is audited.** That log is the tripwire.

### Keys

- Minted on the helper's settings page. **Only a hash is stored**; the key is shown once.
- **Each key binds to a SERVICE ACCOUNT, and only a service account.** Never a person's account.
- Each key carries a mode (read / read+act) alongside its bound account.

> **This is a hard dependency on core, accepted deliberately (owner, 2026-07-26).** Service accounts
> — identities that hold permissions but can never be logged into — do not exist yet; core has been
> asked for them. Until they land, the key dropdown has nothing to offer and **this helper cannot
> ship**.
>
> The alternative was to allow binding to an ordinary user now and restrict later. That was rejected
> because it would break every key already minted, on a security boundary — and because an agent
> bound to a person's account means that identity is also a live login surface, the audit log reads
> as the person, and revoking the agent locks out the human. Never allowing it is cheaper than taking
> it away.
>
> **A service account must not satisfy "at least one admin exists"**, or deleting the last human
> admin while an unreachable account keeps the check happy locks the owner out permanently.
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
- **Opening it to the network is opt-in, confirmed, and requires HTTPS** — a bearer key over plain
  HTTP on a LAN is sniffable. The warning is blocking, not advisory.

### The off switch, and why it needs to be explicit

`bootHelpers()` runs every installed helper's `onBoot` **regardless of whether the consuming module
is enabled** (verified against 1.7.2-beta.2). So disabling the module does **not** stop the endpoint,
which is what an admin would reasonably expect it to do.

Therefore: an explicit on/off on this helper's settings page, and **no keys means the listener does
not start at all**. Uninstalling remains the last resort, not the only one.

---

## Capabilities

| Capability | Shown to the admin as |
| ---------- | --------------------- |
| `mcp:read` | See what an AI agent can read from this install |
| `mcp:act` | Let an AI agent change things, within its user's permissions |

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

**Read (v1) — `mcp:read`**

| Tool | Requires of the bound user | Returns |
| ---- | -------------------------- | ------- |
| `get_server_status` | — | version, channel, uptime, update-available |
| `list_services` | their own tiles | title, url, group, order |
| `list_service_groups` | groups.read | bundles, member counts |
| `list_modules` | modules.manage | id, name, version, enabled, channel |
| `list_sessions` | sessions.manage | user, ip, last seen |
| `query_audit_log` | audit.read | filtered, paginated, hard cap 100 rows |
| `list_users` | users.manage | email, role, status, mfaEnabled |

**Never returned by any read tool:** password hashes, TOTP secrets, recovery codes, session tokens,
API keys, or the contents of `.data/secrets.json`. Not "filtered out" — never selected.

**Act (v1, same release — owner's decision 2026-07-26) — `mcp:act`**

`revoke_session`, `enable_module` / `disable_module`, `check_for_updates` (check only, never
applies). Each additionally requires the bound user to hold the matching permission.

> **Shipping both at once raises what has to be proven before release, not after.** The original
> plan was reads first so the auth could be attacked before anything could change state. The owner
> is testing both together instead, so the act path cannot rely on "nobody can reach it yet" as a
> safety margin — every row of the guarantees table below must pass, and the escalation test (an
> act-key on a read-only user) is the one that decides whether this ships at all.

**Deliberately absent, permanently:** anything that runs a command, reads a file, changes a user's
credentials or MFA, applies an update, or deletes data. An agent that can lock the owner out of their
own install is the one outcome the owner has named as never acceptable — so `revoke_session` refuses
to revoke the owner's own current session.

**Module-contributed tools** are designed for and not in v1. The MCP session's requirement stands: it
must be discovery-based, never a hardcoded per-module list.

---

## What you can rely on

Only what will be tested before this ships.

| Guarantee | How it will be proven |
| --------- | --------------------- |
| An unauthenticated caller cannot list tools | Driven with no key and a bad key; responses byte-identical |
| A key cannot exceed its user's RBAC | Act-key on a read-only user, asserted refused |
| Revoking is immediate | Revoke mid-session, next call refused |
| Nothing listens until a key exists | Fresh install, port checked closed |
| Disabling the module does not silently leave it listening | Module disabled, endpoint state asserted |
| No secret is reachable through any read tool | Every tool's output asserted against a deny-list |

---

## Version history

Nothing published yet.
