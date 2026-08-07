import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import { countItems } from "./lib/store";
import { pluralise } from "./lib/text";
import { MODULE_PATH } from "./lib/constants";

/**
 * The dashboard widget — a card among the user's other dashboard tiles.
 *
 * ⚠ THE THING TO COPY FROM THIS FILE: since JonDash 1.8.0 a user can size a widget from 1×1 to
 * full width, and the frame CLIPS rather than scrolls — anything that doesn't fit is simply
 * invisible, with no warning to you or them. So a widget has exactly one job beyond its
 * content: adapt to whatever box it is given, using container queries (below), never a
 * viewport breakpoint. Reuse JonDash's own tokens (`card`, `var(--muted)`, `var(--primary)`)
 * so the module looks native in light and dark mode for free.
 */

/**
 * Use container queries, never a viewport breakpoint: a 1×1 widget on a 4K monitor is still
 * tiny, and a viewport breakpoint would give it the roomy layout anyway, since it answers the
 * wrong question. The frame is a CSS container, so a container-width query asks the one that
 * matters. Core's own two thresholds (`docs/MODULES-AUTHORING.md`) — use these, do not invent
 * your own, so a dashboard mixing core tiles and add-ons changes shape at the same moments:
 *   under the smaller one   → the essential value only, no label
 *   at the smaller one+     → label appears, small text
 *   at the larger one+      → full spacing
 * Two thresholds, deliberately — each is a visible change of shape, and rearranging four times
 * while somebody drags a corner reads as a glitch.
 */

/**
 * If your own widget shows a LIST instead of one figure: never `items.slice(0, N)`. A constant
 * row count is right for one box size and wrong at every other — clipped when small, half-empty
 * when large. Show the most important rows and let the count follow the container.
 */

/**
 * The sizing idiom worth memorising for anything that scales: a WIDTH as a proportion of the
 * box, bounded by a floor so it never vanishes and a ceiling so it stops growing — three
 * separate utility classes, never a fixed size (fixed sizes are what made small tiles clip in
 * the first place). The figure below uses the same shape, expressed for type instead of width.
 *
 * ⚠ A class built from `clamp()`, `calc()` or a CSS-variable arbitrary value silently produced
 * NO CSS at all in an installed module before JonDash 1.8.2 — no warning from the build, the
 * linter or the verifier. Fixed in 1.8.2; this module still floors below that, so its fluid
 * sizing stays in inline `style` throughout, which works on every version this module supports.
 */

/**
 * Makes THIS WIDGET its own size container, which is what lets the figure below be capped
 * against the card's height as well as its width.
 *
 * Core deliberately leaves the dashboard frame width-only, so a height-based unit there would
 * silently resolve against the viewport. Declaring full containment on the widget root fixes
 * that for this subtree only — confined to one tile if the assumption is ever wrong, rather
 * than the whole dashboard, which is why core would not do this globally. Width-based queries
 * on children are unaffected either way.
 */
const SIZE_CONTAINER = { containerType: "size" } as const;

/**
 * The entry point core renders on the dashboard.
 * REFS addons/template/module.ts › DashboardWidget
 */
export default async function TemplateWidget({ ctx }: ModuleWidgetProps) {
  const heading = String((await ctx.settings.get("heading")) ?? "Items");
  const count = ctx.db ? await countItems(ctx.db) : 0;

  return (
    /**
     * Pinned to its cell's full height (the frame sizing) with overflow hidden (content that
     * escapes is invisible, not scrollable) — stating both here means a mistake shows up as
     * clipped content in *your* card during development, not as something odd on a dashboard.
     *
     * The minimum-width reset looks pointless and is not: without it a long word inside a flex
     * child refuses to shrink below its own width and pushes the card wider than its cell.
     */
    <div
      className="card flex h-full min-w-0 flex-col justify-center overflow-hidden p-2 @[8rem]:p-5"
      style={SIZE_CONTAINER}
    >
      {/*
        The heading is the first thing to go. Below 6rem there is no room for a word AND a number,
        and the number is the thing somebody glances at — so the label steps aside rather than both
        being squeezed into illegibility.
      */}
      <p className="hidden min-w-0 truncate text-xs font-medium @[6rem]:block @[8rem]:text-sm">{heading}</p>

      {/*
        The value scales with the box between a floor and a ceiling — the same shape as the
        sizing idiom above, expressed for type. `cqw` is a percentage of the *container*, so
        this tracks the card rather than the window. `tabular-nums` stops the width jittering
        as the number changes, which is very visible in a small card.

        Inline rather than a class, per the note above: below 1.8.2 a class built this way
        produces nothing at all, and this module supports those releases.
      */}
      {/*
        A tile with a LIST fills a big card by showing more rows. A tile with a single figure has
        nothing more to show, so the only honest way to use the space is to make the figure bigger.

        Two caps, because a tile can be extreme in either direction: 22cqw grows it with the WIDTH,
        and the min() against 34cqh stops it exceeding about a third of the HEIGHT — without which
        a very wide, very short tile computes a huge size from its width and shoves the other three
        lines straight out of the card. cqh only means anything because the root declares size
        containment; on core's frame alone it would quietly measure the viewport instead.
      */}
      <p
        className="truncate font-semibold tabular-nums leading-none"
        style={{ fontSize: "min(clamp(1rem, 22cqw, 6rem), 34cqh)" }}
      >
        {count}
      </p>

      {/*
        Everything below only exists when there is room for it. At 1×1 the card is a number with a
        heading, and that is the correct amount of information for that much space — not a
        compromise.
      */}
      <p className="mt-1 hidden truncate text-xs @[6rem]:block" style={{ color: "var(--muted)" }}>
        {pluralise(count, "item")}
      </p>

      <Link
        href={MODULE_PATH}
        className="mt-2 hidden text-xs @[8rem]:inline"
        style={{ color: "var(--primary)" }}
      >
        open
      </Link>
    </div>
  );
}
