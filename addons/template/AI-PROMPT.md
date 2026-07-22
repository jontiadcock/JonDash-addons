# Have an AI build your module

Copy **everything in the box below** into a capable AI agent (Claude, or similar), then add a sentence
or two at the end describing the module you want. The prompt is self-contained — the AI does not need
to know anything about JonDash beforehand, and does not need this repository.

If the AI has access to your JonDash folder, tell it to read `modules/template/` as a working
reference; if it doesn't, the prompt alone is enough.

Check what it produces before you install it: the permissions it declares, and anything it does with
your data or the network. An install is checked automatically, but the checks catch accidents, not
intent.

---

````text
You are writing a "module" (an add-on) for a self-hosted web app called JonDash. You have never seen
this app; everything you need is below. Follow the contract exactly and output complete files.

WHAT JONDASH IS
- A secure, self-hosted, multi-user dashboard: a login-protected grid of service tiles, admin-managed
  accounts, password + authenticator sign-in. Stack: Next.js 16 (App Router), React 19, TypeScript,
  Prisma + SQLite, Tailwind CSS v4. Server Components by default; add "use client" only where a
  component genuinely needs interactivity.

WHAT A MODULE IS
- A self-contained folder that only ever ADDS functionality — a dashboard widget, its own page(s), its
  own settings and data. Disable or remove it and the app behaves exactly as if it never existed.
- It must never modify the base app, its database tables, or another module.
- Your code is compiled into the app at build time and handed a capability-scoped context object
  (`ctx`). You never import core internals and never write your own login/session logic.

