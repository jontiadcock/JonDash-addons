# JonDash add-ons — roadmap

What's worth **building next** in this repository: add-on modules and the helpers they need. It is a
planning doc, not a record of what exists — shipped modules and helpers live in `addons.json` (the
source of truth for versions) and in each one's `MODULE.md` / `HELPER.md`. Nothing here is committed
to; priority is the owner's call.

Sister docs: the **core app's** own roadmap is `JonDash/docs/ROADMAP.md` (framework work, `MOD-##`
etc.) — different repo, different concern. `VERSIONING.md` here is how anything below gets published.

## IDs and status

Stable IDs that never change and are never reused, so a reference always resolves:
- **`AM-##`** — an add-on **module** (a product installed from Browse).
- **`AH-##`** — a **helper** (first-party privileged capability a module depends on).

Status: ⏳ Planned · ▶️ In progress · 🔨 Built (unpublished) · ✅ Shipped · 🧊 Backlog · 🌅 Someday.
When an item ships it leaves the build queue; its catalog entry records the version and stays for
reference.

## The rule that shapes every item here

A module is verifier-sandboxed: no processes, no filesystem, no sockets — only `ctx` (outbound HTTP,
crypto, audit, email, its own storage, a schedule). So each idea is one of two kinds:
- **Cloud/HTTP only → a plain module**, no helper. Talks to a remote API with `network:outbound`.
- **Touches a local daemon, socket or the host → needs a helper**, because a module cannot.

**Every helper exposes narrow, purpose-built verbs and never `run(command)`.** Docker, WireGuard and
host metrics each have a *structured* interface (the Docker Engine socket, the WireGuard config/daemon,
`/proc` & OS APIs) the helper talks to directly. A generic-exec helper would make the module sandbox
decorative and must never be built. Helper capabilities roll up into the consuming module's consent
screen via `provides` (shipped in JonDash 1.5.2).

**All of the below is buildable on the current framework — no core changes required.**

---

## Build queue (proposed order — owner to confirm; reorder freely)

Ordered by a mix of value, reuse and the owner's stated enthusiasm (2026-07-25). **Not yet confirmed.**
A helper is built with or just before its first consumer.

1. ✅ **AH-02 `system-metrics` helper** → **AM-02 Host vitals** — **shipped 2026-07-25.** `0.0.1` on
   stable; `0.0.2-beta.1` on beta adds eight more readings with per-metric switches. Taken first as
   the quickest read-only pair, and used to prove the two-phase build process below.
2. ⏳ **AH-01 `docker` helper** → **AM-01 Docker manager** — the flagship; owner-led. Spec written.
   **Blocked on a testing decision**, not on design: there is no Docker engine on the development
   machine, so the connected-engine path can't be exercised the way `system-metrics` was.
3. ✅ **AH-04 `host-services`** → **AM-06 Service manager** — **SHIPPED 2026-07-25**, both
   `0.0.1-beta.2` on beta, needing JonDash **1.7.1-beta.2**. The elevation model in
   `helpers/ELEVATION.md` is now proven end to end rather than designed: one approval when a service
   is added, then start and stop with no prompt, and a grant that a standard user cannot edit,
   disable or delete. **This unblocks AH-05, and it is the model AM-01 leans on for installing
   Docker.**
4. ⏳ **AM-04 Dynamic DNS** — no helper, small, a homelab staple. A quick win slottable anywhere.
5. ⏳ **AM-05 health-monitor: speed-test check** — enhancement to a shipped module, no helper. Small.
6. ⏳ **AH-05 `host-install`** — same elevation model as AH-04, so it follows it.
7. ⏳ **AH-03 `wireguard` helper** → **AM-03 VPN access manager** — highest value, heaviest, and the
   most dangerous consent. Its Tailscale slice needs no helper and could come earlier if wanted.

---

## Catalog

### AM — Add-on modules

#### AM-07 · Virtualization manager — ⏳ Planned (owner direction, 2026-07-26)

