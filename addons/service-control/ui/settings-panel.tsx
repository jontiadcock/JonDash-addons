import type { ModuleSettingsPanelProps } from "@/lib/modules/types";
import hostServices from "@/helpers/host-services/api";
import { STATE_LABEL, STATE_TONE, formatRelative, type ServiceState } from "../lib/constants";
import { noticeColour, readNotice } from "../lib/notice";

/**
 * What this module can honestly show about its own use of the helper: the approved services,
 * and the requests it has raised.
 *
 * ⚠ The allowlist editor is not here, and must never come back — it lived here for one release,
 * so this module supplied the service name being approved and could display "Add Plex" while
 * submitting `sshd`. Editing now happens on Admin → Permissions, rendered by JonDash itself
 * with no module in the path (HELPERS-DESIGN rule 8: read and request, never add/remove/approve).
 * REFS addons/service-control/module.ts
 */
export default async function ServiceControlSettings({ ctx }: ModuleSettingsPanelProps) {
  const api = hostServices(ctx);
  const [services, mine, support, notice] = await Promise.all([
    api.list(),
    api.myPending(),
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

      <section className="card flex flex-col gap-2 p-3">
        <h3 className="font-medium">Approved services</h3>
        {services.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            None yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {services.map((s) => {
              const state = s.state as ServiceState;
              return (
                <li key={s.id} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">
                    {s.name}
                    {s.label !== s.name && (
                      <span style={{ color: "var(--muted)" }}> · {s.label}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs" style={{ color: STATE_TONE[state] }}>
                    {STATE_LABEL[state]}
                    {!s.canControl && " · read-only"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Add or remove services under <strong>Admin → Permissions</strong>. This module can
          ask for a service to be added, but cannot add, change or remove one itself.
        </p>

        {!support.ok && (
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {support.reason === "grant-manager-missing"
              ? "This version of JonDash can see service states but cannot change them."
              : support.reason === "no-interactive-session"
                ? "JonDash cannot show a permission prompt on this machine."
                : "Controlling services is not supported on this platform."}
          </p>
        )}
      </section>

      {mine.length > 0 && (
        <section className="card flex flex-col gap-2 p-3">
          <h3 className="font-medium">Waiting for an administrator</h3>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Raised by this module. Approving them happens under Admin → Permissions.
          </p>
          {mine.map((p) => (
            <p key={p.id} className="text-sm">
              <span style={{ textTransform: "capitalize" }}>{p.action}</span> {p.serviceLabel} —{" "}
              <span style={{ color: "var(--muted)" }}>{formatRelative(p.createdAt)}</span>
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
