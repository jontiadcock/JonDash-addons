"use server";

import { revalidatePath } from "next/cache";
import { moduleAction } from "@/lib/modules/api";
import { ADMIN_PATH, MODULE_ID, MODULE_PATH, type ActionResult } from "./lib/types";
import {
  deleteChannel,
  deleteMonitor,
  getChannel,
  getMonitor,
  listChannels,
  markDue,
  monitorIds,
  nowIso,
  parseConfig,
  setRoutes,
  upsertChannel,
  upsertMonitor,
} from "./lib/store";
import { monitorConfigFrom, parseChannelForm, parseMonitorForm, slugify, uniqueId } from "./lib/forms";
import { checkMonitor } from "./lib/engine";
import { importConfigJson } from "./lib/config";
import { readSettings } from "./lib/settings";
import { sendAlert } from "./lib/notify";
import { catchUp } from "./lib/scheduler";

/**
 * Everything the interface can change.
 *
 * `moduleAction` checks the request came from JonDash, that the caller is a full admin
 * (this module is adminOnly) and that the module is still enabled, then hands over a ctx
 * scoped to the granted permissions. It throws when a check fails — that is deliberate,
 * so nothing here catches it.
 *
 * Each action returns a short message which the page shows back to the person. Failures
 * are values, not exceptions: a mistyped address should explain itself, not produce an
 * error screen.
 */

/** Save a new monitor, or update an existing one when `id` is present. */
export const saveMonitorAction = moduleAction(
  MODULE_ID,
  async (ctx, formData: FormData): Promise<ActionResult> => {
    if (!ctx.db) return { ok: false, message: "The module has no database." };

    const parsed = parseMonitorForm(formData);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    const input = parsed.value;

    const existingId = String(formData.get("id") ?? "").trim();
    const existing = existingId ? await getMonitor(ctx.db, existingId) : null;
    if (existingId && !existing) return { ok: false, message: "That monitor no longer exists." };

    const id = existing ? existing.id : uniqueId(slugify(input.name), await monitorIds(ctx.db));

    // Keep any config keys the form doesn't cover (set via import), then apply the form.
    const previous = existing ? parseConfig(existing) : {};
    const config = { ...previous, ...monitorConfigFrom(input) };
    if (!input.insecureTls) delete config.insecureTls;
    if (input.kind === "http" && !input.expectStatus) delete config.expectStatus;

    await upsertMonitor(ctx.db, {
      id,
      name: input.name,
      kind: input.kind,
      target: input.target,
      port: input.port,
      configJson: JSON.stringify(config),
      intervalSec: input.intervalSec,
      timeoutMs: input.timeoutMs,
      retries: input.retries,
      degradedMs: input.degradedMs,
      parentId: input.parentId === id ? null : input.parentId,
      runbook: input.runbook,
      enabled: input.enabled,
      sortOrder: existing?.sortOrder ?? Date.now() % 100000,
    });
    await setRoutes(ctx.db, id, input.channelIds);

    if (ctx.audit) {
      await ctx.audit(existing ? "monitor.update" : "monitor.create", `${input.name} (${input.kind})`);
    }

    // A new monitor should report its state straight away, not at the next interval.
    if (!existing) await markDue(ctx.db, id);
    await catchUp(ctx, true);

    revalidatePath(ADMIN_PATH);
    revalidatePath(MODULE_PATH);
    revalidatePath(`${MODULE_PATH}/monitor/${id}`);
    return { ok: true, message: existing ? `Saved “${input.name}”.` : `Now watching “${input.name}”.` };
  },
);

export const deleteMonitorAction = moduleAction(
  MODULE_ID,
  async (ctx, formData: FormData): Promise<ActionResult> => {
    if (!ctx.db) return { ok: false, message: "The module has no database." };
    const id = String(formData.get("id") ?? "").trim();
    const monitor = id ? await getMonitor(ctx.db, id) : null;
    if (!monitor) return { ok: false, message: "That monitor no longer exists." };

    await deleteMonitor(ctx.db, id);
    if (ctx.audit) await ctx.audit("monitor.delete", monitor.name);

    revalidatePath(ADMIN_PATH);
    revalidatePath(MODULE_PATH);
    return { ok: true, message: `Removed “${monitor.name}” and its history.` };
  },
);

