# Host services helper

**Status: SHIPPED on both channels.** Versions live in [`addons.json`](../../addons.json) on this branch — not restated here, because a version in prose goes stale silently and every one of these lines had. The helper exists and passes `tsc`, `eslint` and its own tests. It is
Shipped and proven on a real machine: one approval when a service is added, then start and stop
with no further prompt, verified by reading the service state either side. Removing an entry prompts
again, because withdrawing a standing privilege is itself an administrator action.

**What still needs no privilege at all:** reading the state of allowlisted services. Querying a
service needs no elevation, so the dashboard is useful on a machine where no grant has ever been made.

**What remains unproven, and must not be claimed:** whether the Scheduled Task security descriptor
stops a standard user *editing* a grant. It is coded that way and has not been tested.

**Elevation is granted once per service, not per action.** Adding a service to the allowlist creates a
fixed OS-level grant — a Scheduled Task on Windows, a sudoers/polkit rule on Linux — and that is the
only time a UAC prompt appears. Afterwards, starting and stopping that service needs no prompt, and the
grant survives restarts of JonDash and of the machine.

Lets a module start, stop and restart **services the administrator has explicitly listed** — a Windows
service, a systemd unit — so a JonDash module can be a control panel for the machine it runs on.

- **Helper id:** `host-services`
- **First consumer:** `service-control` — a tile per allowlisted service with its state and a
  start/stop/restart button.
- **Requires:** JonDash **1.5.2-beta.1** (for `ctx.can()`), **plus** the core grant manager.
- **Grants:** two capabilities, both red on the consent screen.

Read **`../ELEVATION.md` first.** This helper is an application of that model, and every rule there
applies here.

---

## The boundary that makes this safe

> **A module acting on its own can name a service. Only an administrator can add one.**

**This wording was corrected on 2026-07-25.** The original said *"a module can never add one"*, which was
not a stricter guarantee — it was an unimplementable one. A helper has no UI of its own and core has no
generic editor for helper configuration, so with no mutator anywhere the allowlist could never be
populated at all. The real boundary in this app is not module-versus-helper; it is **whether an
authenticated administrator is behind the call**, which is the shape `filesystem` already uses for
approved roots.

So the mutators live under `admin.*` and refuse unless `ctx.user.role === "ADMIN"`. That is stricter than
`filesystem`, which records the user without requiring one — proportionate here, because adding an entry
creates a *standing OS privilege* rather than approving a folder.

**Be honest about what that check is worth:** `ctx.user` is forgeable exactly as `ctx.can` is, since a
module can spread its context and hand back a doctored one. It catches accidents and honest modules,
which is nearly all of them. **What catches the rest is UAC** — creating an entry creates an OS grant,
which raises a real elevation prompt a human must approve at the machine. A module that fakes an admin
context still cannot obtain a standing privilege silently. The software check is the first layer; the
operating system is the one that cannot be talked out of it.

The allowlist lives in this helper's own tables, is edited only by an administrator on JonDash's own
settings screen, and is the complete set of services any module can ever touch. A module asking about
anything else gets "not in the list" — not an error revealing whether the service exists.

That is deliberately the same shape as the `filesystem` helper's approved roots, which has held up:
the dangerous surface is *configuration the admin owns*, not an argument the caller supplies. It is
also what lets the consent line say "the services you allow" and mean it literally.

**Being on the list is what grants the privilege** — that is the whole security decision, and it is why
adding an entry is the moment that prompts. What the grant covers is fixed at that instant: three
actions, one named service, baked into the OS's own definition and unable to accept arguments later.

Each entry then chooses whether a module still needs an admin click per action:

- **Ask me each time** (default) — the module requests, the admin approves in JonDash, it runs.
- **Allow without asking** — the module acts directly. This is what makes real automation possible: a
  health check that restarts a hung service at 3am cannot wait for a human.

The second is a deliberate choice per service, not a global switch, and the settings screen should say
what it means in those words.

## Capabilities

| Capability | Shown to the admin as |
| ---------- | --------------------- |
| `host-services:read` | "See whether the services you listed are running" |
| `host-services:control` | "Start, stop and restart the services you listed" |

