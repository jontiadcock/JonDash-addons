import type { ModuleSettingsPanelProps } from "@/lib/modules/types";
import hostServices from "@/helpers/host-services/api";
import { formatRelative } from "../lib/constants";
import { noticeColour, readNotice } from "../lib/notice";

/**
 * What this module can honestly show about its own use of the helper.
 *
 * **The allowlist editor used to live here and has been removed.** It let this module supply
 * the service name that got approved, while the consent screen promised only *"start, stop and
 * restart the services you listed"*. A module could have displayed "Add Plex" and submitted
 * `sshd` — the UAC prompt names `jondash-grant.exe` and never the service, so nothing on
 * screen would have caught it. The allowlist is meant to BE the boundary, and the thing it
 * bounds could edit it.
 *
 * The fix is placement rather than another check: the editor belongs on the helper's own
 * settings page, where JonDash renders the form and the helper receives the values with no
 * module in between. Core has been asked for that slot. Until it exists the list cannot be
 * edited at all — inert rather than unsound, which is the right way round.
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
            {services.map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate">{s.label}</span>
                <span className="shrink-0 text-xs" style={{ color: "var(--muted)" }}>
                  {s.name}
                  {!s.canControl && " · read-only"}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          This list is managed by JonDash, not by this module. A module can ask for a service to be
          added — it can never add one itself, and it cannot change or remove what is here.
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
            Raised by this module. Approving them happens in JonDash, not here.
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
