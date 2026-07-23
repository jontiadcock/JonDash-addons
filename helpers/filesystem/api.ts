import "server-only";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ModuleContext } from "@/lib/modules/types";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import {
  assertUsableAsSource,
  assertUsableAsDestination,
  assertDistinct,
  canonicalise,
  contains,
} from "./lib/paths";
import { assessRoot, riskSummary, type RootRisk } from "./lib/risk";
import { loadRegistry } from "./lib/secrets";
import {
  DEFAULT_RETENTION,
  RunLog,
  listLogs,
  logsFootprint,
  pruneLogs,
  readLog,
  type LogEntry,
  type RetentionPolicy,
} from "./lib/logfile";
import { probeLocation, type ProbeResult } from "./lib/probe";
import { planCopy, runCopy, type CopyMode, type CopyPlan, type CopyResult } from "./lib/copy";

/**
 * The ONLY surface a consuming module can reach — `@/helpers/filesystem/api`. The verifier
 * permits that import solely for modules that declared `helpers: ["filesystem"]`, and it
 * refuses any deeper path, so everything below is free to change without breaking anyone.
 *
 * There is no call here that returns the contents of a file, and there must never be one.
 * A module names an operation and gets back counts; the bytes never leave this helper. That
 * single restriction is what stops this becoming a way to read `.data/secrets.json`.
 *
 * Every path a module supplies is resolved RELATIVE TO A ROOT the administrator approved.
 * A module cannot name an absolute path at all — that is what lets the consent screen say
 * "the folders you allow" and mean it.
 *
 * ## What changed in 0.0.2
 *
 * A root may now be anything the admin can name, including `C:\`. Refusing broad folders
 * protected a *location*, which is a rule you can walk around by moving a file; the
 * protection now sits on the secrets themselves, which move with them. Three consequences
 * live in this file:
 *
 *  - `assessPath` exists so a module can WARN before saving, since the helper no longer
 *    refuses (see `lib/risk.ts`).
 *  - Every run loads a fresh secret registry and hands it to the copy engine.
 *  - Every run writes a downloadable log naming what it skipped, because a silent
 *    exclusion in a backup tool is discovered at restore time, which is far too late.
 */

const ROOTS = helperTableName("filesystem", "roots");
const RUNS = helperTableName("filesystem", "runs");
const SETTINGS = helperTableName("filesystem", "settings");

export type Root = {
  id: string;
  path: string;
  label: string;
  /** What the admin was warned about when approving it. */
  riskLevel: RootRisk["level"];
  riskNote: string | null;
};

/** In-flight runs, so a module can watch or cancel one. Lost on restart — deliberately: a
 *  run that didn't finish is reconciled as `interrupted`, never as `done`. */
const live = new Map<string, { signal: { aborted: boolean }; progress: Progress }>();
export type Progress = { filesDone: number; bytesDone: number; currentPath: string };

const ROOT_COLS = "id, path, label, riskLevel, riskNote";

async function allRoots(): Promise<Root[]> {
  return prisma.$queryRawUnsafe<Root[]>(`SELECT ${ROOT_COLS} FROM ${ROOTS} ORDER BY label`);
}

async function rootById(id: string): Promise<Root | null> {
  const rows = await prisma.$queryRawUnsafe<Root[]>(`SELECT ${ROOT_COLS} FROM ${ROOTS} WHERE id = ?`, id);
  return rows[0] ?? null;
}

const asNum = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

async function getSetting(key: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
    `SELECT value FROM ${SETTINGS} WHERE key = ?`,
    key,
  );
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${SETTINGS} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

/** Retention, with the defaults applied when nothing has been chosen. */
async function readRetention(): Promise<RetentionPolicy> {
  const [days, runs] = await Promise.all([getSetting("log.keepDays"), getSetting("log.keepRuns")]);
  const n = (v: string | null, dflt: number) => {
    // The absent case must be tested BEFORE coercing: `Number(null)` and `Number("")` are
    // both 0, which is a legitimate stored value meaning "keep forever". Coercing first
    // silently turned "never configured" into "no retention at all" — caught in a browser,
    // where the page read "keeping unlimited days" on a fresh install.
    if (v === null || v.trim() === "") return dflt;
    const parsed = Number(v);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : dflt;
  };
  return {
    keepDays: n(days, DEFAULT_RETENTION.keepDays),
    keepRuns: n(runs, DEFAULT_RETENTION.keepRuns),
  };
}

