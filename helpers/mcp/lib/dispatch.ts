import { authorize } from "./authorize";
import { getTool, listFor, toWire } from "./tools";
import { PROTOCOL_VERSION } from "./transport";
import type { Dispatch } from "./transport";
import type { RefusalReason } from "./keys";

/**
 * JSON-RPC dispatch — the layer between an authenticated request and a tool.
 *
 * **Authorization happens here, once, for every method.** No tool checks its own permission; the
 * requirement is declared on the tool and enforced before `run` is called. A check inside a handler
 * is one that can be forgotten, and forgetting it fails open.
 *
 * **Every authorization failure returns the transport's single rejection**, never a JSON-RPC error
 * that says why. A caller must not be able to tell "no such tool" from "tool exists, you may not
 * call it" — that difference maps the install and the permissions of the account behind the key.
 */

type Req = { method?: string; id?: unknown; params?: unknown };

const ok = (id: unknown, result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

/**
 * A JSON-RPC-level error, for things that are NOT authorization and NOT a tool's own outcome:
 * an unknown method, an unknown tool name. A tool that ran and refused returns `isError` instead
 * — see the `tools/call` catch.
 */
const err = (id: unknown, code: number, message: string) => ({
  status: 200,
  body: { jsonrpc: "2.0", id, error: { code, message } },
});

export const dispatch: Dispatch = async (message: Req, auth) => {
  const { method, id, params } = message;

  // `initialize` still requires a valid key. The handshake is not a free endpoint: letting it
  // through unauthenticated would confirm to any caller that this is a JonDash MCP server.
  const identityFor = async (need: Parameters<typeof authorize>[1]) => authorize(auth.presentedKey, need, auth.ip);

  if (method === "initialize") {
    const res = await identityFor({ kind: "read", permission: null });
    if (!res.ok) return { refuse: asRefusal(res.reason) };
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      // Tools only. No resources, no prompts, no sampling — each would be another surface, and
      // none is needed for what this does.
      capabilities: { tools: {} },
      serverInfo: { name: "jondash", title: "JonDash", version: PROTOCOL_VERSION },
    });
  }

  if (method === "notifications/initialized") {
    // A notification: the transport answers 202 and this body is discarded.
    return { status: 202, body: null };
  }

  if (method === "tools/list") {
    const res = await identityFor({ kind: "read", permission: null });
    if (!res.ok) return { refuse: asRefusal(res.reason) };
    return ok(id, { tools: listFor(res.identity).map(toWire) });
  }

  if (method === "tools/call") {
    const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const tool = p.name ? getTool(p.name) : undefined;

    // **Unknown tool and unauthorized tool must be indistinguishable.** So an unknown name is
    // authorized as if it needed nothing, and only then reported as unknown — a caller holding a
    // valid key learns a name was wrong, and a caller without one learns nothing at all.
    const res = await identityFor(
      tool ? { kind: tool.kind, permission: tool.permission } : { kind: "read", permission: null },
    );
    if (!res.ok) return { refuse: asRefusal(res.reason) };
    if (!tool) return err(id, -32602, `Unknown tool: ${String(p.name)}`);

    try {
      const result = await tool.run(p.arguments ?? {}, res.identity);
      return ok(id, {
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      /**
       * **A tool that refuses is a RESULT, not a protocol error.**
       *
       * The spec draws the line at whose problem it is: a malformed request is the caller's and
       * belongs in a JSON-RPC `error`; a tool that ran and declined is an outcome, and goes back
       * as a normal result carrying `isError`. Clients only feed results to the model — a
       * JSON-RPC error is surfaced as a transport failure and frequently never reaches it.
       *
       * That distinction is the whole point here. Every refusal in `tools-act.ts` is written to be
       * READ BY THE ASSISTANT and passed on: "an assistant cannot sign an administrator out — do
       * it from Admin → Sessions." Returned as -32603 that sentence is thrown away and the user
       * gets an opaque failure, so the guard holds but the person never learns what to do instead.
       *
       * The message a tool throws reaches the model. Keep it about the request, never about the
       * internals — a stack trace or a SQL error is an information leak with a model attached.
       */
      return ok(id, {
        content: [{ type: "text", text: e instanceof Error ? e.message : "The tool failed." }],
        isError: true,
      });
    }
  }

  return err(id, -32601, `Method not found: ${String(method)}`);
};

/**
 * Collapse an authorization outcome to a refusal reason for the log.
 *
 * `mode` and `permission` both mean "authenticated, but not allowed" — recorded distinctly for the
 * admin because they mean different things when reading the tripwire, and returned identically to
 * the caller because the difference is exactly what an attacker wants.
 */
function asRefusal(reason: string): RefusalReason {
  if (reason === "mode" || reason === "permission") return "revoked";
  return (reason as RefusalReason) ?? "bad-key";
}
