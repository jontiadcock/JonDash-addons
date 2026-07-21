import { describe, expect, it, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ModuleContext } from "@/lib/modules/types";
import { runCheck, sanitise } from "../lib/checks";

/**
 * Exercises the check runners against a real local HTTP server and real sockets — no
 * mocks, no outside network. What's proven here: status matching, redirect following and
 * capping, timeouts, TCP connect success and refusal, host validation, and that nothing
 * reaches the network without the `network:outbound` grant.
 */

/** A context with only what runCheck looks at; `fetch` present = permission granted. */
function ctx(granted = true): ModuleContext {
  return {
    moduleId: "health-monitor",
    user: null,
    settings: { get: async () => undefined, set: async () => {}, all: async () => ({}) },
    store: { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] },
    ...(granted ? { fetch: globalThis.fetch } : {}),
  };
}

let server: http.Server;
let base: string;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/ok") return void res.writeHead(200).end("fine");
    if (url === "/missing") return void res.writeHead(404).end("nope");
    if (url === "/boom") return void res.writeHead(500).end("bang");
    if (url === "/hop1") return void res.writeHead(302, { location: "/hop2" }).end();
    if (url === "/hop2") return void res.writeHead(302, { location: "/ok" }).end();
    if (url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    if (url === "/hang") return; // accepted, never answered
    res.writeHead(200).end("root");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const http1 = (target: string) => ({ kind: "http" as const, target, port: null });

describe("http checks", () => {
  it("reports a healthy endpoint with phase timings", async () => {
    const out = await runCheck(ctx(), http1(`${base}/ok`), {}, 5000, 30);
    expect(out.state).toBe("up");
    expect(out.code).toBe("200");
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.phases?.totalMs).toBeGreaterThanOrEqual(0);
    expect(out.phases?.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(out.phases?.connectMs).toBeGreaterThanOrEqual(0);
  });

  it("treats an unexpected status as down", async () => {
    const out = await runCheck(ctx(), http1(`${base}/boom`), {}, 5000, 30);
    expect(out.state).toBe("down");
    expect(out.code).toBe("500");
  });

  it("honours an expected status range", async () => {
    const out = await runCheck(ctx(), http1(`${base}/missing`), { expectStatus: "4xx" }, 5000, 30);
    expect(out.state).toBe("up");
    expect(out.code).toBe("404");
  });

  it("follows a redirect chain to its destination", async () => {
    const out = await runCheck(ctx(), http1(`${base}/hop1`), {}, 5000, 30);
    expect(out.state).toBe("up");
    expect(out.code).toBe("200");
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    const out = await runCheck(ctx(), http1(`${base}/loop`), {}, 5000, 30);
    expect(out.state).toBe("down");
    expect(out.message).toMatch(/redirects/);
  });

  it("times out a server that accepts but never answers", async () => {
    const started = Date.now();
    const out = await runCheck(ctx(), http1(`${base}/hang`), {}, 700, 30);
    expect(out.state).toBe("down");
    expect(out.message).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("refuses a non-http scheme", async () => {
    const out = await runCheck(ctx(), http1("file:///etc/passwd"), {}, 2000, 30);
    expect(out.state).toBe("down");
    expect(out.message).toMatch(/valid http/);
  });

  it("reports a refused connection rather than throwing", async () => {
    const out = await runCheck(ctx(), http1("http://127.0.0.1:1"), {}, 2000, 30);
    expect(out.state).toBe("down");
  });
});

describe("tcp checks", () => {
  it("connects to an open port", async () => {
    const out = await runCheck(ctx(), { kind: "tcp", target: "127.0.0.1", port }, {}, 3000, 30);
    expect(out.state).toBe("up");
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a closed port as down", async () => {
    const out = await runCheck(ctx(), { kind: "tcp", target: "127.0.0.1", port: 1 }, {}, 2000, 30);
    expect(out.state).toBe("down");
  });

  it("rejects an out-of-range port", async () => {
    const out = await runCheck(ctx(), { kind: "tcp", target: "127.0.0.1", port: 99_999 }, {}, 2000, 30);
    expect(out.state).toBe("down");
    expect(out.message).toBe("invalid port");
  });
});

describe("host validation", () => {
  const nasty = "127.0.0.1; rm -rf /";

  it.each(["dns", "tls"] as const)("rejects a hostile hostname for %s", async (kind) => {
    const out = await runCheck(ctx(), { kind, target: nasty, port: 443 }, {}, 2000, 30);
    expect(out.state).toBe("down");
    expect(out.message).toBe("invalid host");
  });
});

describe("hostile output from a monitored endpoint", () => {
  it("caps a very long message and keeps it on one line", () => {
    const evil = "x".repeat(5000);
    const out = sanitise({ state: "down", message: evil, code: evil });
    expect(out.message!.length).toBeLessThanOrEqual(201);
    expect(out.code!.length).toBeLessThanOrEqual(65);
  });

  it("strips control characters, so nothing can forge lines in an alert", () => {
    const injected = ["Subject: real", "Bcc: attacker@example.com"].join(String.fromCharCode(13, 10));
    const out = sanitise({ state: "down", message: injected });
    expect(out.message).not.toContain(String.fromCharCode(10));
    expect(out.message).not.toContain(String.fromCharCode(13));
    expect(out.message).toBe("Subject: real Bcc: attacker@example.com");
  });

  it("leaves ordinary text alone", () => {
    const out = sanitise({ state: "up", message: "34d left · Let's Encrypt", code: "34" });
    expect(out.message).toBe("34d left · Let's Encrypt");
    expect(out.code).toBe("34");
  });
});

describe("permission gate", () => {
  it("makes no request at all without network:outbound", async () => {
    const out = await runCheck(ctx(false), http1(`${base}/ok`), {}, 2000, 30);
    expect(out.state).toBe("down");
    expect(out.message).toMatch(/network permission/);
  });
});
