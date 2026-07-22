import "server-only";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import type { ModuleContext } from "@/lib/modules/types";
import type { CheckOutcome, MonitorConfig, MonitorKind, Phases } from "./types";

/**
 * The check runners. One function per monitor kind; each returns a CheckOutcome and
 * never throws — a failure is a result, not an exception, so one unreachable host can't
 * take down the scheduler.
 *
 * Why Node's clients rather than `ctx.fetch`: `fetch` can't report where the time went
 * (DNS vs connect vs TLS vs first byte), and can't speak TCP, ICMP, DNS or read a
 * certificate at all. So the checks use node:http(s)/net/tls/dns directly — but every
 * one of them is gated on `ctx.fetch` being present, i.e. on the admin having granted
 * `network:outbound`. Without that grant this module makes no outbound contact.
 *
 * Targets are admin-configured and private/LAN addresses are expected (that is the
 * point of a self-hosted dashboard), so there is no address blocklist. The guarantees
 * that do apply: http/https only, a hard deadline on every check, capped redirects, no
 * cookies or credentials, a capped response read, and a strict host pattern before any
 * hostname reaches the operating system.
 */

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Hostnames and IPs we are willing to hand to a socket or to the OS `ping`. */
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,252}[a-zA-Z0-9])?$/;

function down(message: string, code?: string): CheckOutcome {
  return { state: "down", message, code };
}

function ms(from: bigint): number {
  return Number(process.hrtime.bigint() - from) / 1e6;
}

/** Reject anything that isn't a plain http(s) URL before we contact it. */
function parseHttpUrl(target: string): URL | null {
  try {
    const u = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

function validHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  return HOST_RE.test(host) || net.isIP(host) > 0;
}

/** Whether an HTTP status satisfies the monitor's expectation. */
function statusMatches(status: number, expect: MonitorConfig["expectStatus"]): boolean {
  if (expect === undefined || expect === "") return status >= 200 && status < 400;
  if (typeof expect === "number") return status === expect;
  const want = String(expect).trim().toLowerCase();
  if (/^\d+$/.test(want)) return status === Number(want);
  if (/^[1-5]xx$/.test(want)) return Math.floor(status / 100) === Number(want[0]);
  const range = want.match(/^(\d{3})\s*-\s*(\d{3})$/);
  if (range) return status >= Number(range[1]) && status <= Number(range[2]);
  return status >= 200 && status < 400;
}

/**
 * One HTTP(S) request, timed by phase. Redirects are followed manually so each hop is
 * bounded and the final URL is known; the body is read (and discarded) up to a cap so
 * "total" means what a browser would experience, not just time to first byte.
 */
function httpOnce(
  url: URL,
  cfg: MonitorConfig,
  timeoutMs: number,
  startedAt: bigint,
): Promise<{ status: number; location?: string; phases: Phases }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    // A fresh agent per check: Node's global agent keeps sockets alive, which would
    // hide the connect and TLS phases on every check after the first.
    const agent = secure
      ? new https.Agent({ keepAlive: false, maxSockets: 1 })
      : new http.Agent({ keepAlive: false, maxSockets: 1 });

    let dnsAt: number | undefined;
    let connectAt: number | undefined;
    let tlsAt: number | undefined;
    let settled = false;

    const options: https.RequestOptions = {
      method: (cfg.method ?? "GET").toUpperCase(),
      headers: { "user-agent": "JonDash-health-monitor", accept: "*/*", ...(cfg.headers ?? {}) },
      agent,
      rejectUnauthorized: !cfg.insecureTls,
      setHost: true,
    };

    const onResponse = (res: http.IncomingMessage) => {
      const ttfbMs = ms(startedAt);
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) res.destroy();
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        agent.destroy();
        resolve({
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === "string" ? res.headers.location : undefined,
          phases: { dnsMs: dnsAt, connectMs: connectAt, tlsMs: tlsAt, ttfbMs, totalMs: ms(startedAt) },
        });
      };
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", finish);
    };

    const req = secure ? https.request(url, options, onResponse) : http.request(url, options, onResponse);

    req.on("socket", (socket: net.Socket) => {
      socket.on("lookup", () => (dnsAt = ms(startedAt)));
      socket.on("connect", () => (connectAt = ms(startedAt)));
      // Only a TLS socket emits this; harmless on a plain one.
      (socket as tls.TLSSocket).on("secureConnect", () => (tlsAt = ms(startedAt)));
    });

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      agent.destroy();
      reject(err);
    };

    const deadline = setTimeout(() => fail(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on("error", fail);
    req.end();
  });
}

