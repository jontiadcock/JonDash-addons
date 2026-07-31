import type { ModulePageProps } from "@/lib/modules/types";
import hostServices from "@/helpers/host-services/api";
import { ADMIN_PATH, STATE_LABEL, STATE_TONE, verbsFor, type ServiceState } from "./lib/constants";
import { noticeColour, readNotice } from "./lib/notice";
import { requestAction } from "./actions";

/**
 * The full list, with room to say what the tile cannot.
 *
 * Mostly the same data as the widget, but this is where the explanations live: why a service
 * has no buttons, what "waiting for approval" means, and what the machine can actually do.
 * REFS addons/service-control/module.ts
 */
export default async function ServiceControlPage({ ctx }: ModulePageProps) {
  const api = hostServices(ctx);
  const [services, support] = await Promise.all([api.list(), api.capability()]);
  const notice = await readNotice(ctx);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">Services</h1>
        {/*
          Two sentences, because one of them stopped being true.
          Until the helper gained an "allow everything" switch for READING, this said only
          approved services appear — which is now false on an install where that switch is on,
          and a page that overstates its own limits is worse than one that explains them. The
          count decides: anything not controllable is something we can only look at.
        */}
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {services.some((s) => !s.canControl)
            ? "Services an administrator has approved for control can be started and stopped here. The rest are shown for information only — nothing on this page can act on them."
            : "Only the services an administrator has approved appear here. Nothing else on this machine can be reached from JonDash."}
        </p>
      </header>

      {notice && (
        <p className="card p-3 text-sm" style={{ color: noticeColour(notice.tone) }}>
          {notice.text}
        </p>
      )}

      {!support.ok && (
        <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
          {support.reason === "grant-manager-missing"
            ? "This version of JonDash can see service states but cannot change them yet. The component that asks Windows for permission is not installed."
            : support.reason === "no-interactive-session"
              ? "JonDash is running where it cannot show a permission prompt, so new approvals cannot be made here. Services approved earlier still work."
              : "Controlling services is not supported on this platform."}
        </p>
      )}

      {services.length === 0 ? (
        <p className="card p-4 text-sm" style={{ color: "var(--muted)" }}>
          No services have been approved yet. An administrator adds them under{" "}
          <a href={ADMIN_PATH}>Admin → Addons → Service control</a>.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {services.map((s) => {
            const state = s.state as ServiceState;
            const verbs = verbsFor(state);
            return (
              <li key={s.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{s.label}</span>
                  <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                    {s.name}
                  </span>
                </span>

                <span className="text-sm" style={{ color: STATE_TONE[state] }}>
                  {STATE_LABEL[state]}
                </span>

                <span className="flex flex-wrap gap-1">
                  {!s.canControl ? (
                    <span className="text-xs" style={{ color: "var(--muted)" }}>
                      Added as read-only
                    </span>
                  ) : verbs.length === 0 ? (
                    <span className="text-xs" style={{ color: "var(--muted)" }}>
                      {state === "unknown" ? "Not found on this machine" : "Busy — try again shortly"}
                    </span>
                  ) : (
                    verbs.map((verb) => (
                      <form key={verb} action={requestAction}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="verb" value={verb} />
                        <input type="hidden" name="label" value={s.label} />
                        <button type="submit" className="btn btn-sm" style={{ textTransform: "capitalize" }}>
                          {verb}
                        </button>
                      </form>
                    ))
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

