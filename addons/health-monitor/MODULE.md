# Health monitoring

Watches the services you care about and tells you when one stops answering. Runs checks on a
schedule, keeps a history, and sends an alert when something goes down and again when it recovers.

- **Module id:** `health-monitor`
- **Version:** 0.0.4-beta.1
- **Minimum JonDash version:** 1.4.0-beta.11
- **Permissions requested:** `network:outbound`, `crypto:use`, `email:send`, `audit:write`
- **Visibility:** admins only (`adminOnly: true`)

---

## What it does

### Check types

| Type   | What it does                                                                       |
| ------ | ---------------------------------------------------------------------------------- |
| `http` | Requests a URL and records the status code plus a timing breakdown: DNS, TCP connect, TLS handshake, time to first byte, total. Follows redirects and judges the destination; asserts an expected status or range. |
| `tcp`  | Opens a TCP connection to a host and port and records the connect time. For databases, SSH, game servers — anything that isn't HTTP. |
| `ping` | ICMP round-trip time. For a device that answers nothing else — a router, a switch, a printer. |
| `dns`  | Resolves a name within a time limit. By default it resolves the way an application would — through the operating system — so a Pi-hole, a VPN or a hosts entry is honoured. Ask for a specific `recordType` or `expectValue` and it queries the configured DNS server directly instead. |
| `tls`  | Reads the certificate a host presents and reports days until expiry, issuer and hostname match. |

