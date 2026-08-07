"use client";

import { useState } from "react";
import type { ReactNode } from "react";

/**
 * ⚠ Owns pointer state and NOTHING else. The SVG is built by a server component and handed over
 * as `children`, so a chart still draws with JavaScript off — this only adds the readout. Moving
 * the plotting in here would mean a blank card for anyone with scripting disabled.
 *
 * Positions arrive as fractions of the viewBox, so this never needs to know either chart's scale.
 *
 * REFS addons/health-monitor/ui/parts.tsx › LatencyChart() · SpeedChart()
 */
export type ChartPoint = {
  /** Horizontal position as a fraction of the plot width, 0 to 1. */
  x: number;
  /** Vertical position as a fraction of the plot height, 0 at the top. Null for a gap. */
  y: number | null;
  label: string;
  detail: string;
};

/** REFS addons/health-monitor/ui/parts.tsx › LatencyChart() · SpeedChart() — the only callers. */
export function ChartHover({
  points,
  height,
  children,
}: {
  points: ChartPoint[];
  height: number;
  children: ReactNode;
}) {
  const [at, setAt] = useState<number | null>(null);

  function move(e: React.PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const frac = (e.clientX - box.left) / box.width;
    // Nearest point rather than the one under the cursor: between two samples the reading a
    // person means is the closer one, not whichever happens to be to the left.
    let best = 0;
    let bestGap = Infinity;
    for (const [i, p] of points.entries()) {
      const gap = Math.abs(p.x - frac);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    setAt(best);
  }

  const hit = at === null ? null : points[at];
  const showDot = hit && hit.y !== null;

  return (
    <div
      className="relative"
      onPointerMove={move}
      onPointerLeave={() => setAt(null)}
      style={{ touchAction: "pan-y" }}
    >
      {children}

      {hit ? (
        <>
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: `${hit.x * 100}%`,
              top: 0,
              height,
              width: 1,
              background: "var(--border)",
              pointerEvents: "none",
            }}
          />
          {showDot ? (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: `${hit.x * 100}%`,
                top: (hit.y as number) * height,
                width: 9,
                height: 9,
                marginLeft: -4.5,
                marginTop: -4.5,
                borderRadius: "9999px",
                background: "var(--primary)",
                // A ring in the card colour keeps the dot legible where it sits on the line.
                boxShadow: "0 0 0 2px var(--card, var(--bg))",
                pointerEvents: "none",
              }}
            />
          ) : null}
          <span
            className="text-xs"
            style={{
              position: "absolute",
              // Flip to the left near the right edge so the readout never leaves the card.
              left: hit.x > 0.6 ? undefined : `${hit.x * 100}%`,
              right: hit.x > 0.6 ? `${(1 - hit.x) * 100}%` : undefined,
              top: 0,
              marginLeft: hit.x > 0.6 ? undefined : 8,
              marginRight: hit.x > 0.6 ? 8 : undefined,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              color: "var(--muted)",
            }}
          >
            <span style={{ color: "var(--fg, inherit)" }}>{hit.detail}</span> · {hit.label}
          </span>
        </>
      ) : null}
    </div>
  );
}
