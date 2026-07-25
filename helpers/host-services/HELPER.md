# Host services helper

**Status: SPEC — not built.** Awaiting the owner's approval, and the **grant manager from core** (see
`../ELEVATION.md`), without which no action can run.

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

> **A module can name a service. It can never add one.**

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
  | { ok: true; requestId: string; status: "pending" }
  | { ok: false; reason: string };

type RequestOutcome =
  | { status: "pending" }
  | { status: "approved"; ranAt: string; ok: boolean; detail: string }
  | { status: "declined"; at: string }      // admin said no in JonDash
  | { status: "cancelled-at-uac"; at: string } // admin said no at the UAC prompt
  | { status: "expired"; at: string };
```

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
| **A module can never add to the allowlist.** | `suggest` writes a suggestion row; nothing promotes it but an admin edit — and only that edit creates the OS grant. |
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
- **No discovery of services outside the allowlist.** A module cannot enumerate what exists on the
  machine; that is both a scoping and a privacy decision.
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

**Implementation note for whoever builds the grant manager:** a Scheduled Task created by an
administrator is not runnable by a standard user by default. Its security descriptor has to permit the
account JonDash runs as to *read and execute* it — and nothing more. Getting that wrong either breaks
the feature or widens it.

## Version history

| Version | Notes |
| ------- | ----- |
| — | Spec only; nothing published. Blocked on the core grant manager. |
