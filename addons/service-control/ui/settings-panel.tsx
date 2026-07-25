import type { ModuleSettingsPanelProps } from "@/lib/modules/types";
import hostServices from "@/helpers/host-services/api";
import { STATE_LABEL, STATE_TONE, formatRelative, type ServiceState } from "../lib/constants";
import { noticeColour, readNotice } from "../lib/notice";
import { addEntryAction, approveAction, declineAction, removeEntryAction, setUnattendedAction } from "../actions";

/**
 * The allowlist, the approval queue, and the suggestions modules have raised.
 *
 * **This screen is in the wrong place, and now says so on itself.** The allowlist is helper
 * configuration: it outlives this module and represents standing OS permissions. It lives
 * here only because a helper has no settings page of its own yet — which is why this module
 * must declare `host-services:configure`, a red line telling the admin it decides what
 * JonDash may control. When core provides the helper settings slot, this moves there and the
 * capability is deleted.
 */
export default async function ServiceControlSettings({ ctx }: ModuleSettingsPanelProps) {
  const api = hostServices(ctx);
  const [entries, pending, suggestions, support, notice] = await Promise.all([
    api.admin.entries(),
    api.admin.pending(),
    api.admin.suggestions(),
    api.capability(),
    readNotice(ctx),
  ]);

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <p className="card p-3 text-sm" style={{ color: noticeColour(notice.tone) }}>
          {notice.text}
        </p>
      )}

      {!support.ok && (
        <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
          {support.reason === "grant-manager-missing"
            ? "Services can be listed read-only, but approving one for control needs a component this version of JonDash does not ship."
            : support.reason === "no-interactive-session"
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
                <span className="font-medium" style={{ textTransform: "capitalize" }}>
                  {p.action}
                </span>{" "}
                {p.serviceLabel} — asked by <code className="text-xs">{p.moduleId}</code>,{" "}
                {formatRelative(p.createdAt)}
              </span>
              <span className="flex gap-1">
                <form action={approveAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className="btn btn-sm">
                    Approve
                  </button>
                </form>
                <form action={declineAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className="btn btn-sm">
                    Decline
                  </button>
                </form>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Approved services</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          This list is the complete set of services any module can touch. Adding one asks Windows for
          permission once; after that, starting and stopping it needs no prompt. Removing one asks
          again, because withdrawing the permission is itself an administrator action.
        </p>

        {entries.length === 0 ? (
          <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
            Nothing approved yet.
          </p>
        ) : (
          entries.map((e) => {
            const state = e.state as ServiceState;
            return (
              <div key={e.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="flex min-w-0 flex-col">
                  {/* The REAL service name leads, not the label. The label is whatever was
                      typed; the name is what Windows will act on, and they need not match. */}
                  <span className="truncate font-medium">{e.name}</span>
                  <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                    {e.label !== e.name && `“${e.label}” · `}
                    permission <code>{e.taskBase}</code> · added {formatRelative(e.addedAt)}
                  </span>
                </span>

                <span className="text-sm" style={{ color: STATE_TONE[state] }}>
                  {STATE_LABEL[state]}
                </span>

                <span className="flex flex-wrap items-center gap-2">
                  {e.canControl ? (
                    <form action={setUnattendedAction} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="unattended" value={e.unattended ? "0" : "1"} />
                      <button type="submit" className="btn btn-sm">
                        {e.unattended ? "Ask me each time" : "Allow without asking"}
                      </button>
                    </form>
                  ) : (
                    <span className="text-xs" style={{ color: "var(--muted)" }}>
                      Read-only
                    </span>
                  )}
                  <form action={removeEntryAction}>
                    <input type="hidden" name="id" value={e.id} />
                    <button
                      type="submit"
                      className="btn btn-sm"
                      title={
                        e.grantState === "none"
                          ? "Remove"
                          : "Removes it and its permission — Windows will ask you to confirm"
                      }
                    >
                      Remove
                    </button>
                  </form>
                </span>

                {e.unattended && (
                  <p className="w-full text-xs" style={{ color: "var(--warning, var(--muted))" }}>
                    A module can start, stop and restart this without asking you.
                  </p>
                )}
              </div>
            );
          })
        )}
      </section>

      {suggestions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Suggested by modules</h3>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            A module has asked for these. Nothing happens until you add one yourself.
          </p>
          {suggestions.map((s) => (
            <form key={s.id} action={addEntryAction} className="card flex flex-wrap items-end gap-2 p-3">
              <span className="flex flex-col text-sm">
                <span className="font-medium">{s.serviceName}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {s.moduleId}: {s.reason}
                </span>
              </span>
              <input type="hidden" name="serviceName" value={s.serviceName} />
              <input type="hidden" name="label" value={s.serviceName} />
              <button type="submit" className="btn btn-sm">
                Add this
              </button>
            </form>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Approve a service</h3>
        <form action={addEntryAction} className="card flex flex-wrap items-end gap-3 p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Service name</span>
            <input name="serviceName" required placeholder="Spooler" className="input" />
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              The real name, as Windows or systemd knows it.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Label</span>
            <input name="label" placeholder="Print spooler" className="input" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="readOnly" value="1" />
            <span>Read-only — show its state, never control it</span>
          </label>
          <button type="submit" className="btn btn-sm">
            Approve
          </button>
        </form>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Take care with anything that could lock you out of this machine — remote access, the firewall,
          the network stack, or JonDash itself. You will be warned, not stopped.
        </p>
        {/* Said plainly because it is the residual weakness of putting this screen in a module:
            Windows names JonDash in its prompt, not the service, so the prompt cannot catch a
            mismatch between what was shown and what was submitted. The audit log can. */}
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Windows names JonDash in its permission prompt, not the service. Check the list above
          afterwards — every addition is recorded in the audit log with the service it actually added.
        </p>
      </section>
    </div>
  );
}
