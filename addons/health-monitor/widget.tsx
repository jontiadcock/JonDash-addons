import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import { hourlyBuckets, listMonitors, openIncidentCount, type HourBucket } from "./lib/store";
import { formatAgo, formatMs, stateColour, STATE_LABEL, worstState } from "./lib/format";
import { MODULE_PATH, type MonitorRow } from "./lib/types";
import { HealthStyles, StatusDot, StatusStrip } from "./ui/parts";

/**
 * The dashboard widget: a single reassuring line when everything is up, and the detail
 * only when it isn't.
 *
 * Rendering does no work beyond reading. Monitoring runs on the `scheduler` helper from
 * server start, so what you see here is the state as of the last tick — not something
 * this render just went and produced.
 */
export default async function HealthWidget({ ctx }: ModuleWidgetProps) {
  const db = ctx.db;
  const monitors: MonitorRow[] = db ? await listMonitors(db) : [];
  const openIncidents = db ? await openIncidentCount(db) : 0;

  const strips = new Map<string, HourBucket[]>();
  if (db) {
    for (const m of monitors) strips.set(m.id, await hourlyBuckets(db, m.id, 24));
  }

  const active = monitors.filter((m) => m.enabled === 1);
  const overall = worstState(active.map((m) => m.status));
  const problems = active.filter((m) => m.status === "down" || m.status === "degraded");

  // A user can shrink this widget to a single grid cell, so it can't assume room for a
  // long list: show whatever needs attention first, then fill up to a few healthy ones,
  // and say how many are left. The detail lives one click away on the module's page.
  const MAX_ROWS = 4;
  const shown = [...problems, ...monitors.filter((m) => !problems.includes(m))].slice(0, MAX_ROWS);
  const hidden = monitors.length - shown.length;

  // "All up" has to mean it: a monitor that has failed once but hasn't been confirmed
  // down yet is neither up nor down, and saying otherwise is the one thing a status
  // widget must never do.
  const pending = active.filter((m) => m.status === "unknown").length;
  const summary =
    problems.length > 0
      ? `${problems.length} of ${active.length} need attention`
      : pending > 0
        ? `${active.length - pending} up · ${pending} still checking`
        : `All ${active.length} up`;

  return (
    <div className="hm card p-4">
      <HealthStyles />
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-medium">
          <StatusDot state={overall} />
          Health
        </p>
        <Link href={MODULE_PATH} className="text-sm" style={{ color: "var(--primary)" }}>
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
            {summary}
            {openIncidents > 0 ? ` · ${openIncidents} ongoing` : ""}
          </p>

          <ul className="mt-3 flex flex-col gap-3">
            {shown.map((m) => (
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

          {hidden > 0 ? (
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              and {hidden} more
            </p>
          ) : null}

          {problems.length > 0 ? (
            <p className="mt-3 truncate text-xs" style={{ color: "var(--muted)" }}>
              {problems[0].name}: {problems[0].lastMessage ?? "no detail"} · checked{" "}
              {formatAgo(problems[0].lastCheckAt)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
