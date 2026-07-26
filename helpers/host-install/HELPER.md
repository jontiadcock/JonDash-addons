# Host install helper

**Status: SHIPPED on both channels.** Versions live in [`addons.json`](../../addons.json) on this branch — not restated here, because a version in prose goes stale silently and every one of these lines had. `0.0.1-beta.1`, needs JonDash **1.7.1-beta.6**.

Installs and removes software using Windows' own package manager, with an administrator
approving every single one.

- **Helper id:** `host-install`
- **First consumer:** `docker-manager` — installs Docker Desktop for someone who hasn't got it.
- **Grants:** two capabilities, both red on the consent screen.

Read **`../ELEVATION.md` first.** This is the *approve-each-time* half of that model; `host-services`
is the *grant-once* half.

---

## Be honest: this is weaker than grants

`host-services` grants one fixed command that **cannot take arguments**, enforced by Windows. That is
a narrow permanent capability, and it was tested — a standard user cannot edit, disable or delete a
grant.

This is not that. **An installer runs the vendor's code as administrator, by definition.** The bound
here is *"anything in the winget catalogue"*, which is real but far broader than *"restart Plex"*. No
amount of engineering changes that, so nothing in the UI or the docs may imply otherwise.

What follows from it:

- **JonDash's own screen is the real consent surface.** UAC names `jondash-elevate.exe` and says
  nothing about the package, so any UI built on this **must show the package id verbatim** before the
  admin approves.
- **Every action is approved as it happens.** There is no grant to switch off, and no "allow without
  asking" setting — unlike `host-services`, that is a property of the capability rather than a choice.

## Why this is a separate helper, and must stay one

A module inherits **every** capability of every helper it declares. Folding installing into
`host-services` would make `service-control`'s consent screen say *"can install software on your
machine"* — for a module that only restarts Plex, permanently, and for every future consumer.

The elevation models differ too, which is the rule in `../ELEVATION.md`: a service action is FIXED so
it can be granted once; a package name is VARIABLE so there is nothing to bake into a grant.

## Capabilities

| Capability | Shown to the admin as |
| ---------- | --------------------- |
| `host-install:read` | "See whether a piece of software is installed on this server" |
| `host-install:manage` | "Install and remove software on this server — you approve each one, and see its name before it runs" |

## The two gates

> **A module can ask. Only an administrator can install.**

1. **An admin approves it in JonDash**, where the package id is shown verbatim and the module's stated
   reason is visible. This is where the understanding happens.
2. **Windows asks again.** This is the unforgeable gate, but on its own it is nearly content-free —
   it names our binary, not the package.

A module may have **one open request at a time**. The risk here is habituation rather than anything
technical: a module that asks repeatedly trains the admin to click yes, and the thing being clicked
installs software as administrator.

## How a consumer uses it

```ts
import hostInstall, { KNOWN } from "@/helpers/host-install/api";

const hi = hostInstall(ctx);

const support = await hi.capability();              // no capability needed
const present = await hi.isInstalled("Docker.DockerDesktop"); // host-install:read
const req = await hi.requestInstall("Docker.DockerDesktop", "so the Docker module can talk to an engine");
// nothing has happened yet, and may never
```

```ts
permissions: ["host-install:read", "host-install:manage"],
helpers: [{ id: "host-install", minVersion: "0.0.1-beta.1" }],
minAppVersion: "1.7.1-beta.6",
```

## The API

```ts
type HostInstallApi = {
  capability(): Promise<InstallSupport>;                 // no capability required
  isInstalled(packageId: string): Promise<boolean | null>;  // host-install:read
  requestInstall(packageId: string, reason: string): Promise<RequestResult>;   // :manage
  requestUninstall(packageId: string, reason: string): Promise<RequestResult>; // :manage
  requestStatus(requestId: string): Promise<RequestOutcome | null>;            // :manage
  admin: {                                               // ADMIN in ctx.user, always
    pending(): Promise<AdminRequest[]>;
    approve(requestId: string): Promise<RequestOutcome>; // RAISES UAC, runs the installer
    decline(requestId: string): Promise<{ ok: boolean }>;
    installedByUs(): Promise<InstalledByUs[]>;
  };
};
```