Ping is performed by JonDash itself rather than by this module — see [Ping](#ping).

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

The widget leads with whatever needs attention, then fills up to four rows and says how many are left,
so it stays readable when a user resizes it down to a single cell. Each row is a status dot, the latest
response time and a 24-hour strip where every bar is an hour and failures show red.

The module page shows the same list in more detail, and each check has its own page: uptime over 24
hours, 7 days and 30 days, typical and 95th-percentile response times, a latency trace, its outage
history and its recent checks. All drawn as plain SVG — no charting library, no new dependencies. None
of it has any controls; see [Configuring](#configuring).

---

## Settings

Rendered by the framework under **Admin → Modules → Health monitoring**.

These are defaults and safety limits. **Monitors and alert destinations are not set up here** — they
live on the module's own page; see [Configuring](#configuring).

| Key                    | Type    | Default | Meaning                                                        |
| ---------------------- | ------- | ------- | -------------------------------------------------------------- |
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
| `configJson`           | text    | —       | Optional bulk import. Adds and updates only; never deletes.     |

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

### Ping

ICMP needs the operating system's `ping` binary, and modules may not spawn processes — so JonDash
performs the ping itself and this module only asks for the result. The host validation and the
fixed argument list that make that safe live once, in the app, instead of being copied into every
module that wants to ping something.

A ping monitor is `up` when a reply comes back, `down` when nothing does, and reports a failed check
(rather than crashing) if the app refuses the host.

### Hostile input

Anything a monitored endpoint returns is treated as hostile: a TXT record, a certificate's issuer
field and a socket error message all end up in the interface, in an email and in a webhook body. Every
check result is length-capped and stripped of control characters at a single boundary before it is
stored, so a monitored host cannot forge lines in an alert. Response bodies are read only to time the
download — never parsed, never rendered, never executed.

---

## Configuring

**Looking and changing are separate places.** `/m/health-monitor` and the dashboard widget show status
and history and contain no controls at all — a dashboard can be left open on a wall without a stray
click reconfiguring anything. Everything that changes something lives under **Manage checks**
(`/m/health-monitor/settings`), reached from the button on the page.

**To add a check:** Manage checks → *Add a check*. Pick the kind first — *HTTPS / website check*,
*Ping check*, *Port check*, *DNS check* or *SSL certificate check* — and the rest of the form follows
it: the address box is relabelled to suit, a port appears only where one is meaningful, and
HTTP-specific options only show for a website check. It runs immediately on save, so a wrong address
tells you in seconds. Timeouts, retries, a dependency and a note are under *More options*, each
falling back to a sensible default.

**To be told when it breaks:** on the same page, add a destination under *Where alerts go*, send it a
test, then tick it on the checks that should use it. A check with no destination records outages but
tells nobody.

**To change, pause or remove one:** Manage checks → *Change*. The same form edits it. Untick *Checking
is switched on* to pause without losing the history; *Delete this check* asks first and takes the
history with it. *Check now* on each row runs it on demand.

**Defaults and limits** — how long to wait, how many failures before alerting, how long history is
kept — are in **Admin → Modules → Health monitoring**, along with an optional bulk import for
restoring a saved configuration ([`CONFIG.md`](CONFIG.md)). That import **only adds and updates; it
never deletes**, so an old copy can't undo what you set up in the interface.

---

## Status

Everything described above works, and is verified by actually running it rather than by inspection.

Deferred, and shaped by the rules for unauthenticated routes (own permission, off by default, its own
rate limit): a heartbeat / dead-man's-switch monitor and a public status page.

If email isn't configured in JonDash yet, an email channel records a clear failure against that alert
and any webhook channels still deliver — the alert is never lost silently.

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
- **Ping needs a JonDash that provides it** (1.4.0-beta.3 or later). On an older build a ping monitor
  reports that the app can't run the check, rather than silently claiming the host is down.
- **Redirect destinations are followed**, including to a different host. Targets are admin-configured
  and private addresses are allowed on purpose, so a monitored endpoint can point the check somewhere
  else on your network. The chain is capped at five hops and restricted to http(s), and nothing from
  the response is stored beyond its status and timing.
- **Not a sandbox.** Modules compile into JonDash and run in its process with its privileges.
  Permissions are disclosure, consent and install-time checking — not containment. This module is
  written as trusted code: it never evaluates configuration, never fetches and runs remote code, and
  treats every monitored endpoint as hostile.

## Testing

1. Install it from a source, or put the folder at `modules/health-monitor/`, then enable it in
   **Admin → Modules**.
2. On the module's page, add two monitors: something you know works, and something you know doesn't —
   `http://127.0.0.1:9/` is reliably refused. Each is checked the moment you save it.
3. The broken one turns red once its failures are confirmed, an outage is recorded, and the widget
   moves it to the top.
4. On **Alerts**, add a destination and send it a test. Tick it on the broken monitor and confirm the
   alert arrives, then fix the target and confirm the recovery alert.
5. Disable the module: the widget and page disappear and the base dashboard is unchanged.
6. Uninstall: every `mod_health_monitor_*` table and every setting is gone.

## Version history

| Version      | Notes                                                              |
| ------------ | ------------------------------------------------------------------ |
| 0.0.4-beta.1 | Adding and changing checks moved into Admin → Modules → Health monitoring, using the framework's settings panel, with each check expanding in place to edit. The module page and widget stay display-only. Needs JonDash 1.4.0-beta.11. |
| 0.0.3-beta.1 | Looking and changing split apart: the module page and widget are now display-only, and everything that changes something moved to a Manage checks page. The add/edit form adapts to the kind of check chosen — plain-language options (HTTPS / website, Ping, Port, DNS, SSL certificate), the address box relabelled to match, and a port field only where it means something. Needs JonDash 1.4.0-beta.7. |
| 0.0.2-beta.1 | Set-up moved out of JSON and into the interface: add, edit, pause and delete monitors from the module page, manage alert destinations with a test-send button, and run a check on demand. Every setting reworded in plain English with an explanation. Bulk import kept for restoring a saved configuration, and it no longer deletes anything. Custom icon; the widget now leads with whatever needs attention and stays useful when resized small. Needs JonDash 1.4.0-beta.6. |
| 0.0.1-beta.1 | First release. Five check types, scheduler, incidents, retention, eight notification channels, widget and page. Ships 23 tests; verified end to end against a real JonDash 1.4.0-beta.3 — every check type run against live targets, alerts delivered, uninstall clean. Add/edit screens still to come. |
