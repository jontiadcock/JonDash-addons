import type { ReactNode } from "react";
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

/** See `service-control`: a guard against an unbounded list, not a layout size. */
const TILE_CAP = 24;

const RANK: Record<Health, number> = { bad: 0, warn: 1, running: 2, ok: 3, idle: 4 };

/**
 * The card, the title and the "open" link.
 *
 * `WidgetFrame` gives a widget a grid cell and the Customise button and nothing else — no
 * card, no padding, no heading. Every widget draws its own, so one that doesn't renders as
 * loose text on the dashboard background with no clue which module it belongs to. Both
 * return paths below go through this for that reason.
 *
 * # Sizing (JonDash 1.8.0 B5/B6)
 *
 * The user can size this from 1×1 upward and the frame **clips rather than scrolls**. Core's
 * two thresholds decide what appears: at 1×1 just `short` — a count in the verdict's colour,
 * because a sentence does not fit and "2!" says more than "2 backups fai…". The title and the
 * headline arrive at `@[6rem]`, the list and full padding at `@[8rem]`.
 */
function Tile({ tone, headline, short, children }: {
  tone?: string;
  headline: string;
  /** The 1×1 form of `headline`. */
  short: string;
  children?: ReactNode;
}) {
  return (
    <div className="card flex h-full min-w-0 flex-col overflow-hidden p-2 @[8rem]:p-4">
      <div className="hidden items-center justify-between gap-2 @[6rem]:flex">
        <p className="truncate text-xs font-medium @[8rem]:text-sm">Backups</p>
        <a
          href={MODULE_PATH}
          className="hidden shrink-0 text-xs @[8rem]:inline"
          style={{ color: "var(--primary)" }}
        >
          open
        </a>
      </div>
      <p className="truncate font-medium @[6rem]:hidden" style={{ color: tone ?? "var(--muted)" }}>
        {short}
      </p>
      <p
        className="mt-1 hidden truncate text-xs @[6rem]:block"
        style={{ color: tone ?? "var(--muted)" }}
      >
        {headline}
      </p>
      {children}
    </div>
  );
}

export default async function BackupWidget({ ctx }: ModuleWidgetProps) {
  const db = ctx.db;
  if (!db) return null;

  const jobs = await listJobs(db);

  if (jobs.length === 0) {
    return (
      <Tile headline="No backups set up yet." short="—">
        <a href={MODULE_PATH} className="mt-1 hidden truncate text-xs underline @[8rem]:inline">
          Set one up
        </a>
      </Tile>
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
      ? { text: `${bad} backup${bad === 1 ? "" : "s"} failing`, short: `${bad}!`, tone: HEALTH_TONE.bad }
      : active.length > 0
        ? { text: `${active.length} running now`, short: `${active.length}…`, tone: HEALTH_TONE.running }
        : warn > 0
          ? { text: `${warn} need${warn === 1 ? "s" : ""} a look`, short: `${warn}?`, tone: HEALTH_TONE.warn }
          : { text: `${ok} backup${ok === 1 ? "" : "s"} healthy`, short: `${ok}`, tone: HEALTH_TONE.ok };

  return (
    <Tile headline={verdict.text} short={verdict.short} tone={verdict.tone}>
      {/* Only poll while something is actually copying. An idle dashboard stays idle. */}
      {active.length > 0 && <LiveRefresh everyMs={4000} />}

      {/*
        No `.slice(0, 4)`: the rows are already sorted worst-first by RANK, so the frame
        clipping the tail always clips the healthiest job. A constant count did the opposite
        job badly — it hid failing backups on a large tile and overflowed a small one.
        `min-h-0` bounds the list so multi-column continues into a second column rather than
        out of the card.
      */}
      <ul className="mt-2 hidden min-h-0 flex-1 columns-[11rem] gap-x-5 gap-y-1 overflow-hidden @[8rem]:block">
        {rows.slice(0, TILE_CAP).map(({ job, run, health }) => {
          const live = active.find((r) => r.jobId === job.id);
          const progress = live?.helperRunId ? filesystem(ctx).progress(live.helperRunId) : null;
          return (
            <li key={job.id} className="flex min-w-0 break-inside-avoid items-baseline justify-between gap-2 text-xs">
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
    </Tile>
  );
}
