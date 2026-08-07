import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { dependentsOf } from "@/lib/helpers/registry";
import { rateLimit } from "@/lib/security/rate-limit";
import { getPort, isEnabled, isNetworkExposed, type RefusalReason } from "./keys";

/**
 * The MCP endpoint — Streamable HTTP, protocol revision 2025-11-25 (`PROTOCOL_VERSION`; re-read
 * the spec if it moves, don't assume the diff is cosmetic).
 *
 * Single POST+GET endpoint, nothing streamed (POST returns JSON, GET is 405 — spec-legal for a
 * server with no SSE), no session management — the key already IS the identity.
 *
 * ⚠ Spec's security requirements, treated as hard requirements, plus one of ours: MUST validate
 * `Origin` and 403 an invalid one (DNS-rebinding defence); SHOULD bind only to 127.0.0.1 when
 * local; SHOULD authenticate properly; and (ours) an unauthenticated caller learns NOTHING — same
 * status, body and shape for every rejection, whether there's no key, a bad one, or no account.
 */

const PROTOCOL_VERSION = "2025-11-25";
/** Assumed when the client sends no version header, per the spec's backwards-compatibility rule. */
const ASSUMED_VERSION = "2025-03-26";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-06-18", "2025-03-26"]);

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 256 * 1024;

/**
 * ⚠ The listener lives on `globalThis`, never a module variable — a plain `let server` is per
 * *module instance*, and Next.js loads this file more than once. The boot instance (holding the
 * real socket) and a server-action instance (still `null`) would each believe themselves
 * authoritative: `stopListener()` finds nothing to close, `startListener()` binds again, and the
 * machine ends up with two live listeners neither instance knows about — changing the port would
 * leave the old one serving, and `isListening()` would lie to the settings page.
 *
 * `globalThis` is the standard fix in Next (Prisma's client does the same here) and the only way
 * to make "is there a listener?" a question with one answer.
 */
const HANDLE = Symbol.for("jondash.helper.mcp.listener");
type Holder = { server: Server | null };
const holder: Holder = ((globalThis as Record<symbol, unknown>)[HANDLE] ??= { server: null }) as Holder;

