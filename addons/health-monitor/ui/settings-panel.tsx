import Link from "next/link";
import type { ModuleSettingsPanelProps } from "@/lib/modules/types";
import { listChannels, listMonitors, parseConfig, routeIdsFor } from "../lib/store";
import { CHANNEL_CHOICES, KIND_CHOICES } from "../lib/forms";
import { MODULE_PATH, type ChannelRow } from "../lib/types";
import { lastConfigError } from "../lib/config";
import { StatusDot, HealthStyles } from "./parts";
import { ActionForm, Field } from "./form";
import { CheckForm } from "./check-form";
import {
  checkNowAction,
  deleteChannelAction,
  deleteMonitorAction,
  importConfigAction,
  saveChannelAction,
  saveMonitorAction,
  saveSettingsAction,
  testChannelAction,
} from "../actions";
import { SETTING_FIELDS } from "../lib/settings";

/**
 * Everything that changes the monitoring, rendered by JonDash inside
 * Admin → Addons → Health monitoring, below the module's own settings fields.
 *
 * This is where configuration belongs: the module's pages and its dashboard widget stay
 * read-only, so a dashboard can be left open without a stray click reconfiguring
 * anything. Each check expands in place to edit, so nothing here navigates away from the
 * settings screen.
 *
 * REFS addons/health-monitor/module.ts
 */
