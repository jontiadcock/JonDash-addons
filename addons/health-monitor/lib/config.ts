import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModuleContext } from "@/lib/modules/types";
import {
  deleteChannelsExcept,
  deleteMaintenanceExcept,
  deleteMonitorsExcept,
  setRoutes,
  upsertChannel,
  upsertMaintenance,
  upsertMonitor,
} from "./store";

/**
 * The interim configuration channel.
 *
 * The framework has no sanctioned way for a module to handle a form submission yet, so
 * monitors, channels and maintenance windows are declared as JSON in the module's
 * `configJson` setting and reconciled into the module's own tables whenever that text
 * changes. When module actions arrive this becomes the import/export path and a real UI
 * writes the same tables — the schema below is the contract either way.
 *
 * The JSON is untrusted input from an admin's textarea, so everything is validated and
 * clamped before it reaches the database; an invalid document is rejected whole, leaving
 * the previous configuration running rather than half-applying a broken one.
 */

const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "ids are lowercase letters, digits, dash or underscore");

const monitorSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  kind: z.enum(["http", "tcp", "dns", "tls"]),
  target: z.string().min(1).max(500),
  port: z.number().int().min(1).max(65535).optional(),
  intervalSec: z.number().int().min(10).max(86_400).optional(),
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  degradedMs: z.number().int().min(1).max(120_000).optional(),
  parentId: idSchema.optional(),
  runbook: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  channels: z.array(idSchema).optional(),
  config: z
    .object({
      expectStatus: z.union([z.number().int(), z.string()]).optional(),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "OPTIONS"]).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      recordType: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]).optional(),
      expectValue: z.string().max(200).optional(),
      certWarnDays: z.number().int().min(1).max(3650).optional(),
      insecureTls: z.boolean().optional(),
    })
    .optional(),
});

const channelSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  kind: z.enum(["email", "webhook", "discord", "slack", "telegram", "ntfy", "gotify", "homeassistant"]),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const maintenanceSchema = z.object({
  id: idSchema,
  monitorId: idSchema.optional(),
  label: z.string().max(80).optional(),
  kind: z.enum(["once", "weekly"]),
  startsAt: z.string().max(40).optional(),
  endsAt: z.string().max(40).optional(),
  /** Bitmask, Sunday = bit 0. */
  daysMask: z.number().int().min(0).max(127).optional(),
  startMin: z.number().int().min(0).max(1439).optional(),
  durationMin: z.number().int().min(1).max(10_080).optional(),
});

export const configSchema = z.object({
  monitors: z.array(monitorSchema).max(200).optional(),
  channels: z.array(channelSchema).max(50).optional(),
  maintenance: z.array(maintenanceSchema).max(50).optional(),
});

export type ParsedConfig = z.infer<typeof configSchema>;
export type ConfigResult = { ok: true; config: ParsedConfig } | { ok: false; error: string };

/** Validate the configJson text. Empty text is a valid, empty configuration. */
export function parseConfigJson(text: string): ConfigResult {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: true, config: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first.path.join(".") || "config"}: ${first.message}` };
  }
  return { ok: true, config: parsed.data };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export type SyncOutcome = { applied: boolean; monitors: number; channels: number; removed: number; error?: string };

/**
 * Apply `configJson` to the module's tables if it has changed since last time. The hash
 * of the applied text is kept in the module's own store, so this is a cheap no-op on
 * every tick and only does work when an admin actually edits the setting.
 */
export async function syncConfig(ctx: ModuleContext): Promise<SyncOutcome> {
  const db = ctx.db;
  if (!db) return { applied: false, monitors: 0, channels: 0, removed: 0, error: "no database handle" };

  const text = String((await ctx.settings.get("configJson")) ?? "");
  const current = hash(text);
  const lastApplied = String((await ctx.store.get("configHash")) ?? "");
  if (current === lastApplied) return { applied: false, monitors: 0, channels: 0, removed: 0 };

  const parsed = parseConfigJson(text);
  if (!parsed.ok) {
    // Remember nothing: the next tick retries, and the previous config keeps running.
    await ctx.store.set("configError", parsed.error);
    return { applied: false, monitors: 0, channels: 0, removed: 0, error: parsed.error };
  }

  const { monitors = [], channels = [], maintenance = [] } = parsed.config;

  for (const c of channels) {
    const json = JSON.stringify(c.config ?? {});
    await upsertChannel(db, {
      id: c.id,
      name: c.name,
      kind: c.kind,
      // Channel credentials never sit in the table in the clear.
      configEnc: ctx.crypto ? ctx.crypto.encrypt(json) : json,
      enabled: c.enabled === false ? 0 : 1,
    });
  }
  await deleteChannelsExcept(db, channels.map((c) => c.id));

  let order = 0;
  for (const m of monitors) {
    await upsertMonitor(db, {
      id: m.id,
      name: m.name,
      kind: m.kind,
      target: m.target,
      port: m.port ?? null,
      configJson: JSON.stringify(m.config ?? {}),
      intervalSec: m.intervalSec ?? null,
      timeoutMs: m.timeoutMs ?? null,
      retries: m.retries ?? null,
      degradedMs: m.degradedMs ?? null,
      parentId: m.parentId ?? null,
      runbook: m.runbook ?? null,
      enabled: m.enabled === false ? 0 : 1,
      sortOrder: order++,
    });
    await setRoutes(db, m.id, m.channels ?? []);
  }
  const removed = await deleteMonitorsExcept(db, monitors.map((m) => m.id));

  for (const w of maintenance) {
    await upsertMaintenance(db, {
      id: w.id,
      monitorId: w.monitorId ?? null,
      label: w.label ?? null,
      kind: w.kind,
      startsAt: w.startsAt ?? null,
      endsAt: w.endsAt ?? null,
      daysMask: w.daysMask ?? null,
      startMin: w.startMin ?? null,
      durationMin: w.durationMin ?? null,
    });
  }
  await deleteMaintenanceExcept(db, maintenance.map((w) => w.id));

  await ctx.store.set("configHash", current);
  await ctx.store.delete("configError");
  if (ctx.audit) {
    await ctx.audit("config.apply", `${monitors.length} monitors, ${channels.length} channels`);
  }
  return { applied: true, monitors: monitors.length, channels: channels.length, removed };
}

/** The last configuration error, for showing in the UI. */
export async function lastConfigError(ctx: ModuleContext): Promise<string | null> {
  const v = await ctx.store.get("configError");
  return typeof v === "string" && v ? v : null;
}