**`docker-manager` becomes `virtualization-manager`:** one UI over whatever runs isolated workloads on
this host — Docker today, then Hyper-V, WSL, and possibly Podman or Proxmox.

**Broad MODULE, narrow HELPERS. This is the whole design decision.** A consumer discloses *every*
capability of *every* helper it declares, so a single `virtualization` helper covering both would make
a module that only lists containers say **"can control virtual machines"** on its consent screen —
permanently, for every future consumer. Stopping a container and stopping a VM are not the same power
and must not share a line. Same reasoning that split `host-install` from `host-services`, and the same
reasoning behind the 2026-07-26 security fix.

They also share almost no code: Docker is HTTP over a local socket, Hyper-V is WMI/PowerShell, Proxmox
is REST with credentials over a network. The common part is the name.

- **Helpers:** `AH-01 docker` (built) · `AH-06 hyper-v` · `AH-07 wsl` — each with its own capabilities.
- **The module declares only what it uses**, so an admin can grant Docker without granting Hyper-V.
- **Rename while it is cheap.** `docker-manager` is `0.0.1-beta.1` with no users; a module id is a
  stable identifier and renaming later orphans its data.
- **Get Docker right first** (owner, 2026-07-26). The rename and the second engine come after the
  Docker feature set is settled — a second engine built on a shaky first one inherits the shakiness.

#### AM-09 · App catalogue — deploy containers from templates — ⏳ Planned (owner, 2026-07-26)

Owner's goal, stated plainly: ***"make people want to use it because it is better than Docker
Desktop."*** Docker Desktop gives you a list; the draw is a curated set of things you can actually
**deploy in one click** — Plex, Pi-hole, Home Assistant, Immich — the way CasaOS and Umbrel do.

**This is a much bigger security step than everything shipped so far, and it must not be slipped in as
a convenience.** Every capability to date is *lifecycle on things that already exist*: the helper has
no `create`, no image pull, no volume or network operations, deliberately. Deploying an app means
creating containers — and **a container created with the wrong flags is root on the host**
(`--privileged`, `-v /:/host`, `--pid=host`, docker socket mounted through). A one-click catalogue is
therefore a route to arbitrary host compromise unless the template is the boundary.

Design direction, to be settled before any code:

- **Templates are data with a fixed shape, never a compose file or a command.** The module supplies a
  template id and the user's choices (ports, a data folder); the helper builds the create request. If
  a template could name arbitrary mounts or flags, the template *is* the exploit.
- **A refused list that cannot be overridden:** privileged, host PID/network/IPC namespaces, mounting
  `/` or the docker socket, and `cap_add` beyond a tiny allowlist.
- **Its own capability** — `docker:deploy`, red, separate from `docker:manage`. A module that only
  restarts containers must never disclose the power to create them.
- **Where templates come from is the real question.** A remote catalogue means someone else's JSON
  decides what runs as root on the owner's machine. First-party and versioned in this repo is the only
  version that starts safe; a third-party catalogue is a separate decision with a separate consent.

**Links to vendor pages are the cheap half and can ship first** — no new capability, no risk, and it
answers "what can I run?" while the deploy path is designed properly.

#### AM-10 · Start Docker when the machine starts — ⏳ Planned (owner asked, 2026-07-26)

**It does not do this today, and cannot.** The module runs when a page is rendered; nothing in it runs
at boot, and it has no way to start the engine before JonDash itself is up.

What is realistic: Docker Desktop has its own *"Start Docker Desktop when you log in"* setting, and
that is the correct answer for most people — the module should **detect whether it is set and offer to
turn it on**, rather than inventing a competing mechanism. The engine's Windows service
(`com.docker.service`) can also be allowlisted through `host-services`, which is already shipped, so
"start the engine" becomes a button that reuses proven machinery.

- **Needs:** `AH-04 host-services` (shipped) for the service, plus a way to read/set the Desktop
  autostart preference — likely a registry read, which needs no new capability.

#### AM-08 · Installing Docker felt clunky — ⏳ Planned (owner, 2026-07-26)

