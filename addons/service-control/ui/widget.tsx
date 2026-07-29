import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import hostServices from "@/helpers/host-services/api";
import { MODULE_PATH, STATE_LABEL, STATE_TONE, verbsFor, type ServiceState } from "../lib/constants";
import { requestAction } from "../actions";

/**
 * The dashboard tile — "is everything up, and can I fix it from here".
 *
 * It draws its OWN card: the dashboard gives a widget a grid cell and nothing else, so
 * without `card` and a title it renders as loose text with no name.
 *
 * Buttons are plain server-rendered forms. No client JavaScript, which matters here more
 * than usual — a control that stops a service should not depend on a hydration step having
 * succeeded, and a form that posts is honest about the fact that something is happening.
 *
 * # Sizing (JonDash 1.8.0 B5/B6)
 *
 * The user can size this from 1×1 upward and the frame **clips rather than scrolls**, so:
 * core's two thresholds decide what kind of content appears, every row is exactly one line so
 * the list is the `FILL_GRID` below (see host-vitals for why not `columns` or `flex-wrap`), and
 * rows are in priority order —
 * stopped services first, because if anything is clipped it must not be the broken one.
 *
 * `.slice(0, 6)` is gone: a constant row count was picked for one box size and was wrong at
 * every other.
 *
 * **The trap specific to this widget:** only services with `canControl` have buttons, so the
 * rows were about to be two different heights — and uneven rows make column-wrap ragged and
 * unpredictable. `min-h-6` on every row fixes the height whether or not buttons are present.
 * The buttons themselves wait for `@[14rem]`, which is a *horizontal* decision and therefore
 * safe: adding content on a width threshold is only ever safe if it adds no height, because a
 * wide-and-short tile reports a huge container while having almost no room.
 */

/**
 * A guard against an unbounded list — **not** the old layout constant coming back.
 *
 * The difference matters. `.slice(0, 6)` decided *how much of the tile to fill*, which is the
 * container's job and was wrong at every size but one. This decides *how much is worth rendering
 * at all*: the allowlist is admin-controlled and can hold hundreds of entries, and a test machine
 * with ~80 approved services rendered 80 rows, which is pointless work whatever the layout does. How many of these 24 you actually see still follows the
 * container. A tile is a summary; the page is the list.
 */
const TILE_CAP = 24;

/**
 * The layout that makes a list **fill** its tile instead of huddling in the top-left corner.
 * See `host-vitals/ui/widget.tsx` for the full reasoning and the two mechanisms that were wrong
 * first: flex `flex-wrap` (columns ran off the side of the card) and CSS `columns` (it balances,
 * so a few rows spread one-per-column across the top and left the rest of the card empty).
 *
 * `1fr` rows are what fill the height; `gridAutoFlow: column` fills downward before going
 * sideways, so a tall tile is one long list and a wide short one flows into columns.
 *
 * Inline rather than Tailwind because `minmax()` and `repeat()` contain parentheses, and on the
 * versions this module supports such a class generates no CSS at all.
 */
const FILL_GRID = {
  display: "grid",
  gridAutoFlow: "column",
  gridTemplateRows: "repeat(auto-fit, minmax(1rem, 1fr))",
  gridAutoColumns: "minmax(11rem, 1fr)",
  columnGap: "1.25rem",
  overflow: "hidden",
  fontSize: "clamp(0.75rem, 1.3cqw, 1rem)",
} as const;

export default async function ServiceControlWidget({ ctx }: ModuleWidgetProps) {
  const api = hostServices(ctx);
  const [services, support] = await Promise.all([api.list(), api.capability()]);

  const stopped = services.filter((s) => s.state === "stopped");
  // Anything not running first: that is the row you actually came to look at.
  const ordered = [...stopped, ...services.filter((s) => s.state !== "stopped")].slice(0, TILE_CAP);
  const running = services.length - stopped.length;

  return (
    <div className="card flex h-full min-w-0 flex-col overflow-hidden p-2 @[8rem]:p-4">
      <div className="hidden items-baseline justify-between gap-2 @[6rem]:flex">
        <h3 className="truncate text-xs font-medium @[8rem]:text-sm">Services</h3>
        <Link
          href={MODULE_PATH}
          className="hidden shrink-0 text-xs @[8rem]:inline"
          style={{ color: "var(--muted)" }}
        >
          All
        </Link>
      </div>

      {/* At 1×1 the whole widget is this: how many are down, or how many are up. */}
      <p
        className="truncate font-medium @[6rem]:hidden"
        style={{ color: stopped.length > 0 ? STATE_TONE.stopped : undefined }}
      >
        {stopped.length > 0 ? `${stopped.length}!` : running}
      </p>

      {services.length === 0 ? (
        <p className="mt-1 hidden truncate text-xs @[6rem]:block" style={{ color: "var(--muted)" }}>
          No services approved yet. Add one under Admin → Addons → Service control.
        </p>
      ) : (
        <>
          <p
            className="mt-1 hidden truncate text-xs @[6rem]:block"
            style={{ color: "var(--muted)" }}
          >
            {stopped.length > 0 ? `${running} up · ${stopped.length} stopped` : `All ${running} up`}
          </p>

          <div className="mt-2 hidden min-h-0 flex-1 @[8rem]:block">
            <ul className="h-full" style={FILL_GRID}>
            {ordered.map((s) => {
              const state = s.state as ServiceState;
              return (
                <li key={s.id} className="flex min-w-0 items-center justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate">{s.label}</span>
                    <span className="shrink-0" style={{ color: STATE_TONE[state] }}>
                      {STATE_LABEL[state]}
                    </span>
                  </span>

                  {s.canControl && (
                    <span className="hidden shrink-0 gap-1 @[14rem]:flex">
                      {verbsFor(state).map((verb) => (
                        <form key={verb} action={requestAction}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="verb" value={verb} />
                          <input type="hidden" name="label" value={s.label} />
                          <button
                            type="submit"
                            className="btn btn-xs"
                            style={{ textTransform: "capitalize" }}
                          >
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
          </div>
        </>
      )}

      {/* Said once, on the tile, rather than only when a button fails: on a machine that
          cannot elevate, the controls are decoration and the admin should know before
          pressing one. */}
      {!support.ok && services.length > 0 && (
        <p
          className="mt-1 hidden shrink-0 truncate text-xs @[8rem]:block"
          style={{ color: "var(--muted)" }}
        >
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
