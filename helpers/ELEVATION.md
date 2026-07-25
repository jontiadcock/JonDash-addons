# Just-in-time elevation — the model for helpers that touch the host

Some capabilities cannot be delivered by an unprivileged web app: starting a Windows service,
installing a package. This document is the **shared design** for how those helpers get privilege, and
the constraints every one of them must obey.

It exists because there are two ways to build this and only one of them is acceptable.

## The rejected design: a standing privileged agent

The conventional answer is a small daemon running permanently as root, taking requests from the app
over a local socket. It is how Docker Desktop and Chrome's updater work, and it was the first thing
proposed here.

**Rejected by the owner, 2026-07-25, and the objection is sound:** it means something on the machine is
always root, always listening. Compromise it once and privilege is permanent. For a self-hosted
personal dashboard, a root daemon that exists so a button can restart Plex is a poor trade.

## The model: privilege exists only for one approved action

```
module            asks the helper to do something privileged
   ↓              (a request — inert, changes nothing)
helper            queues it; nothing is elevated
   ↓
admin in JonDash  sees the EXACT action and approves it
   ↓
elevate shim      launched with `runas` → the OS shows its own prompt
   ↓
admin at the PC   clicks Yes on UAC
   ↓
action runs       elevated, once, then the process exits
```

Nothing is elevated before that click and nothing stays elevated after it. There is no persistent
privileged process anywhere in this design.

## The three constraints, and why each exists

### 1. It requires a real desktop session

**UAC can only prompt on an interactive desktop.** JonDash today always runs in the signed-in user's
session (`start-dashboard.bat`), so this works. It stops working if JonDash is ever run:

- **as a Windows Service** — Session 0 isolation puts the prompt on a desktop nobody can see;
- **in a container**, or on a **headless** box (a NAS in a cupboard).

**This is a hard boundary, not a rough edge.** A helper built on this model must detect that it cannot
prompt and say so plainly — never fall back to a standing privilege, and never queue an action it
cannot deliver.

### 2. UAC proves presence, not comprehension

This is the constraint people get wrong. The UAC dialog names **the program being elevated**. It cannot
be made to say *"install nginx, requested by the Docker module"*. So:

- UAC is a **strong** check that a human is physically at the machine.
- UAC is a **weak** check that the human understood what they approved.

**Therefore JonDash's own approval screen is the real consent surface**, and it must show the exact
action verbatim — the full command, the actual service name — before the admin clicks. The UAC prompt
is the second factor, not the explanation.

**Corollary: never elevate `powershell.exe` or `cmd.exe`.** A prompt reading "Windows PowerShell"
teaches the admin to approve exactly what malware wants, and is indistinguishable from an attack. The
elevated thing must be a **dedicated, meaningfully named binary** — ideally code-signed, so the prompt
reads a publisher rather than the yellow "Publisher: Unknown".

### 3. Structured actions, never a command string

The shim accepts **an action type and validated arguments** — `service-restart` + a service name from
the allowlist — and never a shell string composed by the caller.

This is defence in depth: with UAC as the only gate, anything that could inject into the request could
run arbitrary code the moment the admin clicks Yes. With structured actions, even a fully compromised
JonDash can only ask for the verbs the shim implements.

It also keeps the approval screen honest: an action you can render as a sentence is an action the admin
can judge. A shell string is something they skim.

## The bar to judge any of this against

Not *"is this safe in the abstract"* — nothing that installs software is. The right question is:

> **Is this worse than the admin typing the command themselves?**

With the exact command displayed, one approval per action, physical presence required and no memory of
past approvals, it is close to equivalent. What it adds over typing it yourself is a **confused
deputy** risk: the suggestion originates from a module rather than from you. That is exactly what the
verbatim display is there to counter, and why a request must never be able to approve itself.

## Rules every elevating helper must follow

1. **A module can only request.** A request is inert and grants nothing.
2. **One approval per action.** Never batched, never remembered, no "don't ask again".
3. **The exact action is displayed** before approval, in full, never truncated.
4. **An allowlist the admin owns**, stored helper-side. A module may name an entry; it may never add
   one. (Same shape as the `filesystem` helper's approved roots, which works.)
5. **No free-form commands from a module**, ever. A package name from an allowlisted manager is a
   value; a shell string is a program.
6. **"User declined" is a distinct, first-class outcome** — not an error, not a retry loop.
7. **Every elevated action is audited** with who approved it, what ran, and its result.
8. **If elevation is impossible** (service, container, headless), say so — never degrade to standing
   privilege.

## What core must provide

The shim is a **packaging** concern, so it belongs to the core app rather than this repo — a binary
shipped with JonDash at a known path, ideally signed. Helpers may spawn processes (that is explicitly
what helpers are for), so a helper can invoke it directly once it exists.

The contract is written up in the prompt sent to the core session; in short: a named executable that
takes a structured action plus a result-file path, runs it elevated, writes `{ok, exitCode, output}`,
and distinguishes a declined UAC prompt from a failed action.

## Helpers built on this model

| Helper | Status | Actions |
| ------ | ------ | ------- |
| `host-services` | spec — see `host-services/HELPER.md` | start / stop / restart an allowlisted service |
| `host-install` | planned | install a package from an allowlisted package manager |

**`host-install` inherits every rule above plus one:** the module supplies a **package name only**,
never arguments and never a command. `winget install Foo.Bar` is displayed in full and run as a fixed
shape. The residual risk is honest and must be documented where a user will read it: approve
`install nginx` and you get whatever that publisher ships today — the same risk as typing it yourself.
