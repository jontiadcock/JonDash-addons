# Scheduler helper

**Status: published, version 0.0.2-beta.1 (beta channel). The runtime lives here and is maintained
here. Proven end to end on 2026-07-22 (see the version history) — `health-monitor` still has its own
poller and migrates onto this next.**

Lets a module run work on a schedule **from the moment the server starts**, rather than the first time
somebody happens to open a page.

- **Helper id:** `scheduler`
- **Requires:** JonDash 1.5.0 — declared as `1.5.0-beta.1`, so it installs on the 1.5.0 betas too
- **Grants:** nothing new. A scheduled job receives the module's own scoped context, so this helper
  adds **no permission and nothing to the consuming module's consent screen**.

---

## The problem it solves

A module's code is only loaded when something imports it. In practice that means a widget or a page
rendering — so periodic work inside a module doesn't start until somebody looks at the dashboard.
Restart the server at 03:00 with nobody watching and nothing runs until morning. For anything whose
job is to notice problems, that is exactly backwards: it stops working precisely when it is least
observed.

Helpers get a boot phase, so work declared through this one starts with the server.

## How a module uses it

Work is **declared, not started**. A module never executes code at boot:

```ts
const mod: ModuleDefinition = {
  // …
  helpers: ["scheduler"],
  schedules: [
    {
      key: "poll",              // stable, unique within your module
      everyMs: 60_000,          // clamped to a 15s floor
      run: async (ctx) => { /* your work; ctx is your module's scoped system context */ },
      skipOnBoot: false,        // optional: wait a full interval instead of catching up
    },
  ],
};
```

`helpers: ["scheduler"]` is required — declaring `schedules` without it is a mistake the installer
should catch.

## What you can rely on

| Guarantee | What it means for you |
| --------- | --------------------- |
| **Starts at server start** | Not at first render. Also runs after every install or uninstall, since those rebuild and restart. |
| **Catch-up** | If a job fell due while the server was down it runs shortly after boot rather than waiting a full interval. Last-run is persisted. Opt out with `skipOnBoot`. |
| **Staggered first runs** | Several modules don't stampede the machine at startup. |
| **No overlap** | A slow run causes the next tick to be **skipped, not queued**. Your job can't stack on itself. |
| **Isolated failures** | A throwing job is logged and keeps its schedule. It doesn't stop the timer or affect other modules. |
| **Disabled modules are skipped** | Enabled state is checked **per tick**, not trusted from a boot snapshot. Disabling stops the work silently — a switched-off module doing nothing is correct, not an error — and re-enabling resumes it with no restart. |
| **Modules enabled later are picked up** | Enabling a module doesn't restart the server, so the scheduler re-checks for new schedules every 30 seconds. Switch a module on and its work starts shortly after, without a restart. |
| **Scoped context** | `run` receives your module's own system context: your settings, your store, your `mod_<id>_*` tables, and only the capabilities you declared. |

## What it deliberately does not do

- **No dynamic schedules.** The set of jobs is fixed at definition time. Dynamic *data* is fine — a
  job that scans a table and acts on whatever it finds is the normal pattern — but the jobs themselves
  are known in advance and can be inspected without being run.
- **No runtime rescheduling.** `everyMs` is fixed when the module is defined. A user-tunable interval
  is not possible; if a module currently exposes one as a setting, it should be removed rather than
  faked.
- **No per-item jobs.** One schedule per kind of work, not one per row.
- **No arbitrary boot code.** The declarative shape is the security property: a module cannot run code
  at startup, only declare work to be run.

## Designing a job

- **Keep the tick cheap and idempotent.** It may be skipped, retried after a failure, or run
  immediately after boot. Nothing should assume it ran exactly on time or exactly once per interval.
- **Choose the interval by the smallest thing you need to notice.** A scan every 15s that acts on rows
  whose own due-time has passed is a better shape than many short schedules.
- **Do slow work inside the job, never at definition time.** The boot phase must stay fast — it
  completes before the server serves any request — so declaring a schedule must not read the database.
- **Guard anything that can also be triggered directly.** The no-overlap guarantee covers *scheduled*
  ticks. If the same work can be kicked off by a user action, that path is yours to protect.

## First consumer

`health-monitor` will drop its in-module poller for this. That poller is the worked example of the
problem: a `setInterval` started from a widget render, with a documented cold-start gap that this
helper removes. The migration also deletes its `pollSeconds` setting, which only controlled how often
the module looked for due work and never how often anything was actually checked.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.2-beta.1 | `minAppVersion` corrected from `1.5.0` to `1.5.0-beta.1`. Runtime unchanged. A bare `1.5.0` ranks *above* every 1.5.0 beta in semver, so nothing could install it. **First end-to-end proof, on a pristine 1.5.0-beta.2 install:** a declared job ran ~5s after a server restart with **nobody signed in and no page opened** — the cold-start gap this helper exists to close — and was skipped entirely while its module was disabled. Two core defects found in the process (helpers were never installed with a module, and never pruned when the last dependent went), both reported; neither is in this runtime. |
| 0.0.1-beta.1 | First release. Runtime moved into this repo by the core session and now maintained here. Fixed before publishing: jobs were collected once at boot, so a module enabled afterwards never ran — and with no schedules present at boot the scheduler gave up entirely, which is the state of every fresh install. |