**The label deliberately does not promise "each one needs your approval",** because that is a
per-service setting the admin controls, not a property of the capability. A consent line that claims a
safeguard the admin can later switch off is worse than one that states the power plainly. What bounds
this capability is the allowlist, and the label says "the services you listed" for that reason.

## How a consumer uses it

```ts
import hostServices, { type ServiceState, type RequestResult } from "@/helpers/host-services/api";

const svc = hostServices(ctx);

const all = await svc.list();                  // needs host-services:read
const req = await svc.request("plex", "restart"); // needs host-services:control
// req.status === "pending" — nothing has happened yet, and may never
```

```ts
permissions: ["host-services:read", "host-services:control"],
helpers: [{ id: "host-services", minVersion: "0.0.1-beta.1" }],
minAppVersion: "1.5.2-beta.1",
```

## The API

```ts
type HostServicesApi = {
  /** Can this installation elevate at all? Needs no capability — a module must be able to
   *  explain itself on a headless box without being granted anything. */
  capability(): Promise<ElevationSupport>;

  /** The allowlisted services and their current state. Needs host-services:read. */
  list(): Promise<Service[]>;

  /** Ask for an action. Queues a request; elevates nothing. Needs host-services:control. */
  request(serviceId: string, action: "start" | "stop" | "restart"): Promise<RequestResult>;

  /** What happened to a request this module raised. Needs host-services:control. */
  requestStatus(requestId: string): Promise<RequestOutcome>;

  /** Ask the admin to ADD a service to the allowlist. Inert — see below. Needs host-services:control. */
  suggest(name: string, reason: string): Promise<RequestResult>;
};

type ElevationSupport =
  | { ok: true; platform: "windows" | "linux" }
  | { ok: false; reason: "no-interactive-session" | "grant-manager-missing" | "unsupported-platform" };

type Service = {
  id: string;            // JonDash's id for the allowlist entry
  name: string;          // the real service/unit name
  label: string;         // what the admin called it
  state: "running" | "stopped" | "starting" | "stopping" | "unknown";
  canControl: boolean;   // false if the admin listed it read-only
};

type RequestResult =
  | { ok: true; requestId: string; status: "pending" | "ran" }
  | { ok: false; reason: string };

type RequestOutcome =
  | { status: "pending" }
  | { status: "approved"; ranAt: string; ok: boolean; detail: string }
  | { status: "declined"; at: string }      // admin said no in JonDash
  | { status: "cancelled-at-uac"; at: string } // admin said no at the UAC prompt
  | { status: "expired"; at: string };
```

**`status: "ran"` exists because an unattended entry acts immediately.** The spec originally returned only
`"pending"`, which would have made a module poll for an outcome that had already happened. A caller that
only understands `"pending"` still behaves correctly — it polls once and gets the finished status — so
this widened the type without breaking the contract.

**`declined` and `cancelled-at-uac` are separate outcomes on purpose.** They mean different things: one
is "I don't want this", the other is "not right now, or not on this machine". A module that retries the
second forever is a nuisance; a module that retries the first is misbehaving, and the distinction has
to exist for that to be visible.

## The "request to add a service" flow

Your button, and it works like this:

1. A module calls `suggest("plex", "so the dashboard can restart it when a check fails")`.
2. **Nothing happens.** The suggestion appears in the helper's settings screen, attributed to the
   module that asked, with its stated reason.
3. The admin adds it — or doesn't. Adding is an ordinary allowlist edit; the suggestion is only a
   prefilled form.
4. A suggestion **never** becomes an allowlist entry without that edit, and there is no API to make
   one.

**The real risk here is not technical, it is habituation** — a module that asks repeatedly trains the
admin to click yes. So: a module may have **one open suggestion at a time**, a declined suggestion
cannot be re-raised for 7 days, and the settings screen shows how many a module has raised. A module
that keeps asking becomes visibly annoying, which is the correct outcome.

## What you can rely on

