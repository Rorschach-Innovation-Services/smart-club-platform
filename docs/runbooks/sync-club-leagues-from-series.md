# Runbook — Sync `club.leagues` from the series a club plays

**Owner:** runs in the **medicoach AWS account** (`af-south-1`), against the prod
DynamoDB table. **App code change:** none required — this is a data step. The Plan B
fixture importer now runs this automatically after `--confirm` (see
`docs/runbooks/planb-fixtures-import.md`), so this standalone runbook is for the
one-time catch-up on series that were imported **before** the hook existed.

**Why:** the Plan B importer writes **Series** rows only — it never patched the clubs.
Season Insights counts `club.leagues`, so a league whose fixtures exist but whose clubs
carry no matching league key renders "0 clubs / 0 teams". On dolphins this hit the two
veterans leagues (`veterans-premier`, `veterans-promotion`): 26 clubs field sides in
them via the series, but none carried the keys. This script reads
`series.participants[]`, groups them by club, and writes the missing league keys back
onto the club records — the same fact the union already expressed by fixturing the
series, made durable so Insights (and future season generation) see it.

---

## What the script does (and refuses to do)

- **Released series only** by default. `--include-drafts` widens to every series; the
  importer passes it for the ids it just wrote (fresh imports are drafts).
- **Merge, never remove.** A league key is only ADDED to `club.leagues`; nothing is
  dropped. `leagueTeams` / `teamRosters` are always spread from the club's current maps
  before mutation — `repo.updateClub` replaces a top-level key **wholesale**, so a bare
  `{ [key]: … }` would wipe every sibling league's roster.
- A club fielding **≥2 sides** in a league gets `leagueTeams[key] = count` and a
  `teamRosters[key]` built from the series participants, so `clubTeamsForLeague`
  reproduces exactly the ids the series snapshotted. The club **ground venue is not
  copied** onto a side (only a genuine venue override is), so a later ground edit still
  propagates.
- A club with **exactly one `tm_` side** in a league (e.g. only its B side) keeps
  `leagueTeams` at 1 and logs a **NOTE**: future series generation there will use
  `teamId === clubId`. The released series keeps its own snapshot, so there is no
  runtime impact.
- A key already present with a **stored roster whose ids differ** from the series →
  **CONFLICT: logged and skipped**. Coach `teamIds` may point at the stored ids; the
  script never rewrites them. Only an absent-roster count is **UPGRADEd**.
- Series whose `leagueKey` is not in the tenant catalogue are logged **ORPHAN** and
  skipped. Every patch is validated with the same `validateClubPatch` guard the rep
  PATCH `/clubs/:id` uses; `amendmentPending` is never touched.
- **Idempotent** — a second run finds no changes and writes nothing.

## Dry-run output shape

Each club that would change prints one line:

```
[dry-run] simplex-cc (Simplex CC): +[veterans-promotion] → 2 league(s) [now multi-league — its team-less players stop resolving to a single fallback league; expect the dashboard's "unattributed" figure to rise]
```

The trailing note appears only when a club crosses from ≤1 to ≥2 leagues: the
demographics single-league fallback (`demographics.ts`) stops attributing that club's
team-less players to one league, so the Insights **unattributed** figure legitimately
rises. That is honest, not a regression — run `backfill-player-team` afterwards if the
figure is material (see its runbook). The run ends with a summary: clubs that would
change, orphan series, conflicts, upgrades, single-side notes.

## Run (dry-run first)

```bash
# 1. Dry-run — lists per club which leagues WOULD be added, writes nothing.
npx sst shell --stage prod -- npx tsx packages/api/src/sync-club-leagues-from-series.ts dolphins

# 2. Review: only expected leagues appear; check the CONFLICT and ORPHAN lines.

# 3. Apply.
npx sst shell --stage prod -- npx tsx packages/api/src/sync-club-leagues-from-series.ts dolphins --confirm
```

Optional flags: `--only s-id,s-id` restricts to specific series ids;
`--include-drafts` also considers unreleased series. Swap `--stage prod` for
`--stage dev` to rehearse on dev first. There is also an npm alias:
`npm --prefix packages/api run sync-club-leagues -- dolphins [--confirm]`.

## Expected dolphins result

- ~26 clubs patched — every club fielding a side in `veterans-premier` and/or
  `veterans-promotion`.
- Season Insights then shows the two veterans leagues with real entries (roughly
  **12 clubs** in Veterans Premier and **15 clubs** in Veterans Promotion), not zeros.
- Multi-side clubs (Simplex A/B/C, Rhythm DHSOB B/C, Meadowridge A/B, and the B sides)
  carry a `teamRosters` entry whose ids match the series participants.

## Verify

- Re-run the script: it reports **0 clubs would change** (idempotence check).
- Admin → Insights: the Veterans Premier / Promotion rows show club and team counts;
  the "fixtures exist but no club has entered this league" hint disappears for them.
- Spot-check a multi-side club in the admin league drill-down — its sides list with the
  same names the fixtures use.
