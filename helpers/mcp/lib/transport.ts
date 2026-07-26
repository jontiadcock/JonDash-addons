import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
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

let server: Server | null = null;

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
 * The single rejection.
 *
 * **Every auth failure funnels through here** so no caller can distinguish "no key" from "revoked
 * key" from "valid key, deleted account". Same status, same body, every time. The reason travels to
 * the refusal log, never to the client.
 */
function reject(res: ServerResponse, status: number, ip: string, reason: RefusalReason): void {
  void recordRefusal(ip, reason);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32001, message: status === 403 ? "Forbidden" : "Unauthorized" },
  });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
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
  if (server) return { started: true, port: server.address() && typeof server.address() === "object" ? (server.address() as { port: number }).port : undefined };

  if (!(await isEnabled())) return { started: false };

  const keyCount = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*) AS n FROM ${helperTableName("mcp", "keys")}`,
  );
  if (Number(keyCount[0]?.n ?? 0) === 0) return { started: false };

  const port = await getPort();
  const exposed = await isNetworkExposed();
  const bind = exposed ? "0.0.0.0" : "127.0.0.1";

  server = createServer((req, res) => void handle(req, res, dispatch, exposed, port));

  await new Promise<void>((resolve, reject_) => {
    server!.once("error", reject_);
    server!.listen(port, bind, () => resolve());
  });

  return { started: true, port };
}

export async function stopListener(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

export const isListening = () => server !== null;

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: Dispatch,
  exposed: boolean,
  port: number,
): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";

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
