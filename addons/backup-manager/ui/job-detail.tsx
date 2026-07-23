import type { ModuleContext } from "@/lib/modules/types";
import filesystem from "@/helpers/filesystem/api";
import { getJob, runsForJob, scheduleOf, statsForJob, type Run } from "../lib/store";
import {
  ADMIN_PATH,
  HEALTH_TONE,
  MODULE_PATH,
  formatBytes,
  formatDuration,
  formatRelative,
  formatTime,
  formatWhen,
  runDuration,
} from "../lib/constants";
import { cancelRunAction, runNowAction, viewLogAction } from "../actions";
import { describeSchedule } from "../lib/schedule";
import LiveRefresh from "./live";

/**
 * One backup, in detail — its own history, its live progress, its snapshots.
 *
 * Split out from the main page because a flat "recent runs" table across every job answers
 * "did anything break?" but never "why does THIS one keep failing?". Reached at
 * /m/backup-manager/job/<id>, which costs nothing: the module page already receives its
 * path segments.
 */

const muted = { color: "var(--muted)" } as const;

function stateTone(run: Run): string {
  if (run.state === "running") return HEALTH_TONE.running;
  if (run.state === "done") return run.errorCount > 0 ? HEALTH_TONE.warn : HEALTH_TONE.ok;
  if (run.state === "cancelled") return HEALTH_TONE.idle;
  return HEALTH_TONE.bad;
}

/** Cancelled is not a failure and must not be coloured or worded like one. */
function stateWord(run: Run): string {
  switch (run.state) {
    case "running": return "running";
    case "done": return run.errorCount > 0 ? `done, ${run.errorCount} error(s)` : "done";
    case "cancelled": return "stopped by you";
    case "interrupted": return "interrupted";
    default: return "failed";
  }
}

