# Health monitoring

Watches the services you care about and tells you when one stops answering. Runs checks on a
schedule, keeps a history, and sends an alert when something goes down and again when it recovers.

- **Module id:** `health-monitor`
- **Version:** 1.0.0-beta.1 (unpublished — see [Status](#status))
- **Minimum JonDash version:** 1.4.0
- **Permissions requested:** `network:outbound`, `crypto:use`, `email:send`, `audit:write`
- **Visibility:** admins only (`adminOnly: true`)

---

## What it does

### Check types

| Type   | What it does                                                                       |
| ------ | ---------------------------------------------------------------------------------- |
| `http` | Requests a URL and records the status code plus a timing breakdown: DNS, TCP connect, TLS handshake, time to first byte, total. Follows redirects and judges the destination; asserts an expected status or range. |
| `tcp`  | Opens a TCP connection to a host and port and records the connect time. For databases, SSH, game servers — anything that isn't HTTP, and the way to ask whether a host is alive. |
| `dns`  | Resolves a name within a time limit. By default it resolves the way an application would — through the operating system — so a Pi-hole, a VPN or a hosts entry is honoured. Ask for a specific `recordType` or `expectValue` and it queries the configured DNS server directly instead. |
| `tls`  | Reads the certificate a host presents and reports days until expiry, issuer and hostname match. |

There is deliberately **no ICMP ping** — see [No ping](#no-ping).

### The engine

Each monitor carries its own interval, timeout, retry count and slow-response budget. A single check
failing does not raise an alert — a monitor only changes state after its failures (or successes) are
confirmed `retries` times in a row, so one dropped packet doesn't page you.

There are three healthy-ish states, not two: **up**, **degraded** (answering, but slower than its
budget) and **down**. Monitors can also be paused, or covered by a maintenance window so planned work
stays quiet.

Checks are driven by a single in-process poller — one timer per server process, `unref`'d so it never
holds the process open, and a cap on how many checks run at once. Enabling the module starts it
immediately, so switching it on is enough to start monitoring. After a JonDash restart the timer only
starts when the module's code is next loaded by a request; the widget and page run anything overdue
when they render, which closes that gap on first view. See [Known limits](#known-limits).

### History and retention

Every check is stored. Raw results older than `rollupAfterDays` are folded into hourly summaries
(count, failures, average, 95th percentile, max) and the raw rows dropped; summaries older than
`retentionDays` are deleted. The database does not grow without bound.

Outages are recorded as incidents with a start, an end, a duration and a reason, and are kept after
recovery so you can see what happened last week.

### Alerts

An alert fires on a **confirmed state change** — down, recovered, degraded, or a certificate nearing
expiry. Each alert names the monitor, what failed, how long it has been failing, and the runbook note
attached to that monitor if it has one.

Channels:

| Channel          | Transport                                                        |
| ---------------- | ---------------------------------------------------------------- |
| `email`          | JonDash's own configured mailer (**primary** — see [Status](#status)) |
| `webhook`        | JSON POST to any URL, with custom headers and an optional secret  |
| `discord`        | Discord webhook payload                                           |
| `slack`          | Slack incoming-webhook payload                                    |
| `telegram`       | Bot `sendMessage` API                                             |
| `ntfy`           | ntfy topic publish, with priority and tags                        |
| `gotify`         | Gotify message API                                                |
| `homeassistant`  | Home Assistant webhook trigger                                    |

Noise control, all configurable: a re-notify interval while something stays down, a hard cap on alerts
per hour, a quiet period for a few minutes after JonDash itself restarts (so an update doesn't look
like an outage), and parent/child monitors — if the router is down, its children don't each send their
own alert.

### On the dashboard

The widget shows one line when everything is up and detail when it isn't: per-monitor status, latest
latency, and a 24-hour strip where each bar is an hour and failures show red. The module's own page at
`/m/health-monitor` lists every monitor and, per monitor, its uptime over 24 hours / 7 days / 30 days,
average and 95th-percentile latency, a latency sparkline, recent checks and the incident log. All of it
is drawn as plain SVG — no charting library, no new dependencies.

---

## Settings

Rendered by the framework under **Admin → Modules → Health monitoring**.

| Key                    | Type    | Default | Meaning                                                        |
| ---------------------- | ------- | ------- | -------------------------------------------------------------- |
| `configJson`           | string  | `{}`    | **Interim** — the monitors and channels, as JSON. See [Configuring](#configuring). |
| `pollSeconds`          | number  | 15      | How often the scheduler looks for due checks.                   |
| `defaultIntervalSec`   | number  | 60      | Default gap between checks for a monitor that doesn't set one.  |
| `defaultTimeoutMs`     | number  | 10000   | Default per-check timeout.                                      |
| `defaultRetries`       | number  | 2       | Confirmations before a state change counts.                     |
| `degradedMs`           | number  | 2000    | Default slow-response budget; over this is "degraded".          |
| `maxConcurrent`        | number  | 4       | Checks allowed to run at the same time.                         |
| `rollupAfterDays`      | number  | 2       | Age at which raw results become hourly summaries.               |
| `retentionDays`        | number  | 30      | Age at which summaries are deleted.                             |
| `quietAfterRestartMin` | number  | 3       | Alerts suppressed for this long after the module loads.         |
| `renotifyMin`          | number  | 30      | Repeat an alert this often while a monitor stays down. 0 = once. |
| `maxAlertsPerHour`     | number  | 12      | Hard ceiling across all channels.                               |
| `certWarnDays`         | string  | `30,14,7` | Days before certificate expiry to warn.                       |
| `notifyEmails`         | string  | —       | Comma-separated recipients for the email channel.               |
| `alertsEnabled`        | boolean | `true`  | Master switch. Off = checks still run, nothing is sent.         |

No setting is marked secret. Channel credentials are **not** stored in settings — they live encrypted
in the module's own table (see below).

---

## Data

Every table is namespaced `mod_health_monitor_*` and created by `migrations/001_init.sql`. The
framework drops all of them, plus the settings above, on uninstall. Nothing is written anywhere else.

| Table           | Holds                                                                |
| --------------- | -------------------------------------------------------------------- |
| `monitors`      | One row per monitored thing: type, target, timings, current state.    |
| `results`       | Individual check results — state, latency, code, phase timings.       |
| `rollups`       | Hourly summaries that replace old raw results.                        |
| `incidents`     | Outages: start, end, duration, reason, how often it has been notified.|
| `channels`      | Notification destinations. `configEnc` is **encrypted** (see below).  |
| `routes`        | Which channels a monitor alerts through.                              |
| `notifications` | A log of what was sent where, used to enforce the rate limits.        |
| `maintenance`   | One-off and weekly quiet windows.                                     |

### Secrets

A webhook URL is a credential — anyone holding a Discord or Slack webhook URL can post as you, and a
Telegram bot token is a full bot login. All channel configuration is therefore serialised and encrypted
with `ctx.crypto` before it is written, and decrypted only when an alert is being sent. Nothing
sensitive is rendered to the browser: the UI shows a channel's kind and name, never its URL or token.

---

## Permissions, and why each one

| Permission         | Why it is needed                                                                   |
| ------------------ | ----------------------------------------------------------------------------------- |
| `network:outbound` | The entire point of the module: it contacts the targets you configure, and posts alerts to the notification services you configure. Nothing else. This includes raw TCP, DNS and TLS connections, because a status code is not the only thing worth checking. |
| `crypto:use`       | To encrypt channel credentials at rest, as above. It is used only for that.          |
| `email:send`       | To send outage emails through the mailer you already configured. The module never reads mail, and never sends anything except alerts to the addresses in `notifyEmails`. |
| `audit:write`      | Records configuration changes and alert failures in JonDash's audit log, so a silent notifier shows up somewhere.  |

It does **not** request access to your user accounts, your sessions, your files, or any other core
data — and it does not read your service tiles. Monitors are the module's own; deleting a service tile
never touches them, and uninstalling the module leaves your dashboard exactly as it was.

### What it connects to

Only the targets you enter, and the notification endpoints you enter. There is no telemetry, no
update check, no call to any address the module chose for you.

Private and LAN addresses are allowed on purpose — monitoring `192.168.1.10:8006` is the normal case
for a self-hosted dashboard. The safeguards are the ones that matter for an admin-configured tool:
`http` and `https` schemes only, a hard timeout on every check, a cap of five redirects, no cookies or
credentials sent, no `file://`, and responses are read up to a size cap and never executed or rendered.

### No ping

ICMP needs either a raw socket — elevated privileges plus a native dependency — or the operating
system's `ping` binary. Modules may not spawn processes (`child_process` is refused at install), and
adding a native dependency is out, so **this module cannot do ICMP** and does not pretend to.

Use a `tcp` check against a port the host answers on; for most things worth monitoring, one exists.
Real ICMP would have to be offered by the framework as a capability, where the hardening lives in
trusted code rather than in every module that wants it.

### Hostile input

Anything a monitored endpoint returns is treated as hostile: a TXT record, a certificate's issuer
field and a socket error message all end up in the interface, in an email and in a webhook body. Every
check result is length-capped and stripped of control characters at a single boundary before it is
stored, so a monitored host cannot forge lines in an alert. Response bodies are read only to time the
download — never parsed, never rendered, never executed.

---

## Configuring

The framework does not yet give modules a safe way to handle form submissions, so v1 has **no
add/edit screens**. Until that lands, monitors and channels are declared in the `configJson` setting
and reconciled into the database automatically when it changes. The format is documented in
[`CONFIG.md`](CONFIG.md).

This is deliberately temporary. When the framework provides a module-action helper, the same data
gains a proper UI and `configJson` becomes an import/export field instead — the tables and the check
engine do not change.

---

## Status

Two features are specified, built up to the boundary, and **inactive** until the core app ships the
capability each needs. Both were accepted and are being built:

1. **Email alerts** need `ctx.email.send(…)`. The email channel is implemented and starts working the
   moment that exists; until then it reports itself unavailable rather than failing silently, and
   webhook channels are unaffected.
2. **Add/edit screens** need `moduleAction(moduleId, fn)`. Until then, configuration is the JSON
   setting described in [Configuring](#configuring).

Also pending: the poller currently captures a request context, which misattributes background audit
entries; it moves to `systemModuleContext("health-monitor")` as soon as that lands.

Deferred, and shaped by the rules for unauthenticated routes (own permission, off by default, its own
rate limit): a heartbeat / dead-man's-switch monitor and a public status page.

### Install-time verification

The installer statically scans a module and refuses anything that reaches past what it declared. This
module is written to pass: no `child_process`, no `eval`, no `new Function`, no computed dynamic
imports, no filesystem access, and no direct import of core internals — the only thing it imports from
the app is the module contract's own types. Its raw-socket use (`node:net`, `node:tls`, `node:dns`,
`node:http`/`https`) is covered by the declared `network:outbound`, and the permissions in `module.ts`
must match its `addons.json` entry exactly.

## Known limits

- **Cold start after a restart.** Enabling the module starts the poller, but a JonDash restart clears
  it, and a module's code is only loaded when something asks for it. So after a restart nothing is
  checked until someone opens JonDash — at which point overdue checks run immediately. A scheduler
  owned by the app would remove this.
- **One process.** The poller assumes a single server process, which is how JonDash runs.
- **Audit attribution.** Background work runs with the context of whichever admin's request started the
  poller, so an audit entry written by a later tick names that person. A system-scoped context would
  fix it; nothing is granted beyond what they already had.
- **No ICMP.** A host that answers nothing but ping cannot be monitored. See [No ping](#no-ping).
- **Redirect destinations are followed**, including to a different host. Targets are admin-configured
  and private addresses are allowed on purpose, so a monitored endpoint can point the check somewhere
  else on your network. The chain is capped at five hops and restricted to http(s), and nothing from
  the response is stored beyond its status and timing.
- **Not a sandbox.** Modules compile into JonDash and run in its process with its privileges.
  Permissions are disclosure, consent and install-time checking — not containment. This module is
  written as trusted code: it never evaluates configuration, never fetches and runs remote code, and
  treats every monitored endpoint as hostile.

## Testing

1. Put the folder at `modules/health-monitor/`, rebuild, and enable it in **Admin → Modules**.
2. Paste a monitor into `configJson` — a URL you control, and one you know is down.
3. Watch the widget: the working one goes green within an interval, the broken one goes red after its
   retries are exhausted, and an incident opens.
4. Add a webhook channel and confirm the alert arrives, then confirm the recovery alert.
5. Disable the module: the widget and page disappear and the base dashboard is unchanged.
6. Uninstall: every `mod_health_monitor_*` table and every setting is gone.

## Version history

| Version      | Notes                                                              |
| ------------ | ------------------------------------------------------------------ |
| 1.0.0-beta.1 | First build. Four check types, scheduler, incidents, eight notification channels, widget and page. ICMP ping dropped (modules may not spawn processes). Email and edit screens pending core support. Ships 19 tests covering the check engine; verified end to end against a real JonDash 1.4.0-beta.2. |
