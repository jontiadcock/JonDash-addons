import "server-only";
import type { ModuleContext } from "@/lib/modules/types";
import type { Job } from "./store";

/**
 * Telling somebody a backup failed.
 *
 * A backup tool that fails silently is worth less than no backup tool, because it also
 * costs you the belief that you were covered. So this exists — but it is deliberately
 * *quiet* about success: nobody reads a nightly "it worked" email for long, and once they
 * stop reading it the failure gets missed too.
 *
 * Two transports, both opt-in per job, both best-effort. **A notification that fails must
 * never fail the backup** — the copy has already happened, and turning a working backup
 * into a failed one because an SMTP server was down would be its own bug.
 */

export type Alert = {
  job: Job;
  /** Short, factual subject line. */
  subject: string;
  /** Plain text. No HTML — this is machine-to-human, and half of it will be read on a phone. */
  body: string;
};

/**
 * The two things worth waking someone for.
 *
 * "Failed" is obvious. "Stale" is the one people forget to build and then wish they had:
 * a job that stopped running altogether raises nothing, because nothing failed. A disabled
 * schedule, a job deleted by accident, a server that never came back up — all silent.
 */
export function failureAlert(job: Job, detail: string): Alert {
  return {
    job,
    subject: `Backup failed: ${job.name}`,
    body: [
      `The backup job "${job.name}" did not finish successfully.`,
      "",
      detail,
      "",
      "Open JonDash and look at the run log for this job to see exactly which files were",
      "affected. Nothing at the destination has been removed.",
    ].join("\n"),
  };
}

export function staleAlert(job: Job, hours: number, lastSuccess: string | null): Alert {
  return {
    job,
    subject: `Backup hasn't run: ${job.name}`,
    body: [
      `The backup job "${job.name}" has not completed successfully in the last ${hours} hours.`,
      "",
      lastSuccess
        ? `The last successful run was ${lastSuccess}.`
        : "There is no record of it ever completing successfully.",
      "",
      "This is not a failure — it means nothing has been running at all. Check the job is",
      "still enabled, and that the destination is reachable.",
    ].join("\n"),
  };
}

/**
 * Send an alert by whatever the job has configured. Returns what actually went out, so the
 * caller can audit it.
 *
 * Every transport is wrapped: one broken webhook must not stop the email, and neither may
 * throw into the scheduler tick that called us.
 */
export async function send(ctx: ModuleContext, alert: Alert): Promise<string[]> {
  const sent: string[] = [];

  if (alert.job.notifyEmail && ctx.email) {
    try {
      await ctx.email.send({
        to: alert.job.notifyEmail,
        subject: alert.subject,
        text: alert.body,
      });
      sent.push(`email to ${alert.job.notifyEmail}`);
    } catch (e) {
      // Recorded rather than raised: the backup's outcome is already decided.
      await ctx.audit?.("backup.notify.failed", `email: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  if (alert.job.notifyWebhook && ctx.fetch) {
    try {
      const res = await ctx.fetch(alert.job.notifyWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A shape that suits both a chat webhook and a script: `text` renders in Slack and
        // friends, the named fields are there for anything parsing it.
        body: JSON.stringify({
          text: `${alert.subject}\n\n${alert.body}`,
          job: alert.job.name,
          jobId: alert.job.id,
          subject: alert.subject,
          at: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sent.push("webhook");
    } catch (e) {
      await ctx.audit?.("backup.notify.failed", `webhook: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  return sent;
}

/**
 * The weekly summary — the one message that is sent when nothing is wrong.
 *
 * Everything else here fires on failure, which leaves a gap people rarely notice: silence
 * means "all well" and "the alerting broke" equally. A digest that arrives on schedule turns
 * silence into evidence, because its absence is itself a signal.
 *
 * Sent module-wide rather than per job — nobody wants six emails — and deliberately leads
 * with anything that went wrong rather than a cheerful total.
 */
export type DigestLine = {
  name: string;
  runs: number;
  failures: number;
  lastSuccess: string | null;
  bytes: number;
  paused: boolean;
};

export function digest(lines: DigestLine[], days: number, formatBytes: (n: number) => string): Alert["body"] {
  const failing = lines.filter((l) => l.failures > 0);
  const stale = lines.filter((l) => !l.paused && l.runs === 0);
  const out: string[] = [];

  out.push(
    failing.length > 0
      ? `${failing.length} of your ${lines.length} backups had failures in the last ${days} days.`
      : `All ${lines.length} backups are healthy over the last ${days} days.`,
  );
  out.push("");

  for (const l of lines) {
    const bits = [
      l.paused ? "paused" : `${l.runs} run${l.runs === 1 ? "" : "s"}`,
      l.failures > 0 ? `${l.failures} FAILED` : null,
      l.bytes > 0 ? `${formatBytes(l.bytes)} copied` : null,
      l.lastSuccess ? `last success ${l.lastSuccess}` : "never succeeded",
    ].filter(Boolean);
    out.push(`  ${l.name} — ${bits.join(", ")}`);
  }

  if (stale.length > 0) {
    out.push("");
    out.push(`Not run at all in this period: ${stale.map((l) => l.name).join(", ")}.`);
  }

  out.push("");
  out.push("This is the scheduled summary. If it stops arriving, something is wrong with the");
  out.push("backups or with JonDash itself — that is rather the point of sending it.");
  return out.join("\n");
}

/**
 * Has this job already been shouted about recently?
 *
 * A job that is broken stays broken, and a tick that fires every minute would otherwise
 * send a thousand emails before anybody woke up. One alert per `everyHours` window is
 * enough to be noticed and few enough to still be read.
 */
export function shouldNotify(job: Job, now = new Date()): boolean {
  if (!job.notifyEmail && !job.notifyWebhook) return false;
  if (!job.lastNotifiedAt) return true;
  const since = now.getTime() - Date.parse(job.lastNotifiedAt);
  if (!Number.isFinite(since)) return true;
  return since >= Math.max(1, job.everyHours) * 3_600_000;
}
