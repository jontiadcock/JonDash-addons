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
      "minAppVersion": "1.5.0",        // minimum JonDash version
      "permissions": ["network:outbound"],
      "path": "addons/health-monitor",
      "tag": "health-monitor/v1.0.0",  // the tag to download this version from
      "notes": "What changed in this version, in one line."   // optional
    }
  ]
}
```

### `notes` — what changed, for the update screen

Optional, one short line per entry, shown on the module's card in **Admin → Updates** so someone can see
why a version is worth taking before they take it. Keep it to what changed and who cares; **300
characters maximum** and no control characters (JonDash caps and strips them, but write it clean).

Update it whenever you bump a version — it describes *that* version, not the module in general. Leaving
it out is fine; the card simply shows the version numbers.

## How JonDash consumes it (the Phase 2 installer)

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

## Future: core modifications (MOD-07)

Higher-trust add-ons that *can modify the base app* live in the **same repo** but are kept separate:
`modifications/<id>/` + a `modifications.json` manifest + `mod-<id>/v<version>` tags, same channel branches.
Separated from add-ons because they carry elevated `core:*` permissions.
