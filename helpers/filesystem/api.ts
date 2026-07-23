import "server-only";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ModuleContext } from "@/lib/modules/types";
import { prisma } from "@/lib/db";
import { helperTableName } from "@/lib/helpers/migrate";
import { assertUsable, assertDistinct, contains } from "./lib/paths";
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
 */

const ROOTS = helperTableName("filesystem", "roots");
const RUNS = helperTableName("filesystem", "runs");

export type Root = { id: string; path: string; label: string };

/** In-flight runs, so a module can watch or cancel one. Lost on restart — deliberately: a
 *  run that didn't finish is reconciled as `interrupted`, never as `done`. */
const live = new Map<string, { signal: { aborted: boolean }; progress: Progress }>();
export type Progress = { filesDone: number; bytesDone: number; currentPath: string };

async function allRoots(): Promise<Root[]> {
  return prisma.$queryRawUnsafe<Root[]>(`SELECT id, path, label FROM ${ROOTS} ORDER BY label`);
}

async function rootById(id: string): Promise<Root | null> {
  const rows = await prisma.$queryRawUnsafe<Root[]>(`SELECT id, path, label FROM ${ROOTS} WHERE id = ?`, id);
  return rows[0] ?? null;
}

/**
 * Resolve a module-supplied location to a real path, or refuse.
 *
 * `subpath` is always relative and always re-checked for containment after joining —
 * a `..` that survives normalisation must never be able to climb out of the root.
 */
async function resolveIn(rootId: string, subpath?: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const root = await rootById(rootId);
  if (!root) return { ok: false, reason: "That location is no longer one of your allowed folders." };

  // The root is re-validated on every use, not merely when it was added: the deny-list may
  // have changed, or the folder may now be a symlink somewhere it shouldn't be.
  const stillValid = assertUsable(root.path);
  if (!stillValid.ok) return { ok: false, reason: stillValid.reason };

  if (!subpath) return { ok: true, path: stillValid.path };
  if (path.isAbsolute(subpath)) return { ok: false, reason: "Give a folder inside the allowed location, not a full path." };

  const joined = path.resolve(stillValid.path, subpath);
  if (!contains(stillValid.path, joined)) {
    return { ok: false, reason: "That is outside the allowed folder." };
  }
  return { ok: true, path: joined };
}

export type FilesystemApi = {
  /** Locations the administrator has approved. */
  listRoots(): Promise<Root[]>;
  /** Validate + approve a new location. Refuses with a reason; never narrows a bad path. */
  addRoot(input: { path: string; label: string }): Promise<{ ok: true; root: Root } | { ok: false; reason: string }>;
  /** Forget a location. Touches no files. */
  removeRoot(rootId: string): Promise<void>;
  /** The explicit "Test this location" check. Does real I/O — only call it on demand. */
  testLocation(input: string, opts?: { wantWritable?: boolean }): Promise<ProbeResult>;
  /** Folder contents for a picker: names, sizes and dates only — never file contents. */
  browse(rootId: string, subpath?: string): Promise<{ name: string; isDir: boolean; bytes: number; modifiedAt: string }[]>;
  /** A dry run. What a real run would change, having changed nothing. */
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
};

export type RunStatus = {
  state: "running" | "done" | "failed" | "cancelled" | "interrupted";
  filesCopied: number;
  bytesCopied: number;
  errorCount: number;
  error: string | null;
  destination: string | null;
};

const asNum = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

export type Spec = {
  sourceRootId: string;
  sourceSubpath?: string;
  destRootId: string;
  destSubpath?: string;
  mode: CopyMode;
  exclude?: string[];
};

/** Resolve a spec's two ends, applying every path rule before anything is touched. */
async function resolveSpec(spec: Spec): Promise<{ ok: true; source: string; dest: string } | { ok: false; reason: string }> {
  const source = await resolveIn(spec.sourceRootId, spec.sourceSubpath);
  if (!source.ok) return source;
  const dest = await resolveIn(spec.destRootId, spec.destSubpath);
  if (!dest.ok) return dest;
  const distinct = assertDistinct(source.path, dest.path);
  if (!distinct.ok) return { ok: false, reason: distinct.reason };
  return { ok: true, source: source.path, dest: dest.path };
}

