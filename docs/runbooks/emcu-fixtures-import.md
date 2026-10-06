# EMCU fixtures import: 2026-27 season workbook

One-time import of the Ethekwini Metro Cricket Union 2026-27 fixtures into the `dolphins`
tenant: `Complete EMCU Fixtures 2026-2027 Season.xlsx` (8 sheets, 11 competitions, 620
fixtures) written as 11 draft `s-emcu-*` series. It replaces the five stale EMCU season-run
drafts (`s-run-*`) and their three season runs left by the 3 Oct backfill. Round 1 is 10-11
Oct 2026.

**Scripts** (all in `packages/api/src`):

- `import-emcu-fixtures.ts` (npm alias `import-emcu-fixtures`)
- `bootstrap-emcu-fixture-prereqs.ts` (npm alias `bootstrap-emcu-prereqs`)
- `emcu-fixture-map.ts`: sheet manifest, team map, venue aliases, new clubs/venues, row
  grammar. Pure, no AWS.

**Purpose-built on the Lions doctrine**, not copy-and-trimmed from planb
(see [lions-fixtures-import.md](./lions-fixtures-import.md)). It reuses planb's pure cell
helpers (`isoDate`, `isoTime`, the `WrittenFixture` shape), the shared club resolver
(`club-name-resolve.ts`), the clash ledger (`venue-clash.ts`), the relocation candidate chain
(`resolve-venue-clashes.ts`) and the version-checked writer (`writeSeriesFromSnapshot`).

Same contract as the rest of the family: `--parse-only` touches no AWS, dry-run is the
default, every abort prints its reason, a JSON backup is written before any write, and
`--revert` / `--restore-stale` undo it. **There is no `--allow-clashes`.**

**Claude builds, tests and dry-runs offline. The user runs every `sst shell` (prod) command.**

## Sheet manifest and expected counts

Series names are a **frozen contract** with the medicoach exporter
(`"<League> · <Stream>[ · <Group>]"` → competition ref
`smartclub:dolphins:competition:<leagueKey>:<stream-slug>`). They never produce `main`, so
they can't collide with the stale medicoach competitions. Don't rename them.

| sheet             | section      | series             | name                                | type / overs | fixtures |
| ----------------- | ------------ | ------------------ | ----------------------------------- | ------------ | -------: |
| Fixtures Div 1    | T20          | `s-emcu-d1-t20`    | EMCU Division 1 · T20               | T20 / 20     |       45 |
| Fixtures Div 1    | 30 Over      | `s-emcu-d1-30ov`   | EMCU Division 1 · 30 Over           | One-Day / 30 |       45 |
| Fixtures Div 2    | T20          | `s-emcu-d2-t20`    | EMCU Division 2 · T20               | T20 / 20     |       91 |
| Fixtures Div 2    | 30 Over Gp A | `s-emcu-d2-30ov-a` | EMCU Division 2 · 30 Over · Group A | One-Day / 30 |       21 |
| Fixtures Div 2    | 30 Over Gp B | `s-emcu-d2-30ov-b` | EMCU Division 2 · 30 Over · Group B | One-Day / 30 |       21 |
| Fixtures Div 3 S1 | T20          | `s-emcu-d3-s1-t20` | EMCU Division 3 Stream 1 · T20      | T20 / 20     |      105 |
| Fixtures Div 3 S2 | T20          | `s-emcu-d3-s2-t20` | EMCU Division 3 Stream 2 · T20      | T20 / 20     |       56 |
| Fixtures Div 4 S1 | T20          | `s-emcu-d4-s1-t20` | EMCU Division 4 Stream 1 · T20      | T20 / 20     |       72 |
| Fixtures Div 4 S2 | T20          | `s-emcu-d4-s2-t20` | EMCU Division 4 Stream 2 · T20      | T20 / 20     |       56 |
| Fixtures Div 5 S1 | T20          | `s-emcu-d5-s1-t20` | EMCU Division 5 Stream 1 · T20      | T20 / 20     |       66 |
| Fixtures Div 5 S2 | T20          | `s-emcu-d5-s2-t20` | EMCU Division 5 Stream 2 · T20      | T20 / 20     |       42 |
| **total**         |              |                    |                                     |              |  **620** |

