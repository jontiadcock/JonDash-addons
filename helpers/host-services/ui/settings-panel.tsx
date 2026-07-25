"use client";
import { useState, useTransition } from "react";
import { saveHelperSettingsAction } from "@/app/admin/helpers/actions";
import type { HelperSettingsContext } from "@/lib/helpers/types";

/**
 * The allowlist editor, on JonDash's own page.
 *
 * **This is where it always belonged.** It lived in a consuming module's settings panel until
 * 2026-07-26, which meant the module supplied the service name being approved — so it could
 * display "Add Plex" and submit `sshd`, and the UAC prompt names the binary rather than the
 * service. The thing being bounded could edit its own boundary.
 *
 * Now core renders this, behind `modules.manage`, and hands `onSettingsSubmit` a `ctx.user`
 * resolved from the session. No module is anywhere in the path, and the
 * `host-services:configure` capability that made the old arrangement *honest* is deleted
 * rather than merely documented.
 *
 * It submits through `saveHelperSettingsAction` and defines no server action of its own. A
 * first-party helper could define one — and that is the point: this whole feature exists
 * because a first-party helper exposed something it should not have, so the gated path is
 * made the only path rather than a rule each new helper has to remember.
 */

type Entry = {
  id: string;
  name: string;
  label: string;
  state: string;
  canControl: boolean;
  unattended: boolean;
  taskBase: string;
};

type Pending = { id: string; moduleId: string; serviceLabel: string; action: string; createdAt: string };
type Suggestion = { id: string; moduleId: string; serviceName: string; reason: string };

export type PanelData = {
  entries: Entry[];
  pending: Pending[];
  suggestions: Suggestion[];
  support: { ok: boolean; reason?: string };
};

export default function HostServicesSettings({ ctx, data }: { ctx: HelperSettingsContext; data?: PanelData }) {
  const [busy, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const entries = data?.entries ?? [];
  const pending = data?.pending ?? [];
  const suggestions = data?.suggestions ?? [];

  function send(payload: Record<string, unknown>) {
    setNotice(null);
    start(async () => {
      // Core catches a throw here, audits it and shows it — the panel never blanks the page.
      const r = await saveHelperSettingsAction(ctx.helperId, payload);
      setNotice(r.ok ? { tone: "ok", text: r.message ?? "Done." } : { tone: "bad", text: r.error });
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <p className="card p-3 text-sm" style={{ color: notice.tone === "bad" ? "var(--danger)" : "var(--success, inherit)" }}>
          {notice.text}
        </p>
      )}

      {data && !data.support.ok && (
        <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
          {data.support.reason === "grant-manager-missing"
            ? "Services can be listed read-only, but approving one for control needs a component this version of JonDash does not ship."
            : data.support.reason === "no-interactive-session"
              ? "New approvals need a permission prompt, which cannot be shown on this machine. Services approved earlier still work."
              : "Controlling services is not supported on this platform."}
        </p>
      )}

      {pending.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Waiting for you</h3>
          {pending.map((p) => (
            <div key={p.id} className="card flex flex-wrap items-center justify-between gap-2 p-3">
              <span className="text-sm">
                <span style={{ textTransform: "capitalize" }}>{p.action}</span> {p.serviceLabel} — asked by{" "}
                <code className="text-xs">{p.moduleId}</code>
              </span>
              <span className="flex gap-1">
                <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "approve", id: p.id })}>
                  Approve
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "decline", id: p.id })}>
                  Decline
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Approved services</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          The complete set of services any module can touch. Adding one asks Windows for permission
          once; after that, starting and stopping it needs no prompt. Removing one asks again.
        </p>

        {entries.length === 0 ? (
          <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
            Nothing approved yet.
          </p>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
              <span className="flex min-w-0 flex-col">
                {/* The real service name leads. The label is decoration; this is what Windows acts on. */}
                <span className="truncate font-medium">{e.name}</span>
                <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                  {e.label !== e.name && `“${e.label}” · `}permission <code>{e.taskBase}</code> · {e.state}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {e.canControl ? (
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => send({ op: "unattended", id: e.id, value: !e.unattended })}
                  >
                    {e.unattended ? "Ask me each time" : "Allow without asking"}
                  </button>
                ) : (
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    Read-only
                  </span>
                )}
                <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "remove", id: e.id })}>
                  Remove
                </button>
              </span>
              {e.unattended && (
                <p className="w-full text-xs" style={{ color: "var(--warning, var(--muted))" }}>
                  A module can start, stop and restart this without asking you.
                </p>
              )}
            </div>
          ))
        )}
      </section>

      {suggestions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Suggested by modules</h3>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            A module has asked for these. Nothing happens until you add one.
          </p>
          {suggestions.map((s) => (
            <div key={s.id} className="card flex flex-wrap items-center justify-between gap-2 p-3">
              <span className="flex flex-col text-sm">
                <span className="font-medium">{s.serviceName}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {s.moduleId}: {s.reason}
                </span>
              </span>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => send({ op: "add", serviceName: s.serviceName, label: s.serviceName })}
              >
                Add this
              </button>
            </div>
          ))}
        </section>
      )}

      <AddForm busy={busy} onAdd={(v) => send({ op: "add", ...v })} />
    </div>
  );
}

function AddForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (v: { serviceName: string; label: string; readOnly: boolean }) => void;
}) {
  const [serviceName, setServiceName] = useState("");
  const [label, setLabel] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium">Approve a service</h3>
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Service name</span>
          <input className="input" value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Spooler" />
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            The real name, as Windows or systemd knows it.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Label</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Print spooler" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          <span>Read-only — show its state, never control it</span>
        </label>
        <button
          className="btn btn-sm"
          disabled={busy || !serviceName.trim()}
          onClick={() => onAdd({ serviceName, label, readOnly })}
        >
          {busy ? "Working…" : "Approve"}
        </button>
      </div>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Take care with anything that could lock you out of this machine — remote access, the firewall,
        the network stack, or JonDash itself. You will be warned, not stopped.
      </p>
    </section>
  );
}
