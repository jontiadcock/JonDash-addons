import type { ModuleContext } from "@/lib/modules/types";

/** The last thing that happened, shared by the page and the settings panel. Kept in one
 *  place because a screen that writes an outcome nobody renders looks like a dead button. */

export type Notice = { tone: "ok" | "warn" | "bad"; text: string };

/** REFS addons/docker-manager/page.tsx · addons/docker-manager/ui/settings-panel.tsx */
export async function readNotice(ctx: ModuleContext): Promise<Notice | null> {
  const raw = (await ctx.store?.get("lastNotice")) as { tone?: unknown; text?: unknown; at?: unknown } | null;
  if (!raw || typeof raw.text !== "string" || typeof raw.at !== "string") return null;
  const at = Date.parse(raw.at);
  // Older than two minutes is stale — a message about something you did before lunch reads as
  // a message about what you just did.
  if (!Number.isFinite(at) || Date.now() - at > 120_000) return null;
  return { tone: raw.tone === "bad" || raw.tone === "warn" ? raw.tone : "ok", text: raw.text };
}

/** REFS addons/docker-manager/page.tsx · addons/docker-manager/ui/settings-panel.tsx */
export function noticeColour(tone: Notice["tone"]): string {
  if (tone === "bad") return "var(--danger)";
  if (tone === "warn") return "var(--warning, var(--muted))";
  return "var(--success, inherit)";
}
