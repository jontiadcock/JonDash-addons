import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import hostServices from "@/helpers/host-services/api";
import { MODULE_PATH, STATE_LABEL, STATE_TONE, verbsFor, type ServiceState } from "../lib/constants";
import { requestAction } from "../actions";

/**
 * The dashboard tile — "is everything up, and can I fix it from here".
 *
 * It draws its OWN card: the dashboard gives a widget a grid cell and nothing else, so
 * without `card p-4` and a title it renders as loose text with no name.
 *
 * Buttons are plain server-rendered forms. No client JavaScript, which matters here more
 * than usual — a control that stops a service should not depend on a hydration step having
 * succeeded, and a form that posts is honest about the fact that something is happening.
 */
export default async function ServiceControlWidget({ ctx }: ModuleWidgetProps) {
  const api = hostServices(ctx);
  const [services, support] = await Promise.all([api.list(), api.capability()]);

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">Services</h3>
        <Link href={MODULE_PATH} className="text-xs" style={{ color: "var(--muted)" }}>
          All
        </Link>
      </div>

      {services.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          No services approved yet. Add one under Admin → Addons → Service control.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {services.slice(0, 6).map((s) => {
            const state = s.state as ServiceState;
            return (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm">{s.label}</span>
                  <span className="shrink-0 text-xs" style={{ color: STATE_TONE[state] }}>
                    {STATE_LABEL[state]}
                  </span>
                </span>

                {s.canControl && (
                  <span className="flex shrink-0 gap-1">
                    {verbsFor(state).map((verb) => (
                      <form key={verb} action={requestAction}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="verb" value={verb} />
                        <input type="hidden" name="label" value={s.label} />
                        <button type="submit" className="btn btn-xs" style={{ textTransform: "capitalize" }}>
                          {verb}
                        </button>
                      </form>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Said once, on the tile, rather than only when a button fails: on a machine that
          cannot elevate, the controls are decoration and the admin should know before
          pressing one. */}
      {!support.ok && services.length > 0 && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {support.reason === "grant-manager-missing"
            ? "This version of JonDash cannot control services yet — states are read-only."
            : support.reason === "no-interactive-session"
              ? "JonDash cannot show a permission prompt on this machine."
              : "Controlling services is not supported on this platform."}
        </p>
      )}
    </div>
  );
}
