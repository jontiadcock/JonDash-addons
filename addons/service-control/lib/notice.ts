import type { ModuleContext } from "@/lib/modules/types";

/**
 * The last thing that happened, so a screen can say so.
 *
 * Shared by the page AND the settings panel. It lived only in the page at first, which
 * meant the settings panel wrote outcomes nobody ever read: approving a service that
 * needed a grant refused correctly, wrote a perfectly good explanation, and rendered a
 * screen where the button simply appeared to do nothing. Found by clicking it, not by
 * reading the code — a silent failure is invisible to every check that isn't a person.
 */

const KEY = "lastNotice";

export type Notice = { tone: "ok" | "warn" | "bad"; text: string };

/** REFS addons/service-control/actions.ts */
export async function writeNotice(ctx: ModuleContext, tone: Notice["tone"], text: string): Promise<void> {
  // The store serialises for us, so an object saves the read side from parsing — and from
  // having to decide what a malformed string means.
  await ctx.store?.set(KEY, { tone, text, at: new Date().toISOString() });
}

/** REFS addons/service-control/page.tsx · addons/service-control/ui/settings-panel.tsx */
export async function readNotice(ctx: ModuleContext): Promise<Notice | null> {
  const raw = (await ctx.store?.get(KEY)) as { tone?: unknown; text?: unknown; at?: unknown } | null;
  if (!raw || typeof raw.text !== "string" || typeof raw.at !== "string") return null;

  // Older than a couple of minutes is stale. A message about something you did before lunch
  // reads as a message about what you just did.
  const at = Date.parse(raw.at);
  if (!Number.isFinite(at) || Date.now() - at > 120_000) return null;

  const tone = raw.tone === "bad" || raw.tone === "warn" ? raw.tone : "ok";
  return { tone, text: raw.text };
}

/** REFS addons/service-control/page.tsx · addons/service-control/ui/settings-panel.tsx */
export function noticeColour(tone: Notice["tone"]): string {
  if (tone === "bad") return "var(--danger)";
  if (tone === "warn") return "var(--warning, var(--muted))";
  return "var(--success, inherit)";
}
