import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { dependentsOf } from "@/lib/helpers/registry";
import { rateLimit } from "@/lib/security/rate-limit";
import { getPort, isEnabled, isNetworkExposed, type RefusalReason } from "./keys";

/**
 * The MCP endpoint. **Streamable HTTP, protocol revision 2025-11-25.**
 *
 * Built against the spec text, read at build time rather than from memory — and that mattered: the
 * revision in my training data (2025-06-18) is superseded, and the current one adds a normative
 * `MUST` to answer **403** on a bad `Origin`, plus a rename of the session header.
 * `PROTOCOL_VERSION` below records exactly what this was written against; when it moves, re-read
 * the spec rather than assuming the difference is cosmetic.
 *
 * ## What this implements, and what it deliberately does not
 *
 * A single endpoint on POST and GET, as required. Nothing here streams — every tool returns a value
 * and returns it now — so POST answers `application/json` rather than opening SSE, and **GET
 * answers 405**, which the spec explicitly permits for a server that offers no SSE stream. That
 * removes resumability, event IDs and stream correlation from the surface entirely: three sources
 * of bugs bought for no capability we need.
 *
 * No session management either. `MCP-Session-Id` is a MAY, and sessions would be a second identity
 * mechanism sitting beside the key — the key already *is* the identity, and one is safer than two.
 *
 * ## The security requirements are the spec's own
 *
 * From the Streamable HTTP security warning, verbatim in force here:
 *
 *   1. Servers **MUST** validate `Origin` on all incoming connections — and answer **403** when it
 *      is present and invalid. This is the DNS-rebinding defence: a web page the operator visits can
 *      make their browser POST to 127.0.0.1, and no amount of TLS prevents it.
 *   2. When local, servers **SHOULD** bind only to 127.0.0.1.
 *   3. Servers **SHOULD** implement proper authentication.
 *
 * This helper treats all three as hard requirements, and adds one of its own: **an unauthenticated
 * caller learns nothing** — not the tool list, not whether a key was close, not whether an account
 * exists. Every rejection is the same status, the same body, and the same shape.
 */

const PROTOCOL_VERSION = "2025-11-25";
/** Assumed when the client sends no version header, per the spec's backwards-compatibility rule. */
const ASSUMED_VERSION = "2025-03-26";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-06-18", "2025-03-26"]);

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 256 * 1024;

/**
 * **The listener is held on `globalThis`, not in a module variable. (AB-01.)**
 *
 * A plain `let server` is per *module instance*, and Next.js loads this file more than once — the
 * copy `instrumentation.ts` uses at boot is not the copy a server action gets. So the boot instance
 * held the socket while `onSettingsSubmit` ran against a second instance whose `server` was still
 * `null`: `stopListener()` saw nothing to close and returned immediately, `startListener()` bound
 * the new port, and the machine ended up with **two live listeners neither instance knew about**.
 *
 * That is why changing the port left the old one serving, and why it survived a fix aimed at
 * keep-alive connections — the close was never reached at all. The same duplication would also make
 * `isListening()` lie to the settings page.
 *
 * A `globalThis` singleton is the standard answer to this in Next (it is what the Prisma client
 * does here) and the only one that makes "is there a listener?" a question with one answer.
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
 * **Per-source backoff, then a temporary block.** (Pentest finding F1, 2026-07-27.)
 *
 * This was documented and surfaced in the UI — the `blocked` refusal reason and its
 * "Too many attempts — temporarily blocked" label both existed — and **nothing ever set it**. A
 * control that is described, typed, given a label, and never written is worse than one that was
 * never claimed: 500 concurrent bad keys were answered instantly, while the settings page implied
 * they would not be.
 *
 * Counting is core's `rateLimit()` — the same sliding window it already uses for login, setup and
 * account actions — rather than a second implementation of the same idea living in an add-on.
 *
 * **Only FAILURES are counted.** A client holding a correct key never fails, so a legitimate
 * assistant can never throttle itself no matter how busy it is. Twenty failures in a minute from
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

  // `blocked` is the block being served; counting it would extend the block for free every time a
  // blocked caller retries, which is a self-inflicted denial of service on a legitimate client
  // that has merely misconfigured its key.
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
   * **A disabled add-on must not leave a live endpoint behind.**
   *
   * `bootHelpers()` used to ignore module state — a helper is not its carrier — and for every other
   * helper that is right, because they only act when a module calls them. This one is different: it
   * listens on a port whether any module ever calls it or not. Without this check, an admin who
   * switched "AI assistant access" off in Addons had done nothing at all, and the screen they used
   * said nothing to the contrary. Someone reasonably believes they closed the door.
   *
   * **Core fixed this centrally in 1.7.3-beta.4** and this check stays anyway, per HELPERS-DESIGN
   * rule 12: fail closed yourself rather than assume core got there first. They cannot conflict —
   * both only ever refuse to open a socket — and this helper's floor is 1.7.3-beta.2, so it must
   * still hold on a core that predates the fix.
   *
   * Phrased over dependents rather than the id `mcp-server`, so it stays true if this helper is
   * ever carried by something else, and so it means what it says: nothing enabled needs this, so
   * nothing listens. It can only ever refuse to start — no arrangement of module state can cause
   * an endpoint that `isEnabled()` and the key count would not already have allowed.
   *
   * The switch in the helper's own settings remains the real control, and stays reachable: the
   * Shared capabilities section lists a helper by whether a module *depends* on it, not by whether
   * that module is enabled. So this is recoverable from the same screen that shows it.
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
 * Stop listening, and **actually release the port**. (AB-01.)
 *
 * `server.close()` alone is not enough, and the way it fails is quiet. It stops *accepting* new
 * connections and resolves only once every existing one has ended — so a single held keep-alive
 * socket keeps the old port bound indefinitely. Changing the port then opened the new one and left
 * the old one listening, on the same process, until the next restart.
 *
 * **That is the ordinary state of a connected MCP client, not an edge case.** Which is why every
 * earlier port test passed: they changed the port with nothing connected, the socket closed
 * instantly, and the bug could not appear.
 *
 * So: end the connections rather than wait for them, and bound the close so a stuck socket can
 * never leave this function hanging — an admin switching the port off a exposed interface must not
 * depend on a client behaving well. The reference is dropped either way, because a `server` that
 * cannot be closed must still never be reused.
 */
const CLOSE_TIMEOUT_MS = 3_000;

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

export const isListening = () => holder.server !== null;

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: Dispatch,
  exposed: boolean,
  port: number,
): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";

  // --- a source serving a block does no work at all --------------------------
  //
  // Before parsing, before the Origin check, before any database access: the whole point is that a
  // caller who has already failed twenty times in a minute stops being able to spend this server's
  // time. Answered 429 rather than the standard 401 — that is the honest status, and it reveals
  // nothing about keys, only about a request count the caller already knows.
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

  // --- authentication, before the body is even read --------------------------
  //
  // A caller with no key does not get to submit JSON for us to parse, and does not get to learn
  // that `tools/list` exists. The tool list is behind auth deliberately: an unauthenticated caller
  // must not be able to enumerate what this install can do.
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
