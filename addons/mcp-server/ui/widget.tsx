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
 *
 * # Sizing (JonDash 1.8.0 B5/B6)
 *
 * Four short lines, so this one mostly survived being resized — but "mostly" is not the bar when
 * the frame **clips rather than scrolls**. Core's two thresholds now decide what appears, and the
 * lines drop from the bottom up: at 1×1 the verdict alone, in its own colour.
 *
 * **The one that matters here is `exposed`.** If the endpoint is open to the network, that must be
 * legible at *every* size — a security state the user shrank into invisibility is the worst
 * possible failure for this particular tile. So the 1×1 form is not a neutral "on": it is the word
 * `LAN`, in the danger colour.
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

  // Never let "reachable from the network" be the state that vanishes when the tile is small.
  const short = !s.enabled ? "Off" : !s.listening ? "—" : s.exposed ? "LAN" : "On";

  const tone = !s.listening
    ? "var(--muted)"
    : s.exposed
      ? "var(--danger)"
      : "var(--text-success, inherit)";

  return (
    <div className="card flex h-full min-w-0 flex-col overflow-hidden p-2 @[8rem]:p-4">
      <div className="hidden items-center justify-between gap-2 @[6rem]:flex">
        <p className="truncate text-xs font-medium @[8rem]:text-sm">AI assistant access</p>
        <Link
          href={MODULE_PATH}
          className="hidden shrink-0 text-xs @[8rem]:inline"
          style={{ color: "var(--primary)" }}
        >
          open
        </Link>
      </div>

      <p className="truncate font-medium @[6rem]:hidden" style={{ color: tone }}>
        {short}
      </p>
      <p
        className="mt-1 hidden truncate text-xs font-medium @[6rem]:block @[8rem]:text-sm"
        style={{ color: tone }}
      >
        {verdict}
      </p>

      <p
        className="mt-1 hidden truncate text-xs @[6rem]:block"
        style={{ color: "var(--muted)" }}
      >
        {s.enabled
          ? `${s.keyCount} key${s.keyCount === 1 ? "" : "s"} · ${s.toolCount} tools`
          : "No assistant can reach this server."}
      </p>

      {s.lastUsedAt && (
        <p
          className="mt-1 hidden truncate text-xs @[8rem]:block"
          style={{ color: "var(--muted)" }}
        >
          Last used {new Date(s.lastUsedAt).toLocaleString()}
        </p>
      )}
      {s.enabled && !s.listening && (
        <p
          className="mt-1 hidden truncate text-xs @[8rem]:block"
          style={{ color: "var(--muted)" }}
        >
          Switched on, but no keys exist — so no port is open.
        </p>
      )}
    </div>
  );
}