First real install worked, but the flow is rough. **Not yet diagnosed** — capture what was actually
awkward before redesigning, rather than guessing. Known candidates: `installPackage` blocks for minutes
with no progress (core deliberately has no progress stream, so the module must poll `isInstalled` and
does not yet); Docker Desktop needs WSL2 and a restart, which the module mentions but does not check
for or sequence; and after a successful install the engine is not running, so the page still says
"Docker isn't running" with no obvious next step.

- **Needs:** nothing new from core — this is module-side sequencing and honesty about long operations.

#### AM-01 · Docker manager — "Hyper-V, but for Docker" — ✅ SHIPPED 2026-07-26 (stable)
Owner request, 2026-07-25, and the lead idea: **an easy, visual way to run Docker**, the way Hyper-V
Manager is to VMs. A grid of containers, each a tile showing name, image, state and health, live
CPU/memory, with start / stop / restart, and tail-the-logs in a panel. A dashboard widget summarises
"N running, M stopped, K unhealthy". Group by Compose project where one is set.

- **Needs:** `AH-01 docker` (the module itself only renders and calls the helper).
- **Permissions on the consent screen:** `docker:read` (see containers, stats, logs) and
  `docker:manage` (start/stop/restart) — the manage line is dangerous and must say so plainly.
- **Deliberately NOT in v1:** creating containers, editing Compose files, arbitrary `exec` into a
  container, volume/network editing. Those are power-user surface area and some are close to remote
  code execution; start with *observe + lifecycle* and earn the rest.
- **Later modules the same helper unlocks:** a Compose stack up/down viewer, and a stale-image checker
  (flag containers whose image has a newer digest upstream — pairs with the scheduler).

#### AM-02 · Host vitals — ✅ SHIPPED 2026-07-26 (stable)
Owner request, 2026-07-25. The homelab "is my box OK" widget: CPU, memory, load, disk free per mount,
temperatures, uptime. Admin-only. **Built and verified; publishing to beta.**

- **Needs:** `AH-02 system-metrics`.
- **Permissions:** one read-only line — "See this server's CPU, memory, disk usage, uptime and
  temperature." Mild disclosure, admin-only, no writes.
- **As built:** a verdict-led dashboard tile (leads with the *problem* — a disk nearly full, memory
  tight — not a count) plus a detail page with every disk, load average and any temperatures. Stores
  nothing: no settings, no tables, no migrations. Trend was dropped from v1 — it would require the
  module to persist snapshots, and the value is in the glance.
- **Built from documentation only**, as a deliberate test of the helper handoff — see the note under
  AH-02.

#### AM-03 · VPN access manager — ⏳ Planned
Owner request, 2026-07-25. Manage remote access to the home network from JonDash. Two providers, two
very different shapes:
- **Tailscale — no helper.** The tailnet admin API is cloud HTTP: list devices, see who's online,
  expire a key, view ACLs, with an encrypted API token. Pure `network:outbound` + `crypto:use`.
  **The natural first slice**, since it ships without touching the host.
- **WireGuard — needs `AH-03`.** Peers live in a local daemon / `wg0.conf` on the host. The valuable,
  hard part is minting a client config + QR code for a new device; that is exactly what the helper is
  for. OpenVPN is the same idea via its management socket, heavier — a later slice, if at all.
- **Permissions (WireGuard slice):** `wireguard:read` and `wireguard:manage`. The manage line is the
  bluntest consent in the whole repo — *"Add or remove devices that can reach your entire network"* —
  and every generated peer key is handled like a secret: created in the helper, shown once, never
  stored readable.

#### AM-04 · Dynamic DNS — ⏳ Planned
Owner request, 2026-07-25. Keep a DNS record pointed at a home connection whose public IP changes.
Detect the current public IP, push it to the registrar (Cloudflare, Namecheap, …) on a schedule and on
change, log each update, alert on repeated failure.

- **Needs:** no helper — `network:outbound` (detect IP + call the registrar API) + `crypto:use` (store
  the API token encrypted) + the `scheduler` helper for the timer.

