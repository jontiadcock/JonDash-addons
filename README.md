# JonDash addons

The official **module source** for [JonDash](https://github.com/jontiadcock/JonDash) — optional add-ons
that plug into JonDash (a dashboard widget, their own pages, their own settings) **without changing the
base app**. Remove one and JonDash behaves exactly as before.

Installing from a source is live as of **JonDash 1.4.0**; **helpers** need **1.5.0**.

## The JonDash project

| Repository | What it is |
| ---------- | ---------- |
| **[JonDash](https://github.com/jontiadcock/JonDash)** | The dashboard itself — the app you install and run. |
| **[JonDash-addons](https://github.com/jontiadcock/JonDash-addons)** *(you are here)* | The official source of add-on **modules** and **helpers**, installed from inside JonDash. |
| **[JonDash-mcp](https://github.com/jontiadcock/JonDash-mcp)** | An [MCP](https://modelcontextprotocol.io) server so an AI assistant can read and manage your instance. |

---

## Installing from here

Nothing is cloned or downloaded by hand. In JonDash: **Admin → Modules → Browse modules**.
This source is already configured, so the list is populated on a fresh install. Tick one or more modules
and install them together — one rebuild and one restart for the batch.

Before anything is installed, JonDash shows the **permissions** each module requests in plain language and
asks you to approve them. Modules **update independently of JonDash** under **Admin → Updates**, and are
never updated automatically.

## What's here

| Module | What it does | Needs |
| ------ | ------------ | ----- |
| `health-monitor` | Watches your services with HTTP, TCP, ping, DNS and certificate checks; records uptime and response times; alerts by email or webhook when something goes down. | JonDash 1.5.0 |
| `backup-manager` | Copies folders you choose to another location — a network share, an external drive — on a schedule, keeps dated copies, tidies old ones away, and tells you when a backup stops being healthy. | JonDash 1.5.2 |
| `template` | **For developers** — a working module to copy when building your own. Installs to `modules/template`; read `MODULE.md` in that folder for the guide, and `AI-PROMPT.md` to have an AI build one for you. Safe to install and uninstall. | JonDash 1.4.1 |

| Helper | What it gives a module | Needs |
| ------ | ---------------------- | ----- |
| `scheduler` | Recurring background work that runs from **server start**, declared rather than started. | JonDash 1.5.0 |
| `filesystem` | Copying and archiving folders to another location, confined to folders an admin approved. Exposes no way to read a file's contents, and never copies JonDash's own secrets. | JonDash 1.5.2 |

Current versions per channel are in [`addons.json`](addons.json) on this branch — `main` is stable, `beta`
is pre-release. Each entry's `notes` field is what JonDash shows on the update card.

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
helpers/<helper-id>/   first-party helpers (see helpers/README.md)
scripts/               publish-time checks — run these before tagging a release
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
read-only under **Admin → Helpers**. There is no install, import or remove button.

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
