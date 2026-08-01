import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, SPEED_ENDPOINT, type ChannelKind, type MonitorKind } from "./types";

/**
 * Turning form fields into validated values, and the choices the forms offer.
 *
 * Pure functions with no imports beyond types, so the rules that decide what is a valid
 * monitor are testable without a database or a browser — and so the same rules can be
 * reused if a monitor ever arrives from somewhere other than a form.
 */

/**
 * The kinds of check, described the way someone picking from a menu would say them, and
 * with the address field relabelled to suit — asking for a "Web address" and asking for
 * a "Hostname or IP" are different questions, and one generic box for both is what makes
 * a form feel clunky.
 */
export type KindChoice = {
  value: MonitorKind;
  /** What the dropdown says. */
  label: string;
  /** One line under the dropdown once chosen. */
  hint: string;
  /** Label for the address box for this kind. */
  addressLabel: string;
  addressPlaceholder: string;
  addressHelp: string;
  /** Whether a port is required, optional, or meaningless for this kind. */
  port: "required" | "optional" | "none";
  portHelp?: string;
  /** Whether the HTTP-only extras apply. */
  httpOptions?: boolean;
  /** Whether the self-signed certificate option is worth offering. */
  tlsOptions?: boolean;
  /** Whether the speed-test extras apply — upload toggle, minimum rate, payload size. */
  speedOptions?: boolean;
  /**
   * What this kind should default to when a monitor is created, overriding the global default.
   * ⚠ Exists for `speed`, whose every run costs real bandwidth — a minute would be indefensible.
   */
  defaultIntervalSec?: number;
};

/**
 * REFS addons/health-monitor/page.tsx · addons/health-monitor/ui/check-form.tsx ·
 *      addons/health-monitor/ui/settings-panel.tsx
 */
export const KIND_CHOICES: KindChoice[] = [
  {
    value: "http",
    label: "HTTPS / website check",
    hint: "Loads the page and checks it answers properly, and how quickly.",
    addressLabel: "Web address",
    addressPlaceholder: "https://example.com",
    addressHelp: "The full address, including https:// — the same thing you'd type in a browser.",
    port: "none",
    httpOptions: true,
    tlsOptions: true,
  },
  {
    value: "ping",
    label: "Ping check",
    hint: "Asks the device to answer a ping. For anything that offers nothing else.",
    addressLabel: "Hostname or IP address",
    addressPlaceholder: "192.168.1.1",
    addressHelp: "No http:// — just the name or address, like 192.168.1.1 or nas.local.",
    port: "none",
  },
  {
    value: "tcp",
    label: "Port check",
    hint: "Opens a connection to a port. For databases, SSH, game servers — anything not a website.",
    addressLabel: "Hostname or IP address",
    addressPlaceholder: "192.168.1.20",
    addressHelp: "No http:// — just the name or address of the machine.",
    port: "required",
    portHelp: "Which port to connect to — 5432 for PostgreSQL, 22 for SSH, 3306 for MySQL.",
  },
  {
    value: "dns",
    label: "DNS check",
    hint: "Checks the name still resolves to an address.",
    addressLabel: "Domain name",
    addressPlaceholder: "example.com",
    addressHelp: "The name to look up.",
    port: "none",
  },
  {
    value: "tls",
    label: "SSL certificate check",
    hint: "Warns you well before the certificate expires, and if it stops being trusted.",
    addressLabel: "Hostname",
    addressPlaceholder: "example.com",
    addressHelp: "The name on the certificate — no https:// and no path.",
    port: "optional",
    portHelp: "Leave blank for 443, the normal HTTPS port.",
    tlsOptions: true,
  },
  {
    value: "speed",
    label: "Internet speed test",
    hint: "Measures your download and upload speed, plus latency and jitter. Uses real data each run — about 20MB with upload on, 10MB without.",
    addressLabel: "Test server",
    addressPlaceholder: SPEED_ENDPOINT,
    addressHelp: "Leave blank to use Cloudflare's public speed test. Change it to point at your own.",
    port: "none",
    speedOptions: true,
    // Every six hours: frequent enough to catch a real degradation, cheap enough to leave on.
    defaultIntervalSec: 21_600,
  },
];

/**
 * Intervals worth offering. Seconds under the hood, sentences on screen.
 * REFS addons/health-monitor/ui/check-form.tsx
 */
export const INTERVAL_CHOICES: { value: number; label: string }[] = [
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
  { value: 1800, label: "Every 30 minutes" },
  { value: 3600, label: "Every hour" },
  { value: 10800, label: "Every 3 hours" },
  { value: 21600, label: "Every 6 hours" },
  { value: 43200, label: "Every 12 hours" },
  { value: 86400, label: "Once a day" },
  { value: 172800, label: "Every 2 days" },
  { value: 259200, label: "Every 3 days" },
  { value: 604800, label: "Once a week" },
];


