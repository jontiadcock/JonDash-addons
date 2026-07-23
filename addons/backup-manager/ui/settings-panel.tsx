import type { ModuleSettingsPanelProps } from "@/lib/modules/types";
import filesystem from "@/helpers/filesystem/api";
import { listJobs, type Job } from "../lib/store";
import { formatTime } from "../lib/constants";
import {
  addRootAction,
  assessPathAction,
  deleteJobAction,
  previewBackupAction,
  previewPruneAction,
  removeRootAction,
  runNowAction,
  saveJobAction,
  setLogRetentionAction,
  testLocationAction,
} from "../actions";
import FolderPicker from "./folder-picker";
import { jobPath } from "../lib/constants";
import { WEEKDAY_NAMES, describeSchedule, parseDays } from "../lib/schedule";
import { cloneJobAction, setAllEnabledAction, setConcurrencyAction } from "../actions";
import { getConcurrency } from "../lib/store";

/**
 * Everything that changes a backup lives here, in Admin → Modules → Backup Manager. The
 * module's own page stays display-only.
 *
 * A server component with plain forms: no client JavaScript, so there is no state to get
 * out of step with the database.
 */

type Assessment = {
  path?: string;
  level?: "none" | "caution" | "high";
  headline?: string;
  reasons?: string[];
  advice?: string[];
  canBeDestination?: boolean;
  destinationReason?: string | null;
  error?: string;
};

type PrunePreview = {
  job?: string;
  keep?: { name: string; because: string }[];
  remove?: string[];
  ignored?: string[];
  error?: string;
};

type BackupPreview = {
  job?: string;
  destination?: string;
  create?: number;
  update?: number;
  unchanged?: number;
  bytes?: number;
  sample?: string[];
  skipped?: { path: string; reason: string }[];
  error?: string;
};

