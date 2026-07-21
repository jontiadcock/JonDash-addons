import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import type { AlertEvent, ChannelRow, MonitorRow } from "./types";

/**
 * Alert delivery. One payload builder per service, all posted with `ctx.fetch` (i.e.
 * only when `network:outbound` was granted).
 *
 * Channel credentials — a Discord webhook URL, a Telegram bot token — are stored
 * encrypted and only decrypted here, at the moment of sending, via `ctx.crypto`.
 */

const SEND_TIMEOUT_MS = 10_000;

/**
 * Email goes through JonDash's own configured mailer, which the module reaches via a
 * capability the framework does not expose yet (`email:send` is declared and consented,
 * but `ctx.email` is not wired). This shape is what the module expects; until it appears
 * the email channel reports itself unavailable instead of failing quietly, and the other
 * channels are unaffected.
 */
type MailerCapability = {
  send(msg: { to: string; subject: string; text?: string; html?: string }): Promise<{ ok: boolean; error?: string }>;
};
type MaybeMailContext = ModuleContext & { email?: MailerCapability };

export type Alert = {
  event: AlertEvent;
  monitor: Pick<MonitorRow, "id" | "name" | "kind" | "target" | "runbook">;
  /** One line saying what happened, e.g. "HTTP 502" or "timed out after 10000ms". */
  detail: string;
  /** How long it has been in this state, in seconds, when that makes sense. */
  forSeconds?: number;
};

export type SendResult = { ok: boolean; error?: string };

const LABEL: Record<AlertEvent, string> = {
  down: "DOWN",
  up: "RECOVERED",
  degraded: "DEGRADED",
  cert: "CERTIFICATE",
  test: "TEST",
};

function duration(seconds?: number): string {
  if (!seconds || seconds < 1) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function alertTitle(a: Alert): string {
  return `[${LABEL[a.event]}] ${a.monitor.name}`;
}

export function alertBody(a: Alert): string {
  const lines = [
    `${a.monitor.name} (${a.monitor.kind}) — ${a.detail}`,
    `Target: ${a.monitor.target}`,
  ];
  const d = duration(a.forSeconds);
  if (d) lines.push(a.event === "up" ? `Was down for ${d}` : `Failing for ${d}`);
  if (a.monitor.runbook) lines.push(`Runbook: ${a.monitor.runbook}`);
  lines.push(`Time: ${new Date().toLocaleString()}`);
  return lines.join("\n");
}

/** Colour for the services that accept one (Slack attachment / Discord embed). */
function colour(event: AlertEvent): number {
  if (event === "up") return 0x22c55e;
  if (event === "degraded" || event === "cert") return 0xf59e0b;
  return 0xdc2626;
}

type ChannelConfig = Record<string, unknown>;

function str(cfg: ChannelConfig, key: string): string {
  const v = cfg[key];
  return typeof v === "string" ? v : "";
}

/** Decrypt a channel's stored configuration. Returns null if it can't be read. */
export function readChannelConfig(ctx: ModuleContext, channel: ChannelRow): ChannelConfig | null {
  try {
    const raw = ctx.crypto ? ctx.crypto.decrypt(channel.configEnc) : channel.configEnc;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ChannelConfig) : null;
  } catch {
    return null;
  }
}

async function post(
  ctx: ModuleContext,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<SendResult> {
  if (!ctx.fetch) return { ok: false, error: "network permission not granted" };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "channel URL must be http(s)" };
  try {
    const res = await ctx.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Deliver one alert through one channel. Never throws: a channel that is misconfigured
 * or unreachable returns an error that gets logged, and the other channels still fire.
 */
export async function sendAlert(
  ctx: ModuleContext,
  channel: ChannelRow,
  alert: Alert,
  fallbackEmails: string[],
): Promise<SendResult> {
  const cfg = readChannelConfig(ctx, channel);
  if (!cfg) return { ok: false, error: "channel configuration could not be read" };

  const title = alertTitle(alert);
  const body = alertBody(alert);

  switch (channel.kind) {
    case "email": {
      const mailer = (ctx as MaybeMailContext).email;
      if (!mailer) return { ok: false, error: "email capability not available in this JonDash version" };
      const recipients = Array.isArray(cfg.to) ? (cfg.to as string[]) : fallbackEmails;
      if (recipients.length === 0) return { ok: false, error: "no recipients configured" };
      const results = await Promise.all(
        recipients.map((to) => mailer.send({ to, subject: title, text: body })),
      );
      const failed = results.find((r) => !r.ok);
      return failed ? { ok: false, error: failed.error ?? "send failed" } : { ok: true };
    }

    case "webhook": {
      const headers: Record<string, string> = {};
      const secretHeader = str(cfg, "secretHeader");
      const secret = str(cfg, "secret");
      if (secretHeader && secret) headers[secretHeader] = secret;
      if (cfg.headers && typeof cfg.headers === "object") {
        for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
          if (typeof v === "string") headers[k] = v;
        }
      }
      return post(
        ctx,
        str(cfg, "url"),
        {
          event: alert.event,
          monitor: { id: alert.monitor.id, name: alert.monitor.name, kind: alert.monitor.kind, target: alert.monitor.target },
          detail: alert.detail,
          forSeconds: alert.forSeconds ?? null,
          runbook: alert.monitor.runbook ?? null,
          at: new Date().toISOString(),
        },
        headers,
      );
    }

    case "discord":
      return post(ctx, str(cfg, "url"), {
        embeds: [{ title, description: body, color: colour(alert.event), timestamp: new Date().toISOString() }],
      });

    case "slack":
      return post(ctx, str(cfg, "url"), {
        text: title,
        attachments: [{ color: alert.event === "up" ? "good" : alert.event === "down" ? "danger" : "warning", text: body }],
      });

    case "telegram": {
      const token = str(cfg, "botToken");
      const chatId = str(cfg, "chatId");
      if (!token || !chatId) return { ok: false, error: "bot token and chat id are required" };
      return post(ctx, `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        chat_id: chatId,
        text: `${title}\n\n${body}`,
        disable_web_page_preview: true,
      });
    }

    case "ntfy": {
      const server = str(cfg, "url") || "https://ntfy.sh";
      const topic = str(cfg, "topic");
      if (!topic) return { ok: false, error: "topic is required" };
      const token = str(cfg, "token");
      return post(
        ctx,
        server.replace(/\/+$/, ""),
        {
          topic,
          title,
          message: body,
          priority: alert.event === "down" ? 5 : alert.event === "up" ? 3 : 4,
          tags: [alert.event === "up" ? "white_check_mark" : "rotating_light"],
        },
        token ? { authorization: `Bearer ${token}` } : {},
      );
    }

    case "gotify": {
      const server = str(cfg, "url").replace(/\/+$/, "");
      const token = str(cfg, "token");
      if (!server || !token) return { ok: false, error: "server URL and app token are required" };
      return post(ctx, `${server}/message?token=${encodeURIComponent(token)}`, {
        title,
        message: body,
        priority: alert.event === "down" ? 8 : 4,
      });
    }

    case "homeassistant":
      return post(ctx, str(cfg, "url"), {
        event: alert.event,
        monitor: alert.monitor.name,
        target: alert.monitor.target,
        detail: alert.detail,
        title,
        message: body,
      });

    default:
      return { ok: false, error: `unknown channel type: ${String(channel.kind)}` };
  }
}

/** Whether a channel kind can actually deliver on this JonDash version. */
export function channelAvailable(ctx: ModuleContext, kind: string): boolean {
  if (kind === "email") return Boolean((ctx as MaybeMailContext).email);
  return Boolean(ctx.fetch);
}
