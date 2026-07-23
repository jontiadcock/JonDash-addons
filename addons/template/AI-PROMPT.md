# Have an AI build your module

Copy **everything in the box below** into a capable AI agent (Claude, or similar), then add a sentence
or two at the end describing the module you want. The prompt is self-contained — the AI does not need
to know anything about JonDash beforehand, and does not need this repository.

**If the agent can run commands, it can do the whole job.** The prompt tells it how to download a
throwaway JonDash, install the module, run the same verifier the installer uses, run its own tests,
start the app and click through the result — so what comes back should be tested, not just written.
If it has no shell, it will still produce a correct module; you'll be the one installing it.

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
    minAppVersion: string;      // "1.4.0" — the release that introduced the module framework.
                                //   Declare the OLDEST build that genuinely works, not the
                                //   newest available: too high locks people out for nothing.
                                //   Always name the PRE-RELEASE — "1.5.0-beta.1", never a
                                //   bare "1.5.0". Semver ranks a pre-release below its
                                //   release, so a bare "1.5.0" is refused on every 1.5.0
                                //   beta, i.e. on the builds beta users actually run.
                                //   Raise it only for what you use: a 2nd migration needs
                                //   "1.4.1-beta.1"; `schedules`/`helpers` need "1.5.0-beta.1";
                                //   a helper-provided permission needs "1.5.2-beta.1".
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
    helpers?: (string | { id: string; minVersion?: string })[];
                                   // first-party shared capability you depend on, e.g. ["scheduler"]
                                   //   or [{ id: "filesystem", minVersion: "0.0.3-beta.1" }].
                                   //   Installed automatically WITH your module; never install one
                                   //   yourself. Required whenever you declare `schedules`, and
                                   //   whenever you declare a "<helperId>:<verb>" permission.
                                   //   `minVersion` is honest documentation, not a guard: JonDash
                                   //   uses it to warn which modules a helper update would break.
                                   //   It does NOT refuse an install against an older helper.
                                   //   DEFAULT TO NEITHER: a module that depends on nothing is
                                   //   easier to install, review and keep working.
    schedules?: { key: string; everyMs: number; skipOnBoot?: boolean;
                  run(ctx): Promise<void> }[];
                                   // Periodic work, DECLARED not started — your code only runs when
                                   //   something renders it, so a timer started from a widget dies
                                   //   the moment nobody is looking. The scheduler helper runs these
                                   //   from server start, skips them while your module is disabled,
                                   //   and never lets a slow run overlap itself. Keep each job cheap
                                   //   and idempotent: it may be skipped, retried, or run right
                                   //   after boot, so never assume exactly one run per interval.
                                   //   Needs `helpers: ["scheduler"]` and minAppVersion 1.5.0-beta.1.
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
  ctx.grants    // readonly list of the permissions you were actually granted (JonDash 1.5.2+)
  ctx.can(p)    // whether a permission was granted (1.5.2+). Helpers call this to refuse work you
                //   did not declare — you do not normally call it yourself.
  Free, no permission needed: your settings, your store, your own mod_<id>_* tables.

PERMISSIONS — each is shown to the admin as a plain-language warning before they enable you. Declare
the fewest that make it work; over-asking gets a module declined.

FOUR come from the app itself, and each one puts a field on ctx:
  network:outbound  → ctx.fetch, ctx.net, and raw TCP/DNS/TLS connections
  crypto:use        → ctx.crypto
  audit:write       → ctx.audit
  email:send        → ctx.email

MORE come from HELPERS you declare, named "<helperId>:<verb>". You may only use these if you also
declare the helper in `helpers`. Today the `filesystem` helper provides three:
  filesystem:read   → look at files and folders, within folders the admin approved
  filesystem:write  → create and change files there
  filesystem:delete → delete files there
These are enforced, not just described: since JonDash 1.5.2 the helper checks ctx.can(permission) on
every call and refuses one you did not declare, naming what you forgot. Declaring a helper permission
needs minAppVersion "1.5.2-beta.1".

Anything outside those two groups is refused at install. There is no permission for reading users,
sessions or other core tables, and none for touching the filesystem DIRECTLY — a module keeps its own
data in ctx.db and ctx.store, and reaches real files only through the filesystem helper, which never
returns a file's contents to your code.

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

ONE MORE TRAP, because it produces a confusing error: a "use client" component must not import
anything that itself imports "server-only" — directly or further down the chain. The build fails with
a misleading message about the Pages Router. Keep constants and types a client component needs in a
plain file with no server imports.