`seriesType` is `Twenty20 (16-25 overs)` or `One-Day (40-50 overs)` (prod convention);
`maxOvers` is 20 or 30. `--only` takes the bare slug (`d2-30ov-a`, not `s-emcu-d2-30ov-a`).

**Sheet grammar.** Each sheet is a block layout, not a table: title and note banners, a
section banner (`T20 – …`, `30 Over – …`, `30 Over – Group A/B …`), then round headers
(`Round N Fixtures` · time in D · date in E · `Venue:` in F · optional note in G) each
followed by `Home | v | Away | Venue` rows. Dates and times come from the round header
(UTC reads). Anything else aborts.

**Asserts** (any failure aborts): counts per series and 620 total; Div 1-4 on Sundays, Div 5
on Saturdays; every date in 1 Oct 2026 to 5 Apr 2027; start times 09:00 (Div 1/2 T20), 08:30
(30 Over), 13:00 (Div 3-5), with the one sheeted exception Div 2 T20 Round 10 (17 Jan 13:00
double-header); no team twice in a round; the Div 2 30-over groups are disjoint, seven each
(a team in both fails the parse); every team string is in `EMCU_TEAM_MAP`.

**Round numbers are sheet-authoritative**, never renumbered. The dry run warns (non-fatal)
about the three oddities: D5S1 has Round 11 on 5 Dec between R4 and R5, D5S2 has Round 14
there, and D3S2 lists "Round 5" twice (6 Dec and 17 Jan).

## Teams

`EMCU_TEAM_MAP` maps all 38 workbook strings to a club. Each is cross-checked against the
shared dolphins resolver (`resolveParticipant`); a disagreement aborts. 36 resolve to existing
clubs; two are new (created by the bootstrap):

- **Dolphins Deaf Cricket Team** (`dolphins-deaf-cricket-team`), Div 4 S2.
- **Umlazi CC (MUT)** (`umlazi-cc-mut`), Div 5 S1. Distinct from `umlazi-cricket-club`
  ("uMlazi cricket club", Div 2).

Lettered Simplex sides (Div 2 A/B/C, Div 3 S1 A/B, Div 5 S2 A/B) play as
`tm_simplex-reservoir-hills-crimson_<leagueKey>_<index>` with **A = 0**. Plain Simplex (Div 1,
3 S2, 4 S1, 4 S2, 5 S1) plays as the club id.

### tm\_ suffix fork (read before touching Simplex rosters)

Two conventions exist for synthesised side ids:

- **0-based** (`…_0` = A): season-run data, `club-name-resolve.ts` `letteredTeamId`, and the
  147 team mappings already in the medicoach prod map. **EMCU uses this.**
- **1-based**: structure intake (`structure-intake`) mints `…_1` for the first side.

The importer's club sync writes 0-based Simplex rosters for `emcuD2`, `emcuD3_s1` and
`emcuD5_s2`. A later structure-intake commit for Simplex in those leagues would mint 1-based
ids, see a stored roster with different ids, and conflict-skip. Fix rosters by hand in the
console if that ever matters; never re-key the EMCU series.

## Venues

**Sheet-authoritative.** Each fixture keeps the workbook's ground. A ground that resolves to
the registry (tenant aliases, with `EMCU_VENUE_ALIASES` filling any gaps) is written locked
with the registry id/name/pin; anything else is a `venueOverride` with an equal `venueName`.
After the bootstrap every one of the 620 resolves (`620 registry-locked, 0 venueOverride`).

