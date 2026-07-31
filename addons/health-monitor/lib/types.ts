/**
 * The module's id — must match `module.ts` and the folder name.
 * REFS addons/health-monitor/actions.ts · addons/health-monitor/module.ts
 */
export const MODULE_ID = "health-monitor";

/**
 * Where this module's pages live.
 * REFS addons/health-monitor/actions.ts · addons/health-monitor/page.tsx ·
 *      addons/health-monitor/ui/settings-panel.tsx · addons/health-monitor/widget.tsx
 */
export const MODULE_PATH = `/m/${MODULE_ID}`;

/**
 * Where the module's settings — and its management UI — are rendered by JonDash.
 * REFS addons/health-monitor/actions.ts · addons/health-monitor/page.tsx
 */
export const ADMIN_PATH = `/admin/modules/${MODULE_ID}`;

/**
 * What an action reports back to the page, to be shown to the person who did it.
 * REFS addons/health-monitor/actions.ts · addons/health-monitor/ui/check-form.tsx ·
 *      addons/health-monitor/ui/form.tsx
 */
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
 *
 * REFS addons/health-monitor/lib/checks.ts · addons/health-monitor/lib/forms.ts ·
 *      addons/health-monitor/ui/check-form.tsx
 */
export type MonitorKind = "http" | "tcp" | "ping" | "dns" | "tls";

/**
 * A monitor's health. `unknown` = never checked yet.
 * REFS addons/health-monitor/lib/engine.ts · addons/health-monitor/lib/format.ts ·
 *      addons/health-monitor/lib/store.ts · addons/health-monitor/ui/parts.tsx
 */
export type MonitorState = "up" | "degraded" | "down" | "unknown";

/**
 * Where an alert can be delivered.
 * REFS addons/health-monitor/lib/forms.ts
 */
export type ChannelKind =
  | "email"
  | "webhook"
  | "discord"
  | "slack"
  | "telegram"
  | "ntfy"
  | "gotify"
  | "homeassistant";

/**
 * Per-phase timings for an HTTP check, in milliseconds.
 * REFS addons/health-monitor/lib/checks.ts
 */
export type Phases = {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  totalMs: number;
};

/**
 * What a single check run produced. Never throws — a failure is an outcome.
 * REFS addons/health-monitor/lib/checks.ts · addons/health-monitor/lib/store.ts
 */
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

/**
 * A row of the module's `monitors` table. SQLite gives booleans back as 0/1.
 * REFS addons/health-monitor/lib/engine.ts · addons/health-monitor/lib/notify.ts ·
 *      addons/health-monitor/lib/store.ts · addons/health-monitor/page.tsx ·
 *      addons/health-monitor/ui/check-form.tsx · addons/health-monitor/widget.tsx
 */
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

/**
 * Per-kind extras, parsed out of `monitors.configJson`.
 * REFS addons/health-monitor/lib/checks.ts · addons/health-monitor/lib/store.ts ·
 *      addons/health-monitor/ui/check-form.tsx
 */
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

/** REFS addons/health-monitor/lib/store.ts */
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

/** REFS addons/health-monitor/lib/store.ts */
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

/**
 * REFS addons/health-monitor/lib/notify.ts · addons/health-monitor/lib/store.ts ·
 *      addons/health-monitor/ui/check-form.tsx · addons/health-monitor/ui/settings-panel.tsx
 */
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

/**
 * The module's settings, resolved and coerced from the framework's setting store.
 * REFS addons/health-monitor/lib/engine.ts · addons/health-monitor/lib/settings.ts
 */
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

/**
 * Which alert an event represents.
 * REFS addons/health-monitor/lib/engine.ts · addons/health-monitor/lib/notify.ts
 */
export type AlertEvent = "down" | "up" | "degraded" | "cert" | "test";
