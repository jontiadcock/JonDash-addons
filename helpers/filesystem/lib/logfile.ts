import fs from "node:fs/promises";
import path from "node:path";

/**
 * Per-run log files, and how long they are kept. A backup that reports "3 files copied, 2
 * skipped" is not accountable — *which* two? Since the helper steps over JonDash's secrets
 * rather than refusing the folder outright, an unenumerable skip is indistinguishable from
 * a bug, so each run writes a plain-text log naming every file it copied, skipped or failed
 * on, downloadable by the admin.
 *
 * See `logDir()` for where these live and why, `MAX_DETAIL_BYTES` for the size cap.
 */

/**
 * Stop recording per-file successes past this point — skips and errors continue. Logging
 * every file means a `C:\` run could otherwise produce a log larger than some of the files
 * it copied; past the cap, the lines that exist for accountability (skips, errors) are the
 * ones worth keeping when something has to give.
 */
const MAX_DETAIL_BYTES = 32 * 1024 * 1024;

/** Flush after this many lines. Small enough to survive a crash, large enough to be cheap. */
const FLUSH_EVERY = 128;

/** REFS helpers/filesystem/api.ts · helpers/filesystem/lib/admin.ts */
export type RetentionPolicy = {
  /** Delete logs older than this many days. 0 disables the age rule. */
  keepDays: number;
  /** Keep at most this many of the most recent logs. 0 disables the count rule. */
  keepRuns: number;
};

/**
 * REFS helpers/filesystem/api.ts · helpers/filesystem/helper.ts ·
 *      helpers/filesystem/lib/admin.ts
 */
export const DEFAULT_RETENTION: RetentionPolicy = { keepDays: 30, keepRuns: 50 };

/**
 * `<install>/logs/helpers/filesystem/` — resolved per call so it honours a relocated
 * install, like everything else here. Three properties had to hold: it survives an update
 * (`logs` is in the updater's preserve list), it stays out of JonDash's own backups (core's
 * config backup walks `.data` with an EXCLUDE list, so anything elsewhere travels with every
 * backup file), and it matches where JonDash already logs, so an admin finds everything in
 * one place.
 *
 * REFS helpers/filesystem/tests/logfile.test.ts
 */
export function logDir(): string {
  return path.join(process.cwd(), "logs", "helpers", "filesystem");
}

/**
 * Run ids come from the helper, but `readLog` is reachable from a page URL — so treat the
 * id as untrusted and refuse anything that is not a plain id. A log viewer that will read
 * `../../.data/secrets.json` would hand back the very thing the rest of this helper exists
 * to protect.
 */
function safeId(runId: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(runId) ? runId : null;
}

function fileFor(runId: string): string | null {
  const id = safeId(runId);
  return id ? path.join(logDir(), `${id}.log`) : null;
}

const stamp = (d = new Date()) => d.toISOString().replace("T", " ").slice(0, 19);

export type LogHeader = {
  runId: string;
  moduleId: string;
  mode: string;
  source: string;
  destination: string;
  /** Warnings the admin accepted when choosing these folders, if any. */
  warnings?: string[];
  /** Set when the master key could not be resolved — the exclusion may be incomplete. */
  keyUnresolved?: boolean;
};

export type LogSummary = {
  state: string;
  filesCopied: number;
  bytesCopied: number;
  skipped: number;
  errors: number;
  error?: string | null;
  /**
   * What this run was. A prune copies nothing and deletes things, so a footer reading
   * "Copied 0 file(s) / Skipped 4" is actively misleading about an operation that just
   * destroyed four backups. Different work, different words.
   */
  kind?: "copy" | "prune";
};

/**
 * An open log for one run. Writes are appended; nothing is held in memory but a buffer.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/copy.ts ·
 *      helpers/filesystem/lib/prune.ts · helpers/filesystem/tests/logfile.test.ts
 */
export class RunLog {
  private buf: string[] = [];
  private written = 0;
  private detailStopped = false;
  private closed = false;

  private constructor(readonly file: string) {}

