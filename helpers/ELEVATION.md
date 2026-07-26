# Elevation — how helpers that touch the host get privilege

Some capabilities cannot be delivered by an unprivileged web app: starting a Windows service,
installing a package. This document is the **shared design** for how those helpers get privilege, and
the constraints every one of them must obey.

## The rejected design: a standing privileged agent

The conventional answer is a small daemon running permanently as root, taking requests from the app
over a local socket — how Docker Desktop and Chrome's updater work.

**Rejected by the owner, 2026-07-25, and the objection is sound:** something on the machine would
always be root and always listening. Compromise it once and privilege is permanent. For a self-hosted
personal dashboard, a root daemon existing so a button can restart Plex is a poor trade.

## Two grant models, and the rule that decides between them

> **A FIXED action can be granted once. A VARIABLE action must be approved every time.**

That single line settles which mechanism a helper uses, and it is a property of the *action*, not a
preference.

| | **Grant once** | **Approve each time** |
| --- | --- | --- |
| For | Actions with no variable part — `restart the "Plex" service` | Actions carrying a value — `install <package>` |
| Windows | A **Scheduled Task** per action, "run with highest privileges" | The **elevate shim**, launched with `runas` |
| Linux | A **sudoers/polkit rule** per action | `pkexec` |
| Prompt | **Once**, when the admin adds the entry | **Every time**, at the moment of action |
| Survives a JonDash restart? | **Yes** — the grant lives in the OS | n/a |
| Standing process? | **No** | **No** |

### Why a fixed action can be granted once

The grant names the whole action. A Scheduled Task called `JonDash\svc-plex-restart` runs exactly
`sc.exe stop "Plex"` / `start` — the service and the verb are baked into the task definition, and
**`schtasks /run` accepts only a task name; it cannot pass arguments** (verified). So the set of things
that can happen without a prompt is fixed at the moment the admin approved it, and enforced by Windows
rather than by our code.

The UAC prompt therefore moves to where the admin's real decision actually is — *"may JonDash restart
Plex?"* — instead of being re-asked on every click, which teaches people to stop reading it.

### Why a variable action cannot

`install <package>` has a hole in it. You cannot bake it into a task without either creating a task per
package in advance (pointless) or having the task read the package name from a file — and **anything
that can write that file then has SYSTEM.** The same is true of any "run the command in this file"
shape. So installs keep a prompt per action, and that is not a limitation to engineer around.

## The one rule that must never be broken

> **A granted action must be entirely self-contained. It must never read what to do from anywhere.**

A task that runs a fixed command is a narrow, permanent capability. A task that runs
`C:\JonDash\pending.bat` is a **local privilege escalation for every process on the machine**, because
the unprivileged app — or anything that compromises it — can write that file.

This is the difference between the design working and being actively dangerous, and it is why the
"grant once" model is only offered for fixed actions.

## What "grant once" honestly costs

It **is** standing capability, and the docs must say so rather than implying privilege has vanished.
What it is not, is a standing *process*:

- **No daemon, no listening socket** — nothing is running between actions.
- **A fixed, enumerable set of actions** — exactly the allowlist, no more.
- **Visible in the OS's own UI.** The admin can open Task Scheduler and read every single thing JonDash
  can do without asking. That is better auditing than a daemon offers.
- **Removable there too**, independently of JonDash.

**The residual risk, stated plainly:** any process running as that user can trigger those tasks. The
blast radius is exactly the allowlist — someone could restart Plex. It is not arbitrary code
execution, and it is bounded by a list the admin wrote.

## Approval inside JonDash is a separate question

The OS prompt and JonDash's own approval screen do different jobs. Once a fixed action is granted,
whether *each request* still needs an admin click in JonDash is a **per-entry setting**:

- **Ask me each time** (default) — a module requests, the admin clicks approve, the task runs. No UAC.
- **Allow without asking** — the module can act directly. This is what makes automation possible at
  all: a health check that restarts a hung service cannot wait for a human.

Default to asking. The second option is a real choice with real consequences and should be made
deliberately, per service.

## For actions that still prompt every time: UAC proves presence, not comprehension

Where a prompt does appear per action, know what it is worth. The UAC dialog names **the program being
elevated**; it cannot be made to say *"install nginx, requested by the Docker module"*. So:

- UAC is a **strong** check that a human is physically at the machine.
- UAC is a **weak** check that the human understood what they approved.

**JonDash's own screen is therefore the real consent surface** and must show the exact command
verbatim. **Never elevate `powershell.exe` or `cmd.exe`** — a prompt reading "Windows PowerShell"
trains the admin to approve exactly what malware wants, and is indistinguishable from an attack.

## The bar to judge any of this against

Not *"is this safe in the abstract"* — nothing that installs software is. The right question is:

> **Is this worse than the admin typing the command themselves?**

With the exact action displayed, granted deliberately, and bounded by a list the admin owns, it is
close to equivalent. What it adds is a **confused deputy** risk: the suggestion originates from a
module rather than from you. That is what the verbatim display counters, and why a request must never
be able to approve itself.

## Rules every elevating helper must follow

1. **A module can only request.** A request is inert and grants nothing.
2. **The allowlist is admin-owned**, stored helper-side. A module may name an entry; it may never add
   one. (The `filesystem` helper's approved-roots shape, which has held up.)
3. **A granted action is fully self-contained** — never parameterised, never read from a file.
4. **Removing an entry removes its grant**, in the same action.
5. **No free-form commands from a module**, ever. A package name is a value; a shell string is a
   program.
6. **"User declined" is a first-class outcome** — not an error, not a retry loop.
7. **Every elevated action is audited**: who approved it, what ran, the result.
8. **If elevation is impossible** — Session 0 (running as a Windows Service), a container, headless —
   say so and refuse. Never degrade to something weaker without saying.

## Where the prompt appears is a deployment constraint

Creating the grant needs an interactive desktop session, because that is where UAC and polkit prompt.
**Using** a grant does not — a Scheduled Task runs fine with nobody logged in, which is what makes
unattended automation work afterwards.

So a headless install can *use* grants created earlier, but cannot create new ones from the web UI.
That should be reported plainly rather than worked around.

## What core must provide

Two things, and they are small:

1. **A grant manager** — create/remove a Scheduled Task (Windows) or sudoers/polkit rule (Linux) for a
   fixed action, itself run elevated once via UAC. This is the piece that needs a signed, named binary.
2. **The elevate shim** — for variable actions that prompt every time, taking a structured action and
   writing a result file.

Both are packaging concerns, so they belong to the core app. Helpers may spawn processes, so a helper
can invoke either once it exists.

## Helpers built on this model

| Helper | Model | Status |
| ------ | ----- | ------ |
| `host-services` | **Grant once** — fixed actions on an allowlisted service | shipped · [`host-services/HELPER.md`](host-services/HELPER.md) |
| `host-install` | **Approve each time** — the package name is variable | shipped · [`host-install/HELPER.md`](host-install/HELPER.md) |

Both are on the stable channel. Versions are in [`addons.json`](../addons.json) rather than here,
because a version in prose is a sentence that goes stale without anyone editing it — this table said
`host-install` was "planned" for as long as it had been shipped.

**What building both actually settled:** the split above is not a preference, it is forced. A grant is
one Scheduled Task per fixed action, and `schtasks /run` takes a task name and cannot pass arguments —
so anything whose *target* varies (a package id, an arbitrary path) has nothing to bake into a grant
and must be approved as it happens. That is also why `host-services:control` can never offer an
"allow everything" switch: there is no fixed action to grant.
