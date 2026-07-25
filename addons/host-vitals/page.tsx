import type { ModulePageProps } from "@/lib/modules/types";
import systemMetrics, { type Snapshot } from "@/helpers/system-metrics/api";
import { bytes, clock, pct, rate, uptime, levelFor, TONE } from "./lib/format";
import { collectFor } from "./lib/groups";

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

/**
 * Shown when a group was collected but the platform had nothing to give — which for several
 * of these means Windows or macOS. Saying so is better than an empty box that looks broken.
 */
function Unavailable() {
  return (
    <p className="text-sm" style={{ color: "var(--muted)" }}>
      Not available on this platform — these readings come from Linux&apos;s <code>/proc</code> and{" "}
      <code>/sys</code>.
    </p>
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
          {m.cpu.speedMhz != null && <Row label="Clock speed" value={clock(m.cpu.speedMhz)} />}
          <Row label="In use now" value={pct(m.cpu.usedPct)} usedPct={m.cpu.usedPct} />
          {m.cpu.load1 !== null && (
            <Row
              label="Load average (1 / 5 / 15 min)"
              value={`${m.cpu.load1.toFixed(2)} / ${m.cpu.load5?.toFixed(2)} / ${m.cpu.load15?.toFixed(2)}`}
            />
          )}
        </div>
        {m.cpu.perCore && m.cpu.perCore.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-sm" style={{ color: "var(--muted)" }}>
              Per core
            </p>
            <div className="flex flex-col gap-2">
              {m.cpu.perCore.map((usedPct, i) => (
                <Row key={i} label={`Core ${i}`} value={pct(usedPct)} usedPct={usedPct} />
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Memory</h2>
        <div className="flex flex-col gap-3">
          <Row
            label={`${bytes(m.memory.usedBytes)} of ${bytes(m.memory.totalBytes)}`}
            value={pct(m.memory.usedPct)}
            usedPct={m.memory.usedPct}
          />
          {m.swap !== undefined && (
            <>
              <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                Swap / page file
              </p>
              {m.swap && m.swap.totalBytes > 0 ? (
                <Row
                  label={`${bytes(m.swap.usedBytes)} of ${bytes(m.swap.totalBytes)}`}
                  value={pct(m.swap.usedPct)}
                  usedPct={m.swap.usedPct}
                />
              ) : (
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  Not reported on this host.
                </p>
              )}
            </>
          )}
        </div>
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

      {m.diskIo !== undefined && (
        <section className="card p-4">
          <h2 className="mb-3 font-medium">Disk activity</h2>
          {m.diskIo.length === 0 ? (
            <Unavailable />
          ) : (
            <div className="flex flex-col gap-2">
              {m.diskIo.map((d) => (
                <Row
                  key={d.device}
                  label={d.device}
                  value={`read ${rate(d.readBytesPerSec)} · write ${rate(d.writeBytesPerSec)}`}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {(m.network !== undefined || m.networkIo !== undefined) && (
        <section className="card p-4">
          <h2 className="mb-3 font-medium">Network</h2>
          <div className="flex flex-col gap-3">
            {m.network?.map((n) => (
              <Row key={n.name} label={n.name} value={n.addresses.join(", ")} />
            ))}
            {m.network && m.network.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No external interfaces found.
              </p>
            )}
            {m.networkIo !== undefined && (
              <>
                <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                  Throughput
                </p>
                {m.networkIo.length === 0 ? (
                  <Unavailable />
                ) : (
                  m.networkIo.map((n) => (
                    <Row
                      key={n.name}
                      label={n.name}
                      value={`↓ ${rate(n.rxBytesPerSec)} · ↑ ${rate(n.txBytesPerSec)}`}
                    />
                  ))
                )}
              </>
            )}
          </div>
        </section>
      )}

      {m.battery !== undefined && (
        <section className="card p-4">
          <h2 className="mb-3 font-medium">Battery</h2>
          {m.battery ? (
            <Row
              label={m.battery.status}
              value={m.battery.percent !== null ? `${m.battery.percent}%` : "—"}
              usedPct={m.battery.percent ?? undefined}
            />
          ) : (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No battery on this host.
            </p>
          )}
        </section>
      )}

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Temperatures &amp; fans</h2>
        <div className="flex flex-col gap-2">
          {m.temps.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No temperature sensors reported on this host.
            </p>
          ) : (
            m.temps.map((t) => (
              <Row key={t.label} label={t.label} value={`${t.celsius.toFixed(1)} °C`} />
            ))
          )}
          {m.fans !== undefined &&
            (m.fans.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No fan speeds reported on this host.
              </p>
            ) : (
              m.fans.map((f) => <Row key={f.label} label={f.label} value={`${f.rpm} RPM`} />)
            ))}
        </div>
      </section>
    </div>
  );
}

export default async function HostVitalsPage({ ctx }: ModulePageProps) {
  // Only gather what the admin left switched on — a metric turned off is never sampled.
  const settings = await ctx.settings.all();
  const m = await systemMetrics(ctx).read({ collect: collectFor(settings) });

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