  /** Never throws: a backup must not fail because its log could not be opened. */
  static async open(header: LogHeader): Promise<RunLog | null> {
    const file = fileFor(header.runId);
    if (!file) return null;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const log = new RunLog(file);
      log.buf.push(
        "JonDash — backup run log",
        `Run           ${header.runId}`,
        `Requested by  ${header.moduleId}`,
        `Started       ${stamp()}`,
        `Mode          ${header.mode}`,
        `Source        ${header.source}`,
        `Destination   ${header.destination}`,
      );
      for (const w of header.warnings ?? []) log.buf.push(`Warning       ${w}`);
      if (header.keyUnresolved) {
        log.buf.push(
          "Warning       JonDash's encryption key could not be read, so copies of it could not be",
          "              recognised by content. Files at its known locations were still skipped.",
        );
      }
      log.buf.push("-".repeat(78));
      await log.flush();
      return log;
    } catch {
      return null;
    }
  }

  private async flush(): Promise<void> {
    if (!this.buf.length) return;
    const text = this.buf.join("\n") + "\n";
    this.buf = [];
    try {
      await fs.appendFile(this.file, text, "utf8");
      this.written += Buffer.byteLength(text);
    } catch {
      // A log that cannot be written must never take the backup down with it.
    }
  }

  private push(line: string): void {
    this.buf.push(line);
    if (this.buf.length >= FLUSH_EVERY) void this.flush();
  }

  /** A file that was copied. Suppressed once the log grows past its cap. */
  copied(relPath: string, bytes: number): void {
    if (this.closed) return;
    if (this.written > MAX_DETAIL_BYTES) {
      if (!this.detailStopped) {
        this.detailStopped = true;
        this.push(
          `${stamp()}  … this log has reached its size limit; individual copied files are no longer listed. Skipped files and errors still are.`,
        );
      }
      return;
    }
    this.push(`${stamp()}  copied   ${relPath} (${bytes} bytes)`);
  }

  /** A file deliberately NOT copied, and why. Always recorded. */
  skipped(relPath: string, reason: string): void {
    if (this.closed) return;
    this.push(`${stamp()}  SKIPPED  ${relPath} — ${reason}`);
  }

  /**
   * Something DESTROYED, and why. Kept distinct from `skipped` deliberately: a line reading
   * "SKIPPED — removed by retention policy" describes the opposite of what happened, and
   * this is the one log anybody reads after wondering where a backup went.
   */
  removed(relPath: string, reason: string): void {
    if (this.closed) return;
    this.push(`${stamp()}  REMOVED  ${relPath} — ${reason}`);
  }

  /** A file that could not be read or written. Always recorded. */
  failed(relPath: string, reason: string): void {
    if (this.closed) return;
    this.push(`${stamp()}  ERROR    ${relPath} — ${reason}`);
  }

  async close(summary: LogSummary): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.push("-".repeat(78));
    this.push(`Finished      ${stamp()}`);
    this.push(`Result        ${summary.state}`);
    if (summary.kind === "prune") {
      this.push(`Removed       ${summary.skipped} backup(s)`);
    } else {
      this.push(`Copied        ${summary.filesCopied} file(s), ${summary.bytesCopied} bytes`);
      this.push(`Skipped       ${summary.skipped} (protected or excluded)`);
    }
    this.push(`Errors        ${summary.errors}`);
    if (summary.error) this.push(`Detail        ${summary.error}`);
    await this.flush();
  }
}

/** REFS helpers/filesystem/api.ts */
export type LogEntry = { runId: string; bytes: number; modifiedAt: string };

/**
 * Newest first. Never throws — an unreadable log directory simply has no logs in it.
 * REFS helpers/filesystem/api.ts · helpers/filesystem/tests/logfile.test.ts
 */
export async function listLogs(): Promise<LogEntry[]> {
  const dir = logDir();
  const out: LogEntry[] = [];
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".log")) continue;
      const runId = name.slice(0, -4);
      if (!safeId(runId)) continue;
      try {
        const st = await fs.stat(path.join(dir, name));
        out.push({ runId, bytes: st.size, modifiedAt: st.mtime.toISOString() });
      } catch {
        // Vanished between readdir and stat. Fine.
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * The log text, or null if there isn't one.
 * REFS helpers/filesystem/api.ts · helpers/filesystem/tests/logfile.test.ts
 */
export async function readLog(runId: string): Promise<string | null> {
  const file = fileFor(runId);
  if (!file) return null;
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function deleteLog(runId: string): Promise<void> {
  const file = fileFor(runId);
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch {
    // Already gone.
  }
}

/**
 * Apply retention. Age and count are independent rules and BOTH apply — a log is removed
 * if it is too old *or* if it has fallen outside the most recent `keepRuns`. Setting
 * either to 0 disables that rule; setting both to 0 keeps everything forever.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/helper.ts ·
 *      helpers/filesystem/lib/admin.ts · helpers/filesystem/tests/logfile.test.ts
 */
export async function pruneLogs(policy: RetentionPolicy = DEFAULT_RETENTION): Promise<{ removed: number }> {
  const entries = await listLogs(); // already newest-first
  const doomed = new Set<string>();

  if (policy.keepDays > 0) {
    const cutoff = Date.now() - policy.keepDays * 86_400_000;
    for (const e of entries) {
      if (Date.parse(e.modifiedAt) < cutoff) doomed.add(e.runId);
    }
  }
  if (policy.keepRuns > 0) {
    for (const e of entries.slice(policy.keepRuns)) doomed.add(e.runId);
  }

  for (const runId of doomed) await deleteLog(runId);
  return { removed: doomed.size };
}

/**
 * Total bytes on disk, so an admin can see what retention is actually costing.
 * REFS helpers/filesystem/api.ts · helpers/filesystem/tests/logfile.test.ts
 */
export async function logsFootprint(): Promise<{ count: number; bytes: number }> {
  const entries = await listLogs();
  return { count: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) };
}