/** REFS addons/health-monitor/ui/settings-panel.tsx */
export const CHANNEL_CHOICES: { value: ChannelKind; label: string; needs: string }[] = [
  { value: "email", label: "Email", needs: "Uses the email account set up in Admin → Email. Leave the boxes empty to use the module's recipient list." },
  { value: "webhook", label: "Webhook (any service)", needs: "Needs the URL to POST to. The secret is sent as an Authorization header if you set one." },
  { value: "discord", label: "Discord", needs: "Needs a Discord webhook URL (Channel settings → Integrations → Webhooks)." },
  { value: "slack", label: "Slack", needs: "Needs a Slack incoming-webhook URL." },
  { value: "telegram", label: "Telegram", needs: "Needs your bot token in Secret, and the chat id in Topic or chat." },
  { value: "ntfy", label: "ntfy", needs: "Needs the topic in Topic or chat. URL is optional (defaults to ntfy.sh); Secret is an access token if your server needs one." },
  { value: "gotify", label: "Gotify", needs: "Needs your server URL and an application token in Secret." },
  { value: "homeassistant", label: "Home Assistant", needs: "Needs a Home Assistant webhook URL." },
];

const KINDS = new Set(KIND_CHOICES.map((k) => k.value));
const CHANNEL_KINDS = new Set(CHANNEL_CHOICES.map((c) => c.value));

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A readable id derived from the name, e.g. "My NAS box" → "my-nas-box".
 * REFS addons/health-monitor/actions.ts
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "monitor";
}

