# JonDash addons

The official **module source** for [JonDash](https://github.com/jontiadcock/JonDash) — optional add-ons
that plug into JonDash (a dashboard widget, their own pages, their own settings) **without changing the
base app**. Remove one and JonDash behaves exactly as before.

Installing from a source arrived in **JonDash 1.4.0** and helpers in **1.5.0**, but that is the
floor for the *mechanism*, not for what is here now — each add-on states the version it needs in
[`addons.json`](addons.json), and several need considerably more than 1.5.0. JonDash tells you: an
add-on that needs a newer build than yours is shown but not installable.

## The JonDash project

| Repository | What it is |
| ---------- | ---------- |
| **[JonDash](https://github.com/jontiadcock/JonDash)** | The dashboard itself — the app you install and run. |
| **[JonDash-addons](https://github.com/jontiadcock/JonDash-addons)** *(you are here)* | The official source of add-on **modules** and **helpers**, installed from inside JonDash. |

Two repositories, not three. Letting an AI assistant manage your instance over
[MCP](https://modelcontextprotocol.io) was once a separate server; it is now the **AI assistant
access** add-on in this repo, installed like any other. See
[`addons/mcp-server/CONNECTING.md`](addons/mcp-server/CONNECTING.md).

---

## Installing from here

Nothing is cloned or downloaded by hand. In JonDash: **Admin → Addons → Browse modules**.
This source is already configured, so the list is populated on a fresh install. Tick one or more modules
and install them together — one rebuild and one restart for the batch.

Before anything is installed, JonDash shows the **permissions** each module requests in plain language and
asks you to approve them. Modules **update independently of JonDash** under **Admin → Updates**, and are
never updated automatically.

## What's here

**Versions and the JonDash build each one needs are in [`addons.json`](addons.json)**, not repeated here
— this branch's copy is this channel's answer. That is deliberate: a version written into prose is a
sentence that becomes false without anyone touching it, and this table said "JonDash 1.5.2" for three
releases after it stopped being true.

| Module | What it does |
| ------ | ------------ |
| `health-monitor` | Watches your services with HTTP, TCP, ping, DNS and certificate checks; records uptime and response times; alerts by email or webhook when something goes down. |
| `backup-manager` | Copies folders you choose to another location — a network share, an external drive — on a schedule, keeps dated copies, tidies old ones away, and tells you when a backup stops being healthy. |
| `host-vitals` | Shows how the server itself is doing — CPU, memory, how full each disk is, uptime and temperatures — as a dashboard tile and a page. |
| `service-control` | Start, stop and restart the services you approve — a Windows service, a systemd unit — from your dashboard, without opening a terminal. |
| `docker-manager` | See the containers on this server and start, stop, pause and restart them. It cannot run commands inside a container, create or delete one, or touch images and volumes. |
| `mcp-server` | **AI assistant access.** Lets an assistant read and manage this server over MCP — including checking and applying JonDash updates and restarting it, if you give the key that level. Installing it opens no port. |
| `template` | **For developers** — a working module to copy when building your own. Installs to `modules/template`; read `MODULE.md` in that folder for the guide, and `AI-PROMPT.md` to have an AI build one for you. Safe to install and uninstall. |

| Helper | What it gives a module |
| ------ | ---------------------- |
| `scheduler` | Recurring background work that runs from **server start**, declared rather than started. |
| `filesystem` | Copying and archiving folders to another location, confined to folders an admin approved. Exposes no way to read a file's contents, and never copies JonDash's own secrets. |
| `system-metrics` | Reading how the server itself is doing — CPU, memory, disk usage, uptime and temperatures. Read-only: it reports numbers and changes nothing. |
| `host-services` | Seeing and controlling the services an admin approved — a Windows service, a systemd unit. Only those services, and only start, stop and restart. |
| `docker` | Seeing containers and starting, stopping, pausing and restarting them. Never the Docker socket, never `exec`. |
| `host-install` | Installing and removing software through the OS package manager, approved one package at a time. |
| `mcp` | Letting an AI assistant read this install, act on it, and look after the server — check and apply JonDash updates, restart, write a backup — as a service account an admin picks. The only helper here that holds a resource of its own: a listening socket. |

Each `addons.json` entry's `notes` field is what JonDash shows on the update card. `main` is stable,
`beta` is pre-release.

## Repository layout

```
addons.json            the source manifest for THIS branch's channel
addons/<module-id>/    one folder per module
  module.ts            the ModuleDefinition (required)
  MODULE.md            what it does, settings, data, permissions, version
  widget.tsx           optional dashboard widget (or ui/widget.tsx — organise as you like)
  page.tsx             optional page (served at /m/<id>/…)
  lib/*.ts             optional; keep pure logic here so it can be unit-tested
  tests/*.test.ts      optional Vitest tests — these ship, and are scanned like any other file
  migrations/          optional NNN_name.sql for the module's own mod_<id>_* tables
  widget.png etc.      optional screenshots, declared in addons.json — FLAT filenames,
                       max 4, 1 MB each; see VERSIONING.md before adding any
helpers/<helper-id>/   first-party helpers (see helpers/README.md)
scripts/               publish-time gates — run check-manifest.mjs, check-docs.mjs AND
                       check-screenshots.mjs before every push, not just before tagging
```

## Channels, versions and tags

- **Channels are branches:** `main` = stable, `beta` = pre-release. Each branch's `addons.json` is that
  channel's manifest.
- **Channels are per add-on**, not per repo — in JonDash you opt a *single module* into beta from its own
  settings, without moving JonDash itself onto beta.
- **Every add-on has its own semver**, independent of other add-ons and of JonDash.
- **Every published version is tagged `<id>/v<version>`**, and that tag is the downloadable artifact the
  installer fetches. Tags are immutable — publish a new version rather than moving one.

Full scheme, the manifest format, the `minAppVersion` rule and the publishing workflow:
**[VERSIONING.md](VERSIONING.md)**.

## Helpers

A **helper** is first-party shared capability that modules depend on for things modules are forbidden to
do themselves. Helpers are installable **only from this official source** (enforced by JonDash's
installer, not by convention), arrive automatically with the module that declares them, and are listed
read-only under **Admin → Addons → Shared capabilities**. There is no install, import or remove button.

Rules, current helpers and their specs: **[helpers/README.md](helpers/README.md)**.

## Building your own module

You don't have to publish here — you can build a module and **import its ZIP straight into JonDash**, or
host your own public source repo and add it by URL. The fastest start is to install the `template` module
above and copy it.

Full contract, permission list and etiquette, testing, and a **paste-in AI prompt** that generates a
module to your spec:
**[JonDash → docs/MODULES-AUTHORING.md](https://github.com/jontiadcock/JonDash/blob/main/docs/MODULES-AUTHORING.md)**.

## License

**Personal-use** — see [LICENSE](LICENSE), in line with the main JonDash repo. Free for personal,
non-commercial use; no selling or redistribution. If you build an add-on, **publish it in your own public
repository and let the author know via GitHub** so it can be linked.