#### AM-05 · health-monitor: periodic speed-test check — ⏳ Planned
Owner decision, 2026-07-25: **speed-test is an enhancement to the shipped `health-monitor` module, not
a standalone module.** Add a check type that measures throughput on a schedule and charts it over time,
so a degrading connection is visible alongside uptime. HTTP-based measurement (download a known-size
resource, time it) rather than a `speedtest` binary, so it stays inside the module sandbox — no helper.

- **Home:** a new check kind in `addons/health-monitor`, shipped as a normal version bump of that
  module, promoted to stable like any other change to it (see `VERSIONING.md`).

#### AM-06 · Service manager (`service-control`) — ✅ SHIPPED 2026-07-26 (stable)
Start, stop and restart the services an administrator has approved, from a dashboard tile and a page.
The consumer that `AH-04 host-services` needed — a helper cannot be tested alone, because the install
path, the consent roll-up and the prune all run through a consuming module.

- **Needs:** `AH-04 host-services`, and JonDash **1.7.1-beta.2** — not merely for the imports, but
  because on beta.1 an elevated action could still proceed when its audit entry failed to write, and
  this module tells administrators that every elevated action is recorded.
- **Proven on real hardware, not asserted:** one UAC prompt when a service is approved, then stop and
  start with none, verified by reading the service's actual state either side; removing prompts again;
  and a grant cannot be repointed, disabled or deleted by the account that uses it.
- **Was known wrong, now fixed (2026-07-26):** the approved-services list used to be edited from
  *this module's* settings panel — helper configuration, edited by the thing it bounded. JonDash
  1.7.1 gave helpers their own settings page and 1.7.2 the Permissions screen, so the editor moved
  out and the helper's `admin.*` API was deleted outright. Modules now have no mutator at all, which
  is HELPERS-DESIGN rule 8.
- **Promoted to stable 2026-07-26**, once JonDash 1.7.2 reached the stable channel.

### AH — Helpers

#### AH-01 · `docker` helper — ✅ SHIPPED 2026-07-26 (stable)
Talks to the **Docker Engine API over its socket** (`/var/run/docker.sock`, or the named pipe on
Windows) — the structured HTTP API, **never the `docker` CLI**. Verbs, narrow: `listContainers`,
`inspect(id)`, `stats(id)`, `logs(id, {tail})`, `start/stop/restart(id)`. Provides two capabilities,
`docker:read` and `docker:manage`, split because "restart my Plex" and "watch my Plex" are different
levels of trust. No `exec`, no image build, no arbitrary endpoint pass-through — those would reopen the
command-execution door the module verifier exists to shut.

#### AH-02 · `system-metrics` helper — ✅ SHIPPED 2026-07-26 (stable)
Reads host telemetry and returns it structured. Entirely read-only — one capability,
`system-metrics:read`, and **no write verb of any kind**, which makes its consent line honest and its
blast radius nil. Cross-platform was the real work (Linux `/proc` + `/sys` vs Windows drive letters);
the API is identical everywhere and the implementation branches.

**As built:** a single call, `read()`, returning one `Snapshot` — host, CPU (with per-platform load
average), memory, mounted disks, best-effort temperatures. Not the six separate verbs sketched above:
a widget wants all of it at once, and one call means one consistent moment rather than six readings
taken microseconds apart. Stateless — no tables, no migrations, no `onBoot`, no config. Dependency-free
(`node:os`, `fs.statfs`, `/proc`, `/sys`).

**Fields degrade rather than lie:** load average is `null` on Windows (Node reports zeros; a fake
`0.00` is worse than an absent row) and `temps` is `[]` where no sensor exists.

> **This pair was the first deliberate test of the helper→module documentation handoff** (owner's
> idea, 2026-07-25): the helper was built with full access, then the module was built **from
> `HELPER.md` and the authoring docs alone**, with the helper's source treated as off-limits. Every
> point where the docs came up short was fixed in the docs rather than worked around. The process is
> worth repeating for `AH-01 docker`.