async function runHttp(target: string, cfg: MonitorConfig, timeoutMs: number): Promise<CheckOutcome> {
  let url = parseHttpUrl(target);
  if (!url) return down("not a valid http(s) URL");

  const startedAt = process.hrtime.bigint();
  let hops = 0;
  try {
    for (;;) {
      const remaining = Math.max(250, timeoutMs - Math.round(ms(startedAt)));
      const res = await httpOnce(url, cfg, remaining, startedAt);

      // Follow redirects by default and judge the destination — a 302 is not an answer.
      // The exception is a monitor that explicitly expects this 3xx, i.e. someone
      // checking that a redirect is in place; then the redirect *is* the result.
      const explicit = cfg.expectStatus !== undefined && cfg.expectStatus !== "";
      const wantsThisRedirect = explicit && statusMatches(res.status, cfg.expectStatus);
      const redirecting = res.status >= 300 && res.status < 400 && res.location;
      if (redirecting && !wantsThisRedirect) {
        if (++hops > MAX_REDIRECTS) return down(`more than ${MAX_REDIRECTS} redirects`, String(res.status));
        const next = parseHttpUrl(new URL(res.location!, url).toString());
        if (!next) return down("redirected to a non-http(s) URL", String(res.status));
        url = next;
        continue;
      }

      const latencyMs = Math.round(res.phases.totalMs);
      const phases: Phases = {
        dnsMs: res.phases.dnsMs === undefined ? undefined : Math.round(res.phases.dnsMs),
        connectMs: res.phases.connectMs === undefined ? undefined : Math.round(res.phases.connectMs),
        tlsMs: res.phases.tlsMs === undefined ? undefined : Math.round(res.phases.tlsMs),
        ttfbMs: res.phases.ttfbMs === undefined ? undefined : Math.round(res.phases.ttfbMs),
        totalMs: latencyMs,
      };
      if (!statusMatches(res.status, cfg.expectStatus)) {
        return { state: "down", latencyMs, code: String(res.status), message: `HTTP ${res.status}`, phases };
      }
      return { state: "up", latencyMs, code: String(res.status), message: `HTTP ${res.status}`, phases };
    }
  } catch (e) {
    return down(e instanceof Error ? e.message : String(e));
  }
}

function runTcp(host: string, port: number, timeoutMs: number): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    if (!validHost(host)) return resolve(down("invalid host"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve(down("invalid port"));

    const startedAt = process.hrtime.bigint();
    const socket = new net.Socket();
    let settled = false;
    const end = (outcome: CheckOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const latencyMs = Math.round(ms(startedAt));
      end({ state: "up", latencyMs, message: `connected to port ${port}`, phases: { connectMs: latencyMs, totalMs: latencyMs } });
    });
    socket.once("timeout", () => end(down(`timed out after ${timeoutMs}ms`)));
    socket.once("error", (err: NodeJS.ErrnoException) => end(down(err.code ?? err.message)));
    socket.connect(port, host);
  });
}

/**
 * "Can this name be resolved?" — the way an application would resolve it, through the
 * operating system (hosts file, VPN and split-horizon rules, whatever the box is
 * actually configured to use).
 *
 * This is the default because the alternative, querying the configured DNS server
 * directly, reports a failure on a great many normal self-hosted setups: a Pi-hole or
 * router-based resolver that only answers on an interface Node isn't querying, or a
 * machine whose listed nameserver is 127.0.0.1 behind something that isn't up yet. That
 * is a false outage, and a monitor that cries wolf is worse than no monitor.
 */
