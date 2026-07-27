# JonDash API contract — what `jondash-mcp` needs

**Status: proposal. Not implemented in JonDash.**
This document specifies the authenticated API and token model that the MCP server (and any other
external client) is built against. It is written to be implemented as-is by the JonDash core app.

Suggested roadmap ID: **SEC-06 · Scoped API tokens + read-first JSON API**.

---

## 1. Why

JonDash today has no external API:

- every route authenticates with the `dashboard_session` cookie, obtainable only through the
  interactive password → TOTP login;
- every mutating server action calls `assertSameOrigin()` (`lib/security/csrf.ts`), which by design
  rejects programmatic callers;
- `proxy.ts` gates `/dashboard`, `/admin`, `/account`, `/m`;
- the only unauthenticated endpoint is `GET /api/health` → `{ ok, boot }`.

That is a correct security posture for a browser app, and none of it should be weakened. What is
missing is a **separate, narrow, token-authenticated surface** alongside it.

## 2. Invariants

These five properties are what make the surface safe. Everything else is negotiable.

1. **`/api/v1/**` accepts bearer tokens only — never the session cookie.**
   This is precisely what makes it safe for these routes to skip `assertSameOrigin()`: a browser
   cannot be induced to attach an `Authorization` header to a cross-origin request, so CSRF is
   structurally impossible. If the session cookie were *also* accepted, every `/api/v1` route would
   instantly become a CSRF hole. **Server actions and all existing routes keep `assertSameOrigin()`
   unchanged** — the exemption is scoped to token-authenticated `/api/v1` handlers and nothing else.

2. **A token can never exceed its user.**
   Effective permission = `token scopes ∩ getEffectivePermissions(user)`, evaluated per request.
   Revoking an access role immediately narrows every token that user holds. A token issued to a
   delegate never gains ADMIN-only powers.

3. **Tokens survive restarts.**
   Do **not** tie them to `SERVER_BOOT_TIME`. Sessions are deliberately killed on restart; a token
   that died on every update would break every external client permanently.

4. **Off by default.**
   A global setting `api.enabled` (default `false`) gates the whole surface. While off, `/api/v1/**`
   returns **404**, not 403 — an installation that does not use the API should not advertise one.

5. **No secret is ever serialised.**
   Never `passwordHash`, `totpSecretEnc`, `setupTokenHash`, `codeHash`, `tokenHash`, session tokens,
   the encryption key, or any `Setting` row with `secret = true`.

## 3. Token model

```prisma
model ApiToken {
  id          String    @id @default(cuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String                        // user-chosen label, e.g. "Claude Desktop"
  tokenHash   String    @unique             // SHA-256 hex — the raw value is never stored
  prefix      String                        // first 8 chars of the raw token, for display
  scopesJson  String    @default("[]")
  lastUsedAt  DateTime?
  expiresAt   DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())

  @@index([userId])
}
```

**Format.** `jd_` + 43 chars base64url (32 random bytes via `generateToken`). The prefix makes tokens
greppable by secret scanners and lets the UI show `jd_A7fQ…` next to each row. Store only
`hashToken(raw)` — the same one-time-reveal pattern already used for setup tokens and backup codes.
High entropy means SHA-256 is correct here, not argon2.

**Transport.** `Authorization: Bearer jd_…`. Reject tokens supplied in query strings outright — URLs
end up in logs and referrers.

**Lifecycle.**
- Expiry optional; default 90 days, maximum 365. `null` = never, discouraged in the UI.
- Revoke by setting `revokedAt`.
- **Revoke all of a user's tokens** wherever `revokeAllSessions()` is already called: admin *Reset
  access*, *Disable*, and delete (cascade). A recovered account must not leave live tokens behind.
- `lastUsedAt` written with the same ~5-minute throttle as `Session.lastSeenAt`.

**Rate limiting.** Reuse `rateLimit()` keyed on the token hash. Suggested 120 req/min → `429` with
`Retry-After`.

**Audit.** Using the existing `audit()`: `api.token.created`, `api.token.revoked`, `api.auth.failed`
(bad, expired or revoked bearer). Do **not** audit every successful call — `lastUsedAt` covers that
without flooding the log. Every *write* performed through a token audits under its **existing action
name**, with `detail` noting `via=api token:<name>`, so the audit log stays one coherent story
regardless of how the change was made.

### Scopes

Scopes are coarse; the real gate remains the capability RBAC in `lib/auth/permissions.ts`.

| Scope | Additional capability required | Notes |
| --- | --- | --- |
| `services:read` | — | the token owner's own visible tiles |
| `services:write` | — | the token owner's own **personal** tiles only |
| `groups:read` | `groups.manage` for the full list | otherwise only groups the user belongs to |
| `status:read` | — for version/health; `settings.manage` for update info | |
| `modules:read` | `modules.manage` | |
| `modules:write` | `modules.manage` | enable/disable only |
| `modules:tools` | per-module (see §7) | invoke tools contributed by add-on modules |
| `users:read` | `users.manage` | |
| `users:write` | `users.manage` | create only |
| `audit:read` | `audit.view` | |
| `sessions:read` | `sessions.manage` | |

