# Connecting an AI assistant to JonDash

A technical guide to the `mcp-server` add-on and the `mcp` helper behind it: what the endpoint is,
how to switch it on, how to connect, and what an assistant can and cannot do once connected.

Everything below has been driven against a real install (JonDash 1.7.3-beta.2). Where a response is
shown, it is a response that was actually returned.

---

## 1. What this is

JonDash speaks the **Model Context Protocol** over **Streamable HTTP**, protocol revision
`2025-11-25`. An assistant connects to a single endpoint with a bearer key you create, and gets a
set of tools bounded by the account that key acts as.

- **One endpoint:** `POST http://127.0.0.1:<port>/mcp`
- **Default port:** `3030`. Choosable from `3030`, `3031`, `3032`, `3040`, `3050`.
- **Binds to `127.0.0.1`** unless you deliberately open it to your network.
- **8 tools** — 6 read, 2 acting.

> **Installing the add-on opens no port.** The listener starts only when *all three* are true: it is
> switched on, at least one key exists, and the add-on is enabled. A fresh install satisfies none of
> them. This is checked in code, not merely intended.

**There is no stdio transport.** The zero-config MCP path — where a client spawns the server as a
subprocess — cannot work from inside a running web server. This is HTTP only, so every client
configures a URL and a key.

---

## 2. Requirements

| | |
| --- | --- |
| JonDash | **1.7.3-beta.2** or newer |
| Add-on | `mcp-server`, from the **beta** channel |
| Helper | `mcp` — installed automatically with the add-on; you cannot install it by hand |
| Account | A **service account**. A key can bind to nothing else. |

---

## 3. Setting it up

### 3.1 Install the add-on

**Admin → Addons → Browse modules → channel `Beta` → "AI assistant access" → Select → Install.**

Before installing you are shown what it can do, in red:

```
⚠ See whether AI assistant access is switched on, and which keys exist
⚠ Allow assistants to make changes
```

Both are listed even though the module itself only uses the first. That is deliberate: a module
earns its access by declaring the *helper*, so consent discloses the helper's whole capability set,
not the subset one module happens to touch.

The confirmation also tells you the helper is coming with it. JonDash then rebuilds and restarts —
everyone signed in has to sign in again.

### 3.2 Create a service account

**Admin → Users → create a service account.**

A service account holds permissions but **can never be signed into** — there is no password to
guess. This matters for three reasons:

- An agent bound to a person's account would make that identity a live login surface.
- The audit log would blame a human for what an assistant did.
- Revoking the agent would lock the human out.

Give it the narrowest role that does the job. **A key can never exceed its account**, so the account
is the real boundary — not the key.

### 3.3 Switch it on and mint a key

**Admin → Addons → Shared capabilities → AI assistant access.**

Everything lives here: the on/off switch, the port, the binding, the keys, and a log of refused
connections. The module's own page is display-only and cannot change any of it.

1. **Switch on.** The status will read *"Switched on, but not listening — no keys exist yet"*.
2. Choose a **port** and **who can reach it**.
3. Under **Keys**: give it a name, pick the **service account** it acts as, and choose
   **Read only** or **Read and act**.
4. **Create key.**

The key is shown **once**:

```
jd_mcp_KkKvMDC-zbocHzzVJSVAZOZP-9m3l0oWN6X3RI66ABc
```

Only a SHA-256 hash is stored, so it cannot be recovered — if you lose it, revoke it and mint
another. Revoking takes effect on the **very next call**: no cache, no grace period, no restart.

The status now reads `Listening on 127.0.0.1:3030`.

---

## 4. Connecting

### 4.1 Headers

Every request needs all four:

```
Authorization: Bearer jd_mcp_…
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-11-25
```

`Accept` must include both types — that is the Streamable HTTP requirement, even though this server
never opens an SSE stream.

### 4.2 The handshake

```bash
curl -s -X POST http://127.0.0.1:3030/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0.0"}}}'
```

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": { "tools": {} },
  "serverInfo": { "name": "jondash", "title": "JonDash", "version": "2025-11-25" }
}
```

Then send `notifications/initialized` (no `id` — it is a notification, and the server answers `202`
with no body), and you are connected.

**`initialize` requires a valid key.** The handshake is not a free endpoint: letting it through
unauthenticated would confirm to any caller that this is a JonDash server.

### 4.3 Listing tools

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

**You are only offered the tools your key can actually use.** The list is filtered by the key's mode
*and* the bound account's permissions, so a read-only key on a thin account sees two tools and an
act-key on an admin service account sees all eight.

### 4.4 Calling a tool

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "get_server_status", "arguments": {} } }
```

```json
{ "version": "1.7.3-beta.2", "uptimeSeconds": 200, "startedAt": "2026-07-26T17:07:37.903Z" }
```

### 4.5 Client configuration

Most MCP clients take a URL and headers. The shape varies by client, but the substance is:

```json
{
  "mcpServers": {
    "jondash": {
      "url": "http://127.0.0.1:3030/mcp",
      "headers": { "Authorization": "Bearer jd_mcp_…" }
    }
  }
}
```

If your client only supports stdio, put a stdio-to-HTTP bridge in front of it — this server does not
offer stdio itself, for the reason in §1.

---

## 5. The tools

### Read — available to `read` and `act` keys