FOLDER LAYOUT — the folder name IS the module id (stable, lowercase-kebab):
  modules/<id>/
    module.ts                 (required) default-exports a ModuleDefinition
    MODULE.md                 (required) plain-English spec: what it does, its settings (say which are
                              secret), its tables, each permission and WHY, and a version history
    widget.tsx                (optional) dashboard card
    page.tsx                  (optional) your page, served at /m/<id>
    actions.ts                (optional) "use server" file for saving changes
    lib/*.ts                  (optional) your own helpers
    migrations/001_init.sql   (optional) your own tables
    tests/*.test.ts           (optional) Vitest tests — these SHIP, and are scanned like any other file

THE ModuleDefinition (module.ts):
  {
    id: string;                 // === folder name
    name: string;               // shown to the admin
    description: string;        // one honest sentence
    version: string;            // semver; "0.0.1-beta.1" for a first beta
    minAppVersion: string;      // "1.4.0" — the release that introduced the module framework
    permissions: string[];      // the FEWEST that work — see below
    adminOnly?: boolean;        // true = only full admins see any of it
    settings?: { key: string; label: string; type: "string"|"text"|"number"|"boolean";
                 default?: unknown; help?: string; secret?: boolean }[];
                                   // "text" = multiline textarea; secret values are encrypted
    icon?: Component;              // optional inline SVG shown beside the module name;
                                   //   use stroke/fill "currentColor" so it follows the theme
    DashboardWidget?: Component;   // props: { ctx }. Users can resize it, so stay useful when small
    Page?: Component;              // props: { ctx, path: string[] }, served at /m/<id>
    SettingsPanel?: Component;     // props: { ctx }. Rendered in Admin -> Modules -> your module,
                                   //   BELOW the auto-generated settings fields (not instead of
                                   //   them), and only once the module is enabled. Put anything
                                   //   richer than a flat settings list here.
    migrations?: string;           // e.g. "./migrations"
    onEnable?(ctx): Promise<void>; onDisable?(ctx): Promise<void>; onUninstall?(ctx): Promise<void>;
  }

THE CONTEXT (ctx) — only what your permissions granted is present:
  ctx.moduleId
  ctx.user      // { id, email, role } of the viewer, or null in background work
  ctx.settings  // .get(key) .set(key, value) .all()      — your declared settings; secrets encrypted
  ctx.store     // .get .set(key, value, { secret? }) .delete .list(prefix?)  — key/value, no migration
  ctx.db?       // only if you ship migrations: .table(name) -> "mod_<id>_<name>",
                //   .query<T>(sql, ...params), .run(sql, ...params). ONLY your own tables.
  ctx.fetch?    // "network:outbound"
  ctx.net?      // "network:outbound": .ping(host, { timeoutMs? }) -> round-trip ms, or null if silent
  ctx.crypto?   // "crypto:use": .encrypt(s) .decrypt(s)
  ctx.email?    // "email:send": .send({ to, subject, text?, html? }) — THROWS if mail isn't configured
  ctx.audit?    // "audit:write": (action, detail?) => Promise<void>
  Free, no permission needed: your settings, your store, your own mod_<id>_* tables.

PERMISSIONS — there are exactly FOUR, and each is shown to the admin as a plain-language warning
before they enable you. Declare the fewest that make it work; over-asking gets a module declined:
  network:outbound  → ctx.fetch, ctx.net, and raw TCP/DNS/TLS connections
  crypto:use        → ctx.crypto
  audit:write       → ctx.audit
  email:send        → ctx.email
Anything else is refused at install. There is no permission for reading users, sessions, other core
tables, or the filesystem — a module keeps its own data in ctx.db and ctx.store.

SAVING CHANGES — the only sanctioned way:
  // actions.ts
  "use server";
  import { revalidatePath } from "next/cache";
  import { moduleAction } from "@/lib/modules/api";
  export const saveThing = moduleAction("<id>", async (ctx, formData: FormData) => {
    const value = String(formData.get("value") ?? "").trim();
    if (!value || !ctx.db) return;
    await ctx.db.run(`INSERT INTO ${ctx.db.table("things")} (value) VALUES (?)`, value);
    revalidatePath("/m/<id>");
  });
  Then in a Server Component: <form action={saveThing}> … </form>  (no "use client" needed).
  moduleAction verifies the request origin, that the caller is signed in (an admin if adminOnly), and
  that the module is enabled, then gives you a scoped ctx. It THROWS if any check fails — never catch
  and ignore that. It proves WHO is calling; validating WHAT they sent is still your job.
  For background work with no user, use systemModuleContext("<id>") from the same module.
  If you use useActionState in a client component: React clears UNCONTROLLED inputs itself after a
  successful form action, but values you hold in state are NOT cleared with them — reset that state
  inside the action, not in an effect (the React Compiler lint refuses setState in an effect).

HARD RULES — an install is refused if you break these:
- Never use child_process, eval, new Function, or a dynamic import() with a computed path.
- Never touch the filesystem (node:fs).
- The ONLY core imports allowed are "@/lib/modules/types" and "@/lib/modules/api". Never import
  @/lib/db, @/lib/crypto, @/lib/email/*, prisma, or the framework's own store/migrate/manage/registry/
  context modules. Everything else you need arrives on ctx.
- Importing node:net, node:dns, node:tls, node:http/https, or using fetch, REQUIRES declaring
  "network:outbound".
- Every table you create must be named mod_<id>_* — the app sanitises the id, so dashes become
  underscores (id "my-thing" -> tables mod_my_thing_*). Never touch a core table.
- Keep everything inside your module folder. Add NO new dependencies — use the stack above.
- Allowed file types: .ts .tsx .sql .md .json .css .txt .svg and images. Limits: 400 files, 2 MB per
  file, 8 MB total.
- TypeScript must compile and lint cleanly, or the install fails.
- Never hardcode a secret. Use a setting with secret: true, or ctx.crypto.
- Treat anything a remote service or a form returns as hostile: validate it, cap its length, and strip
  control characters before storing or displaying it.

WRITING SQL MIGRATIONS: whole-line comments are stripped and statements are split on ";" at the end of
a line — one statement at a time, no trailing comments after code, no triggers or BEGIN…END blocks.
SQLite has no boolean or date type: use INTEGER 0/1 and ISO-8601 TEXT.
CHANGING THE SCHEMA IN A LATER VERSION: never edit a migration that has shipped — it has already run
on other installs and will not run again. Add a higher-numbered file (002_..., 003_...), give every
added column a DEFAULT, and treat migrations as forward-only.

LOOKING NATIVE: reuse the app's own classes (card, btn, btn-primary, btn-danger, input) and CSS
variables (var(--muted), var(--primary), var(--danger), var(--border)) so the module matches light and
dark mode without any styling of its own.

DELIVERABLES
1. modules/<id>/module.ts
2. modules/<id>/MODULE.md
3. Any widget.tsx / page.tsx / actions.ts / lib/*.ts / migrations/*.sql / tests/*.test.ts it needs.
Keep it small and single-purpose. Explain how to test it: put the folder in modules/<id>/ (or zip the
folder and use Admin -> Modules -> Import your own module), rebuild and restart, enable it in
Admin -> Modules after reviewing the permission prompt, check the widget/page/settings work, then
confirm that disabling hides it and uninstalling removes all of its data.

NOW BUILD THIS MODULE:
<<< describe what you want here: what it should show or do, any external service it should talk to,
    its settings, and whether it should be admin-only >>>
````

---

## After the AI has produced it

1. Read the `permissions` it declared. If you can't explain why each one is needed, ask it to justify
   or remove them.
2. Put the folder in `modules/<id>/`, or zip it and use **Admin → Modules → Import your own module**.
3. Try it on a scratch install first, not the one you depend on.
4. Publishing it for others: put it in a public GitHub repository with an `addons.json` manifest, tag
   the release `<id>/v<version>`, and share the repository URL — anyone can add it as a source. The
   permissions in the manifest must match `module.ts` exactly.