#### AH-04 · `host-services` helper — ✅ SHIPPED 2026-07-26 (stable)
Consumer: **AM-06 Service manager**. Needs JonDash **1.7.1-beta.2**. Everything below was the design;
all of it is now measured. Everything privileged goes through core's `@/lib/elevation` rather than
spawning the binary, so every elevated action — including the restart itself — reaches the audit log.

Start / stop / restart **services the administrator explicitly listed**, so a module can be a control
panel for its own machine. Two capabilities: `host-services:read` and `host-services:control` — where
"control" means *may raise a request*, not *may act*, and the label says so.

**Elevation is granted once per service, not per action** (`helpers/ELEVATION.md`). Adding a service
creates a fixed OS-level grant — a Scheduled Task on Windows, a sudoers/polkit rule on Linux — and that
is the only UAC prompt. It survives restarts of JonDash and of the machine, and works with nobody
logged in, which is what makes overnight automation possible at all.

Safe because the grant is **self-contained and unparameterised**: `schtasks /run` cannot pass arguments
(verified), so what can happen without a prompt is fixed at the moment the admin approved it and
enforced by Windows rather than by our code. **No standing privileged agent** — the owner rejected that,
rightly: a root daemon existing so a button can restart Plex is a poor trade.

The allowlist is the boundary and it is the `filesystem` helper's proven shape — admin-owned config, not
a caller's argument. A module may *suggest* an addition (one open suggestion at a time, 7-day cooldown
after a decline); nothing promotes a suggestion but an admin edit.

- **Blocked on:** the core **grant manager** — a small, ideally signed binary that creates and removes
  one OS grant, itself elevated once via UAC. Sent to the core session 2026-07-25.
- **Boundary:** *creating* a grant needs an interactive desktop session, so as a Windows Service
  (Session 0), in a container or headless, adding an entry refuses and says why. *Using* an existing
  grant works anywhere, logged out included.

#### AH-05 · `host-install` helper — ✅ SHIPPED 2026-07-26 (stable)
Install a package from an allowlisted package manager (`winget`, `apt`) at the admin's approval. Same
elevation model, plus one rule: the module supplies a **package name only** — never arguments, never a
command string. A package name is a value; a shell string is a program.

Judged against the right bar — *is this worse than the admin typing the command themselves?* — it is
close to equivalent, given the exact command is shown verbatim, approval is per-action and never
remembered, and physical presence is required. The residual risk is honest and must be documented where
someone will read it: approve `install nginx` and you get whatever that publisher ships today.

#### AH-03 · `wireguard` helper — ⏳ Planned
Manages WireGuard peers against the host's config/daemon: `listPeers`, `status`, `addPeer(name)` →
returns a ready client config + QR **once**, `removePeer(id)`. Provides `wireguard:read` and
`wireguard:manage`. Peer private keys are generated inside the helper and never persisted in readable
form — the same identity-and-secrets discipline the `filesystem` helper already uses. Talks to
`wg`/the config directly; no general exec.

---

## Considered and declined

| Idea | Decision |
| ---- | -------- |
| **Secret / API-key vault module** | **Declined by the owner, 2026-07-25** — *"too scary for how untested this app is."* Storing the homelab's credentials in a young, unaudited app concentrates risk for little gain over an existing password manager. Revisit only after a security pass, if ever. |
| **Speed-test as its own module** | **Folded into `health-monitor` (AM-05)**, 2026-07-25 — it is a measurement over time, which is what that module already is. |

## Open design questions

- **A shared `notify` helper?** Telegram / Discord / ntfy alerts are all just outbound HTTP, so no
  privilege is needed — but without a shared helper, every module (`health-monitor`, `backup-manager`,
  a future Docker-update watcher) carries its own alert config and its own consent line. A `notify`
  helper would centralise routing and config at the cost of slightly bending the "helpers are for
  privileged capability" charter. **Needs the owner's and the core session's agreement before it is
  built** — raised 2026-07-25, undecided.
