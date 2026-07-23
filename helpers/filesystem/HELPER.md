# Filesystem helper

**Status: BUILT and published to the beta channel as `0.0.1-beta.1`. Proven end to end in a
browser against a real 1.5.1-beta.1 install** (see *Live test* below). Requires JonDash
**1.5.1-beta.1**, the release that let a helper name its own capabilities.

| Piece | State |
| ----- | ----- |
| `lib/paths.ts` — canonical form, deny-list, containment | **built + tested** |
| `lib/probe.ts` — the explicit "Test this location" check | **built + tested** |
| `lib/copy.ts` — `sync` and `snapshot` | **built + tested** |
| `lib/roots.ts`, root registration, `api.ts`, run history | **built + tested** |
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

Three separate lines rather than one, deliberately: *"delete"* is far too important to be folded
into the word *"write"*.

### Two screens, two behaviours — get this right

There are **two** places an admin reads these, and they do different things. An earlier draft of this
document got it wrong in both directions before landing here, so the precise version:

| Screen | Behaviour |
| ------ | --------- |
| **Browse / install** (`/admin/modules/browse`) — *pre-install, the screen that governs consent* | **Rolls up.** It unions the module's own permissions with **every** capability of **every** helper it declares. A module asking only for `filesystem:read` still shows the admin all three lines before it is installed. Labels come from the static `provides` in `addons.json`, since the helper isn't installed yet. |
| **Installed modules** (`/admin/modules`) — *post-install* | **Does not roll up.** One line per permission the module actually declared, worded by the helper's `describe()`. |

So the consent an admin gives **is** full disclosure of everything the helper can do. Declaring
narrowly does not reduce what they are shown at install time — it only changes the post-install
summary.

> **Governing rule for this helper's future.** Because the browse screen rolls up, adding a
> capability here widens the disclosure for **every existing consumer, retroactively** — a module
> that never asked for it will start showing the new line. So this helper stays at these three. If
> something genuinely narrower is ever needed — a read-only log viewer, say — that is a **different
> helper**, not a broader one.

### Enforcement — fixed in core 1.5.2, to be adopted here

