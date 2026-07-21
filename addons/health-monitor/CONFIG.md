# Configuration format

Monitors, notification channels and maintenance windows are declared as JSON in the module's
**Monitors and channels (JSON)** setting (`configJson`), under **Admin → Modules → Health monitoring**.
Saving it applies the change within one scheduler tick.

This is temporary. Add/edit screens are the next release's work; when they arrive the same data gets a
proper UI and this field becomes import/export. The shape below is the contract either way.

Rules that keep a bad paste from breaking a working setup:

- The document is validated as a whole. If anything is invalid, **nothing** is applied and the previous
  configuration keeps running — the error is shown at the top of `/m/health-monitor`.
- Ids are lowercase letters, digits, `-` or `_`, and are how a monitor's history is tracked. Renaming an
  id is treated as deleting one monitor and creating another.
- Anything you remove from the document is removed from the database, including its history.

## Shape

```jsonc
{
  "monitors": [
    {
      "id": "router",
      "name": "Router",
      "kind": "ping",
      "target": "192.168.1.1",
      "intervalSec": 60,
      "channels": ["ops-email"]
    },
    {
      "id": "proxmox",
      "name": "Proxmox",
      "kind": "http",
      "target": "https://192.168.1.10:8006",
      "parentId": "router",
      "config": { "expectStatus": "2xx", "insecureTls": true },
      "channels": ["ops-email", "discord"]
    }
  ],
  "channels": [
    { "id": "ops-email", "name": "Ops email", "kind": "email" },
    { "id": "discord", "name": "Discord", "kind": "discord", "config": { "url": "https://discord.com/api/webhooks/…" } }
  ],
  "maintenance": [
    { "id": "sunday-patching", "kind": "weekly", "daysMask": 1, "startMin": 180, "durationMin": 120 }
  ]
}
```

## Monitor fields

| Field         | Required | Meaning                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `id`          | yes      | Stable identifier. Its history follows it.                              |
| `name`        | yes      | What appears on the dashboard.                                          |
| `kind`        | yes      | `http`, `tcp`, `ping`, `dns` or `tls`.                                  |
| `target`      | yes      | A full URL for `http`; a hostname or IP for everything else.            |
| `port`        | for `tcp` | Port number. `tls` defaults to 443.                                    |
| `intervalSec` | no       | Seconds between checks. Defaults to the module setting.                 |
| `timeoutMs`   | no       | Per-check timeout. Defaults to the module setting.                      |
| `retries`     | no       | Consecutive failures before it counts as down.                          |
| `degradedMs`  | no       | Slower than this counts as degraded.                                    |
| `parentId`    | no       | Another monitor's id. While the parent is down, this one stays quiet.   |
| `runbook`     | no       | A note or link included in its alerts.                                  |
| `enabled`     | no       | `false` keeps the monitor and its history but stops checking it.        |
| `channels`    | no       | Channel ids this monitor alerts through. No channels means no alerts.   |
| `config`      | no       | Per-kind extras, below.                                                 |

### `config` by kind

| Kind   | Options                                                                          |
| ------ | --------------------------------------------------------------------------------- |
| `http` | `expectStatus` (`200`, `"2xx"`, `"200-204"`; default any 2xx/3xx), `method`, `headers`, `insecureTls` |
| `dns`  | `recordType` (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`), `expectValue`             |
| `tls`  | `certWarnDays` (default from settings), `insecureTls`                             |

`insecureTls` accepts a self-signed or untrusted certificate. It is off by default and only worth
turning on for a LAN service you know issues its own certificate.

**A `dns` monitor with no `config` asks the operating system to resolve the name** — the same path your
other software uses, so a Pi-hole, a VPN or a hosts entry is respected. Setting `recordType` or
`expectValue` switches it to querying your configured DNS server directly, which is what you want when
you are checking a specific record rather than "can this name be resolved at all".

## Channel fields

`id`, `name`, `kind`, optional `enabled`, and a `config` whose contents depend on the kind. Channel
configuration is **encrypted** before it is stored, and never rendered back to the browser.

| Kind            | `config`                                                                  |
| --------------- | -------------------------------------------------------------------------- |
| `email`         | `to` (array of addresses). Omit to use the module's recipient setting.     |
| `webhook`       | `url`, optional `headers`, optional `secretHeader` + `secret`               |
| `discord`       | `url` — a Discord webhook URL                                              |
| `slack`         | `url` — a Slack incoming-webhook URL                                       |
| `telegram`      | `botToken`, `chatId`                                                       |
| `ntfy`          | `topic`, optional `url` (defaults to `https://ntfy.sh`), optional `token`  |
| `gotify`        | `url`, `token`                                                             |
| `homeassistant` | `url` — a Home Assistant webhook URL                                       |

## Maintenance windows

Alerts are suppressed inside a window; checks still run and history is still recorded.

| Field         | Meaning                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| `id`          | Stable identifier.                                                           |
| `monitorId`   | Omit to cover every monitor.                                                 |
| `kind`        | `once` or `weekly`.                                                          |
| `startsAt` / `endsAt` | For `once`: ISO timestamps.                                          |
| `daysMask`    | For `weekly`: bitmask, Sunday = 1, Monday = 2, Tuesday = 4 … Saturday = 64.  |
| `startMin`    | For `weekly`: minutes past local midnight. `180` = 03:00.                    |
| `durationMin` | For `weekly`: how long the window lasts.                                     |

## A complete starting point

```json
{
  "monitors": [
    { "id": "router", "name": "Router", "kind": "ping", "target": "192.168.1.1", "intervalSec": 120, "channels": ["ops"] },
    { "id": "nas", "name": "NAS web UI", "kind": "http", "target": "http://192.168.1.20:5000", "parentId": "router", "channels": ["ops"] },
    { "id": "db", "name": "Database port", "kind": "tcp", "target": "192.168.1.20", "port": 5432, "parentId": "router", "channels": ["ops"] },
    { "id": "site-cert", "name": "Site certificate", "kind": "tls", "target": "example.com", "intervalSec": 21600, "channels": ["ops"] },
    { "id": "dns", "name": "Public DNS", "kind": "dns", "target": "example.com", "config": { "recordType": "A" }, "channels": ["ops"] }
  ],
  "channels": [
    { "id": "ops", "name": "Ops webhook", "kind": "webhook", "config": { "url": "https://example.com/hooks/health" } }
  ]
}
```
