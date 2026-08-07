import type { MonitorState } from "../lib/types";
import type { HourBucket, LatencyBucket } from "../lib/store";
import { ChartHover, type ChartPoint } from "./chart-client";
import { stateColour } from "../lib/format";

/**
 * The module's presentational pieces. Server components — the one piece of browser code is the
 * pointer readout in `chart-client.tsx`, which wraps a chart rather than drawing it, so every
 * chart here still renders with JavaScript switched off.
 *
 * Charts are hand-drawn SVG on purpose: a charting library would be a new dependency in
 * an app that keeps its install small, and a status strip is a row of rectangles.
 */

/**
 * Status colours, scoped to `.hm` so nothing leaks into the base app's stylesheet, with
 * a dark variant matching how the core defines its own tokens.
 *
 * REFS addons/health-monitor/page.tsx · addons/health-monitor/ui/settings-panel.tsx ·
 *      addons/health-monitor/widget.tsx
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

/**
 * REFS addons/health-monitor/page.tsx · addons/health-monitor/ui/settings-panel.tsx ·
 *      addons/health-monitor/widget.tsx
 */
export function StatusDot({ state, size = 10 }: { state: MonitorState; size?: number }) {
  return (
    <span
      className="hm-dot"
      style={{ width: size, height: size, background: stateColour(state) }}
      aria-hidden="true"
    />
  );
}

/**
 * The 24-hour strip drawn INSIDE a row rather than under it — absolutely positioned into the
 * row's bottom padding, so it costs no height.
 *
 * That sounds like a detail and is the whole reason the widget survives being resized: a strip
 * on its own line made every row ~34px tall against a one-grid-unit tile's ~19px, so those rows
 * spilled straight out of the card. A container query can only report WIDTH, so a wide-and-short
 * widget will say there's room when there is none — never add height here, overlay instead.
 *
 * REFS addons/health-monitor/widget.tsx
 */
