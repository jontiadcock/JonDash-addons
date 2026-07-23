# Backup Manager

Copies folders you choose to somewhere else — a network share, an external drive — on a schedule,
keeps dated copies if you want them, tidies old ones away, and tells you when a backup stops being
healthy.

- **Module id:** `backup-manager`
- **Version:** `0.1.1` on both channels
- **Minimum JonDash version:** `1.5.2-beta.1` — the **pre-release**, deliberately. Semver ranks
  `1.5.2-beta.1` *below* `1.5.2`, so a bare `"1.5.2"` would be refused on every 1.5.2 beta, which is
  exactly what beta-channel users run. 1.5.2 is the release that added `ctx.can()` enforcement, which
  the filesystem helper needs.
- **Permissions requested:** `filesystem:read`, `filesystem:write`, `filesystem:delete`, `email:send`,
  `network:outbound`, `audit:write`
- **Helpers required:** `filesystem` (pinned to at least `0.0.3-beta.1`) and `scheduler` — both
  installed automatically with the module
- **Visibility:** admins only (`adminOnly: true`) — the paths alone tell you how the machine is laid
  out

---

## What it does

You define **backups**. Each one names a source folder, a destination folder, and when to run.

Two modes:

- **`sync`** — keep the destination up to date with the source. Files that changed are copied again;
  files that did not are skipped.
- **`snapshot`** — make a new dated folder each run (`2026-07-23-02-00-00`), so you keep history
  rather than only the latest state.

Snapshots can be tidied automatically on a **grandfather-father-son** schedule: keep a week of daily
copies, a month of weekly ones, a year of monthly ones. Tidying **deletes**, so it is off until you
turn it on for a particular backup, and you can preview exactly what would go before anything does.

### Why there is no restore button

Deliberate, and worth stating plainly: **what this produces is ordinary files.** `sync` leaves a plain
mirror; `snapshot` leaves plain dated folders. Both are already usable — open the destination and copy
back whatever you want, with whatever tools you normally use.

A restore button would add the single most dangerous operation this module could have, writing old
data over current data, in order to save a drag-and-drop. That trade only becomes worth making once
the backup format stops being directly readable — compressed, encrypted, or deduplicated. Until then
it buys convenience and costs the possibility of destroying someone's work.

### Telling you a backup is actually healthy

A backup that quietly stops working is worse than no backup, because you believe you are covered. So:

- A **dashboard tile** leads with a verdict rather than a list, and is deliberately pessimistic — "3
  backups" while one has been failing for a week is worse than showing nothing.
- Each backup has its **own page** with its history, a chart of recent runs, and the dated copies it
  holds.
- A run that copies **far less than usual** is flagged even though it succeeded. That shape — success,
  but almost nothing copied — is what a missing or unmounted source looks like.
- **Failure alerts** by email or webhook, and an alert for a backup that simply stopped running, which
  otherwise raises nothing because nothing failed.
- An optional **weekly summary**: the one email that arrives when nothing is wrong, so that silence
  stops being ambiguous.

## Your files, and JonDash's own secrets

Everything is done by the `filesystem` helper, which:

- confines every operation to a **root** an administrator explicitly approved, stored in the helper
  rather than in this module, so this module cannot widen its own reach;
- **never copies JonDash's own secrets** — it finds the encryption key, database and HTTPS keys by
  file identity wherever they actually are, so moving them does not defeat it;
- exposes **no way to read a file's contents** to this module. Bytes never cross into module code.

Retention is the only thing here that deletes, and the helper recomputes what to remove itself: this
module names a destination and a policy, never a victim.

## Permissions, and why each one

| Permission | Why |
| ---------- | --- |
| `filesystem:read` | Look at the source, work out what needs copying, list existing dated copies |
| `filesystem:write` | Copy files to the destination |
| `filesystem:delete` | Retention removes old dated copies. The heaviest line on the consent screen, and honest: this module genuinely deletes. Off by default on every backup |
| `email:send` | Failure alerts and the weekly summary. Opt-in per backup |
| `network:outbound` | Webhook alerts. Opt-in per backup |
| `audit:write` | Record what ran, and every copy retention removed |

`email:send` and `network:outbound` are declared even though both are opt-in — a consent screen must
describe what a module **can** do, not what it happens to be configured to do today.

## Settings and data

There is no flat settings list; everything is managed in **Admin → Modules → Backup Manager**, and
each backup has its own page at `/m/backup-manager/job/<id>`.

Module-wide settings live in `mod_backup_manager_settings`: how many backups may run at once (a
property of the machine's disk, not of any one backup), and the address for the weekly summary.

| Table | Holds |
| ----- | ----- |
| `mod_backup_manager_jobs` | One row per backup: source, destination, mode, schedule, retention policy, alert settings |
| `mod_backup_manager_runs` | What each run did — files copied, bytes, skipped, errors, copies removed |
| `mod_backup_manager_settings` | Module-wide settings, one row per key |

Uninstalling the module drops all three. **It does not touch anything it copied** — your backups are
ordinary files in a folder you chose, and they stay there.

## Schedule

One declared job runs every 60 seconds. It does not copy anything itself: it reconciles runs the
helper has finished, checks for backups that have gone quiet, sends the weekly summary if one is due,
and starts whatever is due — up to the concurrency limit. A backup that takes hours therefore never
blocks the tick.

Because the scheduler helper fixes `everyMs` when the module is defined, the real timing lives in each
backup's own `nextRunAt`. That is what makes "every night at 2am" possible without a release.

## Version history

| Version | Notes |
| ------- | ----- |
| 0.1.1 | Fixes the dashboard tile, which drew no card of its own. `WidgetFrame` supplies a grid cell and nothing else, so the tile had been rendering as loose text on the dashboard background next to properly framed ones, with nothing naming which module it was. It now draws its own card, titled, with a link into the module. It typechecked and built cleanly throughout, so the regression test asserts the rendered markup rather than the code compiling. *(`beta.1` of this version was refused by the installer — it shipped a test needing core internals, and a module's tests ship and are scanned. Fixed in `beta.2` by moving that test out of the module.)* |
| 0.1.0 | A dashboard tile, a page per backup with history and an activity chart, and a warning when a run copies far less than usual. Day-of-week schedules ("2am on weekdays"), retry with backoff, a concurrency cap, cancel, clone, a destination reachability check before starting, and an optional weekly summary. Adds migration `002`. |
| 0.0.1 | First release. Scheduled `sync` and `snapshot` copies, grandfather-father-son retention with a preview, per-run logs, and failure/stale alerts by email or webhook. |

## Known gaps

Stated rather than left to be discovered:

- **Cancelling a run mid-copy is not proven.** The action fires and is audited, but every test against
  a local SSD finished the copy before the cancel landed, so the interrupt path itself has not been
  exercised. It needs a genuinely slow destination.
- **Audit entries for scheduled work need JonDash 1.5.3 or later.** Below that, background work wrote
  no audit rows at all — a JonDash limitation, not a module one. The per-run log file records
  everything either way, including each copy retention removed, written *before* the deletion happens.
