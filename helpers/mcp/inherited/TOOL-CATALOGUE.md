# JonDash MCP

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant — Claude Desktop, Claude Code,
or any MCP client — read and manage a self-hosted [JonDash](https://github.com/jontiadcock/JonDash)
dashboard.

Ask *"is my dashboard up and is there an update?"*, *"what services do I have?"*, *"who signed in this
week?"* — answered from your own instance, over an authenticated API, with no browser and no screen
scraping.

> **Status: early. One tool works today.**
> `get_server_status` runs against any JonDash, because it is built on the public health probe.
> Everything else needs the scoped-token API described in [docs/API-CONTRACT.md](docs/API-CONTRACT.md),
> which **is not in JonDash yet**. See [Roadmap](#roadmap).

## The JonDash project

| Repository | What it is |
| ---------- | ---------- |
| **[JonDash](https://github.com/jontiadcock/JonDash)** | The dashboard itself — the app you install and run. |
| **[JonDash-addons](https://github.com/jontiadcock/JonDash-addons)** | The official source of add-on **modules** and **helpers**, installed from inside JonDash. |
| **[JonDash-mcp](https://github.com/jontiadcock/JonDash-mcp)** *(you are here)* | An MCP server so an AI assistant can read and manage your instance. |

---

## How it works

```
Claude  ──stdio/MCP──>  jondash-mcp  ──HTTPS + Bearer token──>  JonDash  ──>  SQLite
```

The server holds a **scoped API token** and talks to JonDash's JSON API. It never touches the database,
never scrapes the web UI, and never reuses a browser session — so every request goes through exactly the
same permission checks as a signed-in user, and a token can never do more than the account it belongs to.

## Requirements

- **Node.js 20.11+**
- A running **JonDash** instance you administer
- An **API token** from that instance (for anything beyond the status check)

## Install

```bash
git clone https://github.com/jontiadcock/JonDash-mcp.git
cd JonDash-mcp
npm install
npm run build
```

## Configure

All configuration is environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `JONDASH_URL` | yes | — | Your instance, e.g. `http://localhost:3000` |
| `JONDASH_TOKEN` | for everything but the status check | — | A token minted in JonDash |
| `JONDASH_TIMEOUT_MS` | no | `10000` | Per-request timeout (1000–60000) |
| `JONDASH_ALLOW_WRITES` | no | `0` | Set to `1` to allow write tools to be registered at all |

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jondash": {
      "command": "node",
      "args": ["C:/path/to/JonDash-mcp/dist/index.js"],
      "env": {
        "JONDASH_URL": "http://localhost:3000",
        "JONDASH_TOKEN": "jd_your_token_here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add jondash --env JONDASH_URL=http://localhost:3000 --env JONDASH_TOKEN=jd_your_token_here -- node /path/to/JonDash-mcp/dist/index.js
```

### Minting a token

*(Once the API ships — see [docs/API-CONTRACT.md](docs/API-CONTRACT.md).)* In JonDash: **Account → API
tokens → New token**, choose the scopes, confirm with your authenticator, and copy the value. **It is
shown once and never again.** Grant read scopes only unless you have a reason not to.

## Tools

| Tool | Scope needed | What it does |
| --- | --- | --- |
| `get_server_status` | none | Is JonDash up, how long has it been up, what version, is an update available |

Planned, once the API exists — read first, writes opt-in:

| Tool | Scope | |
| --- | --- | --- |
| `list_services` | `services:read` | your service tiles |
| `list_service_groups` | `groups:read` | shared tile bundles |
| `list_modules` | `modules:read` | installed add-on modules |
| `list_users` | `users:read` | accounts (admin) |
| `query_audit_log` | `audit:read` | filtered audit events (admin) |
| `list_sessions` | `sessions:read` | who is signed in (admin) |
| `add_service` / `update_service` / `delete_service` | `services:write` | manage your own tiles |
| `enable_module` / `disable_module` | `modules:write` | turn modules on and off (admin) |
| `check_for_updates` | `status:read` | trigger an update check |

**Deliberately not exposed:** applying updates, restarting or shutting down the server, exporting or
restoring backups, resetting a user's access, deleting users, and anything touching passwords, 2FA
secrets or tokens. Those are destructive, lock-you-out, or exfiltration-shaped, and they stay in the web
UI behind a real session. A bearer token sitting in an AI client's config is a weaker credential than an
interactive password + 2FA login, so this server's reach is deliberately **smaller** than the UI's — not
equal to it.

## Security

- **Least privilege.** The server can only do what its token's scopes allow, intersected with what the
  owning account is allowed. Write tools additionally require `JONDASH_ALLOW_WRITES=1`, so the default
  posture is read-only no matter how broad the token is.
- **No back doors.** No database access, no HTML scraping, no cookie reuse. If the API cannot do it, this
  server cannot do it.
- **Secrets never surface.** The token is redacted from every log line and error message, and the API
  never returns password hashes, 2FA secrets, backup codes, or session tokens.
- **Tool output is data, not instructions.** Tile titles, module descriptions and audit entries are
  written by users; the server tells the model to treat them as content, never as commands.
- **Revoke at will.** Deleting the token in JonDash cuts this server off immediately.

Report a security problem privately via [github.com/jontiadcock](https://github.com/jontiadcock) rather
than opening a public issue.

## Development

| Command | Description |
| ------- | ----------- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | compile to `dist/` |
| `npm run dev` | run from source (Node type-stripping) |
| `npm start` | run the built server |

Debug output goes to **stderr** — stdout is the JSON-RPC channel and must carry nothing else.

## Roadmap

1. ~~Scaffold + `get_server_status` against the public health probe~~ ✅
2. **JonDash ships scoped API tokens + `/api/v1`** — [the spec](docs/API-CONTRACT.md) *(blocking, core app)*
3. Read tools: services, groups, modules, users, audit, sessions
4. Write tools, opt-in and guarded
5. Module-contributed tools — add-on modules declare their own MCP tools and this server registers them
   dynamically, so installing a module gives the assistant new abilities with no MCP release

## Licence

Personal use only — see [LICENSE](LICENSE). Same terms as JonDash: free for your own non-commercial use,
no selling, no redistribution.
