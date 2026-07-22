import type { ModulePageProps } from "@/lib/modules/types";
import { addItemAction, deleteItemAction, toggleItemAction } from "./actions";
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

      {/* This module exists to be read, so it says so on its own page. Delete this
          section first when you copy it. */}
      <section className="card p-4 text-sm">
        <p className="font-medium">This is a template for developers</p>
        <p className="mt-1" style={{ color: "var(--muted)" }}>
          It is a real, working module kept as small as possible, so you can copy it and build your
          own. Nothing here is needed by JonDash — uninstalling removes it completely.
        </p>
        <p className="mt-2" style={{ color: "var(--muted)" }}>
          Its files are in <code>modules/template/</code> inside your JonDash folder. Read{" "}
          <code>MODULE.md</code> there for the full guide — what each file does, how to rename it, and
          what the installer will refuse. If you would rather have an AI write your module, paste the
          contents of <code>AI-PROMPT.md</code> into it and describe what you want.
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
                <span
                  className="block truncate text-sm"
                  style={
                    item.done
                      ? { textDecoration: "line-through", color: "var(--muted)" }
                      : undefined
                  }
                >
                  {item.text}
                </span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </span>
              <span className="flex flex-none items-center gap-2">
                {/* `done` came from migration 002 — proof a later migration applied. */}
                <form action={toggleItemAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <button className="btn btn-ghost" type="submit">
                    {item.done ? "Undo" : "Done"}
                  </button>
                </form>
                <form action={deleteItemAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <button className="btn btn-danger" type="submit">
                    Delete
                  </button>
                </form>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
