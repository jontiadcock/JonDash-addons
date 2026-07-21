"use server";

import { revalidatePath } from "next/cache";
import { moduleAction } from "@/lib/modules/api";
import { MODULE_ID, MODULE_PATH } from "./lib/constants";
import { addItem, deleteItem } from "./lib/store";
import { normaliseItemText } from "./lib/text";

/**
 * How a module changes data.
 *
 * A form can't call your database directly, so it posts to a Server Action — an async
 * function in a `"use server"` file. Wrap every one in `moduleAction`, which:
 *   * checks the request really came from JonDash (not another site posting to you);
 *   * checks the caller is signed in, and is an admin if your module is `adminOnly`;
 *   * checks your module is still enabled;
 *   * hands you a `ctx` scoped to the permissions the admin actually granted.
 *
 * It THROWS when any of those fail. Let it throw — never wrap it in a try/catch that
 * swallows the error, because that is the check being skipped.
 *
 * Rules for this file: everything exported must be an async function, and you must
 * validate the form data yourself. `moduleAction` proves who is calling; it can't know
 * whether what they sent makes sense.
 */

/** Add an item. Bad input is rejected quietly rather than stored. */
export const addItemAction = moduleAction(MODULE_ID, async (ctx, formData: FormData) => {
  const text = normaliseItemText(formData.get("text"));
  if (!text || !ctx.db) return;

  await addItem(ctx.db, text);

  // Tell Next the page's data changed, so the list re-renders with the new item.
  revalidatePath(MODULE_PATH);
});

/** Delete an item by id. */
export const deleteItemAction = moduleAction(MODULE_ID, async (ctx, formData: FormData) => {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0 || !ctx.db) return;

  await deleteItem(ctx.db, id);
  revalidatePath(MODULE_PATH);
});
