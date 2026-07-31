"use client";
import { useState, useTransition } from "react";
import { saveHelperSettingsAction } from "@/app/admin/helpers/actions";

/**
 * The interactive half. Submits through `saveHelperSettingsAction` and has no server action
 * of its own — a helper reaching around core's audited entry point would be the same mistake
 * as a module reaching around the helper.
 *
 * Interim UI; see the `⚠` in `settings-panel.tsx`. Kept deliberately plain.
 */

export type Root = { id: string; path: string; label: string; riskLevel: string; riskNote: string | null };
export type Suggestion = { id: string; moduleId: string; path: string; reason: string; createdAt: string };
export type Retention = { keepDays: number; keepRuns: number };

/** REFS helpers/filesystem/ui/settings-panel.tsx */
export default function PanelClient({
  helperId,
  roots,
  suggestions,
  retention,
}: {
  helperId: string;
  roots: Root[];
  suggestions: Suggestion[];
  retention: Retention;
}) {
  const [busy, start] = useTransition();
  const [notice, setNotice] = useState<{ bad: boolean; text: string } | null>(null);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(String(retention.keepDays));
  const [runs, setRuns] = useState(String(retention.keepRuns));

  function send(payload: Record<string, unknown>) {
    setNotice(null);
    start(async () => {
      const r = await saveHelperSettingsAction(helperId, payload);
      setNotice(r.ok ? { bad: false, text: r.message ?? "Done." } : { bad: true, text: r.error });
      if (r.ok) location.reload();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <p className="card p-3 text-sm" style={{ color: notice.bad ? "var(--danger)" : "inherit" }}>
          {notice.text}
        </p>
      )}

      {suggestions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Requested by modules</h3>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            A module has asked for these. Nothing happens until you approve one.
          </p>
          {suggestions.map((s) => (
            <div key={s.id} className="card flex flex-wrap items-center justify-between gap-2 p-3">
              <span className="flex min-w-0 flex-col text-sm">
                <span className="truncate font-medium">{s.path}</span>
                <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                  <code>{s.moduleId}</code>: {s.reason}
                </span>
              </span>
              <span className="flex gap-1">
                <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "accept", id: s.id })}>
                  Approve
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "decline", id: s.id })}>
                  Decline
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Approved folders</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Every location any module may read from or write to. JonDash&rsquo;s own secrets are
          never readable, whatever is approved here.
        </p>
        {roots.length === 0 ? (
          <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
            Nothing approved yet.
          </p>
        ) : (
          roots.map((r) => (
            <div key={r.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{r.path}</span>
                <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                  {r.label !== r.path && `${r.label} · `}
                  {r.riskNote ?? "no warnings"}
                </span>
              </span>
              <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "removeRoot", id: r.id })}>
                Remove
              </button>
            </div>
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Approve a folder</h3>
        <div className="card flex flex-wrap items-end gap-3 p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Full path</span>
            <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="D:\Photos" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Label</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Photos" />
          </label>
          <button
            className="btn btn-sm"
            disabled={busy || !path.trim()}
            onClick={() => send({ op: "addRoot", path, label })}
          >
            {busy ? "Working…" : "Approve"}
          </button>
        </div>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          A whole drive is allowed and will be warned about, not refused.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Log retention</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Applies to every module using this helper, which is why a module cannot change it.
          Zero means keep forever.
        </p>
        <div className="card flex flex-wrap items-end gap-3 p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Keep days</span>
            <input className="input" type="number" min="0" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Keep runs</span>
            <input className="input" type="number" min="0" value={runs} onChange={(e) => setRuns(e.target.value)} />
          </label>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => send({ op: "retention", keepDays: Number(days), keepRuns: Number(runs) })}
          >
            Save
          </button>
        </div>
      </section>
    </div>
  );
}