| Guarantee | How it holds |
| --------- | ------------ |
| **A module acting on its own can never add to the allowlist.** | `suggest` writes a suggestion row; nothing promotes it but an admin edit through `admin.add`, which refuses without `ctx.user.role === "ADMIN"` — and only that edit creates the OS grant, behind a UAC prompt that cannot be forged. |
| **A module can never name a service outside it.** | `request` resolves the id against the allowlist first and refuses otherwise. |
| **A grant covers one service and three verbs, fixed when it was made.** | The OS grant is self-contained and takes no arguments — `schtasks /run` cannot pass any. |
| **No standing process.** | Nothing runs between actions; the grant is a definition, not a daemon, and is visible in Task Scheduler. |
| **Service names are validated before use.** | Matched against the allowlist entry, never composed from module input. |
| **Every action is audited** — who approved, what ran, the result. | `ctx.audit` at approval and at completion. |
| **A declined UAC prompt is reported, not retried.** | `cancelled-at-uac` is a terminal outcome. |

## What it deliberately does not do

- **No arbitrary commands.** Three verbs, against a list. This is not a shell.
- **No installing, removing or reconfiguring services** — no changing a startup type, no editing a
  unit file. Those are a different capability with a different argument.
- **No discovery of services outside the allowlist — unless the admin turns that on.** A module
  cannot enumerate what exists on the machine, which is both a scoping and a privacy decision.
  Since 0.0.4 an administrator may switch `host-services:read` to "allow everything — no list", and
  then a module holding that capability does see every service and its state. That is a deliberate
  widening, made on JonDash's own Permissions screen, behind a confirm step and a warning that says
  what it means. **It does not widen control:** everything the unbounded path returns is marked
  uncontrollable and carries a synthetic id no grant will ever resolve, so `request()` still refuses
  anything that is not an allowlisted, controllable entry. There is no equivalent switch for
  `host-services:control`, and there cannot be — see ELEVATION.md.
- **No enumeration from a module, ever, even so.** The service list is read by `browse` on the admin
  screen, which core calls behind `requirePermission("modules.manage")`. `lib/enumerate.ts` is not
  re-exported from `api.ts` and must never be.
- **No unattended action unless the admin chose it, per service.** "Allow without asking" is opt-in on
  one entry at a time — never global, never a default, and never something a module can set.
- **No fallback when a grant cannot be created.** Creating one needs an interactive desktop session;
  on a Service/container/headless install `capability()` reports why and adding an entry refuses.
  (Grants made earlier keep working there — a Scheduled Task runs with nobody logged in, which is what
  makes overnight automation possible.)
- **No removing a service without removing its grant.** They are the same action; a list entry that
  disappears while the OS grant survives is exactly the kind of orphan nobody audits.

## Choosing what to allowlist — a warning worth showing

The settings screen should warn on entries that can lock the admin out of their own machine, in the
same spirit as the `filesystem` helper's risk warnings: **sshd, the firewall, the network stack, and
JonDash itself.** Stopping any of those from a web page is a way to lose access to the box with no
route back. The helper should not refuse them — an admin may have a good reason — but it should say so
plainly at the moment of adding.

## Platform notes

| | Windows | Linux |
| - | ------- | ----- |
| Mechanism | Service Control Manager (`sc.exe`) | systemd (`systemctl`) |
| The grant | a Scheduled Task per service+verb, "run with highest privileges" | a sudoers rule (`NOPASSWD`) or polkit policy per service |
| Prompt to create it | UAC, once | polkit / `sudo`, once |
| Prompt to use it | **none** | **none** |
| Creating a grant needs | an interactive desktop session | an interactive desktop session |
| Using one needs | nothing — works logged out | nothing |

## Tamper resistance — TESTED 2026-07-25, and it holds

A grant's security descriptor lets the account JonDash runs as **read and execute** the task and nothing
more. This was the load-bearing claim: if a standard user could edit a task that runs as SYSTEM, the
model would collapse from a narrow permanent capability into arbitrary SYSTEM execution.

Measured, from a non-elevated process, against a real grant:

