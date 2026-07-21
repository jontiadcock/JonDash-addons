import type { ModulePageProps } from "@/lib/modules/types";
import { addItemAction, deleteItemAction } from "./actions";
import { listItems } from "./lib/store";
import { MAX_ITEM_LENGTH } from "./lib/text";

/**
 * Your module's own page, served at /m/<id> (and /m/<id>/anything — the trailing
 * segments arrive as `path`). JonDash has already checked the viewer is signed in and,
 * if your module is `adminOnly`, that they're an admin.
 *
 * This is a Server Component: it can read the database directly and there is no
 * client-side JavaScript. The forms post to the Server Actions in actions.ts, so even
 * adding and deleting needs no `"use client"`.
 */
export default async function TemplatePage({ ctx, path }: ModulePageProps) {
  const heading = String((await ctx.settings.get("heading")) ?? "Items");
  const items = ctx.db ? await listItems(ctx.db) : [];

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {path.length > 0 ? `Sub-path: /${path.join("/")} · ` : ""}
          Everything here lives in this module&apos;s own table and disappears when it is uninstalled.
        </p>
      </section>

      {/* A plain form pointed at a Server Action — no client JavaScript involved. */}
      <form action={addItemAction} className="flex gap-2">
        <input
          className="input flex-1"
          type="text"
          name="text"
          placeholder="Add an item"
          maxLength={MAX_ITEM_LENGTH}
          required
        />
        <button className="btn btn-primary" type="submit">
          Add
        </button>
      </form>

      {items.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Nothing here yet. Add the first item above.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="card flex items-center justify-between gap-3 p-3">
              <span className="min-w-0">
                <span className="block truncate text-sm">{item.text}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </span>
              <form action={deleteItemAction} className="flex-none">
                <input type="hidden" name="id" value={item.id} />
                <button className="btn btn-danger" type="submit">
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