const parse = <T,>(raw: unknown): T | null => {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export default async function BackupSettingsPanel({ ctx }: ModuleSettingsPanelProps) {
  const db = ctx.db;
  const fs = filesystem(ctx);
  const roots = await fs.listRoots();
  const jobs = db ? await listJobs(db) : [];
  const logRetention = await fs.retention();
  const logSize = await fs.logsSize();

  const get = async (k: string) => (await ctx.store?.get(k)) ?? "";
  const assessment = parse<Assessment>(await get("lastAssess"));
  const preview = parse<PrunePreview>(await get("lastPrunePreview"));
  const backupPreview = parse<BackupPreview>(await get("lastBackupPreview"));
  const lastRoot = String(await get("lastRoot"));
  const lastTest = String(await get("lastTest"));
  const lastLogRetention = String(await get("lastLogRetention"));
  const lastJobSave = String(await get("lastJobSave"));
  const lastConcurrency = String(await get("lastConcurrency"));
  const concurrency = db ? await getConcurrency(db) : 1;

  const muted = { color: "var(--muted)" } as const;

  return (
    <div className="flex flex-col gap-6">
      {/* ------------------------------------------------------------------ folders */}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Allowed folders</h3>
        <p className="text-sm" style={muted}>
          Backups can only read from and write to folders you list here. JonDash&rsquo;s own
          secrets &mdash; its encryption key, database and HTTPS keys &mdash; are never copied,
          wherever they happen to live.
        </p>

        {roots.length === 0 ? (
          <p className="text-sm" style={muted}>None yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {roots.map((r) => (
              <li key={r.id} className="card flex items-center justify-between gap-3 p-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {r.label}
                    {r.riskLevel !== "none" && (
                      <span
                        className="ml-2 text-xs"
                        style={{ color: r.riskLevel === "high" ? "var(--danger)" : "var(--warning, var(--muted))" }}
                      >
                        {r.riskLevel === "high" ? "⚠ holds a lot more than you may intend" : "worth knowing about"}
                      </span>
                    )}
                  </span>
                  <code className="text-xs" style={muted}>{r.path}</code>
                  {r.riskNote && <span className="mt-1 block text-xs" style={muted}>{r.riskNote}</span>}
                </span>
                <form action={removeRootAction}>
                  <input type="hidden" name="rootId" value={r.id} />
                  <button className="btn btn-ghost" type="submit">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {/* Check before saving — the warning replaced an outright refusal, so it has to be
            somewhere an admin will actually read it. */}
        <form action={assessPathAction} className="card flex flex-col gap-2 p-3">
          <label className="text-sm">
            Check a folder before you allow it
            <input className="input mt-1 w-full" name="path" placeholder="D:\Photos  or  \\nas\backups" required />
          </label>
          <button className="btn self-start" type="submit">Check it</button>

          {assessment?.error && (
            <p className="text-sm" style={{ color: "var(--danger)" }}>{assessment.error}</p>
          )}
          {assessment?.path && (
            <div className="text-sm">
              <p><code className="text-xs">{assessment.path}</code></p>
              {assessment.level === "none" ? (
                <p style={muted}>Nothing unusual about this folder.</p>
              ) : (
                <div
                  className="mt-1 rounded p-2"
                  style={{ background: "var(--surface-2)", color: assessment.level === "high" ? "var(--danger)" : undefined }}
                >
                  <p className="font-medium">{assessment.headline}</p>
                  <ul className="mt-1 list-disc pl-5">
                    {(assessment.reasons ?? []).map((r) => <li key={r}>{r}</li>)}
                  </ul>
                  {(assessment.advice ?? []).length > 0 && (
                    <ul className="mt-1 list-disc pl-5" style={muted}>
                      {(assessment.advice ?? []).map((a) => <li key={a}>{a}</li>)}
                    </ul>
                  )}
                </div>
              )}
              {assessment.canBeDestination === false && (
                <p className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
                  Can be copied FROM, but not TO: {assessment.destinationReason}
                </p>
              )}
            </div>
          )}
        </form>

        {/* Proving a share works BEFORE relying on it nightly. Real I/O, on demand only. */}
        <form action={testLocationAction} className="card flex flex-wrap items-end gap-2 p-3">
          <label className="min-w-64 flex-1 text-sm">
            Test a location is reachable and writable
            <input className="input mt-1 w-full" name="path" placeholder="\\nas\backups" required />
          </label>
          <button className="btn" type="submit">Test</button>
          {lastTest && <p className="w-full text-sm">{lastTest}</p>}
        </form>

        <form action={addRootAction} className="card flex flex-col gap-2 p-3">
          <div className="flex flex-wrap gap-2">
            <label className="min-w-64 flex-1 text-sm">
              Full path
              <input className="input mt-1 w-full" name="path" placeholder="D:\Photos" required />
            </label>
            <label className="text-sm">
              What to call it
              <input className="input mt-1" name="label" placeholder="Photos" />
            </label>
          </div>
          <button className="btn btn-primary self-start" type="submit">Allow this folder</button>
          {lastRoot && <p className="text-sm">{lastRoot}</p>}
        </form>

        {/* Saves typing a sub-folder path by hand, which is where the typos live. */}
        <FolderPicker ctx={ctx} roots={roots} />
      </section>

      {/* --------------------------------------------------------------------- jobs */}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Backups</h3>
        {lastJobSave && <p className="text-sm">{lastJobSave}</p>}

        {jobs.length > 0 && (
          <div className="card flex flex-wrap items-end gap-3 p-3">
            <form action={setConcurrencyAction} className="flex items-end gap-2">
              <label className="text-sm">
                Run at most this many at once
                <input className="input mt-1 w-20" type="number" name="concurrency" min={1} max={16} defaultValue={concurrency} />
              </label>
              <button className="btn" type="submit">Save</button>
            </form>
            <form action={setAllEnabledAction}>
              <input type="hidden" name="enabled" value="0" />
              <button className="btn btn-ghost" type="submit">Pause all</button>
            </form>
            <form action={setAllEnabledAction}>
              <input type="hidden" name="enabled" value="1" />
              <button className="btn btn-ghost" type="submit">Resume all</button>
            </form>
            <p className="w-full text-xs" style={muted}>
              Several backups running at once against one disk finish later than running them in
              turn, and make the machine sluggish meanwhile. Raise this only if the destinations are
              genuinely separate.
            </p>
            {lastConcurrency && <p className="w-full text-sm">{lastConcurrency}</p>}
          </div>
        )}

        {jobs.length === 0 ? (
          <p className="text-sm" style={muted}>None set up yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((j) => (
              <li key={j.id} className="card flex flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {j.name}
                      {!j.enabled && <span className="ml-2 text-xs" style={muted}>(paused)</span>}
                    </span>
                    <span className="text-xs" style={muted}>
                      {j.mode === "snapshot" ? "A new dated copy each time" : "Keeps the destination up to date"}
                      {" · "}{describeSchedule({
                        kind: j.scheduleKind === "daily" ? "daily" : "interval",
                        everyHours: j.everyHours,
                        atMinute: j.atMinute,
                        days: parseDays(j.daysCsv ?? ""),
                      }, formatTime)}
                      {j.mode === "snapshot" && j.pruneEnabled && " · older copies tidied automatically"}
                      {j.maxRetries > 0 && ` · retries ${j.maxRetries}×`}
                      {(j.notifyEmail || j.notifyWebhook) && " · alerts on"}
                      {j.consecutiveFailures > 0 && (
                        <span style={{ color: "var(--danger)" }}> · failing ({j.consecutiveFailures})</span>
                      )}
                    </span>
                  </span>
                  <span className="flex flex-none gap-2">
                    <a className="btn btn-ghost" href={jobPath(j.id)}>Details</a>
                    <form action={previewBackupAction}>
                      <input type="hidden" name="id" value={j.id} />
                      <button className="btn btn-ghost" type="submit">What would it copy?</button>
                    </form>
                    {j.mode === "snapshot" && (
                      <form action={previewPruneAction}>
                        <input type="hidden" name="id" value={j.id} />
                        <button className="btn btn-ghost" type="submit">What would be tidied?</button>
                      </form>
                    )}
                    <form action={runNowAction}>
                      <input type="hidden" name="id" value={j.id} />
                      <button className="btn btn-ghost" type="submit">Run now</button>
                    </form>
                    <form action={cloneJobAction}>
                      <input type="hidden" name="id" value={j.id} />
                      <button className="btn btn-ghost" type="submit">Duplicate</button>
                    </form>
                    <form action={deleteJobAction}>
                      <input type="hidden" name="id" value={j.id} />
                      <button className="btn btn-danger" type="submit">Delete</button>
                    </form>
                  </span>
                </div>

                {backupPreview?.job === j.name && <BackupOutcome preview={backupPreview} />}
                {preview?.job === j.name && <PruneOutcome preview={preview} />}

                <details>
                  <summary className="cursor-pointer text-sm" style={muted}>Edit</summary>
                  <JobForm job={j} roots={roots} />
                </details>
              </li>
            ))}
          </ul>
        )}

        {roots.length < 2 ? (
          <p className="text-sm" style={muted}>
            Allow at least two folders above &mdash; one to copy from, one to copy to &mdash; and
            you can set up a backup.
          </p>
        ) : (
          <details className="card p-3">
            <summary className="cursor-pointer font-medium">Add a backup</summary>
            <JobForm roots={roots} />
          </details>
        )}
      </section>

      {/* -------------------------------------------------------------- log keeping */}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Run logs</h3>
        <p className="text-sm" style={muted}>
          Every run writes a log naming each file it copied, skipped or failed on. Currently{" "}
          {logSize.count} log{logSize.count === 1 ? "" : "s"}, {Math.round(logSize.bytes / 1024)} KB.
          This is about the LOGS, not the backups themselves.
        </p>
        <form action={setLogRetentionAction} className="card flex flex-wrap items-end gap-2 p-3">
          <label className="text-sm">
            Keep for (days)
            <input className="input mt-1" type="number" name="keepDays" min={0} defaultValue={logRetention.keepDays} />
          </label>
          <label className="text-sm">
            Keep at most (runs)
            <input className="input mt-1" type="number" name="keepRuns" min={0} defaultValue={logRetention.keepRuns} />
          </label>
          <button className="btn" type="submit">Save</button>
          <p className="w-full text-xs" style={muted}>0 in either box means &ldquo;keep forever&rdquo;.</p>
          {lastLogRetention && <p className="w-full text-sm">{lastLogRetention}</p>}
        </form>
      </section>
    </div>
  );
}

/** What a backup would copy, before it copies anything. */
function BackupOutcome({ preview }: { preview: BackupPreview }) {
  if (preview.error) {
    return <p className="text-sm" style={{ color: "var(--danger)" }}>{preview.error}</p>;
  }
  const create = preview.create ?? 0;
  const update = preview.update ?? 0;
  const skipped = preview.skipped ?? [];
  return (
    <div className="rounded p-2 text-sm" style={{ background: "var(--surface-2)" }}>
      <p className="font-medium">
        {create + update === 0
          ? "Nothing to copy — the destination is already up to date."
          : `Would copy ${create} new and ${update} changed file(s), ${Math.round((preview.bytes ?? 0) / 1024)} KB in total.`}
      </p>
      {(preview.unchanged ?? 0) > 0 && (
        <p style={{ color: "var(--muted)" }}>{preview.unchanged} already identical, left alone.</p>
      )}
      {(preview.sample ?? []).length > 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          For example: {(preview.sample ?? []).join(", ")}
          {create + update > (preview.sample ?? []).length && " …"}
        </p>
      )}
      {skipped.length > 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Stepped over: {skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}
        </p>
      )}
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        Nothing has been copied — this is a dry run.
      </p>
    </div>
  );
}

/** What retention would take, shown before anything is destroyed. */
function PruneOutcome({ preview }: { preview: PrunePreview }) {
  if (preview.error) {
    return <p className="text-sm" style={{ color: "var(--danger)" }}>{preview.error}</p>;
  }
  const keep = preview.keep ?? [];
  const remove = preview.remove ?? [];
  return (
    <div className="rounded p-2 text-sm" style={{ background: "var(--surface-2)" }}>
      <p className="font-medium">
        {remove.length === 0
          ? "Nothing would be removed."
          : `${remove.length} old ${remove.length === 1 ? "copy" : "copies"} would be removed.`}
      </p>
      {keep.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {keep.map((k) => (
            <li key={k.name}><code className="text-xs">{k.name}</code> &mdash; kept as {k.because}</li>
          ))}
        </ul>
      )}
      {remove.length > 0 && (
        <p className="mt-1" style={{ color: "var(--danger)" }}>
          Would remove: {remove.map((n) => <code key={n} className="mr-2 text-xs">{n}</code>)}
        </p>
      )}
      {(preview.ignored ?? []).length > 0 && (
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Left completely alone (not made by this backup): {(preview.ignored ?? []).join(", ")}
        </p>
      )}
    </div>
  );
}

/** One form, used for both adding and editing — so the two can never drift apart. */
function JobForm({ job, roots }: { job?: Job; roots: { id: string; label: string }[] }) {
  const snapshot = job?.mode === "snapshot";
  const selectedDays = parseDays(job?.daysCsv ?? "");
  return (
    <form action={saveJobAction} className="mt-2 flex flex-col gap-3">
      {job && <input type="hidden" name="id" value={job.id} />}

      <label className="text-sm">
        Name
        <input className="input mt-1 w-full" name="name" defaultValue={job?.name} placeholder="Photos to the NAS" required />
      </label>

      <div className="flex flex-wrap gap-2">
        <label className="text-sm">
          Copy from
          <select className="input mt-1" name="sourceRootId" defaultValue={job?.sourceRootId} required>
            {roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <label className="text-sm">
          Sub-folder (optional)
          <input className="input mt-1" name="sourceSubpath" defaultValue={job?.sourceSubpath} placeholder="2026" />
        </label>
        <label className="text-sm">
          Copy to
          <select className="input mt-1" name="destRootId" defaultValue={job?.destRootId} required>
            {roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <label className="text-sm">
          Sub-folder (optional)
          <input className="input mt-1" name="destSubpath" defaultValue={job?.destSubpath} placeholder="photos" />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="text-sm">
          How
          <select className="input mt-1" name="mode" defaultValue={job?.mode ?? "sync"}>
            <option value="sync">Keep the destination up to date</option>
            <option value="snapshot">A new dated copy each time</option>
          </select>
        </label>
        <label className="text-sm">
          Skip these (comma separated)
          <input className="input mt-1" name="excludeCsv" defaultValue={job?.excludeCsv} placeholder="node_modules, .git" />
        </label>
      </div>

      {/* -- when ---------------------------------------------------------------- */}
      <fieldset className="rounded p-3" style={{ background: "var(--surface-2)" }}>
        <legend className="px-1 text-sm font-medium">When to run</legend>
        <div className="flex flex-wrap gap-2">
          <label className="text-sm">
            Pattern
            <select className="input mt-1" name="scheduleKind" defaultValue={job?.scheduleKind ?? "interval"}>
              <option value="interval">Every so many hours</option>
              <option value="daily">At a time of day</option>
            </select>
          </label>
          <label className="text-sm">
            Every (hours)
            <input className="input mt-1 w-24" type="number" name="everyHours" min={1} max={720} defaultValue={job?.everyHours ?? 24} />
          </label>
          <label className="text-sm">
            At
            <input className="input mt-1 w-24" type="number" name="atMinute" min={0} max={1439} defaultValue={job?.atMinute ?? 120} />
            <span className="mt-1 block text-xs" style={{ color: "var(--muted)" }}>
              minutes past midnight &mdash; {formatTime(job?.atMinute ?? 120)}
            </span>
          </label>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-sm">On these days</span>
          {WEEKDAY_NAMES.map((name, i) => (
            <label key={name} className="flex items-center gap-1 text-sm">
              <input type="checkbox" name="days" value={i} defaultChecked={selectedDays.includes(i)} />
              {name}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Days apply to <strong>at a time of day</strong>. Tick none for every day. &ldquo;Every so
          many hours&rdquo; ignores them and counts from the time above, so it stays on the hour
          rather than drifting later each run.
        </p>
      </fieldset>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={job ? !!job.enabled : true} />
          Run this on a schedule
        </label>
        <label className="text-sm">
          Retry a failure this many times
          <input className="input mt-1 w-20" type="number" name="maxRetries" min={0} max={10} defaultValue={job?.maxRetries ?? 0} />
        </label>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          0 means wait for the next scheduled run. Retries back off — five minutes, then ten, up
          to an hour — and never delay the job past its own next slot.
        </span>
      </div>

      {/* -- retention ---------------------------------------------------------- */}
      <fieldset className="rounded p-3" style={{ background: "var(--surface-2)" }}>
        <legend className="px-1 text-sm font-medium">Tidying up old copies</legend>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Only applies to <strong>a new dated copy each time</strong>. It <strong>deletes</strong> old
          copies, so it is off until you turn it on. The most recent copy is always kept, whatever
          these say, and nothing of yours sitting alongside them is ever touched. Use{" "}
          <em>What would be tidied?</em> above to see exactly what would go before enabling it.
        </p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" name="pruneEnabled" defaultChecked={!!job?.pruneEnabled} />
          Tidy up old copies automatically
          {!snapshot && job && (
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              (no effect while this is a keep-up-to-date backup)
            </span>
          )}
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="text-sm">
            Daily
            <input className="input mt-1 w-20" type="number" name="keepDaily" min={0} defaultValue={job?.keepDaily ?? 7} />
          </label>
          <label className="text-sm">
            Weekly
            <input className="input mt-1 w-20" type="number" name="keepWeekly" min={0} defaultValue={job?.keepWeekly ?? 4} />
          </label>
          <label className="text-sm">
            Monthly
            <input className="input mt-1 w-20" type="number" name="keepMonthly" min={0} defaultValue={job?.keepMonthly ?? 12} />
          </label>
          <label className="text-sm">
            Yearly
            <input className="input mt-1 w-20" type="number" name="keepYearly" min={0} defaultValue={job?.keepYearly ?? 0} />
          </label>
        </div>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Keeps the last copy of each of the last N days, weeks, months and years &mdash; so recent
          days stay detailed while older history thins out.
        </p>
      </fieldset>

      {/* -- alerts ------------------------------------------------------------- */}
      <fieldset className="rounded p-3" style={{ background: "var(--surface-2)" }}>
        <legend className="px-1 text-sm font-medium">Telling you when it goes wrong</legend>
        <div className="flex flex-wrap gap-2">
          <label className="text-sm">
            Email to
            <input className="input mt-1" type="email" name="notifyEmail" defaultValue={job?.notifyEmail} placeholder="you@example.com" />
          </label>
          <label className="min-w-64 flex-1 text-sm">
            Or POST to a web address
            <input className="input mt-1 w-full" type="url" name="notifyWebhook" defaultValue={job?.notifyWebhook} placeholder="https://…" />
          </label>
          <label className="text-sm">
            Also warn if nothing has succeeded in (hours)
            <input className="input mt-1 w-24" type="number" name="staleAfterHours" min={0} defaultValue={job?.staleAfterHours ?? 0} />
          </label>
        </div>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Leave blank for no alerts. The last box catches the quiet failure: a backup that stopped
          running altogether raises nothing on its own, because nothing failed. 0 turns it off.
        </p>
      </fieldset>

      <button className="btn btn-primary self-start" type="submit">
        {job ? "Save changes" : "Save backup"}
      </button>
    </form>
  );
}