const api = (ctx: ModuleContext): FilesystemApi => ({
  listRoots: allRoots,

  async addRoot({ path: input, label }) {
    const verdict = assertUsable(input);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    const existing = await prisma.$queryRawUnsafe<Root[]>(`SELECT id, path, label FROM ${ROOTS} WHERE path = ?`, verdict.path);
    if (existing[0]) return { ok: true, root: existing[0] };

    const root: Root = { id: randomUUID(), path: verdict.path, label: label.trim() || verdict.path };
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${ROOTS} (id, path, label, addedAt, addedBy) VALUES (?, ?, ?, ?, ?)`,
      root.id, root.path, root.label, new Date().toISOString(), ctx.user?.id ?? null,
    );
    // Recorded so a location that appears without the admin's knowledge is discoverable.
    await ctx.audit?.("filesystem.root.add", `${root.label} — ${root.path}`);
    return { ok: true, root };
  },

  async removeRoot(rootId) {
    const root = await rootById(rootId);
    await prisma.$executeRawUnsafe(`DELETE FROM ${ROOTS} WHERE id = ?`, rootId);
    if (root) await ctx.audit?.("filesystem.root.remove", `${root.label} — ${root.path}`);
  },

  testLocation: (input, opts) => probeLocation(input, opts),

  async browse(rootId, subpath) {
    const at = await resolveIn(rootId, subpath);
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
    return { ok: true, plan: await planCopy(r.source, r.dest, { mode: spec.mode, exclude: spec.exclude }) };
  },

  async start(spec) {
    const r = await resolveSpec(spec);
    if (!r.ok) return r;

    const runId = randomUUID();
    const signal = { aborted: false };
    live.set(runId, { signal, progress: { filesDone: 0, bytesDone: 0, currentPath: "" } });

    await prisma.$executeRawUnsafe(
      `INSERT INTO ${RUNS} (id, moduleId, startedAt, state) VALUES (?, ?, ?, 'running')`,
      runId, ctx.moduleId, new Date().toISOString(),
    );

    // Deliberately not awaited: `start` returns an id and the caller watches. A backup can
    // take hours, and nothing that renders a page may block on one.
    void runCopy(r.source, r.dest, {
      mode: spec.mode,
      exclude: spec.exclude,
      signal,
      onProgress: (p) => {
        const entry = live.get(runId);
        if (entry) entry.progress = p;
      },
    })
      .then(async (res: CopyResult) => {
        await prisma.$executeRawUnsafe(
          `UPDATE ${RUNS} SET finishedAt = ?, state = ?, destination = ?, filesCopied = ?, bytesCopied = ?, errorCount = ?, error = ? WHERE id = ?`,
          new Date().toISOString(), res.state, res.destination, res.filesCopied, res.bytesCopied,
          res.errors.length, res.errors[0]?.reason ?? null, runId,
        );
        await ctx.audit?.(
          "filesystem.run.finish",
          `${res.state}: ${res.filesCopied} file(s), ${res.errors.length} error(s) → ${res.destination}`,
        );
      })
      .catch(async (e: unknown) => {
        await prisma.$executeRawUnsafe(
          `UPDATE ${RUNS} SET finishedAt = ?, state = 'failed', error = ? WHERE id = ?`,
          new Date().toISOString(), String((e as Error)?.message ?? e).slice(0, 300), runId,
        );
      })
      .finally(() => live.delete(runId));

    return { ok: true, runId };
  },

  progress: (runId) => live.get(runId)?.progress ?? null,

  async status(runId) {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT state, filesCopied, bytesCopied, errorCount, error, destination FROM ${RUNS} WHERE id = ?`,
      runId,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      state: String(r.state) as RunStatus["state"],
      filesCopied: asNum(r.filesCopied),
      bytesCopied: asNum(r.bytesCopied),
      errorCount: asNum(r.errorCount),
      error: (r.error as string | null) ?? null,
      destination: (r.destination as string | null) ?? null,
    };
  },

  cancel: (runId) => {
    const entry = live.get(runId);
    if (entry) entry.signal.aborted = true;
  },
});

export default api;