export function InlineStatusStrip({ buckets }: { buckets: HourBucket[] }) {
  return (
    <span
      aria-hidden="true"
      style={{ position: "absolute", insetInline: 0, bottom: 0, height: 3, opacity: 0.85 }}
    >
      <StatusStrip buckets={buckets} height={3} />
    </span>
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
 * REFS addons/health-monitor/page.tsx
 */
export function StatusStrip({
  buckets,
  height = 22,
  maxWidth,
}: {
  buckets: HourBucket[];
  height?: number;
  /** Cap the drawn width. 24 bars stretched across a wide card read as loose blocks
   *  rather than a timeline, so give the strip a sensible maximum on roomy layouts. */
  maxWidth?: number;
}) {
  // The SVG stretches to its container, so what matters is the ratio: a thin gap keeps
  // the bars reading as one continuous timeline.
  const barWidth = 10;
  const gap = 1.5;
  const width = buckets.length * (barWidth + gap) - gap;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      style={maxWidth ? { maxWidth, display: "block" } : undefined}
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

/**
 * A latency trace. Flat line when every sample is identical, empty when there's nothing.
 * REFS addons/health-monitor/page.tsx
 */
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

/** Round up to a readable axis top — 137 becomes 150, 1,180 becomes 1,200. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}

/**
 * Response time over days, with the slow tail drawn as a band behind the average.
 *
 * ⚠ An hour with no checks is a BREAK in the line, never a zero — zero reads as "instant",
 * the opposite of what happened. Null `avgMs` splits the polyline into segments.
 *
 * The failure ticks are the point of this over a plain latency trace: they answer "was it slow
 * *because* it was struggling", from counts already stored beside the timings.
 *
 * REFS addons/health-monitor/lib/store.ts › latencyBuckets() — the shape this draws
 *      addons/health-monitor/page.tsx › MonitorDetail()
 */
export function LatencyChart({
  buckets,
  height = 150,
  dayLabels = true,
}: {
  buckets: LatencyBucket[];
  height?: number;
  dayLabels?: boolean;
}) {
  const withData = buckets.filter((b) => b.avgMs != null);
  if (withData.length < 2) {
    return (
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Not enough history yet — this fills in as checks run.
      </p>
    );
  }

  const W = 720;
  const padL = 40, padR = 6, padT = 6, padB = dayLabels ? 26 : 8, tickH = 12;
  const plotH = height - padT - padB - tickH;
  const max = niceMax(Math.max(...withData.map((b) => b.p95Ms ?? b.avgMs ?? 0)));
  const x = (i: number) => padL + (i / Math.max(1, buckets.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  // The band is one polygon: p95 left-to-right, then the average back again.
  const top: string[] = [];
  const bottom: string[] = [];
  const segments: string[][] = [];
  let run: string[] = [];
  for (const [i, b] of buckets.entries()) {
    if (b.avgMs == null) {
      if (run.length) segments.push(run);
      run = [];
      continue;
    }
    run.push(`${x(i).toFixed(1)},${y(b.avgMs).toFixed(1)}`);
    top.push(`${x(i).toFixed(1)},${y(b.p95Ms ?? b.avgMs).toFixed(1)}`);
    bottom.unshift(`${x(i).toFixed(1)},${y(b.avgMs).toFixed(1)}`);
  }
  if (run.length) segments.push(run);

  const gridAt = [0, 0.5, 1];
  const dayEvery = Math.max(1, Math.round(buckets.length / 7));

  // The viewBox is `W x height` and the SVG renders at exactly `height`, so an SVG coordinate
  // over its own axis length IS the fraction the hover layer wants — no second scale to keep.
  const hoverPoints: ChartPoint[] = buckets.map((b, i) => ({
    x: x(i) / W,
    y: b.avgMs == null ? null : y(b.avgMs) / height,
    label: `${b.hour.replace("T", " ")}:00`,
    detail:
      b.avgMs == null
        ? "no checks"
        : `${b.avgMs}ms typical · ${b.p95Ms ?? b.avgMs}ms slowest 5%${b.failures ? ` · ${b.failures} failed` : ""}`,
  }));

  return (
    <ChartHover points={hoverPoints} height={height}>
    <svg
      viewBox={`0 0 ${W} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={`Response time over the last ${Math.round(buckets.length / 24)} days, between ${Math.min(
        ...withData.map((b) => b.avgMs ?? 0),
      )} and ${max} milliseconds`}
    >
      {gridAt.map((f) => (
        <g key={f}>
          <line x1={padL} y1={y(max * f)} x2={W - padR} y2={y(max * f)} stroke="var(--border)" strokeWidth={1} />
          <text x={padL - 6} y={y(max * f) + 3.5} textAnchor="end" fontSize={11} fill="var(--muted)">
            {Math.round(max * f)}
          </text>
        </g>
      ))}

      <polygon points={[...top, ...bottom].join(" ")} fill="var(--primary)" opacity={0.16} />

      {segments.map((s) => (
        <polyline
          key={s[0]}
          points={s.join(" ")}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {buckets.map((b, i) =>
        b.failures > 0 ? (
          <rect key={b.hour} x={x(i) - 1.6} y={padT + plotH + 6} width={3.2} height={tickH - 2} rx={1} fill="var(--danger)">
            <title>{`${b.hour.replace("T", " ")}:00 — ${b.failures} of ${b.checks} checks failed`}</title>
          </rect>
        ) : null,
      )}

      {buckets.map((b, i) => (
        <rect key={`h-${b.hour}`} x={x(i) - 2} y={padT} width={4} height={plotH} fill="transparent">
          <title>
            {b.avgMs == null
              ? `${b.hour.replace("T", " ")}:00 — no checks`
              : `${b.hour.replace("T", " ")}:00 — ${b.avgMs}ms typical, ${b.p95Ms ?? b.avgMs}ms slowest 5%${
                  b.failures ? `, ${b.failures} failed` : ""
                }`}
          </title>
        </rect>
      ))}

      {dayLabels
        ? buckets.map((b, i) =>
            i % dayEvery === 0 ? (
              <text key={`d-${b.hour}`} x={x(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {new Date(`${b.hour}:00:00Z`).toLocaleDateString(undefined, { weekday: "short" })}
              </text>
            ) : null,
          )
        : null}
    </svg>
    </ChartHover>
  );
}

/**
 * A speed check over time: throughput as a filled area behind, latency and jitter as bars in
 * front on their own scale.
 *
 * ⚠ Two scales, the one place this module allows it: megabits and milliseconds share no axis, and
 * plotting the bars against the speed axis would draw 20ms of jitter as a flat line forever. The
 * bars read against each other, which is why they are a different kind of mark.
 *
 * Absent upload means the leg was off or refused — drawn as nothing, never as zero.
 *
 * REFS addons/health-monitor/lib/store.ts › LatencyBucket · addons/health-monitor/page.tsx
 */
export function SpeedChart({ buckets, height = 170 }: { buckets: LatencyBucket[]; height?: number }) {
  const withData = buckets.filter((b) => b.downMbps != null);
  if (withData.length < 2) {
    return (
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Not enough speed tests yet — this fills in as they run.
      </p>
    );
  }

  const W = 720;
  const padL = 44, padR = 40, padT = 6, padB = 24;
  const plotH = height - padT - padB;
  const maxMbps = niceMax(Math.max(...withData.map((b) => Math.max(b.downMbps ?? 0, b.upMbps ?? 0))));
  const maxMs = niceMax(Math.max(1, ...withData.map((b) => Math.max(b.avgMs ?? 0, b.jitterMs ?? 0))));
  const x = (i: number) => padL + (i / Math.max(1, buckets.length - 1)) * (W - padL - padR);
  const ySpeed = (v: number) => padT + plotH - (v / maxMbps) * plotH;
  const yMs = (v: number) => padT + plotH - (v / maxMs) * plotH;
  const barW = Math.max(1.5, (W - padL - padR) / buckets.length / 3);

  const area: string[] = [];
  const upLine: string[] = [];
  for (const [i, b] of buckets.entries()) {
    if (b.downMbps == null) continue;
    area.push(`${x(i).toFixed(1)},${ySpeed(b.downMbps).toFixed(1)}`);
    if (b.upMbps != null) upLine.push(`${x(i).toFixed(1)},${ySpeed(b.upMbps).toFixed(1)}`);
  }
  const floor = `${x(buckets.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} ${x(0).toFixed(1)},${(padT + plotH).toFixed(1)}`;

  const hoverPoints: ChartPoint[] = buckets.map((b, i) => ({
    x: x(i) / W,
    y: b.downMbps == null ? null : ySpeed(b.downMbps) / height,
    label: `${b.hour.replace("T", " ")}:00`,
    detail:
      b.downMbps == null
        ? "no test"
        : [
            `${b.downMbps} Mbps down`,
            b.upMbps != null ? `${b.upMbps} up` : null,
            b.avgMs != null ? `${b.avgMs}ms` : null,
            b.jitterMs != null ? `${b.jitterMs}ms jitter` : null,
          ].filter(Boolean).join(" · "),
  }));

  return (
    <ChartHover points={hoverPoints} height={height}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Connection speed over the last ${Math.round(buckets.length / 24)} days, peaking near ${maxMbps} megabits per second`}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} y1={ySpeed(maxMbps * f)} x2={W - padR} y2={ySpeed(maxMbps * f)} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={ySpeed(maxMbps * f) + 3.5} textAnchor="end" fontSize={11} fill="var(--muted)">
              {Math.round(maxMbps * f)}
            </text>
            <text x={W - padR + 6} y={yMs(maxMs * f) + 3.5} fontSize={11} fill="var(--muted)">
              {Math.round(maxMs * f)}
            </text>
          </g>
        ))}

        <polygon points={`${area.join(" ")} ${floor}`} fill="var(--primary)" opacity={0.18} />
        <polyline points={area.join(" ")} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {upLine.length > 1 ? (
          <polyline points={upLine.join(" ")} fill="none" stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.75} vectorEffect="non-scaling-stroke" />
        ) : null}

        {buckets.map((b, i) =>
          b.avgMs != null ? (
            <rect key={`l-${b.hour}`} x={x(i) - barW} y={yMs(b.avgMs)} width={barW} height={padT + plotH - yMs(b.avgMs)} fill="var(--warning, #b45309)" opacity={0.8} />
          ) : null,
        )}
        {buckets.map((b, i) =>
          b.jitterMs != null ? (
            <rect key={`j-${b.hour}`} x={x(i)} y={yMs(b.jitterMs)} width={barW} height={padT + plotH - yMs(b.jitterMs)} fill="var(--danger)" opacity={0.65} />
          ) : null,
        )}

        <text x={4} y={padT + 4} fontSize={10} fill="var(--muted)">Mbps</text>
        <text x={W - padR + 6} y={padT + 4} fontSize={10} fill="var(--muted)">ms</text>
      </svg>
    </ChartHover>
  );
}

/**
 * A labelled figure, used for the uptime and latency read-outs.
 * REFS addons/health-monitor/page.tsx
 */
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