DELIVERABLES
1. modules/<id>/module.ts
2. modules/<id>/MODULE.md
3. Any widget.tsx / page.tsx / actions.ts / lib/*.ts / migrations/*.sql / tests/*.test.ts it needs.
Keep it small and single-purpose.

STANDING IT UP AND TESTING IT — do this yourself, and do not hand over work you have not run.
If you have a shell, everything below is doable without help. Use a THROWAWAY JonDash, never one
somebody depends on, and never the default port if something is already using it.

1. Get a JonDash to test against (skip if you already have a disposable one):
     git clone --depth 1 --branch v1.5.2 https://github.com/jontiadcock/JonDash jondash-test
     cd jondash-test && rm -rf .git && npm install
   Use the newest release tag you can see on that repository. Node must be on PATH.

2. Put your module in place:
     mkdir -p modules && cp -r /path/to/<id> modules/<id>

3. Check it compiles and lints BEFORE anything else — the install refuses a module that fails either:
     npx tsc --noEmit
     npx eslint modules/<id> --ext .ts,.tsx
   Fix everything they report. Warnings about unused imports matter; they mean dead code.

4. Run it against the REAL installer verifier before you trust it. Write this as verify.mts in the
   APP ROOT — not inside your module, because it imports core internals your module may not:
     import fs from "node:fs";
     import path from "node:path";
     import { verifyModuleFiles, formatIssues } from "./lib/modules/verify";
     const dir = path.resolve("modules/<id>");
     const files: { path: string; text?: string; bytes: number }[] = [];
     (function walk(d: string, prefix = "") {
       for (const e of fs.readdirSync(d, { withFileTypes: true })) {
         const full = path.join(d, e.name);
         const rel = prefix ? `${prefix}/${e.name}` : e.name;
         if (e.isDirectory()) walk(full, rel);
         else { const b = fs.readFileSync(full); files.push({ path: rel, text: b.toString("utf8"), bytes: b.length }); }
       }
     })(dir);
     const r = verifyModuleFiles("<id>", files as never, ["<your declared permissions>"] as never);
     console.log("ok=" + r.ok);
     console.log(r.issues.length ? formatIssues(r.issues) : "no issues");
   Run it with:  npx tsx verify.mts       then delete verify.mts.
   This is the same check the installer runs. If it says ok=true you will not be refused at install.

5. Run your own tests. The app's vitest only looks in tests/**, so a module's tests are NOT picked up
   by default. Write vitest.module.config.ts in the APP ROOT (it must live there, or "vitest/config"
   cannot resolve) and delete it afterwards:
     import { defineConfig } from "vitest/config";
     import path from "node:path";
     const root = process.cwd();
     export default defineConfig({
       test: { environment: "node", include: ["modules/*/tests/**/*.test.ts"], fileParallelism: false,
         env: { NODE_ENV: "test", ENCRYPTION_KEY: "0".repeat(64) } },
       resolve: { alias: { "@": root, "server-only": path.resolve(root, "tests/stubs/server-only.ts") } },
     });
   Then:  npx vitest run --config vitest.module.config.ts

6. Build and start it on a free port, with a throwaway database:
     DATABASE_URL="file:./test.db" npx prisma migrate deploy
     DATABASE_URL="file:./test.db" npm run build
     DATABASE_URL="file:./test.db" npx next start -p 3020
   A failed build here is a failed install — read the error, fix it, rebuild.

7. First run needs an administrator. Open http://127.0.0.1:3020 — it redirects to /welcome. Create an
   account, then it shows an authenticator secret. Turn that into a code with:
     node -e "const {authenticator}=require('otplib'); console.log(authenticator.generate('THESECRET'))"
   Enter it, save the recovery codes, and you are in.

8. Now actually exercise the module:
   - Admin -> Modules: your module is listed. Read the permission warnings — they should match what
     you declared and nothing more. Enable it.
   - The widget appears on the dashboard; the page loads at /m/<id>; settings save and survive a reload.
   - Every button and form you added does what it says, including the failure cases: submit something
     invalid and check the message explains what to do.
   - If you ship migrations, confirm your tables exist. List every table and filter in JavaScript
     rather than with SQL LIKE — in LIKE, "_" is a single-character wildcard, so 'mod_%' also matches
     core tables such as Module, and escaping it through the shell is more trouble than it is worth.
     Substitute your own id with dashes turned into underscores:
       DATABASE_URL="file:./test.db" node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.$queryRawUnsafe(\"SELECT name FROM sqlite_master WHERE type='table'\").then(r=>console.log(r.map(x=>x.name).filter(n=>n.startsWith('mod_<id>_')))).finally(()=>p.$disconnect())"
   - Disable it: the widget and page disappear and the rest of the app is untouched.
   - Uninstall it: your mod_<id>_* tables and settings are gone.

9. Report honestly what you ran and what you did NOT. If something is untested, say so plainly rather
   than implying it works. "Compiles" is not "works".

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
