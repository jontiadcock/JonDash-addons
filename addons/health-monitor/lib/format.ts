import type { MonitorState } from "./types";

/** Small display helpers. Pure, dependency-free, safe for any component to import. */

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 1) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(seconds / 86_400)}d`;
}

export function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 10) return "just now";
  return `${formatDuration(seconds)} ago`;
}

export function formatUptime(pct: number, checks: number): string {
  if (checks === 0) return "no data";
  return `${pct.toFixed(pct >= 99.95 || pct === 100 ? 0 : 2)}%`;
}

export const STATE_LABEL: Record<MonitorState, string> = {
  up: "Up",
  degraded: "Degraded",
  down: "Down",
  unknown: "Not checked",
};

/** The CSS variable carrying each state's colour (defined by HealthStyles). */
export function stateColour(state: MonitorState): string {
  return `var(--hm-${state})`;
}

/** Overall state across a set of monitors — the worst one wins. */
export function worstState(states: MonitorState[]): MonitorState {
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("up")) return "up";
  return "unknown";
}
