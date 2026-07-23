# JonDash-addons — versioning, branches & tags

The authoritative scheme for how this **single repo** holds every add-on module (and, later, core
*modifications*) with independent versions and its own stable/beta channels. Mirrors JonDash's own
two-channel model so the mental model is the same on both sides.

## Channels = branches (like JonDash itself)

| Branch | Channel  | Holds |
| ------ | -------- | ----- |
| `main` | **stable** | every add-on at its latest **stable** version; `addons.json` here is the stable manifest |
| `beta` | **beta**   | every add-on at its latest **beta** (pre-release) version; `addons.json` here is the beta manifest |

An add-on with no active beta simply isn't listed in the beta manifest (or matches its stable entry) —
the installer falls back to stable for it. **Channels are per add-on**, not per repo: a user can run
add-on A on stable and add-on B on beta at the same time (see "per-module beta opt-in" below).

## Versions = per add-on, independent

Each add-on has its **own semver**, independent of other add-ons and of JonDash:
- Stable: `X.Y.Z` (e.g. `1.0.0`)
- Beta: `X.Y.Z-beta.N` (e.g. `1.1.0-beta.1`)

The version is recorded in the add-on's `MODULE.md`, its `module.ts` (`version`), and its `addons.json`
entry on the channel branch it lives on.

### Keeping beta ahead of stable — the step that closes a promotion

> **After promoting `X-beta.N` to `X` on `main`, advance the beta manifest past it.** A promotion is
> not finished until both channels have moved.
>
> **Why it matters, and why nothing tells you:** semver ranks a pre-release *below* its release, so
> `0.0.5-beta.1 < 0.0.5`. Leave the beta manifest pointing at the pre-release that became the release
> and every beta user is running something **older than stable, with no way forward** — their channel
> only offers the version they already have. Nothing errors. JonDash used to surface it as a
> downgrade offer (`v0.0.5 → v0.0.5-beta.1`); since it stopped offering older versions as updates, the
> symptom is **silence** — beta users simply read "up to date" while sitting behind stable.
>
> Two ways to advance, both fine:
> - **Match stable** — republish the beta entry at the release version, pointing at the same tag. Use
>   this when nothing is in flight; the two channels agree until the next pre-release opens. This is
>   the normal resting state, not a smell.
> - **Open the next pre-release** — `X.Y.(Z+1)-beta.1` — when there is genuinely work in flight.
>
> Never leave beta on the superseded pre-release. Found 2026-07-24 by the core session with **four of
> five entries** stale; `node scripts/check-manifest.mjs` now diffs the two manifests and **fails** if
> any beta entry sorts below its stable counterpart, because a manifest diff is the only thing that
> catches this.

### Fixing a broken beta — increment `N`, never the version

> **A beta that needs fixing becomes `X.Y.Z-beta.2`, not `X.Y.(Z+1)-beta.1`.** Owner's rule,
> 2026-07-23. `X.Y.Z` names *the release being worked towards*; the `-beta.N` counter is what tracks
> attempts at it. Bumping the version instead invents a release that never existed, so the history
> stops saying "it took three goes to get 0.1.1 right" and starts implying three separate releases.
>
> Set by `backup-manager@0.1.1-beta.1`, which shipped uninstallable. The fix went out as
> **`0.1.1-beta.2`** — same intended release, second attempt. `0.1.2-beta.1` would have been wrong.
>
> The version only moves when the *content of the intended release* changes: a further fix is a new
> `-beta.N`, genuinely new work is a new `X.Y.Z` starting again at `-beta.1`.
>
> **A published tag stays put.** `backup-manager/v0.1.1-beta.1` still exists and still points at the
> broken tree — tags are immutable and deleting one rewrites history someone may already have. The
> manifest simply moves past it, and `MODULE.md` records that the attempt failed and why.

## Tags = one per published version, namespaced per add-on

Every published version is tagged **`<id>/v<version>`** (the `/` namespaces tags by add-on in GitHub):
- Stable: `health-monitor/v1.0.0`
- Beta:   `health-monitor/v1.1.0-beta.1`

