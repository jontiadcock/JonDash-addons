import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import { countItems } from "./lib/store";
import { pluralise } from "./lib/text";
import { MODULE_PATH } from "./lib/constants";

/**
 * The dashboard widget — a card in the dashboard grid, sitting among the user's service tiles.
 *
 * # THE THING TO COPY FROM THIS FILE: it adapts to its own box, not to the screen.
 *
 * Since JonDash 1.8.0 the dashboard is a grid of **square units**, a user can size a widget
 * anywhere from **1×1 to the full width**, and — the part that catches people —
 * **the frame CLIPS. It does not scroll.** Anything that does not fit is not hidden behind a
 * scrollbar, it is simply invisible, and neither you nor the user gets told.
 *
 * So a widget has exactly one job beyond its content: **fit whatever box it is given.**
 *
 * ## Use container queries, never `sm:` / `md:` / `lg:`
 *
 * Viewport breakpoints are the wrong tool here and the mistake is easy to make, because they *look*
 * like they work — you resize your browser and the widget responds. But a **1×1 widget on a 4K
 * monitor is still tiny**, and `lg:` would give it the roomy layout. The frame is a CSS container,
 * so `@[6rem]:` asks the question that actually matters: *how big am I?*
 *
 * ## Core's thresholds — use these, do not invent your own
 *
 * From `docs/MODULES-AUTHORING.md`, "The thresholds core uses". Core's own service tiles use them,
 * so a dashboard mixing tiles and add-ons changes shape at the same moments instead of raggedly:
 *
 * | Container width | What happens |
 * | --------------- | ------------ |
 * | under `@[6rem]` | the essential value only; labels hidden |
 * | `@[6rem]`+      | labels appear, `text-xs` |
 * | `@[8rem]`+      | full spacing — `gap-3`, `p-5`, `text-sm` |
 *
 * **Two thresholds, deliberately — not five.** Each one is a visible change of shape, and a widget
 * that rearranges four times while somebody drags its corner reads as a glitch.
 *
 * ## The sizing idiom worth memorising
 *
 * `w-[46%] min-w-7 max-w-16` — a **proportion** so it tracks the box, a **floor** so it never
 * vanishes, a **ceiling** so it stops growing. Fixed sizes are what made small tiles clip in the
 * first place. Apply the same shape of thinking to anything that scales.
 *
 * ## Trap: a Tailwind class containing `(` silently does nothing in a module
 *
 * Installed modules live in a gitignored folder, so Tailwind never scans them; core mirrors the
 * class names it finds into an allowlist instead. That mirror **drops any token containing
 * parentheses**, so in a module ‘text-[clamp(...)]’, ‘w-[calc(...)]’ and
 * ‘bg-(--brand)’ all produce **no CSS at all** — the class is on the element, nothing styles it,
 * and nothing warns you. Verified on 1.8.1-beta.1; reported to core.
 *
 * Everything else works, so this only bites the CSS *functions* — which is unlucky, because
 * `clamp()` is the obvious tool for fluid sizing. **Put those in an inline `style` instead**, as
 * below. Inline styles are never scanned, so they are immune, and you would already be reaching for
 * one to use a theme token like `var(--muted)`.
 *
 * ## If your widget shows a LIST, this is the bug you will have
 *
 * Do not write `items.slice(0, 6)`. A constant row count was chosen for one box size and is wrong
 * at every other — clipped when small, half-empty when large. Show the *most important* rows and
 * let the count follow the container, exactly as the label does below.
 *
 * Styling: reuse JonDash's own tokens (`card`, `var(--muted)`, `var(--primary)`) so the module
 * looks native and follows light and dark mode for free.
 */
/**
 * Makes THIS WIDGET its own size container, which is what lets the figure below be capped against
 * the card height as well as its width.
 *
 * Core deliberately leaves the dashboard frame on `container-type: inline-size`, so `cqh` there
 * would silently resolve against the viewport. Declaring size containment on the widget root fixes
 * that for our own subtree only: the root is `h-full` inside a sized grid cell, so its height is
 * definite, and if the assumption were ever wrong the damage is confined to this one tile rather
 * than the whole dashboard — which is exactly why core would not make the same change globally.
 *
 * `@[6rem]:` classes on children now resolve against this element instead of the frame. Same
 * width, so nothing changes.
 */
const SIZE_CONTAINER = { containerType: "size" } as const;

export default async function TemplateWidget({ ctx }: ModuleWidgetProps) {
  const heading = String((await ctx.settings.get("heading")) ?? "Items");
  const count = ctx.db ? await countItems(ctx.db) : 0;

  return (
    /**
     * `h-full` because the frame pins the widget root to the full height of its cell, and
     * `overflow-hidden` because content that escapes is invisible rather than scrollable — stating
     * it here means a mistake shows up as clipped content in *your* card during development, not as
     * something odd-looking on somebody's dashboard.
     *
     * `min-w-0` looks pointless and is not: without it a long word inside a flex child refuses to
     * shrink below its own width and pushes the card wider than its cell.
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
        The value scales with the box between a floor and a ceiling — the same shape as core's
        `w-[46%] min-w-7 max-w-16`, expressed for type. `cqw` is a percentage of the *container*,
        so this tracks the card rather than the window. `tabular-nums` stops the width jittering as
        the number changes, which is very visible in a small card.

        Inline rather than ‘text-[clamp(...)]’ — see the note above; as a class it would silently
        produce nothing.
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
