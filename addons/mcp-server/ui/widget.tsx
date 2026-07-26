import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import mcp from "@/helpers/mcp/api";

/**
 * The dashboard tile. One question: **is an assistant able to reach this server right now?**
 *
 * Leads with the answer rather than a count, and is deliberately loudest in the state that
 * deserves it — reachable from the network. A tile reading "3 keys" while the endpoint is open to
 * the LAN would be technically true and useless.
 *
 * **It draws its OWN card and title.** The dashboard hands a widget a bare grid cell and nothing
 * else. Without this the tile rendered as loose text reading "Off / No assistant can reach this
 * server" — no name saying what was off, and no way to click through. Found by loading the
 * dashboard; a build says nothing about it.
 */

const MODULE_PATH = "/m/mcp-server";
export default async function McpWidget({ ctx }: ModuleWidgetProps) {
  const s = await mcp(ctx).status();

  const verdict = !s.enabled
    ? "Off"
    : !s.listening
      ? "On, not listening"
      : s.exposed
        ? "Open to your network"
        : "Listening on this machine";

  const tone = !s.listening
    ? "var(--muted)"
    : s.exposed
      ? "var(--danger)"
      : "var(--text-success, inherit)";

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">AI assistant access</p>
        <Link href={MODULE_PATH} className="text-sm" style={{ color: "var(--primary)" }}>
          open
        </Link>
      </div>

      <p className="mt-1 text-sm font-medium" style={{ color: tone }}>
        {verdict}
      </p>

      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        {s.enabled
          ? `${s.keyCount} key${s.keyCount === 1 ? "" : "s"} · ${s.toolCount} tools`
          : "No assistant can reach this server."}
      </p>

      {s.lastUsedAt && (
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Last used {new Date(s.lastUsedAt).toLocaleString()}
        </p>
      )}
      {s.enabled && !s.listening && (
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Switched on, but no keys exist — so no port is open.
        </p>
      )}
    </div>
  );
}