/**
 * Resolve a module-supplied location to a real path, or refuse.
 *
 * `subpath` is always relative and always re-checked for containment after joining — a
 * `..` that survives normalisation must never be able to climb out of the root.
 *
 * `usage` decides which rules apply. Reading is permissive; writing refuses anywhere that
 * could alter this machine rather than merely fill it. The root is re-validated on every
 * use, not merely when it was added — the folder may since have become a symlink somewhere
 * it shouldn't be.
 */
async function resolveIn(
  rootId: string,
  usage: "source" | "dest",
  subpath?: string,
): Promise<{ ok: true; path: string; root: Root } | { ok: false; reason: string }> {
  const root = await rootById(rootId);
  if (!root) return { ok: false, reason: "That location is no longer one of your allowed folders." };

  const stillValid = usage === "source" ? assertUsableAsSource(root.path) : assertUsableAsDestination(root.path);
  if (!stillValid.ok) return { ok: false, reason: stillValid.reason };

  if (!subpath) return { ok: true, path: stillValid.path, root };
  if (path.isAbsolute(subpath)) {
    return { ok: false, reason: "Give a folder inside the allowed location, not a full path." };
  }

  const joined = path.resolve(stillValid.path, subpath);
  if (!contains(stillValid.path, joined)) {
    return { ok: false, reason: "That is outside the allowed folder." };
  }
  return { ok: true, path: joined, root };
}

/** What a folder means, before anybody commits to it. */
export type PathAssessment = {
  ok: boolean;
  /** The canonical form, when the path is well-formed. */
  path: string | null;
  /** Why it can't be used at all. Null when `ok`. */
  reason: string | null;
  risk: RootRisk;
  /** False when it may be read but never written into (JonDash's own folder, the OS). */
  canBeDestination: boolean;
  destinationReason: string | null;
};

export type RunStatus = {
  state: "running" | "done" | "failed" | "cancelled" | "interrupted";
  filesCopied: number;
  bytesCopied: number;
  errorCount: number;
  /** Files deliberately not copied — protected secrets, or unreadable folders. */
  skippedCount: number;
  error: string | null;
  destination: string | null;
  /** True when a downloadable log survives for this run. */
  hasLog: boolean;
};

export type Spec = {
  sourceRootId: string;
  sourceSubpath?: string;
  destRootId: string;
  destSubpath?: string;
  mode: CopyMode;
  exclude?: string[];
};

export type FilesystemApi = {
  /** Locations the administrator has approved. */
  listRoots(): Promise<Root[]>;
  /**
   * What would happen if this path were approved — warnings included. Purely textual and
   * safe to call while rendering a form; it touches no disk and reaches no network.
   */
  assessPath(input: string): PathAssessment;
  /** Approve a location. Refuses only malformed paths; breadth is warned about, not blocked. */
  addRoot(input: { path: string; label: string }): Promise<{ ok: true; root: Root } | { ok: false; reason: string }>;
  /** Forget a location. Touches no files. */
  removeRoot(rootId: string): Promise<void>;
  /** The explicit "Test this location" check. Does real I/O — only call it on demand. */
  testLocation(input: string, opts?: { wantWritable?: boolean }): Promise<ProbeResult>;
  /** Folder contents for a picker: names, sizes and dates only — never file contents. */
  browse(rootId: string, subpath?: string): Promise<{ name: string; isDir: boolean; bytes: number; modifiedAt: string }[]>;
  /** A dry run. What a real run would change — and skip — having changed nothing. */
  plan(spec: Spec): Promise<{ ok: true; plan: CopyPlan } | { ok: false; reason: string }>;
  /** Begin a run. Returns immediately with an id to watch. */
  start(spec: Spec): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  /** Live progress while a run is in flight, or null once it has ended. In-memory only. */
  progress(runId: string): Progress | null;
  /**
   * The PERSISTED outcome of a run, from the helper's own table. Survives the run ending
   * and survives a restart — a consumer reconciles against this rather than polling
   * `progress`, so nothing has to block for the length of a backup. `null` if unknown.
   */
  status(runId: string): Promise<RunStatus | null>;
  cancel(runId: string): void;

  /** Every run log still on disk, newest first. */
  logs(): Promise<LogEntry[]>;
  /** One log's full text, for download. Null when it has been pruned or never existed. */
  logText(runId: string): Promise<string | null>;
  /** What the logs currently cost on disk. */
  logsSize(): Promise<{ count: number; bytes: number }>;
  /** How long logs are kept. */
  retention(): Promise<RetentionPolicy>;
  /** Change it, and apply the new policy immediately. */
  setRetention(policy: RetentionPolicy): Promise<{ removed: number }>;
};