| Tool | Account must hold | Returns |
| --- | --- | --- |
| `get_server_status` | — | version, uptime, started-at |
| `list_services` | — | the service tiles that account can see |
| `list_modules` | `modules.manage` | id, name, version, enabled, channel |
| `list_sessions` | `sessions.manage` | account, IP, rough location, last seen |
| `query_audit_log` | `audit.read` | filtered and paginated, hard cap 100 rows |
| `list_users` | `users.manage` | name, role, status, whether 2FA is on |

### Act — `act` keys only

| Tool | Account must hold | Refuses even so |
| --- | --- | --- |
| `revoke_session` | `sessions.manage` | a **human administrator's** session |
| `set_module_enabled` | `modules.manage` | its own carrier, `mcp-server` |

### Errors

A tool that runs and declines returns a **normal result** with `isError: true` and the reason in
`content` — because clients feed results to the model but surface JSON-RPC errors as transport
failures the model never sees. So a refusal reaches the assistant as something it can explain:

```json
{ "content": [{ "type": "text",
    "text": "This assistant cannot disable the module it runs through. Do it from Admin → Addons." }],
  "isError": true }
```

JSON-RPC errors are reserved for protocol-level problems: unknown method, unknown tool name,
unsupported protocol version.

---

## 6. What an assistant cannot do

**Never, regardless of key or account:**

- Read anyone's password, TOTP secret, recovery codes, or session tokens. These are not filtered out
  of results — they are **never selected from the database**, so a future edit cannot leak them by
  forgetting a filter.
- Sign out a human administrator. Deliberately blunt: not "the owner's current session", which is
  not knowable from inside a tool, but *any* administrator who is not a service account. A rule that
  has to guess is one that fails on the day it matters.
- Disable the add-on it runs through — that would sever its own connection mid-conversation.
- Run a command, read or write a file, install or update anything, or delete data.
- **Exceed the account its key acts as.** Choosing "read and act" never grants anything the account
  does not already have. Promoting a key is not an escalation path.

**Permissions are re-read on every single call**, never cached. Strip a role and the agent loses that
power on its next request, not at the next restart. Likewise the bound account is re-resolved every
call, so an account that is deleted — or that stops being a service account — fails closed.

---

## 7. Security notes

**An unauthenticated caller learns nothing.** No key, a wrong key, a revoked key and a valid key on a
deleted account all produce an identical response — same status, same body. `tools/list` is behind
authentication, so the tool list cannot be enumerated. Key comparison is constant-time.

**DNS-rebinding defence, as the spec requires.** Any request carrying an `Origin` header is refused
`403`, and a `Host` header that is not this server is refused `403`. A web page you visit cannot make
your browser drive this endpoint.

> Testing this yourself: `fetch()` treats `host` as a forbidden header and **silently drops** an
> override, so a rebinding test written with `fetch` sends the real Host, gets a `200`, and looks
> like a missing defence. Use `curl` or a raw socket.

**Opening it to the network is opt-in and should mean HTTPS.** A bearer key on plain HTTP across a
LAN is sniffable. The default — this machine only — is right for almost everyone: an assistant that
can already reach `127.0.0.1` has access to the machine anyway.

**Refused connections are logged** with the time, source IP and reason, and shown on the settings
page. No key material is recorded, not even a partial hash. That log is the tripwire: an endpoint
nobody should be probing, being probed.

**Every action is attributed to the service account**, prefixed `mcp.` in the audit log — including
the refusals. So you can filter the audit log to exactly what came in through an assistant, and no
human is ever recorded as having done something an assistant did.

**Known limitation, stated plainly:** helpers are first-party code and are **not** scanned by the
module verifier. This helper's own authorization code is the only thing gating the endpoint. That is
why it ships switched off, why it binds to loopback, and why it is on the beta channel pending a
penetration test.

---

## 8. Turning it off

Any of these closes the port immediately:

- **Switch off** on the helper's settings page.
- **Revoke the last key** — a listener nothing can authenticate to has no purpose.
- **Disable the add-on** under Admin → Addons. Re-enabling brings it back.
- **Uninstall the add-on.** The helper's files go when nothing depends on them; its data is kept
  deliberately, so an uninstall cannot destroy your key history.

---

## 9. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Connection refused | Not listening. Check all three: switched on, at least one key, add-on enabled. |
| `401`, identical every time | The key is wrong, revoked, or its account is gone. By design you cannot tell which from the response — check the refusal log on the settings page. |
| `403` | You sent an `Origin` header, or a `Host` that is not this server. Browsers cannot be talked out of `Origin`; use a real client. |
| `400` on every call | Unsupported `MCP-Protocol-Version`. Supported: `2025-11-25`, `2025-06-18`, `2025-03-26`. |
| `405` on GET | Expected. There is no SSE stream, which the spec permits. Use POST. |
| Tool missing from `tools/list` | Your key's mode or the bound account's permissions exclude it. Not an error — the list is what you may use. |
| "Switched on, but not listening" | Either no keys exist, or the add-on is disabled. The page says which. |

---

## Reference

- `helpers/mcp/HELPER.md` — design, threat model, and the guarantees with how each was proven.
- `addons/mcp-server/MODULE.md` — what the module does and why it holds no power.
- MCP specification, revision `2025-11-25`.
