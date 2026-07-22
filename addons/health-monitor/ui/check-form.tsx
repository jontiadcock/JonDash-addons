"use client";

import { useActionState, useState } from "react";
import { INTERVAL_CHOICES, KIND_CHOICES } from "../lib/forms";
import type { ActionResult, ChannelRow, MonitorConfig, MonitorKind, MonitorRow } from "../lib/types";

/**
 * The form for adding or changing a check.
 *
 * It adapts to the kind of check chosen: the address box is relabelled ("Web address"
 * vs "Hostname or IP address"), the port appears only where it means something, and
 * HTTP- or certificate-only options are hidden otherwise. One generic form covering
 * every case is what made the old version feel clunky — most of its boxes didn't apply
 * to whatever you were actually doing.
 *
 * Client-side because the fields change as you pick; the work still happens in a Server
 * Action, and the result is shown inline instead of leaving you guessing.
 */

type Props = {
  action: (formData: FormData) => Promise<ActionResult>;
  channels: ChannelRow[];
  monitor?: MonitorRow;
  config?: MonitorConfig;
  routedTo?: string[];
  others: { id: string; name: string }[];
  submitLabel: string;
};

export function CheckForm({
  action,
  channels,
  monitor,
  config,
  routedTo = [],
  others,
  submitLabel,
}: Props) {
  const isNew = !monitor;
  const [kind, setKind] = useState<MonitorKind>(monitor?.kind ?? "http");

  /**
   * React clears an uncontrolled form by itself once a form action succeeds — but the
   * chosen kind lives in state, so on an "add" form it has to be put back too. Without
   * this the dropdown snaps back to the first option while the fields below still follow
   * the previous kind: "HTTPS / website check" above a port box and a "Hostname" label.
   *
   * Resetting here rather than in an effect keeps it part of the submission instead of a
   * second render pass. An edit form keeps its values, because they are still what's saved.
   */
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => {
      const outcome = await action(formData);
      if (isNew && outcome.ok) setKind("http");
      return outcome;
    },
    null,
  );

  const spec = KIND_CHOICES.find((k) => k.value === kind) ?? KIND_CHOICES[0];
  const routed = new Set(routedTo);
  const interval = monitor?.intervalSec ?? 60;
  const knownInterval = INTERVAL_CHOICES.some((c) => c.value === interval);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {monitor ? <input type="hidden" name="id" value={monitor.id} /> : null}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">What kind of check</span>
        <select
          className="input"
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as MonitorKind)}
        >
          {KIND_CHOICES.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {spec.hint}
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Name</span>
        <input
          className="input"
          name="name"
          defaultValue={monitor?.name ?? ""}
          placeholder="Home router"
          maxLength={80}
          required
        />
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          What you&apos;ll see on the dashboard.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">{spec.addressLabel}</span>
        <input
          className="input"
          name="target"
          defaultValue={monitor?.target ?? ""}
          placeholder={spec.addressPlaceholder}
          maxLength={500}
          required
        />
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {spec.addressHelp}
        </span>
      </label>

      {spec.port !== "none" ? (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">
            Port{spec.port === "optional" ? " (optional)" : ""}
          </span>
          <input
            className="input"
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={monitor?.port ?? ""}
            placeholder={spec.port === "optional" ? "443" : "5432"}
            required={spec.port === "required"}
          />
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            {spec.portHelp}
          </span>
        </label>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Check how often</span>
        <select className="input" name="intervalSec" defaultValue={knownInterval ? interval : 60}>
          {INTERVAL_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Tell me through</span>
        {channels.length === 0 ? (
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            No alert destinations yet — add one below and this check can use it.
          </span>
        ) : (
          <>
            <span className="flex flex-wrap gap-3">
              {channels.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="channelIds"
                    value={c.id}
                    defaultChecked={routed.has(c.id)}
                  />
                  {c.name}
                </label>
              ))}
            </span>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Leave all unticked and this check is recorded but nobody is told.
            </span>
          </>
        )}
      </div>

      <details className="card p-3">
        <summary className="cursor-pointer text-sm font-medium">More options</summary>
        <div className="mt-3 flex flex-col gap-3">
          {spec.httpOptions ? (
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Expected response code</span>
              <input
                className="input"
                name="expectStatus"
                defaultValue={config?.expectStatus === undefined ? "" : String(config.expectStatus)}
                placeholder="anything normal"
                maxLength={20}
              />
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                Blank accepts anything normal. Use 200 for an exact match, 2xx for any success, or 401
                if the page is supposed to ask for a login.
              </span>
            </label>
          ) : null}

          {spec.tlsOptions ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="insecureTls"
                  defaultChecked={Boolean(config?.insecureTls)}
                />
                Accept a self-signed certificate
              </label>
              <span className="-mt-2 text-xs" style={{ color: "var(--muted)" }}>
                For a device on your own network that issues its own certificate, like a NAS or a
                router. Leave off for anything on the internet.
              </span>
            </>
          ) : null}

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Wait up to (milliseconds)</span>
            <input className="input" name="timeoutMs" type="number" min={500} max={120000} defaultValue={monitor?.timeoutMs ?? ""} placeholder="use the default" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Failures in a row before alerting</span>
            <input className="input" name="retries" type="number" min={1} max={10} defaultValue={monitor?.retries ?? ""} placeholder="use the default" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Treat as slow above (milliseconds)</span>
            <input className="input" name="degradedMs" type="number" min={1} max={120000} defaultValue={monitor?.degradedMs ?? ""} placeholder="use the default" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Depends on</span>
            <select className="input" name="parentId" defaultValue={monitor?.parentId ?? ""}>
              <option value="">Nothing</option>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              If that one is down, this stays quiet — so a router outage doesn&apos;t send ten alerts.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Note</span>
            <input className="input" name="runbook" defaultValue={monitor?.runbook ?? ""} maxLength={500} placeholder="Restart the service on the NAS" />
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Included in the alert — a reminder of what to do about it.
            </span>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              value="on"
              defaultChecked={monitor ? monitor.enabled === 1 : true}
            />
            Checking is switched on
          </label>
        </div>
      </details>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </button>
        {result ? (
          <span
            className="text-sm"
            style={{ color: result.ok ? "var(--muted)" : "var(--danger)" }}
            role="status"
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
