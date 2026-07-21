import type { ChannelKind, MonitorKind } from "./types";

/**
 * Turning form fields into validated values, and the choices the forms offer.
 *
 * Pure functions with no imports beyond types, so the rules that decide what is a valid
 * monitor are testable without a database or a browser — and so the same rules can be
 * reused if a monitor ever arrives from somewhere other than a form.
 */

/** What a person picks from the "what to check" menu, in plain language. */
export const KIND_CHOICES: { value: MonitorKind; label: string; hint: string }[] = [
  { value: "http", label: "Website or web app", hint: "Loads a URL and checks it answers properly" },
  { value: "tcp", label: "Port", hint: "Opens a connection to a port — databases, SSH, game servers" },
  { value: "ping", label: "Ping", hint: "For a device that answers nothing else — a router or a printer" },
  { value: "dns", label: "Domain name", hint: "Checks a name still resolves to an address" },
  { value: "tls", label: "HTTPS certificate", hint: "Warns you before a certificate expires" },
];

/** Intervals worth offering. Seconds under the hood, sentences on screen. */
export const INTERVAL_CHOICES: { value: number; label: string }[] = [
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
  { value: 3600, label: "Every hour" },
  { value: 21600, label: "Every 6 hours" },
  { value: 86400, label: "Once a day" },
];

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

/** A readable id derived from the name, e.g. "My NAS box" → "my-nas-box". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "monitor";
}

/** Make a slug unique against ids already in use, by appending -2, -3, … */
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
};

/**
 * Validate what someone typed into the monitor form.
 *
 * The messages are the point: they say what to do, not what went wrong internally,
 * because this is the only feedback the person gets.
 */
export function parseMonitorForm(fd: FormData): FormResult<MonitorInput> {
  const name = text(fd, "name");
  if (!name) return { ok: false, error: "Give the monitor a name." };
  if (name.length > 80) return { ok: false, error: "That name is too long — keep it under 80 characters." };

  const kind = text(fd, "kind") as MonitorKind;
  if (!KINDS.has(kind)) return { ok: false, error: "Choose what to check." };

  const target = text(fd, "target");
  if (!target) return { ok: false, error: "Enter an address to check." };
  if (target.length > 500) return { ok: false, error: "That address is too long." };

  if (kind === "http") {
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
  if (intervalSec !== null && (intervalSec < 10 || intervalSec > 86_400)) {
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
    },
  };
}

/** Build the per-kind `config` blob from the validated form values. */
export function monitorConfigFrom(input: MonitorInput): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (input.kind === "http") {
    if (input.expectStatus) config.expectStatus = input.expectStatus;
    if (input.insecureTls) config.insecureTls = true;
  }
  if (input.kind === "tls" && input.insecureTls) config.insecureTls = true;
  return config;
}

export type ChannelInput = {
  name: string;
  kind: ChannelKind;
  config: Record<string, unknown>;
};

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
