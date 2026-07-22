import Link from "next/link";
import type { ModuleWidgetProps } from "@/lib/modules/types";
import { countItems } from "./lib/store";
import { pluralise } from "./lib/text";
import { MODULE_PATH } from "./lib/constants";

/**
 * The dashboard widget — a card in the "Modules" area of the main dashboard.
 *
 * Keep it small and calm. It sits alongside the user's service tiles, it renders on
 * every dashboard load, and its width varies, so avoid wide tables and heavy queries.
 * Anything detailed belongs on your page, one click away.
 *
 * Styling: reuse JonDash's own tokens (`card`, `btn`, `var(--muted)`, `var(--primary)`)
 * so the module looks native and follows light/dark mode for free.
 */
export default async function TemplateWidget({ ctx }: ModuleWidgetProps) {
  const heading = String((await ctx.settings.get("heading")) ?? "Items");
  const count = ctx.db ? await countItems(ctx.db) : 0;

  return (
    <div className="card p-4">
      <p className="font-medium">{heading}</p>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
        {pluralise(count, "item")} ·{" "}
        <Link href={MODULE_PATH} style={{ color: "var(--primary)" }}>
          open
        </Link>
      </p>
    </div>
  );
}
