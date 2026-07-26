"use client";
import { useState, useTransition } from "react";
import { saveHelperSettingsAction } from "@/app/admin/helpers/actions";

/**
 * The interactive half. Submits through `saveHelperSettingsAction` — no server action of its own,
 * for the same reason a module may not reach around the helper.
 *
 * **The freshly minted key is held in component state and never re-fetched**, because only a hash
 * is stored. Once this component unmounts the key is gone for good, which the UI says plainly
 * rather than letting someone navigate away and come back for it.
 */

export type KeyRow = {
  id: string;
  hint: string;
  label: string;
  accountName: string;
  mode: "read" | "act";
  lastUsedAt: string | null;
  orphaned: boolean;
};
export type Account = { id: string; name: string; role: string; status: string };
export type Refusal = { at: string; ip: string; reason: string; explained: string };

export default function PanelClient({
  helperId,
  enabled,
  listening,
  exposed,
  port,
  ports,
  keys,
  accounts,
  refusals,
}: {
  helperId: string;
  enabled: boolean;
  listening: boolean;
  exposed: boolean;
  port: number;
  ports: number[];
  keys: KeyRow[];
  accounts: Account[];
  refusals: Refusal[];
}) {
  const [busy, start] = useTransition();
  const [notice, setNotice] = useState<{ bad: boolean; text: string } | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [mode, setMode] = useState<"read" | "act">("read");

  function send(payload: Record<string, unknown>, onKey?: (k: string) => void) {
    setNotice(null);
    start(async () => {
      const r = await saveHelperSettingsAction(helperId, payload);
      if (!r.ok) {
        setNotice({ bad: true, text: r.error });
        return;
      }
      // A minted key arrives in the message and is shown once. Everything else reloads.
      if (onKey && r.message?.startsWith("jd_mcp_")) onKey(r.message);
      else {
        setNotice({ bad: false, text: r.message ?? "Done." });
        location.reload();
      }
    });
  }

  const statusTone = listening ? "var(--text-success, inherit)" : "var(--muted)";

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <p className="card p-3 text-sm" style={{ color: notice.bad ? "var(--danger)" : "inherit" }}>
          {notice.text}
        </p>
      )}

      {/* ---------------------------------------------------------- status */}
      <section className="card flex flex-col gap-1 p-3">
        <span className="font-medium" style={{ color: statusTone }}>
          {listening
            ? `Listening on ${exposed ? "this machine's network" : "127.0.0.1"}:${port}`
            : enabled
              ? "Switched on, but not listening — no keys exist yet"
              : "Off. Nothing is listening."}
        </span>
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          {keys.length} key{keys.length === 1 ? "" : "s"}.{" "}
          {listening
            ? "An assistant with a key can reach this."
            : "Installing this opened no port — it starts only when switched on and a key exists."}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-2">
          <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "enabled", value: !enabled })}>
            {enabled ? "Switch off" : "Switch on"}
          </button>
          <label className="flex items-center gap-2 text-sm">
            <span>Port</span>
            <select
              className="input"
              value={port}
              disabled={busy}
              onChange={(e) => send({ op: "port", value: Number(e.target.value) })}
            >
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </span>
      </section>

      {/* ------------------------------------------------------ where it listens */}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Who can reach it</h3>
        <div className="card flex flex-col gap-2 p-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" checked={!exposed} disabled={busy} onChange={() => send({ op: "exposed", value: false })} />
            <span>
              <span className="font-medium">This machine only</span>
              <span className="block text-xs" style={{ color: "var(--muted)" }}>
                Recommended. An assistant already needs access to this machine.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" checked={exposed} disabled={busy} onChange={() => send({ op: "exposed", value: true })} />
            <span>
              <span className="font-medium">Anyone on the network</span>
              <span className="block text-xs" style={{ color: "var(--muted)" }}>
                For an assistant running on another machine.
              </span>
            </span>
          </label>
          {exposed && (
            <p className="card p-2 text-xs" style={{ color: "var(--text-warning, var(--muted))" }}>
              This is reachable from your network. Anyone who can reach the port can try keys against
              it. Turn on HTTPS under Network &amp; HTTPS first — without it a key travels in clear
              text and can be read off the wire.
            </p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------- keys */}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Keys</h3>

        {minted && (
          <div className="card flex flex-col gap-2 p-3">
            <span className="text-sm font-medium">Copy this now — it is not shown again.</span>
            <code className="break-all rounded p-2 text-xs" style={{ background: "var(--surface-2)" }}>
              {minted}
            </code>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Only a hash is stored, so it cannot be recovered. Paste it into your assistant&rsquo;s
              configuration as the <code>Authorization: Bearer</code> header.
            </span>
            <button className="btn btn-sm self-start" onClick={() => { setMinted(null); location.reload(); }}>
              Done
            </button>
          </div>
        )}

        {keys.length === 0 ? (
          <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
            No keys. Nothing can connect, and nothing is listening.
          </p>
        ) : (
          keys.map((k) => (
            <div key={k.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{k.label}</span>
                <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                  <code>{k.hint}</code> · acts as {k.accountName} ·{" "}
                  {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}
                </span>
                {k.orphaned && (
                  <span className="text-xs" style={{ color: "var(--danger)" }}>
                    Its account no longer exists — this key already fails, but remove it.
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <select
                  className="input"
                  value={k.mode}
                  disabled={busy}
                  onChange={(e) => send({ op: "mode", id: k.id, value: e.target.value })}
                >
                  <option value="read">Read only</option>
                  <option value="act">Read and act</option>
                </select>
                <button className="btn btn-sm" disabled={busy} onClick={() => send({ op: "revoke", id: k.id })}>
                  Revoke
                </button>
              </span>
            </div>
          ))
        )}

        {/* ------------------------------------------------------- mint */}
        {accounts.length === 0 ? (
          <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
            No service accounts yet. Create one under Admin &rarr; Users — a key can only act as a
            service account, never as a person.
          </p>
        ) : (
          <div className="card flex flex-wrap items-end gap-3 p-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>Name</span>
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Pentester agent" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Acts as</span>
              <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role.toLowerCase()})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Can it change things?</span>
              <select className="input" value={mode} onChange={(e) => setMode(e.target.value as "read" | "act")}>
                <option value="read">Read only</option>
                <option value="act">Read and act</option>
              </select>
            </label>
            <button
              className="btn btn-sm"
              disabled={busy || !label.trim()}
              onClick={() => send({ op: "mint", label, accountId, mode }, setMinted)}
            >
              {busy ? "Working…" : "Create key"}
            </button>
            <p className="w-full text-xs" style={{ color: "var(--muted)" }}>
              A key can only do what its account can do. Choosing &ldquo;read and act&rdquo; never
              grants more than the account already has.
            </p>
          </div>
        )}
      </section>

      {/* -------------------------------------------------------- refusals */}
      {refusals.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Refused connections</h3>
          <div className="card flex flex-col gap-1 p-3 text-xs" style={{ color: "var(--muted)" }}>
            {refusals.map((r, i) => (
              <span key={i}>
                {new Date(r.at).toLocaleString()} · {r.ip} · {r.explained}
              </span>
            ))}
          </div>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Every refused attempt is recorded. Repeated entries from an address you do not recognise
            are worth looking at.
          </p>
        </section>
      )}
    </div>
  );
}
