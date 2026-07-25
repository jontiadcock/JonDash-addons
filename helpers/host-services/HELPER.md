# Host services helper

**Status: SPEC — not built.** Awaiting the owner's approval, and the **elevate shim from core** (see
`../ELEVATION.md`), without which no action can run.

Lets a module start, stop and restart **services the administrator has explicitly listed** — a Windows
service, a systemd unit — so a JonDash module can be a control panel for the machine it runs on.

- **Helper id:** `host-services`
- **First consumer:** `service-control` — a tile per allowlisted service with its state and a
  start/stop/restart button.
- **Requires:** JonDash **1.5.2-beta.1** (for `ctx.can()`), **plus** the core elevate shim.
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

**Nothing in the allowlist is elevated by being there.** Every action still goes through approval and
UAC, every time.

## Capabilities

| Capability | Shown to the admin as |
| ---------- | --------------------- |
| `host-services:read` | "See whether the services you listed are running" |
| `host-services:control` | "Ask to start, stop and restart the services you listed — each needs your approval at this computer" |

**`control` does not mean "can control".** It means "may raise a request". The label says so, because
a capability that reads as unattended power when it is actually a request queue would be a lie the
admin discovers later.

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
  | { ok: false; reason: "no-interactive-session" | "shim-missing" | "unsupported-platform" };

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
| **A module can never add to the allowlist.** | `suggest` writes a suggestion row; nothing promotes it but an admin edit. |
| **A module can never name a service outside it.** | `request` resolves the id against the allowlist first and refuses otherwise. |
| **Nothing runs without two approvals** — in JonDash, then at UAC. | The shim is only launched after the admin approves, and UAC is the OS's own gate. |
| **No standing privilege.** | Nothing is elevated between actions; the shim runs once and exits. |
| **Service names are validated before use.** | Matched against the allowlist entry, never composed from module input. |
| **Every action is audited** — who approved, what ran, the result. | `ctx.audit` at approval and at completion. |
| **A declined UAC prompt is reported, not retried.** | `cancelled-at-uac` is a terminal outcome. |

## What it deliberately does not do

- **No arbitrary commands.** Three verbs, against a list. This is not a shell.
- **No installing, removing or reconfiguring services** — no changing a startup type, no editing a
  unit file. Those are a different capability with a different argument.
- **No discovery of services outside the allowlist.** A module cannot enumerate what exists on the
  machine; that is both a scoping and a privacy decision.
- **No unattended action, ever.** There is no "approve automatically", no scheduled elevation, and no
  remembered approval. If that is ever wanted it is a different helper with a much harder argument to
  make.
- **No fallback when elevation is impossible.** On a service/container/headless install, `capability()`
  reports why and `request()` refuses. It must never degrade to standing privilege.

## Choosing what to allowlist — a warning worth showing

The settings screen should warn on entries that can lock the admin out of their own machine, in the
same spirit as the `filesystem` helper's risk warnings: **sshd, the firewall, the network stack, and
JonDash itself.** Stopping any of those from a web page is a way to lose access to the box with no
route back. The helper should not refuse them — an admin may have a good reason — but it should say so
plainly at the moment of adding.

## Platform notes

| | Windows | Linux |
| - | ------- | ----- |
| Mechanism | Service Control Manager | systemd |
| Elevation | UAC via the shim | polkit (`pkexec`) via the shim |
| Works | in a desktop session | in a desktop session |
| Does **not** work | as a Service (Session 0), in a container | headless / over plain SSH |

## Version history

| Version | Notes |
| ------- | ----- |
| — | Spec only; nothing published. Blocked on the core elevate shim. |
