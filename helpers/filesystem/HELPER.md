# Filesystem helper

**Status: PART-BUILT, unpublished. Path safety, location testing and the copy engine exist and are
tested (38 tests). Root registration and the module-facing `api.ts` are not written yet, so nothing
can use it.** Requires JonDash **1.5.1-beta.1**, the release that let a helper name its own
capabilities.

| Piece | State |
| ----- | ----- |
| `lib/paths.ts` — canonical form, deny-list, containment | **built + tested** |
| `lib/probe.ts` — the explicit "Test this location" check | **built + tested** |
| `lib/copy.ts` — `sync` and `snapshot` | **built + tested** |
| `lib/roots.ts` — read side only | partial |
| Root registration, `api.ts`, run history | not started |
| `mirror` mode (deletes) | **deliberately not started** |

Lets a module copy, mirror and archive folders — and nothing else. It is the first consumer of
helper-named capabilities, so it is also the first real test of the consent roll-up.

- **Helper id:** `filesystem`
- **First consumer:** `backup-manager`
- **Grants:** three capabilities, all shown in red on the consent screen. See below.

---

## The rule this design exists to satisfy

The helpers charter says: *narrow, purpose-built APIs — never a general escape hatch.* A helper
exposing `readFile(path)` / `writeFile(path, bytes)` would make the module verifier ceremonial —
every restriction on modules becomes one helper call away, and any module granted this helper could
read `.data/secrets.json` (the master encryption key), `prisma/dev.db`, every session token and
every stored credential.

**So this helper exposes no file primitives.** It exposes *operations*: "mirror this folder to that
one". File contents never cross into module code. There is no call that returns the bytes of a
file, and there must never be one.

That is the whole design. Everything below follows from it.

---

## Capabilities

These are what an admin reads when they install **any** module that declares this helper.

| Capability | Label shown to the admin |
| ---------- | ------------------------ |
| `filesystem:read` | Look at files and folders in the locations you allow |
| `filesystem:write` | Create and change files in the locations you allow |
| `filesystem:delete` | Delete files in the locations you allow |

Three separate lines rather than one, deliberately. Every consumer of this helper inherits **all**
of them regardless of what it actually uses, so splitting costs nothing — and *"delete"* is far too
important to be folded into the word *"write"*.

> **Governing rule for this helper's future.** Because consent lists every capability of every
> helper a module declares, adding a capability here widens the disclosure for **every existing
> consumer, retroactively**. So this helper stays at these three. If something genuinely narrower is
> ever needed — a read-only log viewer, say — that is a **different helper**, not a broader one.

### The label is part of the API surface

If a change to this helper's API alters what it can touch, **the label changes in the same commit**.
Core cannot detect drift between what a helper does and what it says it does; nothing will catch
this but discipline. A pull request that widens a call and leaves the label alone is an incomplete
change, not a small one.

---

## Roots — the reason the labels can say "the locations you allow"

A **root** is an absolute path an administrator has explicitly approved. The helper stores roots in
its own `hlp_filesystem_roots` table, validates them on registration **and again on every use**, and
**every operation names a root by id — never by path.**

This is what makes the consent wording literally true. Without it, "the locations you allow" would
mean "anywhere a module later decides", and the browse-time label would be a lie.

**The module never holds the authority.** It renders the form — an admin types a path and confirms
it — but the helper owns the storage, the validation and the deny-list, and refuses anything that
fails them. A module cannot widen its own reach by asking nicely.

Every registration and removal is written to the audit log with the path and the admin who did it,
so a root that appears without the admin's knowledge is discoverable after the fact.

> **Open design question for review.** Helpers have no UI surface today — the Helpers page is
> deliberately read-only. This spec therefore has the *module* render the root form while the
> *helper* owns the rules, which needs no core change. Better would be the Helpers page listing each
> helper's registered roots read-only, so the admin can see the truth without trusting a module to
> present it. That is a small core change and I'd like it eventually, but nothing here is blocked on
> it.

### Paths the helper refuses, always

Non-negotiable, checked on registration and on every operation. Not configurable, not overridable:

- The JonDash installation directory and anything beneath it — `.data`, `prisma`, `node_modules`,
  `.next`, `logs`, and the rest. A backup tool that can write into the app is a backup tool that can
  replace the app.
- `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, and the equivalents on other platforms.
- A bare drive root (`C:\`, `D:\`) or a filesystem root (`/`).
- Any path that is not absolute, or that contains `..` after normalisation.
- A destination inside its own source, or a source inside its own destination — the classic way to
  make a mirror consume itself.

A refused path returns a clear reason. It is never silently narrowed to something that does work.

---

## API sketch

Imported by a consuming module as `@/helpers/filesystem/api`, which the verifier permits only if the
module declares `helpers: ["filesystem"]`.

```ts
// Roots — admin-approved locations
listRoots()                       → Root[]
registerRoot(path, { label })     → Root            // validates; throws with a reason
removeRoot(rootId)                → void            // does not touch files

// Looking — for a folder picker. Names and sizes only, never contents.
browse(rootId, subpath?)          → { name, isDir, bytes, modifiedAt }[]

// Testing — the explicit check an admin runs BEFORE saving a root.
testLocation(path, { wantWritable })  → { ok, message, exists, writable, elapsedMs }