export default async function JobDetail({ ctx, jobId }: { ctx: ModuleContext; jobId: string }) {
  const db = ctx.db;
  if (!db) return null;

  const job = await getJob(db, jobId);
  if (!job) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">That backup no longer exists.</p>
        <a href={MODULE_PATH} className="text-sm underline">Back to all backups</a>
      </div>
    );
  }

  const fs = filesystem(ctx);
  const runs = await runsForJob(db, job.id, 50);
  const stats = await statsForJob(db, job.id);
  const live = runs.find((r) => r.state === "running") ?? null;
  const progress = live?.helperRunId ? fs.progress(live.helperRunId) : null;
  const snapshots = job.mode === "snapshot" ? await fs.listSnapshots(job.destRootId, job.destSubpath || undefined) : [];
  const lastLog = String((await ctx.store?.get("lastLog")) ?? "");

  return (
    <div className="flex flex-col gap-6">
      {live && <LiveRefresh everyMs={3000} />}

      <section>
        <a href={MODULE_PATH} className="text-sm underline" style={muted}>← All backups</a>
        <h1 className="mt-1 text-2xl font-semibold">{job.name}</h1>
        <p className="text-sm" style={muted}>
          {job.mode === "snapshot" ? "A new dated copy each time" : "Keeps the destination up to date"}
          {" · "}{describeSchedule(scheduleOf(job), formatTime)}
          {job.enabled ? <> · next {formatRelative(job.nextRunAt)}</> : " · paused"}
        </p>
      </section>

      {/* ------------------------------------------------------------ live progress */}
      {live && (
        <section className="card flex flex-col gap-2 p-4">
          <h2 className="font-medium">Running now</h2>
          {progress ? (
            <>
              <p className="text-sm">
                {progress.filesDone} file(s), {formatBytes(progress.bytesDone)} copied
              </p>
              {progress.currentPath && (
                <p className="truncate text-xs" style={muted}>{progress.currentPath}</p>
              )}
            </>
          ) : (
            <p className="text-sm" style={muted}>
              Starting up — no files copied yet.
            </p>
          )}
          <p className="text-xs" style={muted}>Started {formatRelative(live.startedAt)}.</p>
          <form action={cancelRunAction}>
            <input type="hidden" name="runId" value={live.id} />
            <button className="btn btn-danger self-start" type="submit">Stop this backup</button>
          </form>
          <p className="text-xs" style={muted}>
            Stopping finishes the file it&rsquo;s on and leaves everything already copied in place.
            Nothing at the destination is removed.
          </p>
        </section>
      )}

      {/* ------------------------------------------------------------------ summary */}
      <section className="card flex flex-col gap-2 p-4">
        <div className="flex flex-wrap gap-6">
          <Stat label="Runs" value={String(stats.total)} />
          <Stat label="Failures" value={String(stats.failures)} tone={stats.failures > 0 ? HEALTH_TONE.bad : undefined} />
          <Stat label="Typical turnaround" value={stats.averageMs == null ? "—" : formatDuration(stats.averageMs)} />
          <Stat label="Last success" value={formatRelative(stats.lastSuccessAt)} />
          {job.mode === "snapshot" && <Stat label="Copies kept" value={String(snapshots.length)} />}
        </div>
        {/*
          Called "turnaround" rather than "duration", because that is what it actually
          measures. A backup runs in the background and this module learns it finished on
          its next check, so up to a minute of waiting is included. On a small backup that
          delay is most of the number — a three-file copy reads as ~50s. Naming it honestly
          costs nothing; calling it "duration" would quietly mislead every time.
        */}
        <p className="text-xs" style={muted}>
          Turnaround is measured from starting until the result was recorded, so it includes up to
          a minute of waiting for the next check. On a short backup that wait is most of it.
        </p>
      </section>

      <section className="flex flex-wrap gap-2">
        {!live && (
          <form action={runNowAction}>
            <input type="hidden" name="id" value={job.id} />
            <button className="btn btn-primary" type="submit">Run now</button>
          </form>
        )}
        <a className="btn" href={ADMIN_PATH}>Edit this backup</a>
      </section>

      {/* ---------------------------------------------------------------- snapshots */}
      {job.mode === "snapshot" && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Dated copies at the destination</h2>
          {snapshots.length === 0 ? (
            <p className="text-sm" style={muted}>None yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {snapshots.slice(0, 30).map((s) => (
                <li key={s.name} className="flex justify-between gap-3">
                  <code className="text-xs">{s.name}</code>
                  <span style={muted}>{formatRelative(s.at)}</span>
                </li>
              ))}
            </ul>
          )}
          {job.pruneEnabled ? (
            <p className="text-xs" style={muted}>
              Older copies are tidied automatically after each successful run — keeping{" "}
              {job.keepDaily} daily, {job.keepWeekly} weekly, {job.keepMonthly} monthly,{" "}
              {job.keepYearly} yearly. The most recent is always kept.
            </p>
          ) : (
            <p className="text-xs" style={muted}>
              Automatic tidying is off, so these will keep accumulating. Turn it on in{" "}
              <a href={ADMIN_PATH} className="underline">settings</a> if you&rsquo;d rather they didn&rsquo;t.
            </p>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------------ history */}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">History</h2>
        {runs.length === 0 ? (
          <p className="text-sm" style={muted}>This backup has never run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={muted}>
                  <th className="py-1 text-left font-normal">When</th>
                  <th className="py-1 text-left font-normal">Result</th>
                  <th className="py-1 text-right font-normal">Took</th>
                  <th className="py-1 text-right font-normal">Copied</th>
                  <th className="py-1 text-right font-normal">Skipped</th>
                  <th className="py-1 text-right font-normal">Tidied</th>
                  <th className="py-1 text-left font-normal">Log</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const ms = runDuration(r.startedAt, r.finishedAt);
                  return (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--surface-2)" }}>
                      <td className="py-1" title={formatWhen(r.startedAt)}>{formatRelative(r.startedAt)}</td>
                      <td className="py-1" style={{ color: stateTone(r) }}>
                        {stateWord(r)}
                        {r.message && <span className="block text-xs" style={muted}>{r.message}</span>}
                      </td>
                      <td className="py-1 text-right">{ms == null ? "—" : formatDuration(ms)}</td>
                      <td className="py-1 text-right">{r.filesCopied}</td>
                      <td className="py-1 text-right">{r.skippedCount}</td>
                      <td className="py-1 text-right">{r.prunedCount}</td>
                      <td className="py-1">
                        {r.helperRunId ? (
                          <form action={viewLogAction}>
                            <input type="hidden" name="runId" value={r.helperRunId} />
                            <button className="btn btn-ghost" type="submit">Show</button>
                          </form>
                        ) : (
                          <span style={muted}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {lastLog && (
          <pre className="max-h-96 overflow-auto rounded p-3 text-xs" style={{ background: "var(--surface-2)" }}>
            {lastLog}
          </pre>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs" style={muted}>{label}</div>
      <div className="text-lg" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}