Unknown scope strings are dropped at mint time (same shape as `sanitizePermissions`). The mint UI
should default to **read scopes only**.

### Minting and management

- **Users mint their own tokens** from `/account`. A self-minted token can only ever carry the
  minter's own capabilities, so this creates no escalation path and needs no new capability key.
- **Full ADMIN** gets a read-and-revoke view of all tokens — suggested `/admin/api-tokens`,
  **ADMIN-only and not delegable**, on the same reasoning as Access Roles: handing out the power to
  issue credentials is itself a privilege boundary.
- **Require step-up** (`verifyStepUp`, fresh TOTP within 30 minutes) to mint a token carrying **any
  write scope** — consistent with how the app already treats credential-issuing actions.

## 4. HTTP conventions

- Base path **`/api/v1`**, JSON only, UTF-8, `Cache-Control: no-store`.
- Every response carries `X-JonDash-Version: <app version>` so clients can detect drift.
- **Lists**: `{ "data": [...], "nextCursor": "<opaque>|null" }`. `limit` defaults to 50, max 200.
  Cursors are opaque id-based strings. All timestamps ISO-8601 UTC.
- **Errors**:

  ```json
  { "error": { "code": "unauthorized", "message": "Token expired.", "details": { "reason": "token_expired" } } }
  ```

  Codes: `unauthorized` · `forbidden` · `not_found` · `invalid_request` · `rate_limited` ·
  `conflict` · `server_error`. On 401, `details.reason` ∈
  `token_invalid | token_expired | token_revoked | user_inactive` — safe, since the caller already
  holds the token, and it lets clients produce a fixable message. Messages never contain stack
  traces, SQL, filesystem paths, or secrets.
- **Versioning**: additive-only within `v1`; anything breaking becomes `/api/v2`.

## 5. Endpoints

### Identity and status

| Method | Path | Scope | Returns |
| --- | --- | --- | --- |
| GET | `/me` | any valid token | who this token is |
| GET | `/status` | `status:read` | version, channel, uptime, update availability |
| POST | `/updates/check` | `status:read` + `settings.manage` | re-runs the update check |

```jsonc
// GET /api/v1/me — the MCP calls this at startup to validate config and shape its tool list
{
  "token": { "name": "Claude Desktop", "scopes": ["status:read", "services:read"], "expiresAt": "2026-10-19T00:00:00.000Z" },
  "user":  { "id": "clx…", "email": "owner@example.com", "role": "ADMIN" },
  "permissions": ["users.manage", "audit.view", "…"]
}

// GET /api/v1/status
{ "version": "1.4.0-beta.1", "channel": "beta", "boot": 1750000000000,
  "uptimeMs": 5821357, "updateAvailable": true, "latestVersion": "1.4.0-beta.2" }
```

`updateAvailable` and `latestVersion` are `null` unless the user holds `settings.manage`.

### Services

Visibility must match `getUserVisibleLinks` / `canViewLink` exactly — personal tiles plus the tiles
of every Service Group the user belongs to, personal first, de-duplicated by URL.

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/services` | `services:read` | |
| POST | `/services` | `services:write` | **personal tiles only** |
| PATCH | `/services/:id` | `services:write` | 403 unless the caller owns the personal tile |
| DELETE | `/services/:id` | `services:write` | same ownership rule |
| GET | `/service-groups` | `groups:read` | |

```jsonc
// GET /api/v1/services
{ "data": [
    { "id": "clx…", "title": "Router", "url": "http://192.168.1.1", "hasIcon": true,
      "sortOrder": 0, "source": "personal" },
    { "id": "clx…", "title": "Wiki", "url": "https://wiki.example.com", "hasIcon": false,
      "sortOrder": 1, "source": "group", "groupName": "Household" }
  ], "nextCursor": null }
```

Group tiles are **read-only** over the API — creating or editing shared tiles stays in the UI, where
it belongs to `groups.manage`. Icon *bytes* are not exposed; `hasIcon` is enough for a text client.

### Modules

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/modules` | `modules:read` |
| POST | `/modules/:id/enable` | `modules:write` |
| POST | `/modules/:id/disable` | `modules:write` |

Returns `{ id, name, version, enabled, channel, source }`. Install, uninstall and update are
**deliberately excluded** — they execute third-party code and run migrations.

### Admin reads

| Method | Path | Scope | Filters |
| --- | --- | --- | --- |
| GET | `/users` | `users:read` | `status`, `role`, `q` |
| GET | `/audit` | `audit:read` | `action`, `userId`, `since`, `until` — `limit` max **100** |
| GET | `/sessions` | `sessions:read` | |

