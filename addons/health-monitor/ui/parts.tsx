import type { MonitorState } from "../lib/types";
import type { HourBucket } from "../lib/store";
import { stateColour } from "../lib/format";

/**
 * The module's presentational pieces. All server components — nothing here needs
 * interactivity, so the module ships no client JavaScript at all.
 *
 * Charts are hand-drawn SVG on purpose: a charting library would be a new dependency in
 * an app that keeps its install small, and a status strip is a row of rectangles.
 */

/**
 * Status colours, scoped to `.hm` so nothing leaks into the base app's stylesheet, with
 * a dark variant matching how the core defines its own tokens.
 */
export function HealthStyles() {
  return (
    <style>{`
.hm { --hm-up:#16a34a; --hm-degraded:#d97706; --hm-down:#dc2626; --hm-unknown:#94a3b8; }
@media (prefers-color-scheme: dark) {
  .hm { --hm-up:#4ade80; --hm-degraded:#fbbf24; --hm-down:#f87171; --hm-unknown:#64748b; }
}
.hm-dot { display:inline-block; border-radius:9999px; flex:none; }
.hm-bar { transition:none; }
`}</style>
  );
}

export function StatusDot({ state, size = 10 }: { state: MonitorState; size?: number }) {
  return (
    <span
      className="hm-dot"
      style={{ width: size, height: size, background: stateColour(state) }}
      aria-hidden="true"
    />
  );
}

/** Which state an hour of checks represents. No checks = no data, not "healthy". */
function bucketState(b: HourBucket): MonitorState {
  if (b.checks === 0) return "unknown";
  if (b.failures > b.checks / 2) return "down";
  if (b.failures > 0 || b.degraded > 0) return "degraded";
  return "up";
}

/**
 * One bar per hour, oldest on the left. Bars are drawn at a fixed size and the SVG
 * scales to its container, so the same strip works in a narrow widget and a wide page.
 */
export function StatusStrip({ buckets, height = 22 }: { buckets: HourBucket[]; height?: number }) {
  const barWidth = 4;
  const gap = 2;
  const width = buckets.length * (barWidth + gap) - gap;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Hourly status for the last ${buckets.length} hours`}
    >
      {buckets.map((b, i) => {
        const state = bucketState(b);
        return (
          <rect
            key={b.hour}
            className="hm-bar"
            x={i * (barWidth + gap)}
            y={0}
            width={barWidth}
            height={height}
            rx={1}
            fill={stateColour(state)}
            opacity={state === "unknown" ? 0.25 : 1}
          >
            <title>
              {`${b.hour.replace("T", " ")}:00 — ${
                b.checks === 0 ? "no checks" : `${b.checks} checks, ${b.failures} failed`
              }`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

/** A latency trace. Flat line when every sample is identical, empty when there's nothing. */
export function Sparkline({
  values,
  height = 40,
  colour = "var(--primary)",
}: {
  values: number[];
  height?: number;
  colour?: string;
}) {
  if (values.length < 2) {
    return (
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Not enough data yet.
      </p>
    );
  }
  const width = 300;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Response time trend, ${Math.round(min)} to ${Math.round(max)} milliseconds`}
    >
      <polyline points={points} fill="none" stroke={colour} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A labelled figure, used for the uptime and latency read-outs. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {label}
      </p>
      <p className="text-lg font-medium">{value}</p>
      {hint ? (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