| Attempt | Result |
| --- | --- |
| Repoint the task at `calc.exe` | `ERROR: Access is denied.` |
| Disable it | `ERROR: Access is denied.` |
| Delete it | `ERROR: Access is denied.` |

The command it runs was unchanged afterwards. **Everything in the model is now verified:** creating a
grant needs a human at a UAC prompt, declining creates nothing, the fixed command cannot take arguments,
and the grant cannot be altered by the account that uses it.

**Implementation note for whoever builds the grant manager:** a Scheduled Task created by an
administrator is not runnable by a standard user by default. Its security descriptor has to permit the
account JonDash runs as to *read and execute* it — and nothing more. Getting that wrong either breaks
the feature or widens it. (Core confirmed 2026-07-25 that it does this, namespaces tasks under
`JonDash\`, refuses anything outside that folder, and stores the absolute path to `sc.exe` so an app
update or move cannot break existing grants.)

## Naming an entry, and why the names are readable

Core's grant manager fixes the *grammar* — `--service <name> --verb start|stop|restart`, with no syntax
for "run this command" or "read the action from a file". This helper owns *policy*: which services, and
which verbs on each.

**Task names are readable, not opaque.** An entry named `Plex` produces `JonDash\Plex-restart`. The
tempting alternative — an opaque id like `svc_a7f3-restart`, immune to any name-derived trickery — was
rejected, because **the whole case for granting once rests on the admin being able to open Task
Scheduler and read exactly what JonDash may do unprompted.** An opaque id forfeits the property that
justifies the design. Safety here comes from a strict charset, not from hiding meaning.

| Rule | |
| --- | --- |
| Charset | `[A-Za-z0-9._-]` only, ≤ 64 chars. Everything else is replaced, not escaped. |
| Collisions | resolved with a numeric suffix (`Plex-2`), never by silently reusing a task. |
| One task per verb | a grant covers one service and one verb; three verbs is three tasks. |
| The display label never appears in a task name | so relabelling an entry never touches the OS, and a label with emoji or a `\` cannot reach the task path. |

The charset matters beyond tidiness: `\` is the Task Scheduler folder separator, so an unsanitised
name is a path-escape attempt. Core refuses anything outside `JonDash\` as a backstop — both checks
should exist, and neither should be removed on the grounds that the other is there.

**Ask of core:** put the human label and the origin (*"added by <admin> on <date> for the
`service-control` module"*) in the task's **Description** field. It costs nothing, and it is what turns
the Task Scheduler view from a list of names into an actual audit trail.

## When a prompt appears, and when it does not

Measured on a real machine (2026-07-25), not inferred:

| Action | Prompt? |
| --- | --- |
| Add a service to the allowlist | **Yes** — once, covering start, stop and restart together |
| Start / stop / restart it afterwards | **No** — this is the entire point of granting once |
| **Remove** a service from the allowlist | **Yes** — deleting a SYSTEM-level task is itself an admin operation |
| Read a service's state | No — querying needs no privilege at all |

**The removal prompt is easy to forget and worth stating plainly**, because an admin who clicks "Remove"
and is not expecting a UAC dialog will assume something is wrong. It is also correct: revoking a standing
privilege should be at least as protected as granting one, or anything running as that user could quietly
strip an admin's grants.

So a full add-then-remove cycle costs **two** prompts, not one. The first live end-to-end test raised
exactly two, with none in between — grant, stop, start, revoke.

## Adding a service is ONE prompt, not three

Core supports batching several grants into one elevation. **Use it:** adding an entry creates its
start, stop and restart grants behind a single UAC prompt.

Three prompts to add one service would train the admin to click through them, which is precisely the
habituation `../ELEVATION.md` warns about — and the second and third prompts carry no new information,
since the decision the admin actually made was *"may JonDash control this service"*. Batching by
**arguments** is safe; `--create-from <file>` remains forbidden, because a file is a mutable
instruction source and that is the hole, not the batching.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.1 (unpublished) | Built: allowlist, requests, suggestions, state reading, grant bridge, risk warnings. 22 tests. Not on any channel — needs OPS-18 and the `service-control` consumer. |