async function runDnsLookup(host: string, timeoutMs: number): Promise<CheckOutcome> {
  const startedAt = process.hrtime.bigint();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      dns.promises.lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const latencyMs = Math.round(ms(startedAt));
    const addresses = result.map((a) => a.address);
    if (addresses.length === 0) return { state: "down", latencyMs, message: "no address returned" };
    return {
      state: "up",
      latencyMs,
      code: addresses[0],
      message: `resolved to ${addresses.slice(0, 3).join(", ")}`,
      phases: { dnsMs: latencyMs, totalMs: latencyMs },
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return down("name does not resolve", code);
    return down(e instanceof Error ? e.message : String(e), code);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Query the configured DNS server directly — used when a specific record is asked for. */
async function runDnsQuery(host: string, cfg: MonitorConfig, timeoutMs: number): Promise<CheckOutcome> {
  const type = cfg.recordType ?? "A";
  const resolver = new dns.promises.Resolver();
  const startedAt = process.hrtime.bigint();

  const timer = setTimeout(() => resolver.cancel(), timeoutMs);
  try {
    // resolve() is overloaded per record type; the cast picks one signature, and the
    // runtime shape (strings for A/CNAME/NS, objects for MX/TXT) is handled below.
    const answers: unknown = await resolver.resolve(host, type as "A");
    const flat = (Array.isArray(answers) ? answers : [answers]).map((a) =>
      typeof a === "string" ? a : JSON.stringify(a),
    );
    const latencyMs = Math.round(ms(startedAt));
    if (flat.length === 0) return { state: "down", latencyMs, message: `no ${type} record` };
    if (cfg.expectValue && !flat.some((a) => a.includes(cfg.expectValue!))) {
      return { state: "down", latencyMs, code: flat[0], message: `expected ${cfg.expectValue}, got ${flat.join(", ")}` };
    }
    return {
      state: "up",
      latencyMs,
      code: flat[0],
      message: `${type} → ${flat.slice(0, 3).join(", ")}`,
      phases: { dnsMs: latencyMs, totalMs: latencyMs },
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ECANCELLED") return down(`timed out after ${timeoutMs}ms`, code);
    // Naming the server turns an opaque ECONNREFUSED into something actionable.
    if (code === "ECONNREFUSED" || code === "ESERVFAIL" || code === "ETIMEOUT") {
      const server = dns.getServers()[0] ?? "the configured server";
      return down(`DNS server ${server} did not answer (${code})`, code);
    }
    return down(code ?? String(e), code);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ICMP, via the framework. `ctx.net.ping` resolves round-trip milliseconds, or null when
 * the host simply didn't answer — which is an ordinary monitor result, not an error. It
 * throws only on a host it won't accept, and that is worth reporting as a failed check
 * rather than letting it escape.
 */
async function runPing(
  net: NonNullable<ModuleContext["net"]>,
  host: string,
  timeoutMs: number,
): Promise<CheckOutcome> {
  try {
    const latencyMs = await net.ping(host, { timeoutMs });
    if (latencyMs === null) return down(`no reply within ${timeoutMs}ms`);
    return {
      state: "up",
      latencyMs: Math.round(latencyMs),
      message: `replied in ${Math.round(latencyMs)}ms`,
      phases: { totalMs: Math.round(latencyMs) },
    };
  } catch (e) {
    return down(e instanceof Error ? e.message : String(e));
  }
}

/**
 * A plain "does it resolve?" goes through the OS; asking for a specific record type or
 * an expected value means a real DNS query is what was wanted.
 */
async function runDns(host: string, cfg: MonitorConfig, timeoutMs: number): Promise<CheckOutcome> {
  if (!validHost(host)) return down("invalid host");
  const wantsSpecificAnswer = Boolean(cfg.recordType || cfg.expectValue);
  return wantsSpecificAnswer ? runDnsQuery(host, cfg, timeoutMs) : runDnsLookup(host, timeoutMs);
}

/**
 * Read the certificate a host presents. Validation is deliberately not enforced here —
 * an expired or self-signed certificate is exactly what we want to report on, and a
 * rejected connection would tell us nothing about why.
 */
function runTls(host: string, port: number, cfg: MonitorConfig, timeoutMs: number, warnDays: number): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    if (!validHost(host)) return resolve(down("invalid host"));

    const startedAt = process.hrtime.bigint();
    let settled = false;
    const socket = tls.connect(
      { host, port: port || 443, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false },
      () => {
        if (settled) return;
        settled = true;
        const latencyMs = Math.round(ms(startedAt));
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        // Node has reported this as a bare code string and as an Error across versions.
        const rawAuthError: unknown = socket.authorizationError;
        const authError =
          typeof rawAuthError === "string"
            ? rawAuthError
            : rawAuthError instanceof Error
              ? ((rawAuthError as { code?: string }).code ?? rawAuthError.message)
              : "";
        socket.end();

        if (!cert || !cert.valid_to) return resolve(down("no certificate presented"));
        const expiresAt = new Date(cert.valid_to);
        const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);
        const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? "unknown issuer";
        const threshold = cfg.certWarnDays ?? warnDays;

        if (daysLeft < 0) {
          return resolve({ state: "down", latencyMs, code: String(daysLeft), message: `certificate expired ${-daysLeft}d ago` });
        }
        // A self-signed certificate is normal on a LAN box; report its expiry rather
        // than refusing to look at it. Anything else untrusted is a real failure.
        if (!authorized && authError && !/SELF_SIGNED/i.test(authError) && !cfg.insecureTls) {
          return resolve({ state: "down", latencyMs, code: authError, message: `certificate not trusted: ${authError}` });
        }
        return resolve({
          state: daysLeft <= threshold ? "degraded" : "up",
          latencyMs,
          code: String(daysLeft),
          message: `${daysLeft}d left · ${issuer}`,
          phases: { tlsMs: latencyMs, totalMs: latencyMs },
        });
      },
    );

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(down(msg));
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => fail(`timed out after ${timeoutMs}ms`));
    socket.once("error", (err: NodeJS.ErrnoException) => fail(err.code ?? err.message));
  });
}