Through 0.0.2 these capabilities were **disclosed but not enforced**. `ModuleContext` carried no
record of what a module was granted: core capabilities are enforced *structurally* (`ctx.fetch`
simply isn't there unless `network:outbound` was granted), but a helper API is imported directly, so
nothing can be withheld and the verifier's check is one binary gate on the whole helper. Verified
live — the `Module` row granted read + write only, while every method stayed callable.

Core **1.5.2-beta.1** adds `ctx.grants` (a frozen `readonly DeclaredPermission[]`) and
`ctx.can(permission)`. Frozen deliberately: an unfrozen array could be pushed onto by the very module
a helper is about to check it against.

**To adopt** (needs `minAppVersion: "1.5.2-beta.1"`, since `ctx.can` does not exist before it):
`browse` and `plan` require `filesystem:read`; `start` requires `filesystem:write`; any future
deletion requires `filesystem:delete`. A caller that didn't declare the capability is refused with a
reason, and the refusal is audited like any other.

Note what this does and does not change. The admin was **already shown** all three capabilities at
install time (the browse screen rolls up — see above), so this was never an under-disclosure. It was
that the disclosure had no teeth: a module could call past what it declared. Enforcement makes the
declared subset mean something.

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

### Reading and writing follow different rules — 0.0.2 onwards

Until 0.0.2 one deny-list governed both directions, and it refused any location touching JonDash or
the system. That was **simultaneously too strict and too weak**: you could not back up `C:\` at all,
and the protection was defeated by moving a file, because it protected a *path* rather than a
*secret*. `JONDASH_DATA_DIR` or a relocated `DATABASE_URL` walked straight around it.

So the rule split in two.

**Reading — permissive.** A source may be anything: a whole drive, a user profile, even JonDash's
own folder. The protection moved onto the files themselves (see *The secret registry* below), and
breadth is **warned about, not blocked** (*Warnings* below). Only a path that isn't a path is
refused — not absolute, containing `..` after normalisation, or a bare `\\server` with no share.

**Writing — strict, and not negotiable.** Backups may never be written into:

- The JonDash installation directory or anything beneath it. A backup tool that can write into the
  app is a backup tool that can **replace** the app: overwrite `modules/`, drop something into
  `.next`, and the next restart runs it. No warning covers that.
- `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, and the POSIX
  equivalents.

A **drive root is allowed as a destination** — `E:\` is what an external backup disk looks like, and
refusing it would rule out the most ordinary target there is.

**Both directions**: a destination inside its own source, or a source inside its own destination, is
refused — the classic way to make a mirror consume itself.

A refused path returns a clear reason. It is never silently narrowed to something that does work,
and **the helper audits its own refusals** rather than trusting the calling module to report them.

---

## The secret registry — what actually protects the key

`lib/secrets.ts`. The question it answers is not *"is this path forbidden?"* but **"which files on
this disk ARE the secrets, right now?"**

It resolves them from the same configuration the running app reads — `JONDASH_DATA_DIR`,
`DATABASE_URL`, `ENCRYPTION_KEY`, the `.env` — and then matches them by **file identity**, not by
name.

### Why identity beats path

`fs.stat()` reports a volume serial (`dev`) and file index (`ino`), on NTFS as well as POSIX. That
pair survives a rename, a move within the volume, a hard link, and any casing or junction used to
reach the file. Verified on Windows: the same file renamed, moved into a subfolder, reached via
`SUB\DEEP.JSON`, and opened through a hard link all reported one identity, while a *copy* reported a
different one.

Directories have identities too, so `.data` is stepped over in a single comparison rather than one
per file inside it.

### Three tiers, and the honest limit of each

| Tier | Catches | Cost |
| ---- | ------- | ---- |
| **1 — identity** | The live secrets wherever they now live, plus every alternate route to them | One `Set` lookup on a `stat` the walk already took |
| **2 — content** | A verbatim *copy* (`secrets.json.bak`), and the master key's literal value pasted into any small file | One hash, and only on files under 64 KB that are actually about to be written |
| **3 — nothing** | A re-encoded secret, a key in a screenshot, a value retyped by hand | — |

Tier 2 exists because a copy has its own identity, so tier 1 is blind to it. Tier 3 is **data-loss
prevention**, an entire product category that does not work reliably, and this helper must not imply
otherwise. What it promises is precise: *JonDash's own secrets, and verbatim copies of them.*

If the key cannot be resolved at all, the run log says so in its header rather than implying full
protection.

> **One duplicated line, deliberately called out.** Core does not export `dataDir()`, so
> `secrets.ts` mirrors it. If core ever changes how the data directory is located, this must change
> with it. **Asked of the core session: export `dataDir()` / `secretsPath()`** so the duplicate can
> go.

---

## Warnings — because it no longer refuses

`lib/risk.ts`. Excluding JonDash's secrets makes a broad backup safe *for JonDash*, and says nothing
about the rest of the disk. Copying `C:\` to a network share also carries browser password stores,
SSH keys, and credential caches for every profile on the machine — none of which this helper knows
how to protect.

So `assessPath()` returns a level, what is actually in there, and what to do instead:

| Location | Level | What the admin is told |
| -------- | ----- | ---------------------- |
| A whole drive | **high** | It's the OS and every account, and locked files mean unavoidable errors |
| User profiles | **high** | Saved passwords, SSH and cloud keys, credential caches |
| System directories | **high** | Not useful in a backup and not all readable |
| Contains JonDash | caution | Its secrets are skipped automatically and listed in the log |
| Anything else | none | — |

Purely textual — no I/O, no network — so it is safe to call while rendering a form. **A refusal the
admin cannot override teaches them to work around the tool; a warning they must read leaves them in
charge with their eyes open.**

---

## Run logs and retention

Every run writes a plain-text log naming **every file it copied, skipped or failed on**. This is not
a nicety: the helper now *steps over* things instead of refusing the job, and a skip nobody can
enumerate is indistinguishable from a bug. A backup missing files you were never told about is
discovered at restore time, which is far too late.

**Where:** `<install>/logs/helpers/filesystem/<runId>.log`. Three properties had to hold at once —
it survives an update (`logs` is in the updater's preserve list), it stays *out* of JonDash's own
config backup (which walks `.data` with an *exclude* list, so anything there travels inside every
backup file), and it sits where JonDash already logs.

**Size:** past 32 MB the per-file successes stop being listed, but **skips and errors keep being
written**. When something has to give, the lines that exist for accountability are the ones worth
keeping.

**Retention:** `keepDays` (default 30) and `keepRuns` (default 50). Both rules apply — a log goes if
it is too old *or* has fallen outside the most recent N. Either set to `0` disables that rule; both
`0` keeps everything. Applied when a run starts and again at boot, so an idle server still prunes.

**Reading a log is treated as untrusted input.** `readLog(runId)` is reachable from a page, so the id
is validated against `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`. A log viewer that would read
`../../.data/secrets.json` hands back the very thing the rest of this helper exists to protect.

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

## Live test — 2026-07-23, JonDash 1.5.1-beta.1

Driven through a browser by a throwaway `fs-demo` module against real scratch folders, on a
testbed built from the published release. What it proved:

| # | Check | Result |
| - | ----- | ------ |
| 1 | Migrations create `hlp_filesystem_roots` / `hlp_filesystem_runs`; `Helper` row records all 3 capabilities | pass |
| 2 | Consent screen words the capabilities in English, filesystem ones flagged dangerous | pass |
| 3 | Helpers page lists the helper, its version and its dependent module | pass |
| 4 | Deny-list refuses the JonDash install directory, with a reason | pass |
| 5 | Deny-list refuses `.data` *inside* it — containment, not string prefix | pass |
| 6 | Root registration persists with the admin's user id | pass |
| 7 | `testLocation` on a local folder: found + writable in **3ms**, leaving no marker behind | pass |
| 8 | `testLocation` on an unreachable UNC: failed in **1.25s**, no hang | pass |
| 9 | Copying a folder into itself is refused | pass |
| 10 | `sync` copied 3 files / 32 bytes, recreated the nested subfolder, contents identical, mtimes carried | pass |
| 11 | Re-run copied **0 files**; after changing one file, exactly **1 file / 25 bytes** | pass |
| 12 | Every run persisted to `hlp_filesystem_runs` against the calling `moduleId` | pass |
| 13 | Audit entries namespaced per module (`module.fs-demo.filesystem.root.add`) | pass |
| 14 | A run left `running` became `interrupted` at the next boot | pass |

Two defects found, both in this helper and both still open:

1. **Refused root registrations are not audited.** Only successes reach the audit log. A refusal is
   the more interesting event — it is a module reaching outside its bounds — and recording it
   currently depends on the *consuming module* choosing to, which a hostile one would not. The
   helper should audit its own refusals.
2. **A raw OS error code reaches the admin.** An unreachable share reports
   `Couldn't open that folder (UNKNOWN).` `UNKNOWN` is a Windows code, not English. It should say
   the network location couldn't be reached and what to check.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.0.2-beta.1 *(unpublished)* | **Protection moved from paths to files.** A source may now be anything — a whole drive, JonDash's own folder — because the secrets inside are excluded by *file identity* resolved from the app's live configuration, so the exclusion follows a secret that has been moved. Writing stays strictly bounded. Adds warnings for broad locations, downloadable per-run logs with retention, `assessPath()`, and audit of the helper's own refusals. 77 tests. Two bugs fixed from the 0.0.1 live test (unaudited refusals; `UNKNOWN` leaking into an error message) and one found here: reading retention coerced before testing for absence, so `Number(null) === 0` turned "never configured" into "keep nothing" — caught in a browser, not by a unit test, and now pinned by one. |
| 0.0.1-beta.1 *(unpublished)* | Path safety, location testing and the `sync`/`snapshot` copy engine, 38 tests. Three bugs found and fixed while writing them, all in path handling: a UNC share root was refused as if it were a whole drive (`path.parse()` reports a share as its own root); `path.normalize(String.raw`\\server`)` silently became `\server` on the *current drive*, so a missing share name became a real folder elsewhere; and validation was doing network I/O, per the section above. |
