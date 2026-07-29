# Docker manager

**Status: BUILT, not published.** `0.0.1-beta.1`, needs JonDash **1.7.1-beta.7**.

See the containers on this server and start, stop, pause and restart them — and install Docker if it
isn't there yet.

## What it can never do

The module touches no container and no socket. Everything goes through the `docker` helper, which
exposes operations rather than the engine, so these are properties of that API rather than promises
made here:

- **No running commands inside a container.** `exec` is arbitrary code execution, usually as root on
  the host. It does not exist and is not a later feature — a console would be a different capability,
  declared in red, decided deliberately.
- **No creating or deleting containers**, and **no image or volume operations**.
- **No naming an endpoint, path, method or body.** A container id and a verb from a fixed list.

## Before Docker exists

This is the part that earns its keep on a machine with nothing installed. Four states, four different
fixes — the third is the one nobody diagnoses unaided:

| State | What it shows |
| --- | --- |
| Not running | Install steps, a copy-paste `winget install Docker.DockerDesktop`, and a button to ask an admin to install it |
| Running, no access | The account JonDash runs as needs to be in **docker-users** — and to sign out and back in |
| Timed out | It may still be starting |
| Running | The manager |

"Not installed" and "installed but stopped" are not distinguishable from the socket alone, so the page
offers both rather than guessing.

## Installing Docker

Goes through `host-install`, which means **two gates**: an administrator approves it in JonDash, where
the package id is shown verbatim, and then Windows asks again. The module can only ask.

**Its consent screen is heavy — five red lines**, because declaring `host-install` means disclosing the
power to install software even while you are only looking at a container list. That is the honest cost
of the install button being built in rather than living elsewhere, and it is stated rather than hidden.

## Removing Docker

> **Clean up what you created, never what you found.**

Offered **only if JonDash installed it**. If you installed Docker yourself, the module says so and
offers nothing — it is not ours to remove.

Asked on the **uninstall confirmation** (core's `uninstallQuestions`, 1.7.1-beta.7), because the moment
someone thinks about removing Docker is the moment they remove the module. Defaults to **off**;
containers and volumes go with it. The settings panel also carries a Remove button for doing it
deliberately at any other time.

## Performance

`stats()` costs about a second per call — Docker samples CPU twice, roughly a second apart — so it is
fetched **on the page only, never in the widget**. A dashboard renders whether or not anyone is looking
at the tile; names and states are cheap, resource use is not.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.5-beta.1 | **The tile now fits any size the user gives it (JonDash 1.8.0 B5/B6).** The dashboard became a grid of square units you can size from 1×1 upward, and the frame clips rather than scrolls, so the tile now shows only what genuinely fits: at 1×1 a single figure, from ~6rem the name and summary, from ~8rem the detail list. Rows are one line each and flow into extra columns when the tile is wide and short, and they are in priority order so anything clipped is always the least urgent thing. `minAppVersion` rises to `1.8.0-beta.14` — the exact build where the dashboard frame became a CSS `@container`; on anything older the container queries never match and the labels could never appear. **`.slice(0, 6)` is gone**, and containers now sort unhealthy first, then stopped, then running. When Docker is unreachable the 1×1 form is a dash rather than a truncated “Dock…”. |
| 0.0.1-beta.1 | First build. Engine detection, container list with live state, start/stop/pause/unpause/restart, logs, install and remove flows. **Never run against a real engine** — there is no Docker on the development machine, so every connected path is unexercised. |
