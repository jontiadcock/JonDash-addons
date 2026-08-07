"use server";

import { revalidatePath } from "next/cache";
import { moduleAction } from "@/lib/modules/api";
import { MODULE_ID, MODULE_PATH } from "./lib/constants";
import { addItem, deleteItem, toggleItem } from "./lib/store";
import { normaliseItemText } from "./lib/text";

/**
 * How a module changes data: a form posts to a Server Action — an async function in a
 * `"use server"` file — since it can't call your database directly.
 *
 * ⚠ Wrap every export in `moduleAction`, which checks the request is really from JonDash, the
 * caller is signed in (admin, if `adminOnly`), and the module is still enabled, then hands you a
 * `ctx` scoped to what was actually granted. It THROWS on failure — never swallow that in a
 * try/catch, since the throw IS the check being made.
 * ⚠ Beyond that, this file enforces nothing for you: every export must still be async, and YOU
 * must validate the form data yourself — `moduleAction` proves who is calling, not that what
 * they sent makes sense.
 */

/**
 * Add an item. Bad input is rejected quietly rather than stored.
 * REFS addons/template/page.tsx
 */
export const addItemAction = moduleAction(MODULE_ID, async (ctx, formData: FormData) => {
  const text = normaliseItemText(formData.get("text"));
  if (!text || !ctx.db) return;

  await addItem(ctx.db, text);
  // ctx.audit exists only because this module declares `audit:write` in module.ts — the whole
  // permission model in one line. Check it's present; an ungranted capability simply isn't there.
  if (ctx.audit) await ctx.audit("item.add", text);

  // Tell Next the page's data changed, so the list re-renders with the new item.
  revalidatePath(MODULE_PATH);
});

/**
 * Mark an item done, or put it back.
 * REFS addons/template/page.tsx
 */
export const toggleItemAction = moduleAction(MODULE_ID, async (ctx, formData: FormData) => {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0 || !ctx.db) return;

  await toggleItem(ctx.db, id);
  revalidatePath(MODULE_PATH);
});

/**
 * Delete an item by id.
 * REFS addons/template/page.tsx
 */
export const deleteItemAction = moduleAction(MODULE_ID, async (ctx, formData: FormData) => {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0 || !ctx.db) return;

  await deleteItem(ctx.db, id);
  if (ctx.audit) await ctx.audit("item.delete", `item ${id}`);

  revalidatePath(MODULE_PATH);
});