/** Run one monitor's check immediately and report what came back. */
export const checkNowAction = moduleAction(
  MODULE_ID,
  async (ctx, formData: FormData): Promise<ActionResult> => {
    if (!ctx.db) return { ok: false, message: "The module has no database." };
    const id = String(formData.get("id") ?? "").trim();
    const monitor = id ? await getMonitor(ctx.db, id) : null;
    if (!monitor) return { ok: false, message: "That monitor no longer exists." };

    const settings = await readSettings(ctx);
    const state = await checkMonitor(ctx, monitor, settings);
    const after = await getMonitor(ctx.db, id);

    revalidatePath(ADMIN_PATH);
    revalidatePath(MODULE_PATH);
    revalidatePath(`${MODULE_PATH}/monitor/${id}`);
    return {
      ok: state !== "down",
      message: `${monitor.name}: ${after?.lastMessage ?? state}`,
    };
  },
);

export const saveChannelAction = moduleAction(
  MODULE_ID,
  async (ctx, formData: FormData): Promise<ActionResult> => {
    if (!ctx.db) return { ok: false, message: "The module has no database." };

    const parsed = parseChannelForm(formData);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    const input = parsed.value;

    const existingId = String(formData.get("id") ?? "").trim();
    const id = existingId || uniqueId(slugify(input.name), (await listChannels(ctx.db)).map((c) => c.id));
    const json = JSON.stringify(input.config);

    await upsertChannel(ctx.db, {
      id,
      name: input.name,
      kind: input.kind,
      // Webhook URLs and bot tokens are credentials — never stored in the clear.
      configEnc: ctx.crypto ? ctx.crypto.encrypt(json) : json,
      enabled: 1,
    });
    if (ctx.audit) await ctx.audit("channel.save", `${input.name} (${input.kind})`);

    revalidatePath(ADMIN_PATH);
    return { ok: true, message: `Saved “${input.name}”. Send a test to check it works.` };
  },
);

export const deleteChannelAction = moduleAction(
  MODULE_ID,
  async (ctx, formData: FormData): Promise<ActionResult> => {
    if (!ctx.db) return { ok: false, message: "The module has no database." };
    const id = String(formData.get("id") ?? "").trim();
    const channel = id ? await getChannel(ctx.db, id) : null;
    if (!channel) return { ok: false, message: "That channel no longer exists." };

    await deleteChannel(ctx.db, id);
    if (ctx.audit) await ctx.audit("channel.delete", channel.name);

    revalidatePath(ADMIN_PATH);
    return { ok: true, message: `Removed “${channel.name}”.` };
  },
);

/** Apply whatever is in the bulk-import box. Adds and updates only — never deletes. */
export const importConfigAction = moduleAction(MODULE_ID, async (ctx): Promise<ActionResult> => {
  const outcome = await importConfigJson(ctx);
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
  if (!outcome.applied) return { ok: false, message: outcome.error ?? "Nothing was imported." };
  return {
    ok: true,
    message: `Imported ${outcome.monitors} monitor${outcome.monitors === 1 ? "" : "s"} and ${outcome.channels} channel${outcome.channels === 1 ? "" : "s"}.`,
  };
});

/** Send a test alert, so a channel can be proven before an outage depends on it. */
export const testChannelAction = moduleAction(
  MODULE_ID,
  async (ctx, formData: FormData): Promise<ActionResult> => {
    if (!ctx.db) return { ok: false, message: "The module has no database." };
    const id = String(formData.get("id") ?? "").trim();
    const channel = id ? await getChannel(ctx.db, id) : null;
    if (!channel) return { ok: false, message: "That channel no longer exists." };

    const settings = await readSettings(ctx);
    const result = await sendAlert(
      ctx,
      channel,
      {
        event: "test",
        monitor: { id: "test", name: "Test alert", kind: "http", target: "JonDash health monitoring", runbook: null },
        detail: `Sent from JonDash at ${nowIso()}`,
      },
      settings.notifyEmails,
    );

    revalidatePath(ADMIN_PATH);
    return result.ok
      ? { ok: true, message: `Test sent to “${channel.name}”. Check it arrived.` }
      : { ok: false, message: `“${channel.name}” failed: ${result.error ?? "unknown error"}` };
  },
);
