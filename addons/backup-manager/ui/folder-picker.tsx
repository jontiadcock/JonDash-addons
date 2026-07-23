import type { ModuleContext } from "@/lib/modules/types";
import filesystem from "@/helpers/filesystem/api";
import { formatBytes } from "../lib/constants";
import { browseAction } from "../actions";

/**
 * Look inside an approved folder and copy out the sub-folder path, instead of typing it.
 *
 * Typing `D:\Photos\2026\Holidays` by hand into a field is the worst part of setting a
 * backup up: a typo produces a job that runs happily against a folder that doesn't exist,
 * or worse, one that does but isn't the one you meant. This shows what's actually there.
 *
 * Plain forms and no client JavaScript. The current position lives in the module's own
 * store rather than the URL, because this renders inside the admin settings panel, which
 * has no route of its own to hang state on.
 *
 * `browse` returns names, sizes and dates only — the helper exposes no way to read a
 * file's contents, so looking cannot leak anything.
 */

const muted = { color: "var(--muted)" } as const;

/** The parent of a relative subpath, or "" at the top. Never climbs above the root. */
function parentOf(subpath: string): string {
  const parts = subpath.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export default async function FolderPicker({
  ctx,
  roots,
}: {
  ctx: ModuleContext;
  roots: { id: string; label: string }[];
}) {
  if (roots.length === 0) return null;

  const raw = String((await ctx.store?.get("browse")) ?? "");
  let at: { rootId: string; subpath: string } = { rootId: "", subpath: "" };
  try {
    if (raw) at = { subpath: "", ...(JSON.parse(raw) as { rootId: string; subpath?: string }) };
  } catch {
    // Unreadable position — start again at nothing rather than guess.
  }

  const root = roots.find((r) => r.id === at.rootId) ?? null;
  const entries = root ? await filesystem(ctx).browse(root.id, at.subpath || undefined) : [];
  const folders = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <details className="card p-3">
      <summary className="cursor-pointer text-sm font-medium">Look inside a folder</summary>

      <div className="mt-2 flex flex-col gap-2">
        <form action={browseAction} className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            Folder
            <select className="input mt-1" name="rootId" defaultValue={at.rootId} required>
              <option value="">Choose…</option>
              {roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <input type="hidden" name="subpath" value="" />
          <button className="btn" type="submit">Open</button>
        </form>

        {root && (
          <>
            <p className="text-sm">
              <strong>{root.label}</strong>
              {at.subpath && <span> / <code className="text-xs">{at.subpath.replace(/\\/g, "/")}</code></span>}
            </p>

            {at.subpath && (
              <form action={browseAction}>
                <input type="hidden" name="rootId" value={root.id} />
                <input type="hidden" name="subpath" value={parentOf(at.subpath)} />
                <button className="btn btn-ghost" type="submit">↑ Up one level</button>
              </form>
            )}

            {folders.length === 0 ? (
              <p className="text-sm" style={muted}>No sub-folders here.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {folders.slice(0, 100).map((f) => (
                  <li key={f.name}>
                    <form action={browseAction} className="flex items-center gap-2">
                      <input type="hidden" name="rootId" value={root.id} />
                      <input type="hidden" name="subpath" value={at.subpath ? `${at.subpath}/${f.name}` : f.name} />
                      <button className="btn btn-ghost text-sm" type="submit">📁 {f.name}</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            {files.length > 0 && (
              <p className="text-xs" style={muted}>
                …and {files.length} file{files.length === 1 ? "" : "s"} here
                {files.length <= 5 && `: ${files.map((f) => `${f.name} (${formatBytes(f.bytes)})`).join(", ")}`}
              </p>
            )}

            {/* The point of the whole exercise: something to paste into the job form. */}
            <p className="mt-1 text-sm">
              Sub-folder path:{" "}
              {at.subpath
                ? <code className="text-xs">{at.subpath.replace(/\\/g, "/")}</code>
                : <span style={muted}>(the folder itself — leave the sub-folder box empty)</span>}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
