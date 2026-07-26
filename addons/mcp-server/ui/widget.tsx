import type { ModuleWidgetProps } from "@/lib/modules/types";
import mcp from "@/helpers/mcp/api";

/**
 * The dashboard tile. One question: **is an assistant able to reach this server right now?**
 *
 * Leads with the answer rather than a count, and is deliberately loudest in the state that
 * deserves it — reachable from the network. A tile reading "3 keys" while the endpoint is open to
 * the LAN would be technically true and useless.
 */
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
    <div className="flex flex-col gap-1">
      <span className="text-lg font-medium" style={{ color: tone }}>
        {verdict}
      </span>
      <span className="text-sm" style={{ color: "var(--muted)" }}>
        {s.enabled
          ? `${s.keyCount} key${s.keyCount === 1 ? "" : "s"} · ${s.toolCount} tools`
          : "No assistant can reach this server."}
      </span>
      {s.lastUsedAt && (
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          Last used {new Date(s.lastUsedAt).toLocaleString()}
        </span>
      )}
      {s.enabled && !s.listening && (
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          Switched on, but no keys exist — so no port is open.
        </span>
      )}
    </div>
  );
}
