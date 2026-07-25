import type { ModulePageProps } from "@/lib/modules/types";
import systemMetrics, { type Snapshot } from "@/helpers/system-metrics/api";
import { bytes, pct, uptime, levelFor, TONE } from "./lib/format";

/**
 * The detail page at /m/host-vitals — everything the tile summarises, in full: every disk,
 * every temperature sensor, and the load average where the platform reports one.
 *
 * Display-only. Like the widget it reads once per render; there is nothing to submit and
 * nothing stored, so there are no actions and no forms.
 */

function Row({ label, value, usedPct }: { label: string; value: string; usedPct?: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">{label}</span>
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          {value}
        </span>
      </div>
      {usedPct !== undefined && (
        <span
          style={{
            display: "block",
            height: 6,
            borderRadius: 3,
            background: "var(--border)",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${Math.min(100, Math.max(0, usedPct))}%`,
              background: TONE[levelFor(usedPct)],
            }}
          />
        </span>
      )}
    </div>
  );
}

function Body({ m }: { m: Snapshot }) {
  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4">
        <h2 className="mb-3 font-medium">This server</h2>
        <div className="flex flex-col gap-2">
          <Row label="Host" value={m.host.hostname} />
          <Row label="System" value={`${m.host.platform} · ${m.host.arch}`} />
          <Row label="Uptime" value={uptime(m.host.uptimeSec)} />
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Processor</h2>
        <div className="flex flex-col gap-2">
          <Row label={m.cpu.model} value={`${m.cpu.cores} cores`} />
          <Row label="In use now" value={pct(m.cpu.usedPct)} usedPct={m.cpu.usedPct} />
          {m.cpu.load1 !== null && (
            <Row
              label="Load average (1 / 5 / 15 min)"
              value={`${m.cpu.load1.toFixed(2)} / ${m.cpu.load5?.toFixed(2)} / ${m.cpu.load15?.toFixed(2)}`}
            />
          )}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Memory</h2>
        <Row
          label={`${bytes(m.memory.usedBytes)} of ${bytes(m.memory.totalBytes)}`}
          value={pct(m.memory.usedPct)}
          usedPct={m.memory.usedPct}
        />
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Disks</h2>
        <div className="flex flex-col gap-3">
          {m.disks.map((d) => (
            <Row
              key={d.mount}
              label={d.mount}
              value={`${bytes(d.usedBytes)} of ${bytes(d.totalBytes)} · ${pct(d.usedPct)}`}
              usedPct={d.usedPct}
            />
          ))}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Temperatures</h2>
        {m.temps.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No temperature sensors reported on this host.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {m.temps.map((t) => (
              <Row key={t.label} label={t.label} value={`${t.celsius.toFixed(1)} °C`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default async function HostVitalsPage({ ctx }: ModulePageProps) {
  const m = await systemMetrics(ctx).read();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold tracking-tight">Host vitals</h1>
      {m ? (
        <Body m={m} />
      ) : (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Host metrics are not available. This module needs the <code>system-metrics</code> helper and
          the permission to read them.
        </p>
      )}
    </div>
  );
}
