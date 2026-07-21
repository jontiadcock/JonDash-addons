import { Field } from "./form";
import { INTERVAL_CHOICES, KIND_CHOICES } from "../lib/forms";
import type { ChannelRow, MonitorConfig, MonitorRow } from "../lib/types";

/**
 * The fields for adding or editing a monitor, shared by both so they can't drift apart.
 * Rendered on the server and handed to the client form wrapper as children.
 *
 * Everything a beginner needs is visible; everything else is behind "More options", so
 * the common case is four fields and a menu.
 */
export function MonitorFields({
  monitor,
  config,
  channels,
  routedTo,
  others,
}: {
  monitor?: MonitorRow;
  config?: MonitorConfig;
  channels: ChannelRow[];
  routedTo?: string[];
  others: MonitorRow[];
}) {
  const routed = new Set(routedTo ?? []);
  const interval = monitor?.intervalSec ?? 60;
  const knownInterval = INTERVAL_CHOICES.some((c) => c.value === interval);

  return (
    <>
      {monitor ? <input type="hidden" name="id" value={monitor.id} /> : null}

      <Field label="Name" help="What you'll call it on the dashboard — “Home router”, “Website”.">
        <input className="input" name="name" defaultValue={monitor?.name ?? ""} maxLength={80} required />
      </Field>

      <Field label="What to check">
        <select className="input" name="kind" defaultValue={monitor?.kind ?? "http"}>
          {KIND_CHOICES.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label} — {k.hint}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Address"
        help="For a website, the full address including https://. For everything else, just the hostname or IP — for example 192.168.1.1 or nas.local."
      >
        <input
          className="input"
          name="target"
          defaultValue={monitor?.target ?? ""}
          placeholder="https://example.com  or  192.168.1.1"
          maxLength={500}
          required
        />
      </Field>

      <Field
        label="Port"
        help="Only needed when checking a port — 5432 for PostgreSQL, 22 for SSH. Certificate checks use 443 unless you change it."
      >
        <input
          className="input"
          name="port"
          type="number"
          min={1}
          max={65535}
          defaultValue={monitor?.port ?? ""}
          placeholder="—"
        />
      </Field>

      <Field label="Check how often">
        <select className="input" name="intervalSec" defaultValue={knownInterval ? interval : 60}>
          {INTERVAL_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Tell me through"
        help={
          channels.length === 0
            ? "You have no alert destinations yet — add one on the Alerts page, then come back."
            : "Tick every destination that should be told when this goes down or comes back."
        }
      >
        {channels.length === 0 ? (
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            Nothing set up yet
          </span>
        ) : (
          <span className="flex flex-wrap gap-3">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="channelIds" value={c.id} defaultChecked={routed.has(c.id)} />
                {c.name}
              </label>
            ))}
          </span>
        )}
      </Field>

      <details className="card p-3">
        <summary className="cursor-pointer text-sm font-medium">More options</summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field
            label="Expected response code"
            help="Websites only. Blank accepts anything normal. Use 200 for an exact match, 2xx for any success, or 401 if the page is meant to ask for a login."
          >
            <input
              className="input"
              name="expectStatus"
              defaultValue={config?.expectStatus === undefined ? "" : String(config.expectStatus)}
              placeholder="anything normal"
              maxLength={20}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="insecureTls" defaultChecked={Boolean(config?.insecureTls)} />
            Accept a self-signed certificate
          </label>
          <span className="-mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Tick this for a device on your own network that issues its own certificate, such as a NAS or
            a router. Leave it off for anything on the internet.
          </span>

          <Field
            label="Wait up to (milliseconds)"
            help="Blank uses the module default. 10000 is ten seconds."
          >
            <input className="input" name="timeoutMs" type="number" min={500} max={120000} defaultValue={monitor?.timeoutMs ?? ""} placeholder="default" />
          </Field>

          <Field
            label="Failures in a row before alerting"
            help="Blank uses the module default. Raise it for something that blips often."
          >
            <input className="input" name="retries" type="number" min={1} max={10} defaultValue={monitor?.retries ?? ""} placeholder="default" />
          </Field>

          <Field
            label="Treat as slow above (milliseconds)"
            help="Blank uses the module default. Answers slower than this show amber."
          >
            <input className="input" name="degradedMs" type="number" min={1} max={120000} defaultValue={monitor?.degradedMs ?? ""} placeholder="default" />
          </Field>

          <Field
            label="Depends on"
            help="If the thing it depends on is down, this one stays quiet — so a router outage doesn't send ten alerts."
          >
            <select className="input" name="parentId" defaultValue={monitor?.parentId ?? ""}>
              <option value="">Nothing</option>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Note" help="Included in the alert. A reminder of what to do, or a link to instructions.">
            <input className="input" name="runbook" defaultValue={monitor?.runbook ?? ""} maxLength={500} placeholder="Restart the service on the NAS" />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" value="on" defaultChecked={monitor ? monitor.enabled === 1 : true} />
            Checking is switched on
          </label>
        </div>
      </details>
    </>
  );
}
