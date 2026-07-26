import { prisma } from "@/lib/db";
import { listModulesForAdmin } from "@/lib/modules/registry";
import { getUserVisibleLinks } from "@/lib/services";
import { register } from "./tools";

/**
 * The read tools.
 *
 * Names and scopes are inherited unchanged from the MCP session's catalogue, so an agent written
 * against the old external server still recognises them — the transport changed, the vocabulary
 * did not. See `inherited/TOOL-CATALOGUE.md`.
 *
 * ## Two rules every tool here obeys
 *
 * **1. It never checks its own permission.** The requirement is declared and the dispatcher
 * enforces it before `run` is called. A check inside a handler is one that can be forgotten, and
 * forgetting fails open.
 *
 * **2. It selects only what it returns.** Not "fetch the row and delete the secret fields" —
 * `select` names the columns, so a password hash, a TOTP secret or a session token is never loaded
 * into memory in the first place. There is no filtering step to get wrong, and adding a column to
 * the schema cannot silently widen what an agent can read.
 *
 * The model sees only the name, description and schema, so all three are written for it: say what
 * the tool returns and what it will NOT do, because that is what stops it inventing a follow-up.
 */

register({
  name: "get_server_status",
  // Describes exactly what `run` returns and nothing more. It previously advertised the release
  // channel and whether an update was available — neither of which this returns — and a tool
  // description is read by the MODEL, so an overstated one makes an assistant confidently answer a
  // question from data it never received.
  description:
    "The JonDash server's version, how long it has been running, and when it started. Read-only; changes nothing.",
  kind: "read",
  // Deliberately available to any valid key: an agent must be able to say what it is connected to
  // without having been granted anything.
  permission: null,
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    const pkg = await import("../../../package.json", { with: { type: "json" } }).catch(() => null);
    return {
      version: (pkg as { default?: { version?: string } } | null)?.default?.version ?? "unknown",
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    };
  },
});

register({
  name: "list_services",
  description:
    "The service tiles visible to the account this key acts as — title, URL and group. Only what that account can see, not every tile on the install.",
  kind: "read",
  permission: null,
  inputSchema: { type: "object", properties: {} },
  run: async (_args, identity) => {
    // Scoped to the bound account, not to every tile. The same call the dashboard makes, so
    // visibility rules cannot drift between what a person sees and what their agent sees.
    const links = await getUserVisibleLinks(identity.accountId);
    // `source` is "personal" or the access-role name the tile came from — that IS the grouping.
    return links.map((l) => ({ title: l.title, url: l.url, from: l.source }));
  },
});

register({
  name: "list_modules",
  description:
    "Installed add-on modules: id, name, version, whether enabled, and release channel. Does not enable, disable or update anything.",
  kind: "read",
  permission: "modules.manage",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    const mods = await listModulesForAdmin();
    // ModuleState wraps the definition rather than flattening it — id/name/version live on .def.
    return mods.map((m) => ({
      id: m.def.id,
      name: m.def.name,
      version: m.def.version,
      enabled: m.enabled,
      installed: m.installed,
      channel: m.channel,
    }));
  },
});

register({
  name: "list_sessions",
  description:
    "Active sign-ins: which account, from what IP and rough location, when last seen. Use this to spot a session that looks wrong. It does not revoke anything — revoke_session does that, and needs a key with permission to act.",
  kind: "read",
  permission: "sessions.manage",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    const rows = await prisma.session.findMany({
      // Named columns only. `tokenHash` is never selected, so the credential that would let
      // somebody impersonate that session cannot leave through this tool even by accident.
      select: {
        id: true,
        ip: true,
        location: true,
        userAgent: true,
        expiresAt: true,
        lastSeenAt: true,
        user: { select: { email: true, displayName: true } },
      },
      where: { expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
      take: 100,
    });
    return rows.map((s) => ({
      id: s.id,
      account: s.user.displayName ?? s.user.email,
      ip: s.ip ?? "unknown",
      location: s.location ?? "unknown",
      userAgent: s.userAgent ?? "unknown",
      lastSeen: s.lastSeenAt?.toISOString() ?? null,
      expires: s.expiresAt.toISOString(),
    }));
  },
});

register({
  name: "query_audit_log",
  description:
    "Recent audit entries — what happened, who did it and when. Optionally filter by action text. Capped at 100 rows, newest first.",
  kind: "read",
  permission: "audit.view",
  inputSchema: {
    type: "object",
    properties: {
      contains: {
        type: "string",
        description: "Only entries whose action contains this text, matched literally and case-insensitively.",
      },
      limit: { type: "number", description: "How many rows, 1-100. Defaults to 50." },
    },
  },
  run: async (args) => {
    const contains = typeof args.contains === "string" ? args.contains : undefined;
    // Clamped here rather than trusted: the model chooses this number, and "give me everything"
    // is a reasonable thing for it to try.
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));

    /**
     * **Substring means substring — `%` and `_` are literal here.**
     *
     * Prisma's `contains` compiles to SQL `LIKE` and does not escape the wildcards, so
     * `contains: "%"` matched every row and `revoke_session` also matched `revokeXsession`. Not an
     * injection (Prisma parameterises, and `' UNION SELECT …` comes back as literal text) — but a
     * search that quietly means something other than what was asked is worth being exact about,
     * especially when the thing asking is a model that cannot see it went wrong.
     *
     * Prisma offers no `ESCAPE` clause, so rather than drop to raw SQL — and lose the explicit
     * column list that is what actually keeps secrets unreachable — the match is done against the
     * distinct action vocabulary, which is bounded and small (dozens of values, not rows). The
     * filter is then an exact `in`, and the database still does the ordering and the limit.
     */
    let actionFilter: { in: string[] } | undefined;
    if (contains !== undefined) {
      const vocabulary = await prisma.auditLog.findMany({
        select: { action: true },
        distinct: ["action"],
      });
      const needle = contains.toLowerCase();
      actionFilter = { in: vocabulary.map((v) => v.action).filter((a) => a.toLowerCase().includes(needle)) };
    }

    const rows = await prisma.auditLog.findMany({
      select: { action: true, detail: true, createdAt: true, source: true, user: { select: { email: true } } },
      where: actionFilter ? { action: actionFilter } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      at: r.createdAt.toISOString(),
      action: r.action,
      detail: r.detail ?? null,
      by: r.user?.email ?? r.source ?? "system",
    }));
  },
});

register({
  name: "list_users",
  description:
    "Accounts on this install: name, role, status and whether two-factor is set up. Never returns passwords, two-factor secrets or recovery codes — those are not readable through this interface at all.",
  kind: "read",
  permission: "users.manage",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    const rows = await prisma.user.findMany({
      // The deny-list approach would be to fetch the user and strip fields. This is the allow-list:
      // passwordHash, totpSecretEnc and the recovery codes are never selected, so they cannot be
      // returned by a later edit that forgets to strip them.
      select: {
        email: true,
        displayName: true,
        role: true,
        status: true,
        mfaEnabled: true,
        isServiceAccount: true,
      },
      orderBy: { email: "asc" },
    });
    return rows.map((u) => ({
      name: u.displayName ?? u.email,
      role: u.role,
      status: u.status,
      twoFactor: u.mfaEnabled,
      serviceAccount: u.isServiceAccount,
    }));
  },
});
