import type { ModulePageProps } from "@/lib/modules/types";
import filesystem from "@/helpers/filesystem/api";
import { lastRunFor, listJobs, recentRuns, type Job, type Run } from "./lib/store";
import { ADMIN_PATH, formatBytes, formatTime } from "./lib/constants";
import { viewLogAction } from "./actions";

/**
 * What happened — display only. Everything that CHANGES a backup lives in
 * Admin → Modules → Backup Manager, so this page can be read without any risk of altering
 * anything. The one thing it does is fetch a run's log, which is a read.
 */

const muted = { color: "var(--muted)" } as const;

/** A run's state as a person would say it, with the colour that matches. */
function describeState(run: Run | null): { text: string; tone?: string } {
  if (!run) return { text: "Never run", tone: "var(--muted)" };
  switch (run.state) {
    case "running":
      return { text: "Running now" };
    case "done":
      return run.errorCount > 0
        ? { text: `Finished, ${run.errorCount} file(s) couldn't be copied`, tone: "var(--warning, var(--muted))" }
        : { text: "Last backup succeeded" };
    case "cancelled":
      return { text: "Cancelled", tone: "var(--muted)" };
    case "interrupted":
      return { text: "Interrupted — not a complete backup", tone: "var(--danger)" };
    default:
      return { text: run.message || "Last backup failed", tone: "var(--danger)" };
  }
}

const when = (iso: string | null) => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "—";
};

export default async function BackupPage({ ctx }: ModulePageProps) {
  const db = ctx.db;
  const jobs = db ? await listJobs(db) : [];
  const runs = db ? await recentRuns(db, 20) : [];
  const logs = await filesystem(ctx).logs();
  const lastLog = String((await ctx.store?.get("lastLog")) ?? "");

  const latest = new Map<string, Run | null>();
  if (db) for (const j of jobs) latest.set(j.id, await lastRunFor(db, j.id));

  const nameOf = (jobId: string) => jobs.find((j) => j.id === jobId)?.name ?? "(deleted backup)";

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="mb-1 text-2xl font-semibold">Backup Manager</h1>
        <p className="text-sm" style={muted}>
          Keeps folders copied somewhere else on a schedule. Set backups up in{" "}
          <a href={ADMIN_PATH} className="underline">Admin → Modules → Backup Manager</a>.
        </p>
      </section>

      {/* ------------------------------------------------------------------- jobs */}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Your backups</h2>
        {jobs.length === 0 ? (
          <p className="text-sm" style={muted}>
            None set up yet. <a href={ADMIN_PATH} className="underline">Add one</a>.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((job: Job) => {
              const run = latest.get(job.id) ?? null;
              const state = describeState(run);
              return (
                <li key={job.id} className="card flex flex-col gap-1 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">
                      {job.name}
                      {!job.enabled && <span className="ml-2 text-xs" style={muted}>(paused)</span>}
                    </span>
                    <span className="text-sm" style={state.tone ? { color: state.tone } : undefined}>
                      {state.text}
                    </span>
                  </div>
                  <div className="text-xs" style={muted}>
                    {job.mode === "snapshot" ? "A new dated copy each time" : "Keeps the destination up to date"}
                    {" · "}every {job.everyHours}h at {formatTime(job.atMinute)}
                    {job.enabled ? <> · next {when(job.nextRunAt)}</> : null}
                  </div>
                  {run && (
                    <div className="text-xs" style={muted}>
                      Last run {when(run.startedAt)} — {run.filesCopied} file(s), {formatBytes(run.bytesCopied)}
                      {run.skippedCount > 0 ? <>, {run.skippedCount} skipped</> : null}
                      {run.prunedCount > 0 ? <>, {run.prunedCount} old copy(ies) tidied</> : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------------- runs */}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm" style={muted}>Nothing has run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={muted}>
                  <th className="py-1 text-left font-normal">Backup</th>
                  <th className="py-1 text-left font-normal">Started</th>
                  <th className="py-1 text-left font-normal">Result</th>
                  <th className="py-1 text-right font-normal">Copied</th>
                  <th className="py-1 text-right font-normal">Skipped</th>
                  <th className="py-1 text-right font-normal">Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const state = describeState(r);
                  return (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--surface-2)" }}>
                      <td className="py-1">{nameOf(r.jobId)}</td>
                      <td className="py-1" style={muted}>{when(r.startedAt)}</td>
                      <td className="py-1" style={state.tone ? { color: state.tone } : undefined}>
                        {r.state}
                        {r.message && <span className="block text-xs" style={muted}>{r.message}</span>}
                      </td>
                      <td className="py-1 text-right">{r.filesCopied}</td>
                      <td className="py-1 text-right">{r.skippedCount}</td>
                      <td className="py-1 text-right">{r.errorCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------- logs */}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Run logs</h2>
        <p className="text-sm" style={muted}>
          Each log names every file copied, skipped or failed on — including anything of
          JonDash&rsquo;s own that was deliberately stepped over.
        </p>
        {logs.length === 0 ? (
          <p className="text-sm" style={muted}>No logs yet.</p>
        ) : (
          <form action={viewLogAction} className="card flex flex-wrap items-end gap-2 p-3">
            <label className="min-w-64 flex-1 text-sm">
              Choose a run
              <select className="input mt-1 w-full" name="runId" required>
                {logs.slice(0, 50).map((l) => (
                  <option key={l.runId} value={l.runId}>
                    {when(l.modifiedAt)} — {Math.max(1, Math.round(l.bytes / 1024))} KB
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit">Show it</button>
          </form>
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