Spellings treated as one ground (also listed in the union report for EMCU to confirm):
Penguin Street (Chatsworth) = PENGUIN STREET GROUND (every such fixture is a Saints home game),
Phoenix Sydmore = Sidmore, Dhubri Road = Dhubri road grounds, Toti Oval / Toti Oval 2 = Toti 1
/ Toti 2, Forest Hill = Forest Hills Sports Club, Lahee Park 1 = Lahee park cricket oval,
Crawford NC = Crawford North Coast, Hammond (UKZN) = Hammond Cricket Oval, Kloof Country Club
= Kloof CC, Gledhow / Mpumalanga / Tills / Phoenix Stonebridge per the existing aliases.
"Phoenix Northcroft" and "Chatsworth Oval" need no alias (they normalise onto the registry
name). Only "Forest Hill" is genuinely new to the alias map.

**Two new venues** (bootstrap): **Lutherfield** (home: Harlequins, Hillary/Malvern, Chatsworth
Sporting) and **Dokkies Primary School** (home: Amanzimtoti, Chesterville, Chatsworth
Sporting, Newlands, Ntuzuma, Saints, Simplex). `homeClubIds` = every club that is the home
side of a workbook fixture there (a test asserts this against the workbook).

## Clash and relocation policy

The scan runs **first**, on a ledger of every remaining tenant fixture (any lifecycle) plus
the 620, with the **five stale `s-run-*` drafts excluded** (they're being replaced). Nothing is
deleted or written until it comes back clean.

- **EMCU yields** to any non-EMCU booking (released KZNCU or otherwise) in the same slot.
- **EMCU-internal** clashes go through `chooseFixtureToMove`. Between two EMCU series the
  home-ground, promotion/premier and group-number rules rarely apply, so it usually falls
  through to "later fixture id moves". That is expected.
- A mover takes the **first `buildCandidateGrounds` ground free all day** on its date (away
  side's ground, home secondary, away secondary, home club's facility list, away club's).
  `venueStatus: 'alternative'`, `venueReason: "Moved: <ground> taken by <fixture>"`.
- **No free candidate ⇒ `dateTbc: true`** (drafts only; the release gate exempts TBC dates).
  The sheet ground is kept.
- **Double listing** (a club at one ground twice at once, EMCU v EMCU) ⇒ the later by
  (seriesId, fixtureId) is written `dateTbc` and goes to the top of the union report. This is
  the user's 6 Oct decision for Hillary/Malvern on 29 Nov 13:00 at Fairfield Park: Div 3 S1
  H/M v Simplex A stays; **Div 4 S1** H/M v Merebank (`s-emcu-d4-s1-t20/f26`) goes date-TBC.
  (The plan said "Div 4 S2"; the workbook has this fixture on the Div 4 S1 sheet.) A club with
  sides in two divisions at the same time on **different** grounds is normal and is not
  flagged.
- Processing order is (date, time, ground, seriesId, fixture number), so the result is
  deterministic. A post-relocation `findClashes` scan (release-gate semantics) must be clean.

**Offline dry run result (prod export, 6 Oct 2026):** 10 relocations (8 yield to released
KZNCU fixtures, 2 EMCU-internal on 29 Nov), 3 date-TBC (the H/M double listing plus 2 with
no free ground: **Div 2 T20 R1 Sun 11 Oct 09:00 PTCC v Railways at Lahee** and Div 2 T20 R9
17 Jan Simplex A v Forest Hills at Siripat 1). The 11 Oct one is this weekend: get EMCU a
ground or a date for it before release, or release Div 2 T20 knowing R1 has one TBC fixture.

## The union report

`--report-out <md>` writes the EMCU-facing report: double listings (date-TBC), relocations,
no-ground date-TBC, sheet notes (the **Div 2 30-over Group B R7, 28 Mar 2027 "TO MOVE - AS
THIS WEEKEND IS EASTER"** note, imported as sheeted), venue names not on the registry, the
**Div 1 Premier Reserve facility** check (warn-only: a Div 1 fixture at a ground that's
neither club's listed facility) and the alias equivalences to confirm. Send it to EMCU after
the import.

## Prerequisites

1. `fix/dolphins-oct10-fixture-patches` committed (the EMCU work builds on its exports).
2. `bootstrap-emcu-prereqs --confirm` has run. It is idempotent and never overwrites:
   - **Clubs**: the two new clubs as skeletal records in "Ethekwini Metro Cricket Union", no
     ground, no leagues (the import's club sync fills leagues). Fix chair/ground in the console.
   - **Venues**: Lutherfield and Dokkies Primary School. An existing row only gains missing
     `homeClubIds`.
   - **Aliases**: `EMCU_VENUE_ALIASES` merged into the tenant's
     `competitionDefaults.venueAliases` (not the engine defaults), so the release gate resolves
     the same spellings. Missing keys only; a conflicting key is reported and left alone.
     The importer's `--confirm` aborts on a missing club, a missing league key, or an EMCU alias
     absent from the tenant config.
3. The 8 league keys (`emcuD1`, `emcuD2`, `emcuD3_s1`, `emcuD3_s2`, `emcuD4_s1`, `emcuD4_s2`,
   `emcuD5_s1`, `emcuD5_s2`) are configured on the tenant (they are).

## Commands (run from the repo root)

```bash
# Offline (Claude or the user): no AWS. Prod exports from a recent read-only Query.
npx tsx packages/api/src/import-emcu-fixtures.ts --parse-only \
  --report-out ~/Downloads/emcu-union-report.md \
  --series-json prod-SERIES.json --clubs-json prod-CLUB.json --venues-json prod-VENUE.json
npx tsx packages/api/src/import-emcu-fixtures.ts \
  --series-json prod-SERIES.json --clubs-json prod-CLUB.json --venues-json prod-VENUE.json
# (offline runs apply the would-be bootstrap: +2 clubs, +2 venues, + EMCU aliases)

# Prereqs (user, prod)
npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-emcu-prereqs
npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-emcu-prereqs -- --confirm

# Import (user, prod). Dry run first, read it, then confirm.
npx sst shell --stage prod -- npm --prefix packages/api run import-emcu-fixtures
npx sst shell --stage prod -- npm --prefix packages/api run import-emcu-fixtures -- --confirm
… import-emcu-fixtures -- --confirm --only d1-t20,d1-30ov     # partial write
… import-emcu-fixtures -- --confirm --no-club-sync             # skip the club-league sync

# Revert / restore (user, prod)
… import-emcu-fixtures -- --revert                              # lists
… import-emcu-fixtures -- --revert --confirm                    # deletes the s-emcu-* series
… import-emcu-fixtures -- --restore-stale packages/api/emcu-fixtures-backup-<ts>.json
… import-emcu-fixtures -- --restore-stale packages/api/emcu-fixtures-backup-<ts>.json --confirm
```

Flag rules: `--parse-only` and `--confirm` are exclusive; offline JSON flags come as all three
and never with `--confirm`; `--revert` and `--restore-stale` take only `--confirm`; `--tenant`
must be `dolphins`.

## What `--confirm` does, in order

1. **Gates** on fresh reads: parse, resolution, clubs, league keys, aliases, no released
   `s-emcu-*` in scope, no released stale series, **no medicoach result recorded against a
   stale series** (belt and braces), relocation clean, `findClashes` clean.
2. **Backup** `packages/api/emcu-fixtures-backup-<ts>.json` (gitignored): every existing
   `s-emcu-*` series, the five stale series and the three stale runs.
3. **Delete** the five stale drafts, mirroring `DELETE /series` (the series, its umpire
   appointments, its medicoach-sync state and held `PENDINGSYNC` rows), then the three season
   runs. Absent ones are skipped. This happens even with `--only`: they're replaced either way.
4. **Write** the drafts through `writeSeriesFromSnapshot` (version-checked;
   `approved:false, released:false`). A RELEASED `s-emcu-*` refuses the whole run before step 2. A stored draft is replaced wholesale; the dry run lists any drift first.
5. **Club-league sync** (`sync-club-leagues-from-series --include-drafts`, scoped to the ids
   written) unless `--no-club-sync`. It writes the 0-based Simplex rosters and fixes Season
   Insights "0 clubs" for all 8 keys.
6. **Post-write verification**: re-reads the tenant and runs `findClashes` over the stored
   `s-emcu-*` series. Any clash exits non-zero and points at `--revert --confirm`.

## End-to-end order (SC first)

1. Claude: build, tests, offline `--parse-only` + dry run (done).
2. **User, this week, before the weekend:** bootstrap dry run then `--confirm`; import dry
   run then `--confirm`. 11 drafts land in Smart Club. Send the union report to EMCU.
3. **User:** review in the admin console, approve, and **release the 11 series**. The release
   gate re-runs the clash check (date-TBC rows are exempt). Clubs see Round 1 immediately.
   Release-triggered medicoach sync pushes are answered `unmapped` (no mapping yet) and
   dropped. That's harmless: the bundle carries every schedule.
4. **Medicoach rehearsal on testing** (early next week), then **prod carry**. Summary:
   stale-competition cleanup (`cleanup-emcu-stale.mjs`), `export-medicoach --leagues
emcuD1,emcuD2,emcuD3_s1,emcuD3_s2,emcuD4_s1,emcuD4_s2,emcuD5_s1,emcuD5_s2`,
   `import-bundle.mjs --no-publish` run three times (`--only institutions`, `--only leagues`,
   `--only fixtures`: it takes one phase per run), `backfill-external-refs --confirm`, then
   publish all 8 leagues (the 5 new ones too). Expect 5 `derived-*` + 3 `cal_*` seasons, 10
   competitions, 620 fixtures, 2 new institutions. The step-by-step lives in the medicoach
   runbook section for the EMCU cleanup and carry (`scripts/league-migration/` in the
   medicoach repo), maintained there.

### Smart Club fixture-edit freeze

From the medicoach **prod export** until **`backfill-external-refs --confirm`** completes,
make **no fixture edits at all** in Smart Club, not just structural ones. An edit in that
window is pushed, answered `unmapped`, and silently dropped, so medicoach never learns it.
The freeze ends after the backfill; delete the bundle file then. From there the 15-minute sync
keeps both sides aligned.

## Verification checklist (after `--confirm`)

1. The console lists 11 `s-emcu-*` drafts with the manifest counts; no `s-run-*` EMCU series.
2. Div 2 T20 R10 = 17 Jan 13:00. Div 5 on Saturdays. D5S1 R11 on 5 Dec between R4 and R5.
3. Simplex A/B/C render as separate sides in Div 2.
4. The 10 relocated fixtures show the new ground with "Moved: …" as the reason; the 3
   date-TBC fixtures show TBC.
5. Season Insights shows non-zero clubs for all 8 EMCU keys.
6. Re-run the dry run: the verification scan is clean and nothing is relocated again.

## Rollback

- Smart Club: `--revert --confirm` deletes the 11 `s-emcu-*` series (refuses while any is
  released: recall it first). `--restore-stale <import backup> --confirm` then re-puts the 5
  stale series and 3 runs exactly as backed up. It refuses while any `s-emcu-*` series exists
  (the two sets would double-book every EMCU fixture), and leaves anything already present
  alone. The bootstrap's clubs, venues and aliases stay; they're harmless without fixtures.
- Medicoach: the new run's migration manifest → `import-bundle.mjs --rollback --apply`. The
  cleanup script keeps a map backup and audit manifest. The 3 Oct manifest is insurance at
  `~/Development/medicoach-import-email/scripts/league-migration/migration-manifest.prod.jsonl`.

## Follow-ups

- Grounds or dates for the 3 date-TBC fixtures, from EMCU (the 11 Oct Lahee one first).
- The Easter Round 7 (Div 2 30-over Group B, 28 Mar) new date.
- The new clubs' chair and ground, in the console.
- Kloof CC is red-listed in the registry but EMCU fixtures it (imported as sheeted).
- Relocation targets that are Premier-Women-reserved or junior fields (Commons 2, Chatsworth
  121 (Junior)) are allowed by the candidate chain; check them in the union report.
