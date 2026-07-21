# JonDash addons

The official **module source** for [JonDash](https://github.com/jontiadcock/JonDash) — a repository of
optional add-on modules (a dashboard widget, its own page, its own settings) that plug into JonDash
**without changing the base app**. Disable or remove a module and JonDash behaves exactly as before.

> ⚠️ **Early days.** JonDash's module framework is in active development. The framework core shipped
> (v1.4.0-beta.1); **installing modules from a source repo like this arrives in a later JonDash update**
> (MOD-01 Phase 2). This repo is the scaffold that installer will read.

## Using this source (once JonDash supports it)

In JonDash: **Admin → Settings → Modules → add source** → paste this repo's URL, then browse and install a
module. Before enabling, JonDash shows the **permissions** the module requests and asks you to approve them.
Each module carries its **own version** and updates **independently** of the JonDash base app.

## Repository layout

```
addons.json          # the source manifest (what modules this source offers)
addons/<module-id>/  # one folder per module
  module.ts          # the ModuleDefinition (required)
  MODULE.md          # human spec: what it does, settings, data, permissions, version
  widget.tsx         # optional dashboard widget
  page.tsx           # optional page (served at /m/<id>/…)
  migrations/        # optional NNN_name.sql for the module's own mod_<id>_* tables
```

## The manifest (`addons.json`)

```jsonc
{
  "manifestVersion": 1,
  "name": "JonDash official addons",
  "modules": [
    {
      "id": "example",              // stable, lowercase-kebab = the addons/<id> folder
      "name": "Example",
      "description": "One line.",
      "latest": "1.0.0",           // newest published version (semver)
      "minAppVersion": "1.5.0",    // minimum JonDash version required
      "permissions": ["network:outbound"],   // what it will ask the admin to approve
      "path": "addons/example"      // where the module lives in this repo
    }
  ]
}
```

*(Format v1 — the exact fields the installer consumes are finalized with JonDash's Phase 2 installer; this
scaffold is the target.)*

## Versioning & channels

Each add-on has its **own version** and its own **stable / beta** channel, independent of other add-ons and
of JonDash. Channels are branches (`main` = stable, `beta` = beta); every published version is tagged
`<id>/v<version>`. In JonDash you opt a **specific module** into beta from that module's settings. The full
scheme (branches, tags, manifest, publishing workflow) is in **[VERSIONING.md](VERSIONING.md)**.

## Building your own module

You don't have to use this repo — you can build a module and **import it directly** into JonDash, or host
your own source repo. Full contract, the permission list + etiquette, testing, and a **paste-in AI prompt**
that generates a module to your spec are in JonDash's author guide:
**[docs/MODULES-AUTHORING.md](https://github.com/jontiadcock/JonDash/blob/beta/docs/MODULES-AUTHORING.md)**.

## License

**Personal-use** — see [LICENSE](LICENSE) (in line with the main JonDash repo). Free for personal,
non-commercial use; no selling or redistribution. If you build an add-on, **publish it in your own public
repository and let the author know via GitHub** so it can be linked.