`approve()` **returns when the installer has finished**, which is minutes, not seconds. That is core's
deliberate design: exit codes come back from an elevated child but stdout does not, and a shared
progress file would be an arbitrary file write as admin. Poll `isInstalled` if you want to show
progress — it is unprivileged and never prompts.

## The uninstall rule

> **Clean up what you created, never what you found.**

`hlp_host_install_installed` records what JonDash installed, written **only on success**. That record
is what later authorises removal:

- `requestUninstall` **refuses** for anything not in it — software the admin installed themselves is
  not ours to offer to remove.
- Writing the record optimistically would let JonDash offer to uninstall something it never managed to
  install, so it is written after the installer reports success and not before.

**Uninstalling the helper does NOT uninstall software.** `onUninstall` writes an audit line saying what
was left and stops there. Deleting Docker because a dashboard module was pruned is destructive in a way
no audit entry excuses; the helper's tables survive removal, so reinstalling restores the ability to
remove it deliberately.

**Owner wants an offer at that moment** — *"would you like to remove Docker too?"* — which `onUninstall`
cannot do, because it is headless: it can act, but it cannot ask.

*It could not wait, either — until it turned out it can.* `uninstallMayPrompt: true` shipped in
JonDash 1.7.1-beta.5 and raises the budget to the elevation timeout, and the hook already runs inside
the uninstall the admin just clicked. The timing objection was designed around a constraint that had
already been lifted; **check the current contract before building around a limit.**

What is genuinely missing is only the *asking*. Core has confirmed the shape but not scheduled it:

```ts
uninstallQuestions?: () => Promise<{ id: string; label: string; detail?: string; default: boolean }[]>
onUninstall?: (ctx, answers: Record<string, boolean>) => Promise<void>
```

Max 10 questions, and `label`/`detail` render as **text, never markup**. When it lands, this helper
returns one question per package it installed, defaulting to **no**, naming the package and saying that
containers and volumes go with it. Until then the Docker module carries a **Remove Docker** button in
its own settings — a worse place, since the moment someone thinks about removing Docker is the moment
they remove the module.

## Package ids — the only variable that reaches an elevated process

Validated here *and* by core. The duplication is deliberate: this turns "winget rejected your input"
after a UAC prompt into a clear refusal before one appears, and keeps the request queue free of things
that can only ever fail.

| Rule | |
| --- | --- |
| Charset | `[A-Za-z0-9._+-]`, max 128 |
| **May not start with `-`** | `winget install --override …` reads a leading dash as a **flag**. That is how a pass-through gets smuggled in wearing a package name. |
| Refused outright by core | `--custom`, `--override`, `--manifest`, `--version`, `--location` — any one is arbitrary code as administrator |
| winget's path | discovered by core's binary; a caller-supplied path would be arbitrary exe execution |

## What you can rely on

| Guarantee | How it holds |
| --------- | ------------ |
| **A module can never install anything on its own.** | `requestInstall` writes a row; only `admin.approve` acts, and it requires an ADMIN in `ctx.user` plus a UAC prompt. |
| **A module can never remove software JonDash didn't install.** | `requestUninstall` checks the installed record first and refuses otherwise. |
| **No command strings, ever.** | The API takes a package id; core takes a structured action. There is no syntax for "run this". |
| **A leading-dash id cannot reach winget.** | Refused here and again by core. |
| **One open request per module.** | Enforced in `store.ts`; a module cannot pester its way to a yes. |
| **Every action is audited** — requested, approved, declined, failed. | `ctx.audit` on each, plus core's own entry written before it acts. |

## What it deliberately does not do

- **No arbitrary commands.** Install and uninstall, by package id. This is not a shell.
- **No package sources other than winget.** One manager, chosen because it covers Docker Desktop and
  most of what a homelab installs. Another would be a new capability, not a wider one.
- **No unattended installs.** There is no "allow without asking" here and there must not be.
- **No removal of software JonDash didn't install.**
- **No progress stream.** Core considered it and refused: a file we nominate is an arbitrary file
  write as admin. Poll `isInstalled` instead.

## Platform notes

Windows only. Core's Linux design exists but is unbuilt (OPS-19), because JonDash has no Linux
launcher yet. `capability()` reports `unsupported-platform` rather than degrading.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.1-beta.1 | First release. Request/approve flow, package-id validation, and the installed record that authorises removal. 8 unit tests. **No install has been performed yet** — the elevating path is unexercised. |
