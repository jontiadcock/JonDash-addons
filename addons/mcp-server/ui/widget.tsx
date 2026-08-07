import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import mcp from "@/helpers/mcp/api";

/**
 * The dashboard tile — one question: is an assistant able to reach this server right now? Leads
 * with the answer, not a count: "3 keys" while open to the LAN would be technically true and
 * useless.
 * ⚠ Draws its OWN card and title — the dashboard hands a widget only a bare grid cell.
 * Resizes per core's two thresholds (JonDash 1.8.0 B5/B6): lines drop bottom-up as the tile
 * shrinks; at 1×1, the verdict alone, in its own colour.
 *
 * ⚠ `exposed` is the one that matters: reachable-from-network must stay legible at EVERY size — a
 * security state shrunk into invisibility is the worst failure this tile could have. So 1×1 is
 * never a neutral "on": it is the word `LAN`, in the danger colour.
 */

/**
 * Makes THIS WIDGET its own size container, so the figure below can be capped against card HEIGHT
 * as well as width.
 *
 * Core leaves the dashboard frame on `container-type: inline-size`, so `cqh` there would silently
 * resolve against the viewport. Size containment on the widget root fixes that for our subtree
 * only — root is full-height inside a sized grid cell, so its height is definite, and any damage
 * from that assumption being wrong stays confined to this one tile, not the whole dashboard.
 *
 * Child container-query classes now resolve against this element instead of the frame; same
 * width, so nothing else changes.
 */
const SIZE_CONTAINER = { containerType: "size" } as const;

const MODULE_PATH = "/m/mcp-server";
/** REFS addons/mcp-server/module.ts */
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
    <div
      className="card flex h-full min-w-0 flex-col justify-center overflow-hidden p-2 @[8rem]:p-4"
      style={SIZE_CONTAINER}
    >
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
      {/* Scales with the tile so a large card leads with the state rather than a 14px line.
          Capped against the HEIGHT as well, so a wide short tile does not push the lines below it
          out of the card. cqh works here only because the root declares size containment. */}
      <p
        className="mt-1 hidden truncate font-medium @[6rem]:block"
        style={{ color: tone, fontSize: "min(clamp(0.75rem, 4cqw, 2.5rem), 18cqh)" }}
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
