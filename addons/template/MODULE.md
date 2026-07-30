# Module template (for developers)

A complete, working JonDash module with one of everything, meant to be copied. Install it to see the
parts working together, then copy the folder and make it yours.

**This module is only useful if you are building a module.** It adds a small demonstration widget and
page and nothing else; uninstalling removes it completely. Ordinary users can ignore it.

- **Module id:** `template`
- **Version:** see [`addons.json`](../../addons.json) on this branch — stable on `main`, beta on `beta`.
  Deliberately not restated here: it drifts the moment a version is published.
- **Minimum JonDash version:** `1.8.0-beta.14` — the oldest build that genuinely works, not the newest
  available. Declared as the **pre-release** on purpose: semver ranks `1.8.0-beta.14` *below* `1.8.0`,
  so naming the pre-release is what lets it install on that series' betas too. Copy this habit — and
  copy how the number was arrived at: `beta.14` is the exact build in which the dashboard frame became
  a CSS container, found by checking the tags rather than guessing a round number. Too low and the
  widget installs somewhere its labels can never appear; too high and it is refused by builds that
  would have run it perfectly.
- **Permissions requested:** `audit:write` — see [Permissions](#what-you-get-without-asking-for-anything)
- **Depends on:** nothing. No helpers, no background work — copy this and you get a module that
  installs entirely on its own. Helpers are covered below as an option, not used here.
- **Where the files are:** `modules/template/` inside your JonDash folder, once installed
- **What it does:** keeps a list of short text items — one setting, its own table, a dashboard widget,
  a page, and add/delete forms that write through a Server Action

**In a hurry?** [`AI-PROMPT.md`](AI-PROMPT.md) next to this file is a self-contained prompt you can
paste into an AI agent, along with a description of what you want, to have it write a valid module for
you. It needs no other context.

---

## What's in the box

| File | Required | What it's for |
| ---- | -------- | ------------- |
| `module.ts` | **yes** | The contract: id, name, version, permissions, settings, and which UI parts exist. Start here. |
| `MODULE.md` | **yes** | This file. Yours should describe what the module does, its settings, its tables, and why it asks for each permission. |
| `widget.tsx` | no | The card on the main dashboard. |
| `page.tsx` | no | Your own page at `/m/<id>`. |
| `actions.ts` | no | Server Actions — how a form changes data. The one part worth reading twice. |
| `migrations/001_init.sql` | no | Your own `mod_<id>_*` tables. |
| `migrations/002_add_done.sql` | no | How to add a column in a LATER version. Read it before you ship a schema change. |
| `lib/store.ts` | no | Every query in one place. |
| `lib/text.ts` | no | Pure helpers, easy to test. |
| `lib/constants.ts` | no | The module id in one place. |
| `tests/text.test.ts` | no | Example test. **Ships with the module and is scanned like every other file** — see below. |
| `AI-PROMPT.md` | no | A paste-in prompt for having an AI agent write, test and verify a module. Delete it from your copy. |

> ### Your tests ship, and the installer scans them
>
> The whole folder is the artifact, so a test is not exempt from any rule. A test that imports
> `@/lib/db`, touches `node:fs`, or reads `process.env` makes the **whole module fail verification and
> refuse to install** — while still typechecking, linting, building and passing under Vitest. Nothing
> you normally run models the installer.
>
> Test **your own** logic: parsing, date maths, formatting, rendering your widget. A test that needs
> the app's internals — the real Prisma client, the real migration runner — is a maintainer's test of
> JonDash, not part of your module, and belongs outside the module folder entirely.
>
> This is not hypothetical: `backup-manager@0.1.1-beta.1` shipped exactly this mistake and could not be
> installed at all. Run the verifier before you call a module finished — see the AI prompt's step 4.

> ### Your widget draws its own card
>
> The dashboard hands a widget a grid cell and nothing else — no card, no padding, no heading. Wrap
> your top-level element in `className="card p-4"` and name your module inside it, or the widget
> renders as loose text on the page background beside properly framed ones, with nothing saying which
> module it belongs to. It builds and typechecks perfectly either way, so the **only** thing that
> catches it is opening the dashboard and looking — or a test that renders the component and asserts
> the markup.

> ### Your widget must fit any box, from 1×1 up (JonDash 1.8.0+)
>
> The dashboard is a grid of square units, the user can size your widget anywhere from **1×1 to full
> width**, and **the frame clips — it does not scroll.** Anything that doesn't fit is simply invisible,
> and nobody is told.
>
> Size against the **container**, never the viewport: the frame is a CSS `@container`, so use
> `@[6rem]:` and `@[8rem]:`, not `sm:`/`md:`/`lg:`. A 1×1 widget on a 4K monitor is still tiny, and
> `lg:` would hand it the roomy layout. Core's own service tiles change shape at those two widths —
> match them and a mixed dashboard reflows as one system instead of raggedly. `widget.tsx` in this
> module is the worked example; copy its structure.
>
> **If your widget shows a list, do not write `items.slice(0, 6)`.** A constant row count was picked
> for one box size and is wrong at every other — clipped when small, half-empty when large. Show the
> most important rows first and let the count follow the container. Keep **every row exactly one
> line**: a row that can wrap to two makes the visible count wrong at every size, and a bar or
> sparkline on its own line is the usual culprit — overlay it instead.

> ### The 1×1 form: one convention, so a mixed dashboard degrades the same way
>
> At the smallest size a widget gets roughly one word. Whatever you choose there, every add-on should
> choose it the same way, or a dashboard holding five of them shrinks into five different languages.
> The convention:
>
> - **A number if the state is countable or a proportion** — `7`, `64%`. Not a word.
> - **A short word only when there genuinely is no number** — a category, like `LAN` or `Off`.
> - **Always in the tone colour**, so the colour carries the severity and the glyph does not have to.
> - **One suffix only: `!` for "needs attention".** Resist inventing a second. A set of `!`, `?` and
>   `…` looks like three states to the author and like noise to everyone else.
>
> Say the *most alarming true thing*, not a total: `3!` when three are failing beats `12` when twelve
> exist.

> ### Before JonDash 1.8.2, a Tailwind class containing `(` silently did nothing
>
> Installed modules live in a gitignored folder that Tailwind never scans, so core mirrors your class
> names into an allowlist instead. **Up to and including 1.8.1 that mirror dropped every token
> containing parentheses**, so a class holding any CSS function — a `clamp()` font size, a `calc()`
> width, the `bg-(--var)` shorthand — produced **no CSS at all**: the class sat on the element,
> nothing styled it, and neither the build nor the verifier said a word.
>
> **Fixed in 1.8.2**, so if your module requires 1.8.2 or newer you can write those classes normally.
>
> **This module still targets 1.8.0-beta.14**, so its fluid sizing lives in an inline
> `style={{ fontSize: … }}`. That is the safe choice whenever your floor is below 1.8.2 — inline styles
> are never scanned, so they work on every version — and you would already be reaching for one to use a
> theme token like `var(--muted)`. Raise your floor to 1.8.2 first, or keep the inline form.
>
> The general lesson outlives the bug: **anything that reads your source with a regex reads your
> comments too.** Keep literal class syntax out of `.ts` comments — the mirror picks tokens out of
> backtick spans as readily as out of real `className` strings, and an invalid one can take the CSS
> build down rather than merely doing nothing.

Delete anything you don't need. A module with just `module.ts` and `MODULE.md` that declares a couple
of settings is perfectly valid.

## Copy it and rename it

The id appears in a handful of places and they must all agree. Assuming the new id is `my-thing`:

1. **Copy the folder** to `addons/my-thing/` — the folder name *is* the id.
2. `lib/constants.ts` — `MODULE_ID = "my-thing"`.
3. `module.ts` — update `name`, `description`, `version` (start at `0.0.1-beta.1`), and the settings.
4. `migrations/001_init.sql` — rename every table from `mod_template_*` to `mod_my_thing_*`.
   **Dashes become underscores**: the id `my-thing` gives the prefix `mod_my_thing_`.
5. This file — rewrite it for your module.
6. Publishing? Add an entry to `addons.json` on the branch for your channel, with `path`
   `addons/my-thing`, a `tag` of `my-thing/v<version>`, and `permissions` **exactly** matching
   `module.ts`. Then tag and push. A mismatch is refused at install, not warned about.

Then check: `grep -ri template addons/my-thing` should come back empty.

## What you get without asking for anything

Every module, with no permissions declared:

- **`ctx.settings`** — the settings you declared in `module.ts`. `.get(key)`, `.set(key, value)`, `.all()`.
  Values marked `secret: true` are encrypted at rest.
- **`ctx.store`** — a key/value store for anything that doesn't deserve a table. No migration needed.
- **`ctx.db`** — scoped SQL over your own `mod_<id>_*` tables, if you ship migrations.
- **`ctx.user`** — who is viewing, or `null` in background work.

Anything more is a **permission**, declared in `module.ts` and shown to the admin as a plain-language
warning before they enable you. Four come from the app itself, each tied to the capability it unlocks:

| Permission | What appears on `ctx` |
| ---------- | --------------------- |
| `network:outbound` | `ctx.fetch`, `ctx.net.ping`, and raw TCP / DNS / TLS connections |
| `crypto:use` | `ctx.crypto.encrypt` / `.decrypt` |
| `audit:write` | `ctx.audit(action, detail?)` |
| `email:send` | `ctx.email.send({ to, subject, text?, html? })` |

**A helper you declare can name further permissions**, written `<helperId>:<verb>` — today the
`filesystem` helper provides `filesystem:read`, `filesystem:write` and `filesystem:delete`. Those work
differently from the four above: they don't put anything on `ctx`, because a helper's API is imported
directly. Instead the helper checks `ctx.can(permission)` on each call and refuses one you didn't
declare. Using any of them needs `minAppVersion: "1.5.2-beta.1"` and the helper in `helpers`.

Declaring anything outside those two groups gets it stripped, which makes your manifest disagree with
your `module.ts` and the install is refused. There is no permission for reading users, sessions or
other core tables, and none for touching the filesystem *directly* — a module keeps its own data in
`ctx.db` and `ctx.store`, and reaches real files only through the filesystem helper. Ask for the
fewest that make your module work; over-asking gets modules declined.

**This template declares exactly one: `audit:write`**, because `actions.ts` records added and deleted
items in JonDash's audit log. That is the only reason it's there — delete the audit calls and the list
should go back to empty. Notice the code writes `if (ctx.audit)` rather than assuming: a capability you
didn't declare, or that the admin didn't approve, simply isn't on `ctx`.

**Adding a permission in a later version is not free.** When someone updates, JonDash shows them what
the new version additionally wants and makes them approve it before the update applies. Every extra
entry is a question you're asking a person to answer, so earn it.

## Changing your database later

`migrations/002_add_done.sql` exists to show the pattern, because getting it wrong breaks other
people's installs:

- **Never edit a migration that has shipped.** `001` has already run elsewhere and won't run again —
  JonDash records applied files per module. Add a new, higher-numbered file.
- An existing install runs only the new file; a fresh install runs `001` then `002`. Both end up
  identical.
- **Give every added column a `DEFAULT`** — rows already exist and SQLite needs something to put in them.
- Forward-only. There is no "down"; if you get it wrong, ship `003` that fixes it.
- Migrations run when the module is enabled, and — from JonDash 1.4.1 — after an update too. On older
  builds an updated module's new migration doesn't run, which is why this version requires 1.4.1.

## What will get your module refused

The installer scans every `.ts`/`.tsx` file before it will install. It refuses:

- **`child_process`, `eval`, `new Function`, or a computed `import()`** — always, no exceptions.
- **Filesystem access** (`node:fs`).
- **Any core import except two:** `@/lib/modules/types` and `@/lib/modules/api`. Not `@/lib/db`, not
  `@/lib/crypto`, not `@/lib/email/*`, not `prisma`, and not the framework's own internals. Everything
  else you need arrives on `ctx`.
- **A capability you didn't declare** — importing `node:net`, `node:dns`, `node:tls`, `node:http(s)` or
  using `fetch` requires `network:outbound`.
- **`addons.json` permissions that don't match `module.ts`.**
- Archive problems: path traversal, symlinks, unexpected file types, or more than 400 files / 2 MB per
  file / 8 MB total. Allowed: `.ts .tsx .sql .md .json .css .txt .svg` and images.

None of this is a sandbox — a module compiles into JonDash and runs with its privileges. The checks
catch accidents and make the consent screen honest. Write your module as trusted code: never evaluate
configuration, never fetch and run remote code, and treat anything a remote service returns as hostile.

## Things worth knowing

- **Server Components by default.** Add `"use client"` only where you genuinely need interactivity —
  this template needs none, even for its forms. A client component must not import anything that
  imports `server-only`, or the build fails.
- **Installing or updating a module rebuilds and restarts JonDash**, so everyone gets signed out. Don't
  design around hot-reload.
- **Add no dependencies.** Use the platform: Next.js 16 App Router, React 19, TypeScript, SQLite via
  `ctx.db`, Tailwind v4. Reuse the app's own classes (`card`, `btn`, `input`) and CSS variables
  (`var(--muted)`, `var(--primary)`, `var(--danger)`) so you match light and dark mode for free.
- **Uninstall is total and irreversible**: your tables are dropped and your settings and store are
  purged. Anything a user would hate to lose deserves an export.

## Testing it

1. Copy the folder into a JonDash install at `modules/<id>/`, or zip it and use
   **Admin → Addons → Import your own module**.
2. Rebuild and restart, then **Admin → Addons** → review the permission list → **Enable**.
3. Check the widget appears on the dashboard, the page loads at `/m/<id>`, and the settings save.
4. **Disable** it — the widget and page vanish and the base app is unchanged.
5. **Uninstall** it — confirm the `mod_<id>_*` tables and its settings are gone.

Use a scratch install, not the one you rely on.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.8-beta.2 | **Fills the card instead of huddling in its top-left corner.** The previous beta was measured only for overflow, and an empty card overflows nothing — so a large tile showed a few rows across the top and left most of itself blank. Two mechanisms were wrong before this one: flex `flex-wrap` ran columns off the side of the card, and CSS `columns` fixed that but *balances*, spreading a handful of rows one-per-column across the top. It is now a grid whose rows are `1fr`, so they stretch to use the height, flowing into another column only once the height is spent. Measured fill went from about 10% to 86–96% of the card on large tiles, with nothing cut at any normal size. The figure also scales with the tile and is capped against its height as well as its width — the widget root now declares its own size containment, which is what makes `cqh` mean the card rather than the browser window. |
| 0.0.8-beta.1 | **The widget is now the reference implementation for sizing (JonDash 1.8.0 B5/B6).** The dashboard became a grid of square units a user can size from 1×1 upward, and the frame clips rather than scrolls — so the widget now adapts to its *container* (`@[6rem]:`, `@[8rem]:` — core's own two thresholds) instead of the viewport, with the count scaling between a floor and a ceiling. Verified at every width from 40px to 993px with nothing clipped. Also documents a trap found while building it: a Tailwind class containing parentheses produces **no CSS** in a module, so fluid sizing goes in an inline `style`. `minAppVersion` rises to `1.8.0-beta.14` (the exact build that made the frame a container) — this is a real floor, not caution: on older builds the frame is not a CSS container, so the labels would be permanently hidden. |
| 0.0.6 | **The template depends on nothing again.** The `scheduler` helper and the six-hourly `tidy` schedule added in 0.0.4-beta.1 are gone: a starter module should not drag a dependency in with it, and copying this now gives you something that installs entirely on its own. Helpers and `schedules` are still documented — as an option, with the syntax, in `module.ts` and in `AI-PROMPT.md` — just not used. `minAppVersion` drops back to `1.4.1-beta.1`, the genuine floor (migration 002), so the template works on far more installs. First version published to **both** channels since 0.0.1. |
| 0.0.5-beta.1 | `minAppVersion` corrected from `1.5.0` to `1.5.0-beta.1`, so the module could actually be installed — 0.0.4-beta.1 was refused on every build that existed. No code change. |
| 0.0.4-beta.1 | **Uninstallable — never use.** Declared the `scheduler` helper and a `schedules` entry (a six-hourly tidy of finished items). Removed again in 0.0.6. Required JonDash 1.5.0. |
| 0.0.3 | The AI prompt now covers the whole job, not just the writing: how to stand up a throwaway JonDash, run the same verifier the installer uses, run the module's own tests, start the app and click through it — plus the `server-only` trap and an instruction to report honestly what was and was not tested. |
| 0.0.2 | Adds a `done` toggle, which demonstrates the two things authors get wrong in a second version: a follow-up SQL migration, and declaring a permission (`audit:write`) that the code actually uses. Requires JonDash 1.4.1-beta.1, the first build that runs a module's migrations after an update. |
| 0.0.1 | First version: settings, own table, widget, page, Server Action forms, example test. |