/** Resolve a spec's two ends, applying every path rule before anything is touched. */
async function resolveSpec(
  spec: Spec,
): Promise<{ ok: true; source: string; dest: string; warnings: string[] } | { ok: false; reason: string }> {
  const source = await resolveIn(spec.sourceRootId, "source", spec.sourceSubpath);
  if (!source.ok) return source;
  const dest = await resolveIn(spec.destRootId, "dest", spec.destSubpath);
  if (!dest.ok) return dest;
  const distinct = assertDistinct(source.path, dest.path);
  if (!distinct.ok) return { ok: false, reason: distinct.reason };

  const warnings = [source.root.riskNote, dest.root.riskNote].filter((w): w is string => !!w);
  return { ok: true, source: source.path, dest: dest.path, warnings };
}

const api = (ctx: ModuleContext): FilesystemApi => ({
  listRoots: allRoots,

  assessPath(input) {
    const canonical = canonicalise(input);
    if (!canonical.ok) {
      return {
        ok: false,
        path: null,
        reason: canonical.reason,
        risk: assessRoot(""),
        canBeDestination: false,
        destinationReason: null,
      };
    }
    const source = assertUsableAsSource(input);
    if (!source.ok) {
      return {
        ok: false,
        path: null,
        reason: source.reason,
        risk: assessRoot(""),
        canBeDestination: false,
        destinationReason: null,
      };
    }
    const dest = assertUsableAsDestination(input);
    return {
      ok: true,
      path: source.path,
      reason: null,
      risk: assessRoot(source.path),
      canBeDestination: dest.ok,
      destinationReason: dest.ok ? null : dest.reason,
    };
  },

  async addRoot({ path: input, label }) {
    const verdict = assertUsableAsSource(input);
    if (!verdict.ok) {
      // Recorded by the HELPER, not left to the caller. A refusal is a module reaching
      // outside its bounds — the single most interesting thing in this log — and a module
      // that meant harm would simply decline to report it.
      await ctx.audit?.("filesystem.root.refused", `${input}: ${verdict.reason}`);
      return { ok: false, reason: verdict.reason };
    }

    const existing = await prisma.$queryRawUnsafe<Root[]>(
      `SELECT ${ROOT_COLS} FROM ${ROOTS} WHERE path = ?`,
      verdict.path,
    );
    if (existing[0]) return { ok: true, root: existing[0] };

    const risk = assessRoot(verdict.path);
    const note = riskSummary(risk) || null;
    const root: Root = {
      id: randomUUID(),
      path: verdict.path,
      label: label.trim() || verdict.path,
      riskLevel: risk.level,
      riskNote: note,
    };
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${ROOTS} (id, path, label, addedAt, addedBy, riskLevel, riskNote) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      root.id, root.path, root.label, new Date().toISOString(), ctx.user?.id ?? null, root.riskLevel, root.riskNote,
    );
    // Recorded so a location that appears without the admin's knowledge is discoverable —
    // and at what risk level, so a later `C:\` is visible in the log without re-deriving it.
    await ctx.audit?.(
      "filesystem.root.add",
      `${root.label} — ${root.path}${risk.level === "none" ? "" : ` (${risk.level} risk)`}`,
    );
    return { ok: true, root };
  },

  async removeRoot(rootId) {
    const root = await rootById(rootId);
    await prisma.$executeRawUnsafe(`DELETE FROM ${ROOTS} WHERE id = ?`, rootId);
    if (root) await ctx.audit?.("filesystem.root.remove", `${root.label} — ${root.path}`);
  },

  testLocation: (input, opts) => probeLocation(input, opts),

  async browse(rootId, subpath) {
    const at = await resolveIn(rootId, "source", subpath);
    if (!at.ok) return [];
    const entries = await fsp.readdir(at.path, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const stat = await fsp.stat(path.join(at.path, e.name)).catch(() => null);
      if (!stat) continue;
      out.push({
        name: e.name,
        isDir: e.isDirectory(),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
    return out;
  },

  async plan(spec) {
    const r = await resolveSpec(spec);
    if (!r.ok) return r;
    const registry = await loadRegistry();
    return {
      ok: true,
      plan: await planCopy(r.source, r.dest, { mode: spec.mode, exclude: spec.exclude, registry }),
    };
  },

  async start(spec) {
    const r = await resolveSpec(spec);
    if (!r.ok) {
      await ctx.audit?.("filesystem.run.refused", r.reason);
      return r;
    }

    const runId = randomUUID();
    const signal = { aborted: false };
    live.set(runId, { signal, progress: { filesDone: 0, bytesDone: 0, currentPath: "" } });

    // Resolved per run, never cached: the admin may have moved the database or rotated the
    // key since the last one, and a stale registry protects the wrong place.
    const registry = await loadRegistry();
    const log = await RunLog.open({
      runId,
      moduleId: ctx.moduleId,
      mode: spec.mode,
      source: r.source,
      destination: r.dest,
      warnings: r.warnings,
      keyUnresolved: registry.keyUnresolved,
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO ${RUNS} (id, moduleId, startedAt, state, logPath) VALUES (?, ?, ?, 'running', ?)`,
      runId, ctx.moduleId, new Date().toISOString(), log?.file ?? null,
    );

    // Old logs go now rather than at the end, so a run that never finishes still leaves the
    // directory tidy.
    void pruneLogs(await readRetention()).catch(() => undefined);

    // Deliberately not awaited: `start` returns an id and the caller watches. A backup can
    // take hours, and nothing that renders a page may block on one.
    void runCopy(r.source, r.dest, {
      mode: spec.mode,
      exclude: spec.exclude,
      signal,
      registry,
      log,
      onProgress: (p) => {
        const entry = live.get(runId);
        if (entry) entry.progress = p;
      },
    })
      .then(async (res: CopyResult) => {
        await log?.close({
          state: res.state,
          filesCopied: res.filesCopied,
          bytesCopied: res.bytesCopied,
          skipped: res.skippedCount,
          errors: res.errorCount,
          error: res.errors[0]?.reason ?? null,
        });
        await prisma.$executeRawUnsafe(
          `UPDATE ${RUNS} SET finishedAt = ?, state = ?, destination = ?, filesCopied = ?, bytesCopied = ?, errorCount = ?, skippedCount = ?, error = ? WHERE id = ?`,
          new Date().toISOString(), res.state, res.destination, res.filesCopied, res.bytesCopied,
          res.errorCount, res.skippedCount, res.errors[0]?.reason ?? null, runId,
        );
        await ctx.audit?.(
          "filesystem.run.finish",
          `${res.state}: ${res.filesCopied} file(s), ${res.skippedCount} skipped, ${res.errorCount} error(s) → ${res.destination}`,
        );
      })
      .catch(async (e: unknown) => {
        const message = String((e as Error)?.message ?? e).slice(0, 300);
        await log?.close({ state: "failed", filesCopied: 0, bytesCopied: 0, skipped: 0, errors: 1, error: message });
        await prisma.$executeRawUnsafe(
          `UPDATE ${RUNS} SET finishedAt = ?, state = 'failed', error = ? WHERE id = ?`,
          new Date().toISOString(), message, runId,
        );
      })
      .finally(() => live.delete(runId));

    return { ok: true, runId };
  },

  progress: (runId) => live.get(runId)?.progress ?? null,

  async status(runId) {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT state, filesCopied, bytesCopied, errorCount, skippedCount, error, destination, logPath FROM ${RUNS} WHERE id = ?`,
      runId,
    );
    const r = rows[0];
    if (!r) return null;

    // The row can outlive its log once retention has been applied, so "is there a log"
    // is answered by looking, not by the row remembering there once was one.
    let hasLog = false;
    if (r.logPath) hasLog = await fsp.stat(String(r.logPath)).then(() => true).catch(() => false);

    return {
      state: String(r.state) as RunStatus["state"],
      filesCopied: asNum(r.filesCopied),
      bytesCopied: asNum(r.bytesCopied),
      errorCount: asNum(r.errorCount),
      skippedCount: asNum(r.skippedCount),
      error: (r.error as string | null) ?? null,
      destination: (r.destination as string | null) ?? null,
      hasLog,
    };
  },

  cancel: (runId) => {
    const entry = live.get(runId);
    if (entry) entry.signal.aborted = true;
  },

  logs: () => listLogs(),
  logText: (runId) => readLog(runId),
  logsSize: () => logsFootprint(),
  retention: () => readRetention(),

  async setRetention(policy) {
    const clamp = (n: number, max: number) =>
      Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), max) : 0;
    const next: RetentionPolicy = {
      keepDays: clamp(policy.keepDays, 3650),
      keepRuns: clamp(policy.keepRuns, 10_000),
    };
    await setSetting("log.keepDays", String(next.keepDays));
    await setSetting("log.keepRuns", String(next.keepRuns));
    await ctx.audit?.(
      "filesystem.logs.retention",
      `keep ${next.keepDays || "unlimited"} days, ${next.keepRuns || "unlimited"} runs`,
    );
    return pruneLogs(next);
  },
});

export default api;