export default async function HealthSettingsPanel({ ctx }: ModuleSettingsPanelProps) {
  const db = ctx.db;
  if (!db) {
    return (
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        The module has no database yet — enable it and this will appear.
      </p>
    );
  }

  const monitors = await listMonitors(db);
  const channels: ChannelRow[] = await listChannels(db);
  const configError = await lastConfigError(ctx);
  const settingValues = await ctx.settings.all();
  const kindName = new Map(KIND_CHOICES.map((k) => [k.value, k.label]));
  const channelName = new Map(CHANNEL_CHOICES.map((c) => [c.value, c.label]));

  const routes = new Map<string, string[]>();
  for (const m of monitors) routes.set(m.id, await routeIdsFor(db, m.id));

  return (
    <div className="hm flex flex-col gap-6">
      <HealthStyles />

      {configError ? (
        <div className="card p-3 text-sm" style={{ borderColor: "var(--danger)" }}>
          <span style={{ color: "var(--danger)" }}>Last bulk import failed:</span> {configError}
        </div>
      ) : null}

      <section>
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Your checks</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
          {monitors.length === 0
            ? "Nothing is being watched yet. Add your first check below."
            : "Open one to change it. Status and history are on the "}
          {monitors.length > 0 ? (
            <Link href={MODULE_PATH} style={{ color: "var(--primary)" }}>
              Health monitoring page
            </Link>
          ) : null}
          {monitors.length > 0 ? "." : ""}
        </p>

        {monitors.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {monitors.map((m) => (
              <li key={m.id} className="card p-3">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusDot state={m.enabled === 1 ? m.status : "unknown"} size={8} />
                      <span className="truncate font-medium">{m.name}</span>
                      <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                        {kindName.get(m.kind) ?? m.kind} · {m.target}
                        {m.port ? `:${m.port}` : ""}
                        {m.enabled === 1 ? "" : " · paused"}
                      </span>
                    </span>
                    <span className="text-xs" style={{ color: "var(--primary)" }}>
                      change
                    </span>
                  </summary>

                  <div className="mt-4 flex flex-col gap-4">
                    <CheckForm
                      action={saveMonitorAction}
                      monitor={m}
                      config={parseConfig(m)}
                      channels={channels}
                      routedTo={routes.get(m.id) ?? []}
                      others={monitors.filter((o) => o.id !== m.id).map((o) => ({ id: o.id, name: o.name }))}
                      submitLabel="Save changes"
                    />

                    <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                      <ActionForm action={checkNowAction} submitLabel="Check now" variant="ghost" inline>
                        <input type="hidden" name="id" value={m.id} />
                      </ActionForm>
                      <ActionForm
                        action={deleteMonitorAction}
                        submitLabel="Delete this check"
                        variant="danger"
                        inline
                        confirm={`Delete “${m.name}” and all of its history? This cannot be undone.`}
                      >
                        <input type="hidden" name="id" value={m.id} />
                      </ActionForm>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card p-4">
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Add a check</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
          Pick what kind of check it is and the rest of the form follows. It runs straight away, so you
          find out immediately whether the address was right.
        </p>
        <CheckForm
          action={saveMonitorAction}
          channels={channels}
          others={monitors.map((m) => ({ id: m.id, name: m.name }))}
          submitLabel="Add this check"
        />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Where alerts go</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
          Add a destination, send it a test, then tick it on the checks that should use it.
        </p>

        {channels.length === 0 ? (
          <p className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
            Nothing set up — you will not be told when something breaks.
          </p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {channels.map((c) => (
              <li key={c.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {channelName.get(c.kind) ?? c.kind} · stored encrypted, not shown again
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ActionForm action={testChannelAction} submitLabel="Send a test" variant="ghost" inline>
                    <input type="hidden" name="id" value={c.id} />
                  </ActionForm>
                  <ActionForm
                    action={deleteChannelAction}
                    submitLabel="Remove"
                    variant="danger"
                    inline
                    confirm={`Remove “${c.name}”? Checks using it will stop alerting there.`}
                  >
                    <input type="hidden" name="id" value={c.id} />
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}

        <details className="card p-4">
          <summary className="cursor-pointer font-medium">Add a destination</summary>
          <div className="mt-3">
            <ActionForm action={saveChannelAction} submitLabel="Add it">
              <Field label="Name" help="How you'll recognise it — “My phone”, “Team chat”.">
                <input className="input" name="name" maxLength={80} required />
              </Field>

              <Field label="Send to">
                <select className="input" name="kind" defaultValue="email">
                  {CHANNEL_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="card p-3 text-xs" style={{ color: "var(--muted)" }}>
                <p className="mb-1 font-medium" style={{ color: "var(--foreground)" }}>
                  What each one needs
                </p>
                <ul className="flex flex-col gap-1">
                  {CHANNEL_CHOICES.map((c) => (
                    <li key={c.value}>
                      <strong>{c.label}:</strong> {c.needs}
                    </li>
                  ))}
                </ul>
              </div>

              <Field label="URL" help="Where alerts are posted. Not needed for email or Telegram.">
                <input className="input" name="url" type="url" placeholder="https://…" maxLength={500} />
              </Field>

              <Field label="Secret or token" help="A bot token, an app token, or a value sent as an Authorization header. Stored encrypted.">
                <input className="input" name="secret" maxLength={300} />
              </Field>

              <Field label="Topic or chat" help="The ntfy topic, or the Telegram chat id.">
                <input className="input" name="topic" maxLength={200} />
              </Field>

              <Field label="Email addresses" help="Email only. Comma-separated. Blank uses the recipients set above.">
                <input className="input" name="recipients" maxLength={500} placeholder="you@example.com" />
              </Field>
            </ActionForm>
          </div>
        </details>
      </section>

      <AdvancedSettings values={settingValues} />

      <details className="card p-4">
        <summary className="cursor-pointer text-sm font-medium">Bulk import (JSON)</summary>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          To add a lot at once, or restore a configuration you kept a copy of: paste it into the bulk
          import field above, save, then press this. It only adds and updates — nothing is ever removed
          this way.
        </p>
        <div className="mt-3">
          <ActionForm action={importConfigAction} submitLabel="Run the import" variant="ghost" />
        </div>
      </details>
    </div>
  );
}

/**
 * The module's own settings, rendered here rather than declared to the framework.
 *
 * ⚠ Declared settings are always drawn ABOVE a module's panel — that order lives in core and a
 * module cannot change it. Declaring none is the only way to put the checks first, so `module.ts`
 * has no `settings` array; putting one back would silently push all of this above them again.
 *
 * Fields come from `SETTING_FIELDS`, so keys and saved values carry across an upgrade untouched.
 *
 * REFS addons/health-monitor/actions.ts › saveSettingsAction — writes the same keys
 *      addons/health-monitor/lib/settings.ts › SETTING_FIELDS
 */
function AdvancedSettings({ values }: { values: Record<string, unknown> }) {
  return (
    <details className="card p-4">
      <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
      <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
        Defaults for every check, how long history is kept, and how noisy alerts are allowed to be.
        The defaults suit most people — a check can override the timing ones itself.
      </p>
      <div className="mt-3">
        <ActionForm action={saveSettingsAction} submitLabel="Save settings">
          {SETTING_FIELDS.map((f) => {
            const current = values[f.key] ?? f.default;
            if (f.type === "boolean") {
              return (
                <label key={f.key} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name={f.key} defaultChecked={Boolean(current)} className="mt-1" />
                  <span>
                    {f.label}
                    {f.help ? (
                      <span className="block text-xs" style={{ color: "var(--muted)" }}>{f.help}</span>
                    ) : null}
                  </span>
                </label>
              );
            }
            return (
              <Field key={f.key} label={f.label} help={f.help}>
                {f.type === "text" ? (
                  <textarea
                    className="input"
                    name={f.key}
                    rows={3}
                    defaultValue={current == null ? "" : String(current)}
                  />
                ) : (
                  <input
                    className="input"
                    name={f.key}
                    type={f.type === "number" ? "number" : "text"}
                    defaultValue={current == null ? "" : String(current)}
                  />
                )}
              </Field>
            );
          })}
        </ActionForm>
      </div>
    </details>
  );
}
