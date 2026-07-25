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
2. ⏳ **AH-01 `docker` helper** → **AM-01 Docker manager** — the flagship; owner-led. The helper
   unlocks more than one module, so it earns its cost among the remaining work.
3. ⏳ **AM-04 Dynamic DNS** — no helper, small, a homelab staple. A quick win slottable anywhere.
4. ⏳ **AM-05 health-monitor: speed-test check** — enhancement to a shipped module, no helper. Small.
5. ⏳ **AH-03 `wireguard` helper** → **AM-03 VPN access manager** — highest value, heaviest, and the
   most dangerous consent. Its Tailscale slice needs no helper and could come earlier if wanted.

---

## Catalog

### AM — Add-on modules

#### AM-01 · Docker manager — "Hyper-V, but for Docker" — ⏳ Planned
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

#### AM-02 · Host vitals — 🔨 Built 2026-07-25 (`0.0.1-beta.1`)
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

### AH — Helpers

#### AH-01 · `docker` helper — ⏳ Planned
Talks to the **Docker Engine API over its socket** (`/var/run/docker.sock`, or the named pipe on
Windows) — the structured HTTP API, **never the `docker` CLI**. Verbs, narrow: `listContainers`,
`inspect(id)`, `stats(id)`, `logs(id, {tail})`, `start/stop/restart(id)`. Provides two capabilities,
`docker:read` and `docker:manage`, split because "restart my Plex" and "watch my Plex" are different
levels of trust. No `exec`, no image build, no arbitrary endpoint pass-through — those would reopen the
command-execution door the module verifier exists to shut.

#### AH-02 · `system-metrics` helper — 🔨 Built 2026-07-25 (`0.0.1-beta.1`)
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