const MAX_MESSAGE = 200;
const MAX_CODE = 64;

/**
 * Everything a monitored endpoint hands back is hostile input: a TXT record, a
 * certificate's issuer field and a socket error message all end up in the UI, in an
 * email and in a webhook body. So every outcome is length-capped and stripped of control
 * characters at this one boundary, rather than trusting each runner to behave.
 */
export function sanitise(outcome: CheckOutcome): CheckOutcome {
  const clean = (s: string | undefined, max: number) => {
    if (s === undefined) return undefined;
    const stripped = Array.from(s)
      .map((ch) => (ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127 ? " " : ch))
      .join("");
    const flat = stripped.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };
  return { ...outcome, message: clean(outcome.message, MAX_MESSAGE), code: clean(outcome.code, MAX_CODE) };
}

/**
 * Run one check. `ctx.fetch` is the permission gate: it exists only when the admin
 * granted `network:outbound`, so without it nothing reaches the network.
 */
export async function runCheck(
  ctx: ModuleContext,
  monitor: { kind: MonitorKind; target: string; port: number | null },
  cfg: MonitorConfig,
  timeoutMs: number,
  certWarnDays: number,
): Promise<CheckOutcome> {
  if (!ctx.fetch) return down("network permission not granted");

  switch (monitor.kind) {
    case "http":
      return sanitise(await runHttp(monitor.target, cfg, timeoutMs));
    case "tcp":
      return sanitise(await runTcp(monitor.target, monitor.port ?? 0, timeoutMs));
    case "ping":
      if (!ctx.net) return down("this JonDash version cannot run ping checks");
      return sanitise(await runPing(ctx.net, monitor.target, timeoutMs));
    case "dns":
      return sanitise(await runDns(monitor.target, cfg, timeoutMs));
    case "tls":
      return sanitise(await runTls(monitor.target, monitor.port ?? 443, cfg, timeoutMs, certWarnDays));
    default:
      return down(`unknown check type: ${String(monitor.kind)}`);
  }
}