/** Recorded for the admin's tripwire. Never returned to the caller. */
async function recordRefusal(ip: string, reason: RefusalReason): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${helperTableName("mcp", "refusals")} (id, at, ip, reason) VALUES (?, ?, ?, ?)`,
      randomUUID(),
      new Date().toISOString(),
      ip,
      reason,
    );
  } catch {
    // A failed audit write must not become a failed refusal. The request is still refused.
  }
}

/**
 * Per-source backoff, then a temporary block, via core's `rateLimit()` — the same sliding window
 * already used for login, setup and account actions, rather than a second implementation living
 * in an add-on.
 *
 * ⚠ Only FAILURES are counted. A client holding a correct key never fails, so a legitimate
 * assistant can never throttle itself no matter how busy it is — twenty failures in a minute from
 * one source is not a busy client, it is someone trying keys.
 */
const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 60_000;

/** Sources currently serving a block, and until when. Small, and pruned as it is read. */
const blockedUntil = new Map<string, number>();

/** True when this source is inside a block. Does NOT count against the limit — see `reject`. */
function isBlocked(ip: string): boolean {
  const until = blockedUntil.get(ip);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    blockedUntil.delete(ip);
    return false;
  }
  return true;
}

/**
 * The single rejection.
 *
 * **Every auth failure funnels through here** so no caller can distinguish "no key" from "revoked
 * key" from "valid key, deleted account". Same status, same body, every time. The reason travels to
 * the refusal log, never to the client.
 *
 * It is also the one place every failure is guaranteed to pass through, which is why the failure
 * count is incremented here rather than at each call site — a new refusal path added later is
 * counted automatically instead of being silently exempt.
 */
function reject(res: ServerResponse, status: number, ip: string, reason: RefusalReason): void {
  void recordRefusal(ip, reason);

  // `blocked` is the block already being served; counting it would extend it for free on every
  // retry — a self-inflicted DoS on a client that merely misconfigured its key.
  if (reason !== "blocked") {
    const verdict = rateLimit(`mcp:auth:${ip}`, AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS);
    if (!verdict.allowed) blockedUntil.set(ip, Date.now() + verdict.retryAfterSec * 1000);
  }
  const message = status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Unauthorized";
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    // Standard, and useful to a legitimate client that has misconfigured its key: it can back off
    // rather than spin. Only ever sent with a 429, so it says nothing about any key.
    ...(status === 429
      ? { "retry-after": String(Math.max(1, Math.ceil(((blockedUntil.get(ip) ?? Date.now()) - Date.now()) / 1000))) }
      : {}),
    // No CORS headers, ever. Nothing that would let a page read a response.
  });
  res.end(body);
}

/**
 * DNS-rebinding defence, and the reason this endpoint is safe to run on loopback.
 *
 * A real MCP client is not a browser: it sends no `Origin`. A page performing a rebinding attack
 * cannot suppress one. So **any** `Origin` at all is invalid here — there is no origin from which a
 * browser should legitimately be reaching this endpoint.
 *
 * `Host` is checked for the same reason: rebinding works by resolving an attacker's hostname to
 * 127.0.0.1, so the request arrives with a foreign `Host` while reaching our socket.
 */
function originIsAcceptable(req: IncomingMessage, exposed: boolean, port: number): { ok: true } | { ok: false; reason: RefusalReason } {
  if (req.headers.origin) return { ok: false, reason: "origin" };

  const host = (req.headers.host ?? "").toLowerCase();
  if (!host) return { ok: false, reason: "host" };

  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  // When deliberately exposed, the operator's own hostname is legitimate — but a bare IP or name
  // still has to carry the port we are actually bound to, so a rebound name does not slip through.
  if (!exposed && !allowed.has(host)) return { ok: false, reason: "host" };
  if (exposed && !host.endsWith(`:${port}`)) return { ok: false, reason: "host" };

  return { ok: true };
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      // A body bigger than any legitimate JSON-RPC message is refused rather than buffered.
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/** REFS helpers/mcp/lib/dispatch.ts */
export type Dispatch = (
  message: { method?: string; id?: unknown; params?: unknown },
  auth: { presentedKey: string | undefined; ip: string },
) => Promise<{ status: number; body: unknown } | { refuse: RefusalReason }>;

/**
 * Start listening, if an administrator has switched it on.
 *
 * **Returns without starting when disabled or when no key exists.** "Installed" and "listening" are
 * different states — a fresh install binds no port at all, and a port with no key behind it is a
 * surface with nothing to protect but every reason to be probed.
 * REFS helpers/mcp/helper.ts
 */
export async function startListener(dispatch: Dispatch): Promise<{ started: boolean; port?: number }> {
  if (holder.server) {
    const a = holder.server.address();
    return { started: true, port: a && typeof a === "object" ? a.port : undefined };
  }

  if (!(await isEnabled())) return { started: false };

  const keyCount = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*) AS n FROM ${helperTableName("mcp", "keys")}`,
  );
  if (Number(keyCount[0]?.n ?? 0) === 0) return { started: false };

  /**
   * ⚠ A disabled add-on must not leave a live endpoint behind — unlike most helpers, this one
   * listens whether any module calls it or not, so "AI assistant access" off in Addons must
   * actually mean off.
   *
   * Core fixed this centrally in 1.7.3-beta.4; this stays too, per HELPERS-DESIGN rule 12 (fail
   * closed yourself) — the two cannot conflict, since both only ever refuse to open a socket.
   * Phrased over dependents, not the id `mcp-server`, so it can only ever refuse to start, never
   * open something `isEnabled()` and the key count would not already allow. The real, recoverable
   * control is still the settings switch, reachable via Shared capabilities regardless of enabled
   * state.
   */
  const dependents = dependentsOf("mcp");
  const liveDependents = await prisma.module.count({
    where: { id: { in: dependents.map((d) => d.id) }, enabled: true },
  });
  if (liveDependents === 0) return { started: false };

  const port = await getPort();
  const exposed = await isNetworkExposed();
  const bind = exposed ? "0.0.0.0" : "127.0.0.1";

  const created = createServer((req, res) => void handle(req, res, dispatch, exposed, port));
  holder.server = created;

  await new Promise<void>((resolve, reject_) => {
    created.once("error", reject_);
    created.listen(port, bind, () => resolve());
  });

  return { started: true, port };
}

