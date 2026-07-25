"use server";
import { moduleAction } from "@/lib/modules/api";
import { revalidatePath } from "next/cache";
import hostServices from "@/helpers/host-services/api";
import { MODULE_ID, ADMIN_PATH, MODULE_PATH } from "./lib/constants";
import { writeNotice } from "./lib/notice";

/**
 * Everything this module can change — which is now only *asking*.
 *
 * The allowlist actions (add, remove, set-unattended, approve, decline) were removed in
 * `0.0.1-beta.5`. They let this module choose the service name that got approved while its
 * consent screen promised only that it could control services already on the list. See
 * `ui/settings-panel.tsx` for the full reasoning; the short version is that a module must not
 * be able to edit the boundary that bounds it.
 *
 * `moduleAction` wraps each handler: same-origin asserted, refused if the module is disabled,
 * and a context scoped to exactly the permissions declared. Plain server-rendered forms, so a
 * button that stops a service does not depend on hydration having succeeded.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const notice = writeNotice;

/**
 * Ask for an action on an allowlisted service.
 *
 * The reply distinguishes "it ran" from "it is waiting for you" — those look identical
 * otherwise, and the difference is the entire point of the approval model.
 */
export const requestAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const id = str(form, "id");
  const verb = str(form, "verb");
  const label = str(form, "label") || "that service";

  if (verb !== "start" && verb !== "stop" && verb !== "restart") {
    await notice(ctx, "bad", "That is not an action this module can ask for.");
  } else {
    const r = await hostServices(ctx).request(id, verb);
    if (!r.ok) {
      await notice(ctx, "bad", `Could not ${verb} ${label}: ${r.reason}.`);
    } else if (r.status === "ran") {
      await notice(ctx, "ok", `${label} — ${verb} done.`);
    } else {
      await notice(ctx, "warn", `Asked to ${verb} ${label}. It needs approval before it runs.`);
    }
  }
  revalidatePath(MODULE_PATH);
  revalidatePath(ADMIN_PATH);
});

/**
 * Suggest a service for the allowlist. **Inert** — it writes a suggestion an administrator may
 * act on, and there is no call anywhere that promotes one.
 */
export const suggestAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const name = str(form, "serviceName");
  const why = str(form, "reason");
  const r = await hostServices(ctx).suggest(name, why);
  await notice(
    ctx,
    r.ok ? "ok" : "warn",
    r.ok
      ? `Suggested "${name}". An administrator has to add it before anything can happen.`
      : `Could not suggest "${name}": ${r.reason}.`,
  );
  revalidatePath(ADMIN_PATH);
});
