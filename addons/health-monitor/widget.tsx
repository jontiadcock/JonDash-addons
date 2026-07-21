import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import { ensureRunning } from "./lib/scheduler";
import { hourlyBuckets, listMonitors, openIncidentCount, type HourBucket } from "./lib/store";
import { formatAgo, formatMs, stateColour, STATE_LABEL, worstState } from "./lib/format";
import type { MonitorRow } from "./lib/types";
import { HealthStyles, StatusDot, StatusStrip } from "./ui/parts";

/**
 * The dashboard widget: a single reassuring line when everything is up, and the detail
 * only when it isn't. Rendering also starts the poller and runs anything overdue, which
 * is what closes the cold-start gap after a restart.
 */
export default async function HealthWidget({ ctx }: ModuleWidgetProps) {
  await ensureRunning();

  const db = ctx.db;
  const monitors: MonitorRow[] = db ? await listMonitors(db) : [];
  const openIncidents = db ? await openIncidentCount(db) : 0;

  const strips = new Map<string, HourBucket[]>();
  if (db) {
    for (const m of monitors) strips.set(m.id, await hourlyBuckets(db, m.id, 24));
  }

  const overall = worstState(monitors.filter((m) => m.enabled).map((m) => m.status));
  const problems = monitors.filter((m) => m.status === "down" || m.status === "degraded");

  return (
    <div className="hm card p-4">
      <HealthStyles />
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-medium">
          <StatusDot state={overall} />
          Health
        </p>
        <Link href="/m/health-monitor" className="text-sm" style={{ color: "var(--primary)" }}>
          open
        </Link>
      </div>

      {monitors.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          No monitors yet — add some under Admin → Modules → Health monitoring.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            {overall === "up"
              ? `All ${monitors.length} service${monitors.length === 1 ? "" : "s"} up`
              : `${problems.length} of ${monitors.length} need attention`}
            {openIncidents > 0 ? ` · ${openIncidents} open incident${openIncidents === 1 ? "" : "s"}` : ""}
          </p>

          <ul className="mt-3 flex flex-col gap-3">
            {monitors.map((m) => (
              <li key={m.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot state={m.status} size={8} />
                    <span className="truncate">{m.name}</span>
                  </span>
                  <span className="flex-none text-xs" style={{ color: "var(--muted)" }}>
                    {m.status === "down" ? (
                      <span style={{ color: stateColour("down") }}>{STATE_LABEL.down}</span>
                    ) : (
                      formatMs(m.lastLatencyMs)
                    )}
                  </span>
                </div>
                <StatusStrip buckets={strips.get(m.id) ?? []} height={14} />
              </li>
            ))}
          </ul>

          {problems.length > 0 ? (
            <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
              {problems[0].name}: {problems[0].lastMessage ?? "no detail"} · checked{" "}
              {formatAgo(problems[0].lastCheckAt)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