/**
 * Stop listening, and ⚠ actually release the port. `server.close()` alone is not enough, and
 * fails quietly: it only stops *accepting* new connections and resolves once every existing one
 * has ended, so a single held keep-alive socket keeps the old port bound indefinitely — changing
 * the port then leaves the old one listening until the next restart.
 *
 * So: end the connections rather than wait for them, and bound the close so a stuck socket can
 * never leave this function hanging. The reference is dropped either way, because a `server` that
 * cannot be closed must still never be reused.
 */
const CLOSE_TIMEOUT_MS = 3_000;

/** REFS helpers/mcp/helper.ts */
export async function stopListener(): Promise<void> {
  if (!holder.server) return;
  const s = holder.server;
  // Dropped FIRST: `startListener` returns early when this is set, so if the close below is slow
  // the rebind would otherwise be skipped and the endpoint would end up on neither port.
  holder.server = null;

  // Node 18.2+. Ends held keep-alive sockets instead of waiting for them — the actual fix.
  s.closeAllConnections?.();

  await Promise.race([
    new Promise<void>((resolve) => s.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]);
}

/** REFS helpers/mcp/api.ts · helpers/mcp/ui/settings-panel.tsx */
export const isListening = () => holder.server !== null;

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: Dispatch,
  exposed: boolean,
  port: number,
): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";

  // A blocked source does no work at all — before parsing, the Origin check, or any DB access.
  // Answered 429, not 401: the honest status, revealing only a request count the caller knows.
  if (isBlocked(ip)) {
    return reject(res, 429, ip, "blocked");
  }

  // --- the spec's security warning, first, before anything is parsed ---------
  const origin = originIsAcceptable(req, exposed, port);
  if (!origin.ok) {
    // MUST be 403 when Origin is present and invalid (2025-11-25).
    return reject(res, 403, ip, origin.reason);
  }

  const url = (req.url ?? "").split("?")[0];
  if (url !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }

  // --- GET: we offer no SSE stream, which the spec explicitly allows ---------
  if (req.method === "GET") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  // --- protocol version ------------------------------------------------------
  const version = (req.headers["mcp-protocol-version"] as string | undefined) ?? ASSUMED_VERSION;
  if (!SUPPORTED_VERSIONS.has(version)) {
    // MUST be 400 on an unsupported version.
    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Unsupported MCP-Protocol-Version: ${version}` },
    });
    res.writeHead(400, { "content-type": "application/json" }).end(body);
    return;
  }

  // Authenticated before the body is even read — no key means no JSON parsed, and no learning
  // that `tools/list` exists: the list sits behind auth so a caller cannot enumerate this install.
  const authHeader = (req.headers.authorization as string | undefined) ?? "";
  const presentedKey = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : undefined;
  if (!presentedKey) return reject(res, 401, ip, "no-key");

  const raw = await readBody(req);
  if (raw === null) {
    res.writeHead(413).end();
    return;
  }

  let message: { method?: string; id?: unknown; params?: unknown };
  try {
    message = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }),
    );
    return;
  }

  const outcome = await dispatch(message, { presentedKey, ip });

  if ("refuse" in outcome) return reject(res, 401, ip, outcome.refuse);

  // A notification or response carries no id: the spec requires 202 with no body.
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }

  const body = JSON.stringify(outcome.body);
  res.writeHead(outcome.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export { PROTOCOL_VERSION, MCP_PATH };