/**
 * Make a slug unique against ids already in use, by appending -2, -3, …
 * REFS addons/health-monitor/actions.ts
 */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function number(fd: FormData, key: string): number | null {
  const raw = text(fd, key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export type MonitorInput = {
  name: string;
  kind: MonitorKind;
  target: string;
  port: number | null;
  intervalSec: number | null;
  timeoutMs: number | null;
  retries: number | null;
  degradedMs: number | null;
  parentId: string | null;
  runbook: string | null;
  enabled: number;
  insecureTls: boolean;
  expectStatus: string;
  channelIds: string[];
  /** speed: leave the upload leg out, halving what a run costs. */
  skipUpload: boolean;
  /** speed: report `degraded` below this download rate. Blank or 0 never degrades. */
  minMbps: number | null;
  /** speed: megabytes to transfer per leg. */
  payloadMb: number | null;
};

/**
 * Validate what someone typed into the monitor form.
 *
 * The messages are the point: they say what to do, not what went wrong internally,
 * because this is the only feedback the person gets.
 * REFS addons/health-monitor/actions.ts
 */
export function parseMonitorForm(fd: FormData): FormResult<MonitorInput> {
  const name = text(fd, "name");
  if (!name) return { ok: false, error: "Give the monitor a name." };
  if (name.length > 80) return { ok: false, error: "That name is too long — keep it under 80 characters." };

  const kind = text(fd, "kind") as MonitorKind;
  if (!KINDS.has(kind)) return { ok: false, error: "Choose what to check." };

  const target = text(fd, "target");
  // A speed check is the one kind whose address may be blank — it falls back to the public
  // endpoint, and demanding a URL for the common case would be pointless friction.
  if (!target && kind !== "speed") return { ok: false, error: "Enter an address to check." };
  if (target.length > 500) return { ok: false, error: "That address is too long." };

  if (kind === "speed") {
    if (target && !/^https?:\/\//i.test(target)) {
      return { ok: false, error: "A speed test server must start with http:// or https://" };
    }
  } else if (kind === "http") {
    if (!/^https?:\/\//i.test(target)) {
      return { ok: false, error: "A website address must start with http:// or https://" };
    }
    try {
      new URL(target);
    } catch {
      return { ok: false, error: "That doesn't look like a valid web address." };
    }
  } else if (/^[a-z]+:\/\//i.test(target)) {
    return { ok: false, error: "Enter just the hostname or IP address, without http:// in front." };
  }

  const port = number(fd, "port");
  if (kind === "tcp" && (port === null || port < 1 || port > 65535)) {
    return { ok: false, error: "A port check needs a port number between 1 and 65535." };
  }
  if (port !== null && (port < 1 || port > 65535)) {
    return { ok: false, error: "That port number isn't valid." };
  }

  const intervalSec = number(fd, "intervalSec");
  if (intervalSec !== null && (intervalSec < MIN_INTERVAL_SEC || intervalSec > MAX_INTERVAL_SEC)) {
    return { ok: false, error: "Choose how often to check from the list." };
  }

  const timeoutMs = number(fd, "timeoutMs");
  if (timeoutMs !== null && (timeoutMs < 500 || timeoutMs > 120_000)) {
    return { ok: false, error: "The timeout must be between 500 and 120000 milliseconds." };
  }

  const retries = number(fd, "retries");
  if (retries !== null && (retries < 1 || retries > 10)) {
    return { ok: false, error: "Confirmations must be between 1 and 10." };
  }

  const degradedMs = number(fd, "degradedMs");
  if (degradedMs !== null && (degradedMs < 1 || degradedMs > 120_000)) {
    return { ok: false, error: "The slow-response limit must be between 1 and 120000 milliseconds." };
  }

  const runbook = text(fd, "runbook");
  if (runbook.length > 500) return { ok: false, error: "That note is too long — keep it under 500 characters." };

  const minMbps = number(fd, "minMbps");
  if (minMbps !== null && (minMbps < 0 || minMbps > 100_000)) {
    return { ok: false, error: "The minimum speed must be between 0 and 100000 Mbps." };
  }
  const payloadMb = number(fd, "payloadMb");
  if (payloadMb !== null && (payloadMb < 1 || payloadMb > 100)) {
    return { ok: false, error: "The amount to transfer must be between 1 and 100 MB." };
  }

  return {
    ok: true,
    value: {
      name,
      kind,
      target,
      port: kind === "tls" && port === null ? 443 : port,
      intervalSec,
      timeoutMs,
      retries,
      degradedMs,
      parentId: text(fd, "parentId") || null,
      runbook: runbook || null,
      // An unticked checkbox sends nothing at all, so presence is the signal.
      enabled: text(fd, "enabled") === "on" ? 1 : 0,
      insecureTls: text(fd, "insecureTls") === "on",
      expectStatus: text(fd, "expectStatus"),
      channelIds: fd.getAll("channelIds").filter((v): v is string => typeof v === "string" && v.length > 0),
      skipUpload: text(fd, "skipUpload") === "on",
      minMbps,
      payloadMb,
    },
  };
}

/**
 * Build the per-kind `config` blob from the validated form values.
 * REFS addons/health-monitor/actions.ts
 */
export function monitorConfigFrom(input: MonitorInput): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (input.kind === "http") {
    if (input.expectStatus) config.expectStatus = input.expectStatus;
    if (input.insecureTls) config.insecureTls = true;
  }
  if (input.kind === "tls" && input.insecureTls) config.insecureTls = true;
  if (input.kind === "speed") {
    if (input.skipUpload) config.skipUpload = true;
    if (input.minMbps) config.minMbps = input.minMbps;
    // Stored as bytes because that is what the transfer works in; shown as MB because that is
    // what a person thinks in.
    if (input.payloadMb) config.payloadBytes = input.payloadMb * 1024 * 1024;
  }
  return config;
}

export type ChannelInput = {
  name: string;
  kind: ChannelKind;
  config: Record<string, unknown>;
};

/**
 * Same validation shape as `parseMonitorForm` — see its note.
 * REFS addons/health-monitor/actions.ts
 */
export function parseChannelForm(fd: FormData): FormResult<ChannelInput> {
  const name = text(fd, "name");
  if (!name) return { ok: false, error: "Give the channel a name." };
  if (name.length > 80) return { ok: false, error: "That name is too long." };

  const kind = text(fd, "kind") as ChannelKind;
  if (!CHANNEL_KINDS.has(kind)) return { ok: false, error: "Choose where alerts should go." };

  const url = text(fd, "url");
  const secret = text(fd, "secret");
  const topic = text(fd, "topic");
  const recipients = text(fd, "recipients");

  const needsUrl: ChannelKind[] = ["webhook", "discord", "slack", "gotify", "homeassistant"];
  if (needsUrl.includes(kind) && !url) {
    return { ok: false, error: "That kind of channel needs a URL." };
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "The URL must start with http:// or https://" };
  }
  if (kind === "telegram" && (!secret || !topic)) {
    return { ok: false, error: "Telegram needs a bot token in Secret and a chat id in Topic or chat." };
  }
  if (kind === "ntfy" && !topic) return { ok: false, error: "ntfy needs a topic." };
  if (kind === "gotify" && !secret) return { ok: false, error: "Gotify needs an application token in Secret." };

  const config: Record<string, unknown> = {};
  if (kind === "email") {
    const list = recipients.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.some((a) => !a.includes("@"))) return { ok: false, error: "That doesn't look like an email address." };
    if (list.length) config.to = list;
  } else if (kind === "telegram") {
    config.botToken = secret;
    config.chatId = topic;
  } else if (kind === "ntfy") {
    config.topic = topic;
    if (url) config.url = url;
    if (secret) config.token = secret;
  } else if (kind === "gotify") {
    config.url = url;
    config.token = secret;
  } else {
    config.url = url;
    if (secret) {
      config.secretHeader = "Authorization";
      config.secret = secret;
    }
  }

  return { ok: true, value: { name, kind, config } };
}
