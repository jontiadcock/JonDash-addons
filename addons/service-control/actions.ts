"use server";
import { moduleAction } from "@/lib/modules/api";
import { revalidatePath } from "next/cache";
import hostServices from "@/helpers/host-services/api";
import { MODULE_ID, ADMIN_PATH, MODULE_PATH } from "./lib/constants";
import { writeNotice } from "./lib/notice";

/**
 * Everything that changes something.
 *
 * `moduleAction` is a FACTORY: it wraps a handler and returns the action, so each export
 * below is the wrapped function rather than a call to it. The wrapper asserts same-origin,
 * refuses if the module is disabled, and builds a context scoped to exactly the permissions
 * this module declared.
 *
 * All of these are used from plain server-rendered `<form action={…}>`, so each takes only
 * FormData and returns nothing. Outcomes are written to the module's own store and read back
 * on the next render — no client JavaScript, and no state that can drift from the database.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

const notice = writeNotice;

/* ------------------------------------------------------------------ using a service */

/**
 * Ask for an action on an allowlisted service.
 *
 * The reply distinguishes "it ran" from "it is waiting for you", because those look
 * identical to a user otherwise and the difference is the entire point of the approval
 * model. An entry the admin marked unattended runs immediately; everything else queues.
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
      await notice(ctx, "warn", `Asked to ${verb} ${label}. It needs your approval before it runs.`);
    }
  }
  revalidatePath(MODULE_PATH);
  revalidatePath(ADMIN_PATH);
});

/** Ask the administrator to allowlist something. Inert — it writes a suggestion, nothing more. */
export const suggestAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const name = str(form, "serviceName");
  const why = str(form, "reason");
  const r = await hostServices(ctx).suggest(name, why);
  await notice(
    ctx,
    r.ok ? "ok" : "warn",
    r.ok
      ? `Suggested "${name}". An administrator has to approve it before anything can happen.`
      : `Could not suggest "${name}": ${r.reason}.`,
  );
  revalidatePath(ADMIN_PATH);
});

/* ------------------------------------------------------------------ administering the list */
// Everything below reaches `admin.*`, which refuses unless ctx.user is an ADMIN. These
// actions are only rendered on the settings panel, but the helper re-checks rather than
// trusting where the call came from.

/** Approve a service. Raises a UAC prompt, because it creates the OS grant. */
export const addEntryAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const serviceName = str(form, "serviceName");
  const label = str(form, "label");
  const readOnly = Boolean(form.get("readOnly"));

  const r = await hostServices(ctx).admin.add({ serviceName, label, canControl: !readOnly });
  if (r.ok) {
    const risk = r.risk.level === "none" ? "" : ` ${r.risk.message}`;
    await notice(ctx, r.risk.level === "lockout" ? "warn" : "ok", `Added ${r.entry.label}.${risk}`);
  } else {
    await notice(ctx, r.cancelledAtUac ? "warn" : "bad", `Could not add "${serviceName}" — ${r.reason}.`);
  }
  revalidatePath(ADMIN_PATH);
});

/** Remove an entry and its grants together. */
export const removeEntryAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const r = await hostServices(ctx).admin.remove(str(form, "id"));
  await notice(ctx, r.ok ? "ok" : "bad", r.ok ? "Removed." : `Could not remove it — ${r.reason}.`);
  revalidatePath(ADMIN_PATH);
});

/** Per entry: may a module act without asking? Never global, never module-settable. */
export const setUnattendedAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const on = str(form, "unattended") === "1";
  await hostServices(ctx).admin.setUnattended(str(form, "id"), on);
  await notice(
    ctx,
    on ? "warn" : "ok",
    on
      ? "That service can now be controlled without asking you first."
      : "That service will ask for your approval each time.",
  );
  revalidatePath(ADMIN_PATH);
});

/** Approve a queued request — the moment a module's ask becomes an action. */
export const approveAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const outcome = await hostServices(ctx).admin.approve(str(form, "id"));
  if (outcome.status === "approved") {
    await notice(ctx, outcome.ok ? "ok" : "bad", outcome.ok ? "Done." : `It ran but failed: ${outcome.detail}`);
  } else if (outcome.status === "cancelled-at-uac") {
    await notice(ctx, "warn", "You dismissed the Windows permission prompt, so nothing happened.");
  } else if (outcome.status === "failed") {
    await notice(ctx, "bad", `It could not run: ${outcome.detail}`);
  } else {
    await notice(ctx, "warn", "That request is no longer waiting.");
  }
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
});

/** Refuse a queued request. Terminal — the module cannot re-raise the same ask. */
export const declineAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  await hostServices(ctx).admin.decline(str(form, "id"));
  await notice(ctx, "ok", "Declined.");
  revalidatePath(ADMIN_PATH);
});
