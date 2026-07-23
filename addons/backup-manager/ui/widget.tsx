import type { ModuleWidgetProps } from "@/lib/modules/types";
import filesystem from "@/helpers/filesystem/api";
import { listJobs, lastRunFor, runningRuns, type Job, type Run } from "../lib/store";
import {
  HEALTH_TONE,
  MODULE_PATH,
  formatBytes,
  formatRelative,
  jobPath,
  type Health,
} from "../lib/constants";
import LiveRefresh from "./live";

/**
 * The dashboard tile.
 *
 * A backup tool earns its place on a dashboard by answering one question at a glance: *am I
 * covered?* So the headline is a verdict, not a table — and the verdict is deliberately
 * pessimistic. Anything not currently fine is what gets shown, because a tile that says
 * "3 backups" while one of them has been failing for a week is worse than no tile.
 *
 * Admin-only, like the rest of the module: core only renders a widget from an `adminOnly`
 * module to admins, so the paths on show never reach anyone else.
 */

function healthOf(job: Job, run: Run | null): Health {
  if (!job.enabled) return "idle";
  if (run?.state === "running") return "running";
  if (!run) return "warn"; // enabled but never run — not fine, not yet broken
  if (run.state === "done") return run.errorCount > 0 ? "warn" : "ok";
  return "bad";
}

const RANK: Record<Health, number> = { bad: 0, warn: 1, running: 2, ok: 3, idle: 4 };

export default async function BackupWidget({ ctx }: ModuleWidgetProps) {
  const db = ctx.db;
  if (!db) return null;

  const jobs = await listJobs(db);
  const muted = { color: "var(--muted)" } as const;

  if (jobs.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm" style={muted}>No backups set up yet.</p>
        <a href={MODULE_PATH} className="text-sm underline">Set one up</a>
      </div>
    );
  }

  const active = await runningRuns(db);
  const rows: { job: Job; run: Run | null; health: Health }[] = [];
  for (const job of jobs) {
    const run = await lastRunFor(db, job.id);
    rows.push({ job, run, health: healthOf(job, run) });
  }
  rows.sort((a, b) => RANK[a.health] - RANK[b.health] || a.job.name.localeCompare(b.job.name));

  const bad = rows.filter((r) => r.health === "bad").length;
  const warn = rows.filter((r) => r.health === "warn").length;
  const ok = rows.filter((r) => r.health === "ok").length;

  // The verdict. Worst-first, because "all good" is the only reassuring thing worth saying
  // and everything else needs attention.
  const verdict =
    bad > 0
      ? { text: `${bad} backup${bad === 1 ? "" : "s"} failing`, tone: HEALTH_TONE.bad }
      : active.length > 0
        ? { text: `${active.length} running now`, tone: HEALTH_TONE.running }
        : warn > 0
          ? { text: `${warn} need${warn === 1 ? "s" : ""} a look`, tone: HEALTH_TONE.warn }
          : { text: `${ok} backup${ok === 1 ? "" : "s"} healthy`, tone: HEALTH_TONE.ok };

  return (
    <div className="flex flex-col gap-2">
      {/* Only poll while something is actually copying. An idle dashboard stays idle. */}
      {active.length > 0 && <LiveRefresh everyMs={4000} />}

      <p className="text-sm font-medium" style={{ color: verdict.tone }}>{verdict.text}</p>

      <ul className="flex flex-col gap-1">
        {rows.slice(0, 4).map(({ job, run, health }) => {
          const live = active.find((r) => r.jobId === job.id);
          const progress = live?.helperRunId ? filesystem(ctx).progress(live.helperRunId) : null;
          return (
            <li key={job.id} className="flex items-baseline justify-between gap-2 text-xs">
              <a href={jobPath(job.id)} className="min-w-0 truncate underline">{job.name}</a>
              <span className="flex-none" style={{ color: HEALTH_TONE[health] }}>
                {health === "running"
                  ? progress
                    ? `${progress.filesDone} files · ${formatBytes(progress.bytesDone)}`
                    : "running…"
                  : health === "idle"
                    ? "paused"
                    : health === "bad"
                      ? "failed"
                      : run
                        ? formatRelative(run.startedAt)
                        : "never run"}
              </span>
            </li>
          );
        })}
      </ul>

      {rows.length > 4 && (
        <p className="text-xs" style={muted}>and {rows.length - 4} more</p>
      )}
      <a href={MODULE_PATH} className="text-xs underline" style={muted}>All backups</a>
    </div>
  );
}