// Backing up
plan(spec)                        → Plan     // a DRY RUN: what would change, and why
start(spec)                       → runId    // begins a run and RETURNS; never waits
progress(runId)                   → { filesDone, bytesDone, currentPath } | null  // in-memory, in-flight only
status(runId)                     → RunStatus | null   // PERSISTED outcome; survives the run ending AND a restart
cancel(runId)                     → void
```

**A consumer reconciles against `status`, it does not poll `progress`.** `start` returns an id and
returns; the copy runs in the helper's background and writes its outcome to
`hlp_filesystem_runs`. The consuming module reads `status` on its own schedule tick and updates its
records from it. Nothing blocks for the length of a backup, and a run left mid-flight by a restart is
healed to `interrupted` at the helper's boot — so a backup that didn't finish can never be mistaken
for one that did. This is the same event-free pattern the scheduler and health-monitor use.

```ts
type Spec = {
  sourceRootId: string;  sourcePath?: string;   // relative to the root
  destRootId:   string;  destPath?:   string;
  mode: "sync" | "mirror" | "snapshot";
  options?: {
    exclude?: string[];        // glob patterns
    deleteBudgetPct?: number;  // mirror only; default 25, 0 disables the guard
    keepArchives?: number;     // snapshot only
  };
};
```

### Modes

| Mode | Behaviour | Deletes? |
| ---- | --------- | -------- |
| `sync` | New and changed files copied. Nothing at the destination is ever removed. | No |
| `mirror` | Destination becomes an exact copy of the source. | **Yes** |
| `snapshot` | Fresh copy into a dated folder; the previous one is zipped. Keep the last *N*. | No |

`sync` and `snapshot` ship first. `mirror` ships only once the guards below have been tested against
real failures, not just unit tests.

---

## Safety rules, enforced in the helper

These live here rather than in the module. A module cannot switch them off, and a second consumer
inherits them for free.

1. **Never delete from an empty source.** If the source resolves to zero files, abort and report it.
   There is no legitimate case where mirroring an empty folder should empty a destination full of
   files. This is the single most common way people lose data to a mirror — the source fails to
   mount, presents as empty, and the mirror faithfully deletes the backup.
2. **Deletion budget.** If a `mirror` run would delete more than `deleteBudgetPct` of the
   destination (default 25%), stop before deleting anything and report what it wanted to do. A
   genuine large cleanup gets confirmed once; a mounting failure never gets the chance.
3. **Verify the source is really mounted.** For a removable or network root, confirm the root
   directory exists and is readable *before* trusting a file listing. A disconnected share and an
   emptied folder are indistinguishable from a listing alone.
4. **Record every deletion individually**, not as a count. "What did it remove last night" must be
   answerable.
5. **Never follow symlinks out of a root.** Resolve, then re-check containment.
6. **A run survives nothing.** If the server restarts mid-run the run is marked interrupted, not
   completed — a partially-copied backup must never be recorded as a good one.

---

## What it deliberately does not do

- **No file contents in or out.** No read, no write, no streaming. If a future consumer needs that,
  it is a different helper with a different consent line.
- **No arbitrary paths.** Everything is relative to an admin-approved root.
- **No shell.** No `robocopy`, no `rsync`, no `child_process`. The copying is Node, so behaviour is
  identical everywhere and there is no command string to inject into.
- **No cloud targets.** Out of scope; would need `network:outbound` and a credential story.
- **No scheduling.** That is the `scheduler` helper's job. A consumer declares both.

---

## Open questions for review

1. **Roots UI** — module-rendered form with helper-owned rules (as specified), or wait for a core
   change giving helpers a real settings surface? I've specified the former so nothing is blocked.
2. **Is `filesystem:delete` worth a separate capability**, given every consumer inherits it anyway?
   I say yes — the disclosure is more honest — but it is a judgement call.
3. **Archive format** for `snapshot`. Zip is the obvious choice and core already depends on
   `fflate`; a helper may import it, unlike a module.

## Validation never touches the network

**`assertUsable` is textual, instant and deterministic. `testLocation` does the I/O, and only
because somebody pressed a button.** The split is not tidiness — it is a bug fix.

Resolving symlinks with `realpath` on a UNC path makes Windows try to reach the server. Against an
unreachable host the same check took **187ms or 5 seconds** depending on whether the failure was
DNS-cached, and returned a *different verdict* each time. In a backup tool that means saving a NAS
destination would block the request thread and behave differently run to run.

So a network path is now canonical from its text alone; symlinks are resolved for local paths only,
which is where the deny-list escape actually lives. Reachability is a separate, explicit question
with a timeout. **Nothing on a save path, a render or a scheduled tick may probe.**

The trade, and it is a real one: a mistyped share name can no longer be caught when it is typed —
it surfaces when the admin presses *Test*, or at the first run. Fast and honest beats slow and
occasionally wrong.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.1-beta.1 *(unpublished)* | Path safety, location testing and the `sync`/`snapshot` copy engine, 38 tests. Three bugs found and fixed while writing them, all in path handling: a UNC share root was refused as if it were a whole drive (`path.parse()` reports a share as its own root); `path.normalize(String.raw`\\server`)` silently became `\server` on the *current drive*, so a missing share name became a real folder elsewhere; and validation was doing network I/O, per the section above. |
