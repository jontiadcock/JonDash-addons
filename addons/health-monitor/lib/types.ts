/** The module's id — must match `module.ts` and the folder name. */
export const MODULE_ID = "health-monitor";

/** Where this module's pages live. */
export const MODULE_PATH = `/m/${MODULE_ID}`;

/** Where the module's settings — and its management UI — are rendered by JonDash. */
export const ADMIN_PATH = `/admin/modules/${MODULE_ID}`;

/** What an action reports back to the page, to be shown to the person who did it. */
export type ActionResult = { ok: boolean; message: string };

/**
 * Shared types for the health-monitor module.
 *
 * Deliberately free of `server-only` and of any Node import so every other file in the
 * module — including anything that might one day be a client component — can import it
 * safely. (A `server-only` module reaching a client component breaks the build.)
 */

/**
 * The kinds of check this module knows how to run.
 *
 * `ping` is ICMP via `ctx.net.ping` — the framework owns it because it needs the OS
 * `ping` binary, and the host validation and argument handling that makes that safe
 * belongs in trusted code once rather than in every module that wants it.
 */
export type MonitorKind = "http" | "tcp" | "ping" | "dns" | "tls";

/** A monitor's health. `unknown` = never checked yet. */
export type MonitorState = "up" | "degraded" | "down" | "unknown";

/** Where an alert can be delivered. */
export type ChannelKind =
  | "email"
  | "webhook"
  | "discord"
  | "slack"
  | "telegram"
  | "ntfy"
  | "gotify"
  | "homeassistant";

/** Per-phase timings for an HTTP check, in milliseconds. */
export type Phases = {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  totalMs: number;
};

/** What a single check run produced. Never throws — a failure is an outcome. */
export type CheckOutcome = {
  /** `up` or `down` from the check itself; the engine downgrades slow `up` to `degraded`. */
  state: Exclude<MonitorState, "unknown">;
  latencyMs?: number;
  /** Status code, exit code or resolved value — whatever identifies this result. */
  code?: string;
  /** One line a human can read. Shown in the UI and included in alerts. */
  message?: string;
  phases?: Phases;
};

/** A row of the module's `monitors` table. SQLite gives booleans back as 0/1. */
export type MonitorRow = {
  id: string;
  name: string;
  kind: MonitorKind;
  target: string;
  port: number | null;
  configJson: string;
  intervalSec: number | null;
  timeoutMs: number | null;
  retries: number | null;
  degradedMs: number | null;
  parentId: string | null;
  runbook: string | null;
  enabled: number;
  sortOrder: number;
  status: MonitorState;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  lastLatencyMs: number | null;
  lastMessage: string | null;
  failStreak: number;
  okStreak: number;
  createdAt: string;
  updatedAt: string;
};

/** Per-kind extras, parsed out of `monitors.configJson`. */
export type MonitorConfig = {
  /** http: expected status, e.g. 200 or "2xx". Defaults to any 2xx or 3xx. */
  expectStatus?: number | string;
  /** http: request method. Defaults to GET. */
  method?: string;
  /** http: extra request headers. */
  headers?: Record<string, string>;
  /** dns: record type to resolve. Defaults to A. */
  recordType?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";
  /** dns: the answer must contain this value. */
  expectValue?: string;
  /** tls: warn when the certificate has fewer than this many days left. */
  certWarnDays?: number;
  /** http/tls: accept an untrusted or self-signed certificate. Opt-in, for LAN services. */
  insecureTls?: boolean;
};

export type IncidentRow = {
  id: number;
  monitorId: string;
  state: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  reason: string | null;
  lastNotifiedAt: string | null;
  notifyCount: number;
};

export type ResultRow = {
  id: number;
  monitorId: string;
  ts: string;
  state: MonitorState;
  latencyMs: number | null;
  code: string | null;
  message: string | null;
  phasesJson: string | null;
};

export type ChannelRow = {
  id: string;
  name: string;
  kind: ChannelKind;
  configEnc: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
};

/** Rolled-up hourly history, which replaces raw results once they age out. */
export type RollupRow = {
  monitorId: string;
  hourStart: string;
  checks: number;
  failures: number;
  degraded: number;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

/** The module's settings, resolved and coerced from the framework's setting store. */
export type ModuleSettings = {
  defaultIntervalSec: number;
  defaultTimeoutMs: number;
  defaultRetries: number;
  degradedMs: number;
  maxConcurrent: number;
  rollupAfterDays: number;
  retentionDays: number;
  quietAfterRestartMin: number;
  renotifyMin: number;
  maxAlertsPerHour: number;
  certWarnDays: number[];
  notifyEmails: string[];
  alertsEnabled: boolean;
};

/** Which alert an event represents. */
export type AlertEvent = "down" | "up" | "degraded" | "cert" | "test";