A tag is **immutable** and is the **downloadable artifact** for that exact version (the installer fetches
the tag's archive and extracts just `addons/<id>/`). Never move a published tag; publish a new version
instead. *(Future core modifications use the distinct namespace `mod-<id>/v<version>`.)*

## Manifest (`addons.json`) — one per channel branch

```jsonc
{
  "manifestVersion": 1,
  "channel": "stable",                 // "stable" on main, "beta" on the beta branch
  "modules": [
    {
      "id": "health-monitor",          // = the addons/<id> folder
      "name": "Health monitoring",
      "description": "One line.",
      "version": "1.0.0",              // the latest version on THIS channel
      "minAppVersion": "1.5.0-beta.1", // minimum JonDash version — see the warning below
      "permissions": ["network:outbound"],
      "path": "addons/health-monitor",
      "tag": "health-monitor/v1.0.0",  // the tag to download this version from
      "notes": "What changed in this version, in one line."   // optional
    }
  ]
}
```

### `minAppVersion` — name the pre-release, not the release

**A bare `"1.5.0"` makes an addon uninstallable on every 1.5.0 beta.** Semver ranks a pre-release
*below* its release (`1.5.0-beta.2 < 1.5.0`), and the installer refuses anything whose
`minAppVersion` is newer than the running build. Beta-channel users are, by definition, running
pre-releases — so a bare release number excludes exactly the people the beta channel is for.

If your addon needs something that lands in `X.Y.Z`, declare **`X.Y.Z-beta.1`**. It still keeps out
every build older than that series, and it works on the betas as well as the final release. Keep the
value identical in `addons.json` and in the addon's own `module.ts` / `helper.ts`.

This is not hypothetical: `template@0.0.4-beta.1` and `scheduler@0.0.1-beta.1` both shipped with a
bare `"1.5.0"` and could not be installed by anyone, on any build that existed.

### `notes` — what changed, for the update screen

Optional, one short line per entry, shown on the module's card in **Admin → Updates** so someone can see
why a version is worth taking before they take it. Keep it to what changed and who cares.

> **300 characters maximum, and JonDash TRUNCATES rather than refuses.**
> `sanitizeModuleEntry` / `sanitizeHelperEntry` do `.slice(0, 300)`, so an over-length note is not
> rejected, not warned about, and not logged — it simply reaches the admin cut off mid-sentence.
> Control characters are stripped the same silent way.
>
> This is not hypothetical. On 2026-07-23 **four of the five stable entries were over the cap** —
> `filesystem` at 1063 characters, `backup-manager` at 1026, `template` at 340, `health-monitor` at
> 303 — so release notes that took real care to write had been rendering as fragments for weeks. The
> rule was already on this page; nothing checked it.
>
> **`node scripts/check-manifest.mjs` now does.** Run it before every publish. It fails on an
> over-length note and prints where the cut would land, and also checks that each `tag` names its
> `version`, that the manifest version matches the addon's own `module.ts` / `helper.ts`, and that a
> pre-release never appears on the stable channel.

Update it whenever you bump a version — it describes *that* version, not the module in general. Leaving
it out is fine; the card simply shows the version numbers.

## How JonDash consumes it

- **Discover:** read `addons.json` from `main` (stable). For any add-on the user opted into beta, read that
  add-on's entry from `beta` too.
- **Install / update add-on X:** pick X's channel (per-add-on setting; stable by default) → read X's entry
  from that channel's manifest → download its `tag` archive → extract `addons/X/` → install/migrate/rebuild.
- The per-add-on channel is stored on JonDash's `Module` row (`channel`: `stable` | `beta`).

## Per-module beta opt-in (JonDash side)

Independent of JonDash's own app channel, **each module's settings has an "Opt into beta releases for this
module" toggle**. On ⇒ that module updates from the `beta` channel; off ⇒ `stable`. This is the module
equivalent of JonDash's own beta channel, but chosen per module.

## Publishing workflow (for the maintainer)

**New stable version of add-on X (A.B.C):**
1. On `main`: update `addons/X/` + set `version` in `MODULE.md`, `module.ts`, and X's `addons.json` entry
   (with `"tag": "X/vA.B.C"`).
2. Commit → tag `X/vA.B.C` → push `main` + the tag.

**New beta version of add-on X (A.B.C-beta.N):**
1. On `beta`: same edits, version `A.B.C-beta.N`, `addons.json` (beta) entry with `"tag": "X/vA.B.C-beta.N"`.
2. Commit → tag `X/vA.B.C-beta.N` → push `beta` + the tag.

**Promote a beta to stable:** bring X's beta version into `main` (merge or copy the folder), set version to
the release `A.B.C`, update the stable `addons.json`, commit, tag `X/vA.B.C`, push `main` + tag.

## Helpers — different rules on purpose

**Live as of JonDash 1.5.0.** See [`helpers/README.md`](helpers/README.md).

Helpers are first-party shared capability living in `helpers/<id>/` in this repository. They are
published like add-ons but consumed differently:

- **Same publishing mechanics.** A `helpers` array in `addons.json` on each channel branch, semver per
  helper, and one immutable tag per published version in the **same `<id>/v<version>` namespace** as
  add-ons (e.g. `scheduler/v0.0.2`, `scheduler/v0.0.2-beta.1`).
- **No version negotiation.** A user gets whatever version the channel publishes — no ranges, no
  resolution, no conflicts. A helper never breaks its own API; both sides of the contract belong to the
  same project, which is what makes that promise keepable rather than aspirational.
- **The channel is inherited, not chosen.** JonDash resolves a helper on the channel of the module
  pulling it in, from the official manifest. There is no per-helper channel setting.
- **Not user-installable.** They arrive automatically as dependencies of a module that declares them
  (`helpers: ["scheduler"]` in both `module.ts` and the module's `addons.json` entry), and are listed
  read-only under **Admin → Helpers**. There is no install, import or remove button.
- **Official source only**, enforced by JonDash's installer — a `helpers` array published by any other
  source is silently dropped. Otherwise a third party publishes a `helpers/` folder and inherits
  privilege that modules are specifically denied.
- **`minAppVersion` is enforced.** A helper needing a newer JonDash than the running build is refused,
  and the module that declared it fails to install rather than installing in a state where it can never
  work. The pre-release rule above applies here too.
- **Their capabilities roll up** into the consent screen of any module that depends on them, described
  by real-world effect rather than capability name.
- **Removal keeps data.** Files go when nothing depends on a helper any more; anything it owns stays.

## Future: core modifications (MOD-07)

Higher-trust add-ons that *can modify the base app* live in the **same repo** but are kept separate:
`modifications/<id>/` + a `modifications.json` manifest + `mod-<id>/v<version>` tags, same channel branches.
Separated from add-ons because they carry elevated `core:*` permissions.