`/users` returns `{ id, email, role, status, mfaEnabled, createdAt }` and nothing more.
`/sessions` returns `{ id, userId, email, ip, location, userAgent, createdAt, lastSeenAt, expiresAt }`
— never `tokenHash`.

### Admin writes

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| POST | `/users` | `users:write` + `users.manage` | returns the one-time setup link |

```jsonc
// POST /api/v1/users  { "email": "new@example.com", "role": "USER" }
{ "id": "clx…", "email": "new@example.com", "role": "USER", "status": "PENDING_SETUP",
  "setupUrl": "https://dash.example.com/setup/<raw-token>" }
```

`setupUrl` is a **one-time credential**, returned once and never retrievable again — same as the
admin UI. The existing anti-escalation rule still applies: a non-ADMIN delegate cannot create ADMIN
users.

## 6. Not in the API

Excluded, and each needs an explicit decision to ever add: **apply update · restart · shutdown ·
export backup · restore backup · reset access · disable user · delete user · mint or rotate tokens ·
anything touching TOTP secrets or backup codes**.

The reasoning is one line: a bearer token living in an AI client's config file is a **weaker
credential** than an interactive password + TOTP session, so the surface it unlocks must be strictly
**smaller** than the UI's. These operations are destructive, lock-you-out, or exfiltration-shaped;
they stay behind a real session, with step-up where they already require it.

## 7. Phase 2 — module-contributed tools

**This is a requirement, not a nice-to-have** — add-on modules are where JonDash is heading, and a
module that an assistant cannot see is a module the assistant cannot help with. The wrong answer is
hardcoding each module's tools into the MCP server and re-releasing it; the right one is **discovery**.

**Module contract** — one new optional field and one new permission in `lib/modules/types.ts`:

```ts
export type ModuleMcpTool = {
  name: string;                 // unique within the module, snake_case
  description: string;          // shown to the AI model — see the injection note below
  inputSchema: object;          // JSON Schema for the arguments
  readOnly: boolean;            // read-only tools can be exposed without write scopes
  handler: (ctx: ModuleContext, input: unknown) => Promise<unknown>;
};

// on ModuleDefinition:
mcpTools?: ModuleMcpTool[];

// new ModulePermission, consented at install like every other:
| "mcp:expose"   // "Expose tools to AI assistants"
```

**Endpoints**

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| GET | `/tools` | `modules:tools` | list tools from enabled modules granted `mcp:expose` |
| POST | `/tools/:moduleId/:toolName` | `modules:tools` | invoke one, body = the arguments |

The MCP server calls `/tools` at startup and registers each as `mod_<moduleId>_<name>`, so installing
a module gives the assistant new abilities with **no MCP release at all**.

**Security notes specific to this** — worth care, because it is the one place third-party text
reaches the model:

- A module tool's `name` and `description` are **authored by a third party and injected into an AI
  agent's context**. That is a prompt-injection surface. Cap descriptions (≈512 chars), strip control
  characters, and namespace every tool so a module can never shadow a core tool such as
  `list_users`. The MCP server additionally prefixes each with its origin (`[module: weather]`).
- A module tool runs with the **module's** granted permissions, intersected with the token's scopes
  and the user's capabilities — never more.
- `readOnly: false` tools require `JONDASH_ALLOW_WRITES` on the client as well.
- Tool *results* are untrusted data too, and are surfaced to the model as content, never as
  instructions.

## 8. Implementation checklist

- [ ] `ApiToken` model + migration
- [ ] `lib/auth/api-token.ts` — mint, hash, verify, revoke, scope resolution
- [ ] `requireApiToken(scopes)` helper: bearer-only, cookie explicitly ignored, `api.enabled` check,
      rate limit, `lastUsedAt` throttle
- [ ] `/api/v1` route handlers per §5
- [ ] `api.enabled` setting (default **off**) in Admin → Settings
- [ ] `/account` token management + step-up for write scopes
- [ ] `/admin/api-tokens` (ADMIN-only) list + revoke
- [ ] Revoke tokens alongside `revokeAllSessions()` at all three existing call sites
- [ ] Tests: cookie auth rejected on `/api/v1`; scope ∩ capability enforced; secrets absent from every
      response body; 404 while `api.enabled` is false; expired/revoked tokens rejected

## 9. Open questions for the user

1. **Self-service vs ADMIN-only minting** — proposed: users mint their own, ADMIN can revoke any.
2. **Should `POST /users` be in v1 at all?** It is the only endpoint returning a credential.
   Deferring it to v2 costs little.
3. **HTTPS enforcement** — should the API refuse to serve over plain HTTP to a non-loopback client?
   A bearer token over LAN HTTP is sniffable. Proposed: allow loopback, warn otherwise.
