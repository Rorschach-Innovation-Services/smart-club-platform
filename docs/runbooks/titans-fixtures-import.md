# Titans fixtures import: 2026-27 first-half workbook

One-time import of the Titans Cricket Union 2026-27 first-half fixtures into the `titans`
tenant: 36 sheets, **1,398 fixtures**, written as **44 draft `s-titans-*` series** (42 league,
group and junior series plus the two Veterans playoff brackets).

**On prod this lands as DRAFTS ONLY. Do not approve or release anything** until the union has
answered the report (provisional times, ground sharing, TBC venues). Releasing is a separate,
later decision with its own rules (see [Releasing later](#releasing-later)).

**Scripts** (all in `packages/api/src/`):

| file                                  | npm alias                          | role                                                                  |
| ------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `import-titans-fixtures.ts`           | `import-titans-fixtures`           | parse, `--append-sides`, import, `--revert`, `--restore-clubs`        |
| `bootstrap-titans-fixture-prereqs.ts` | `bootstrap-titans-fixture-prereqs` | league keys, venue aliases, venue registry                            |
| `titans-fixture-map.ts`               |                                    | sheet manifest, time rules, venue aliases, `HELD_BACK` (pure, no AWS) |
| `titans-sides.ts`                     |                                    | side resolution and the `--append-sides` club patches (pure)          |

Same contract as the Lions/EMCU family: `--parse-only` touches no AWS, dry-run is the default,
every blocker aborts with its reason, a JSON backup is written before any write, and there is
**no `--allow-clashes`**.

## What gets written

| what                    | detail                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Series                  | 44 drafts, 1,398 fixtures. 4 more fixtures are parsed but held back (see below). T20 knockouts are **not** written (they need PR B).                                                                                                                                                     |
| Tenant config           | +3 league keys (`mens-t20`, `womens-t20` fixtures-only; `womens-junior-league`), +15 misspelling-only venue aliases                                                                                                                                                                      |
| Venue registry          | ~77 new rows (`v-*`, surfaces 1). The 21 existing rows that match are reused untouched.                                                                                                                                                                                                  |
| Clubs, `--append-sides` | TUKS: `third-league` grows 1 → 2 (TUKS 5, TUKS 6) and `u11` gains TUKS C. Pretoria: `veterans-league` key + 2 sides. Pretoria East: `u11` gains PRETORIA EAST C. Counters (`teams/women/juniors`) recomputed.                                                                            |
| Clubs, club sync        | 19 clubs gain league keys they now have fixtures in: 5 × `womens-junior-league`, Atteridgeville `second-league`, and `mens-t20` / `womens-t20` on 19 clubs. T20 sides reuse existing league side ids, and the sync only ever adds a fixtures-only cup's KEY (never a roster or a count). |

So "drafts only" still changes club records. Take the snapshot in step 0 before anything else.

**Times.** Sheet times are kept. T20 `AM`/`PM` become 09:00/13:30. Untimed junior fixtures get
**08:30** and untimed senior, women's and veterans fixtures get **13:00**. Those are
provisional (1,199 fixtures, tagged `timeSource: 'provisional'`) until the union confirms.

**Overs.** Set only where a source states them: 2nd/3rd/4th League 45 and 5th League and
Women's League 35 (the union's own "Club League Entry" form labels), the T20s 20. Premier,
Promotion, Sixth (it switches from T20 to 30 overs mid-sheet), Veterans, Women's Junior and
U9–U15 are left **unset** and asked in the union report ("Match length (overs) we could not
find"). The admin console shows no overs for an unset series once the UI guard is deployed;
before that deploy it shows "undefined ov" for those series, which is cosmetic.

**Venues.** Only misspellings are merged. Distinct fields of one complex (Irene Oval vs Irene
Country Club, Gijima Oval vs Gijima Sports Ground) stay separate, because merging them creates
false clashes. Vets B has 18 TBC-venue fixtures, written venue-less.

## Prerequisites

1. **PR A is on the branch you run from** (this branch, or `main` once merged). No deploy is
   needed: the import tooling writes through the repo layer, and nothing in it changes the API.
2. **Inputs in `~/Downloads`** (the defaults):
   - `2026 Titans Club Cricket 2026-2027 Fixtures - 1st Half Final Final Draft.xlsx` (`--file`)
   - `Titans Club Cricket 2026-2027 PROMOTION RELEGATION.xlsx` (`--structure`, the August
     structure sheet; it places TBC fixtures at the home club's ground in the release-gate preview)
3. **A structure snapshot of prod titans** (step 0). This is your restore point for club
   records, which `--revert` does not touch.
4. **The full JSON backups the CLIs write.** With `npm --prefix packages/api run …` they land
   in `packages/api/` (gitignored by `packages/api/*-backup-*.json`). Override with
   `--backup-dir <dir>`. Keep all of them until the union signs off:
   - `titans-append-sides-backup-<ts>.json`: full pre-image of the clubs `--append-sides` patched
   - `titans-clubs-backup-<ts>.json`: every titans club, just before the import writes
   - `titans-fixtures-backup-<ts>.json`: every existing `s-titans-*` series (empty on the first run)

   The club backups are full club records and include chair and officer contact details
   (PII). Don't share or commit them.

## Prod commands, in order

Run everything from the repo root. Each step is dry-run first, read the output, then
`--confirm`. If any STOP condition below shows up, stop and don't move on to the next step.

### 0. Snapshot (read-only)

Save this to a scratch file **outside the repo** (for example
`~/titans-snapshot/export-titans-structure.mts`). It whitelists structure fields only, so the
output holds no personal data:

```ts
// Read-only export of the titans tenant's club structure (no personal data).
// npx sst shell --stage prod -- npx tsx <this file> <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
const repo = await import(`${process.cwd()}/packages/api/src/repo.ts`);
const out = process.argv[2];
if (!out) throw new Error('usage: export-titans-structure.mts <out-dir>');
mkdirSync(out, { recursive: true });
const T = 'titans';
const KEEP = [
  'id',
  'name',
  'district',
  'sub',
  'affiliation',
  'teams',
  'women',
  'juniors',
  'color',
  'ground',
  'leagues',
  'leagueTeams',
  'teamRosters',
  'version',
];
const pick = (c: Record<string, unknown>) =>
  Object.fromEntries(KEEP.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
const [config, clubs, series, runs, venues] = await Promise.all([
  repo.getTenantConfig(T),
  repo.listClubs(T),
  repo.listSeries(T),
  repo.listSeasonRuns(T),
  repo.listVenues(T),
]);
const w = (n: string, d: unknown) => writeFileSync(`${out}/${n}.json`, JSON.stringify(d, null, 2));
w('clubs', clubs.map(pick));
w('tenant-config', {
  tenant: T,
  leagues: config?.leagues ?? [],
  venueAliases: config?.competitionDefaults?.venueAliases ?? {},
  features: config?.features ?? null,
});
w('venues', venues);
w(
  'series-summary',
  series.map((s: any) => ({
    id: s.id,
    name: s.name,
    leagueKey: s.leagueKey,
    released: !!s.released,
    approved: !!s.approved,
    fixtures: s.fixtures?.length ?? 0,
  })),
);
w(
  'season-runs-summary',
  runs.map((r: any) => ({ id: r.id, name: r.name, leagueKey: r.leagueKey })),
);
console.log(
  `stage=${process.env.SST_STAGE} clubs=${clubs.length} series=${series.length} venues=${venues.length}`,
);
```

```bash
npx sst shell --stage prod -- npx tsx ~/titans-snapshot/export-titans-structure.mts ~/titans-snapshot/prod-before
```

Expect `clubs=21 series=0 venues=22`, 16 leagues, 0 venue aliases, no `features`. If prod
already has `s-titans-*` series or a different club count, stop and re-check before going on.

### 1. Parse only and the union report (no AWS)

```bash
npx tsx packages/api/src/import-titans-fixtures.ts --parse-only \
  --report-out ~/Downloads/titans-union-report.md
```

Expect every sheet `✓` with `total: 1398 fixtures (expected 1398), 111 BYE rows skipped, 19 KO
rows`, five `date corrected` lines (FOURTH ×3, FIFTH ×2), and `[parse-only] gate clean`. It
writes `titans-union-report.md` and `.json`. That's the document for the union.

### 2. Bootstrap: league keys, venue aliases, venue registry

```bash
npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-titans-fixture-prereqs
npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-titans-fixture-prereqs -- --confirm
```

Check in the dry run:

- `── Leagues`: the 13 workbook keys `exists, untouched`, plus `add league mens-t20`,
  `womens-t20` (both fixtures-only) and `womens-junior-league`. Nothing else added.
- `── Venue aliases: 15 to add, 0 already present`. A key already mapped to a different value
  makes the bootstrap refuse (`✗ … venue alias conflict(s)`): STOP and resolve it in the console.
  The importer refuses on the same conflict, because the API gate uses the tenant's value.
- `── Venue registry: 22 existing · 21 matched (id reused, row untouched) · 77 to create · 1
existing not in the workbook`. The one unused row is `irene-oval-cricket-ground-de34e6`
  (see [cleanup](#cleanup)). A `homeClubIds differ (not changed)` note on FH ODENDAAL is
  report-only.

`--confirm` ends with `wrote tenant config (+3 league(s), +15 venue alias(es))`, one `wrote
venue` line per created row, and `Done.` It's idempotent: a re-run adds nothing.

### 3. `--append-sides`: grow the club rosters

```bash
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- --append-sides
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- --append-sides --confirm
```

Check in the dry run:

- `Side resolution: 303 side(s) … 2 seeded (1→2), 4 appended`.
- `── Club patches (3)`: TUKS, Pretoria East and Pretoria, exactly as in
  [What gets written](#what-gets-written).
- **Every 1 → 2 growth line ends `(no references found)`**: `third-league: single side
tuks-cricket-club → tm_tuks-cricket-club_third-league_0 "TUKS 5" (no references found)` and the
  same for Pretoria `veterans-league`. That growth re-ids the club's single side, which is only
  safe because nothing references it yet.
- **No existing roster id changes.** Every other line is a `+ tm_…` append or a counter change.
- WOMENS LEAGUE placement: all 11 clubs `✓`.
- Two `⚠` notes are expected and harmless: Sinoville `veterans-league` (leagueTeams 1 vs a
  2-entry roster) and Adelaar `u15` (two entries share side "A").
- Ends `[dry-run] 3 club(s) would change`, no `✗ Refusing`. Every club patch is checked with
  `validateClubPatch` (the rep PATCH guard) in the dry run, so a patch the API would reject is a
  dry-run blocker, never a half-applied `--confirm`.

`--confirm` writes `titans-append-sides-backup-<ts>.json` first, then `wrote <clubId>` ×3 and
`Done. 3 club(s) written`. A `changed since the read — NOT written` line means someone edited
that club meanwhile: re-run the dry run, then `--confirm` again.

### 4. Import: dry run

```bash
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- \
  --report-out ~/Downloads/titans-union-report-prod.md
```

Check:

- `Tenant "titans": 21 club(s), 99 registry venue(s), 0 series (0 s-titans-*)` and
  `medicoachSync feature: off`.
- `Side resolution: 303 side(s) — 170 roster, 133 bare club id`, and no "Sides the clubs do not
  have yet" block (that would mean step 3 didn't land).
- `── Held back (4) — parsed, never written`: U11 Plat B and U11 Gold A (24 Oct, Laerskool Anton van
  Wouw), U15 Plat A and U15 Gold A (25 Oct, Irene Oval). Held-back fixtures take the ids AFTER the
  written ones (first import: f36, f28, f28, f21), so they never collide with a written fixture.
- `CLASH SCAN before HELD_BACK`: 2 provisional-vs-provisional clashes (the pairs above).
- **`CLASH SCAN after HELD_BACK`: `✓ no clashes`.** This is the gate.
- `Release-gate preview after HELD_BACK`: **3 sheet-vs-sheet clashes, all Vets B TBC fixtures**
  placed at their home club ground (Aloe Park 18 Oct, Laudium Oval 25 Oct and 1 Nov). Expected
  and non-blocking for drafts. They do block a later Vets B release (see below).
- `Shared ground-days … 98` and `Other ground-days … 40`: report-only.
- `Time sources (written fixtures): t20-marker 47, sheet 148, provisional 1199`.
- `── Series (44) as DRAFTS` and `44 draft series (1398 fixtures) would be written.`
- Club sync preview: `19 club(s) would change, 2 CONFLICT(s), 0 orphan series` (6 clubs gain a
  league key, and the T20 cup keys go on 19 clubs). The two CONFLICTs are **expected and
  harmless**: `tuks-cricket-club / u9` and `cbcob-cricket-club / u11`. Both clubs store more (or
  reordered) junior sides than the workbook uses, so the sync skips those rosters. Both clubs
  already carry those league keys.
- **0 blockers**: no `✗ Refusing to pass the dry run` block.

`Fixtures dated before <today>` is informational (97 on 7 Oct). Those are already-played
fixtures stored as drafts. Nothing notifies anyone about them.

### 5. Import: `--confirm`

```bash
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- --confirm
```

It writes `titans-clubs-backup-<ts>.json` and `titans-fixtures-backup-<ts>.json`, then 44
`wrote s-titans-… v1` lines, the club sync (`19 club(s) patched — 2 conflict`), and
`Post-write verification (stored tenant) ✓ no clashes`. It ends:

```
Done. 44 draft series written. Backup: …. Nothing is released — approve and release from the console (tick "Withhold start times").
```

The dry run's "differs from the stored draft" check covers fixtures (dates, times, sides,
venues) and the series-level fields the importer owns (`maxOvers`, `seriesType`, `leagueKey`,
start/end dates).

Then re-run the step 4 dry run once. Every series should say `(replaces stored v1 draft)` with
no drift warnings, and the club sync preview should show `0 club(s) would change` (2 CONFLICTs
still). That proves the write is stable and idempotent.

**If a write aborts part-way** (a network or AWS error, not a version conflict), the CLI prints
`✗ ABORTED after N of M … — RE-RUN REQUIRED` and stops. Re-run the same command: written series
are replaced in place with the same ids, and the rest are written. For `--append-sides`, re-run
the dry run first (it lists only what is still missing), or undo the written clubs with
`--restore-clubs <the append backup>`. A version conflict (`changed since the read — NOT
written`) is not an abort: re-run after checking who edited the club or series.

### STOP conditions (any step)

- Any `✗ Refusing …` / `Gate FAILED` blocker block.
- Any 1 → 2 growth line that doesn't say `(no references found)`, or a `would change the single
side … but it is referenced` / `roster id … would change — refusing` line. The guard checks
  stored series, season-run entrants and coach `teamIds`.
- `roster entries … unmatched while appending …`: a stored side under another name (a rename).
  Rename it in the console to the sheet name, or decide; never append beside it.
- A `venue alias conflict` or `is not fixtures-only` blocker.
- Any clash in `CLASH SCAN after HELD_BACK`. Never work around it: no `--allow-clashes` exists,
  by standing rule.
- A Release-gate preview clash that isn't one of the 3 Vets B TBC ones.
- Club sync CONFLICTs other than TUKS u9 and CBCOB u11, or any orphan series.
- `medicoachSync feature: on` (pause the sync cron before writing).
- Counts that differ from this runbook (44 / 1,398 / 303 sides / 3 club patches). Prod drifted
  from what dev rehearsed: re-snapshot and compare before going on.
- `stored fixture … is not in the workbook` or `… is already RELEASED`.

## Revert

```bash
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- --revert
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- --revert --confirm
… -- --revert --include-released --confirm   # only if something was released
```

`--revert` backs up then deletes the 44 manifest series (with their umpire appointments and
sync state). A released series in scope makes `--confirm` refuse unless you pass
`--include-released`. Other `s-titans-*` series aren't touched.

**What `--revert` does NOT undo** (it says so when it finishes):

- **Bootstrap**: the 3 league keys, the 15 venue aliases and the ~77 registry venues.
- **`--append-sides`**: the new rosters, `leagueTeams` and counters (TUKS, Pretoria, Pretoria
  East, including Pretoria's `veterans-league` key).
- **Club sync**: the league keys it added (6 clubs) and any rosters it wrote.
- **Cup keys**: `mens-t20` / `womens-t20` on 19 clubs' `club.leagues`.

Leaving all of that in place is harmless: a re-import reuses it. Only restore clubs if the
union rejects the structure itself.

**Restoring club structure: `--restore-clubs`** (only after `--revert --confirm`, since fixtures
reference the new side ids). It takes any club backup — the step 0 snapshot's `clubs.json`,
`titans-clubs-backup-<ts>.json` (taken just before the import) or
`titans-append-sides-backup-<ts>.json` (just before `--append-sides`):

```bash
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- --restore-clubs ~/titans-snapshot/prod-before/clubs.json
npx sst shell --stage prod -- npm --prefix packages/api run import-titans-fixtures -- --restore-clubs ~/titans-snapshot/prod-before/clubs.json --confirm
```

The dry run prints every field it would change, per club, old → new. It restores only
`leagues`, `leagueTeams`, `teamRosters`, `teams`, `women` and `juniors` (only those the backup
carries, only where they differ), version-pinned, and checks every patch with
`validateClubPatch` before writing anything, so compliance docs or contacts edited since the
backup survive and nothing half-applies. A re-run is a no-op. Remove bootstrap venues and
leagues by hand in the console if you must; nothing scripts that.

## Releasing later

Not part of this import. When the union has answered:

- **Tick "Withhold start times"** in the release dialog for every Titans release until the union
  confirms the provisional times. Only the release dialog sets `withheld`.
- **Vets B will 409 at release** until its 18 TBC fixtures have venues: the release gate places
  them at the home club ground, where 3 of them clash. Set grounds in the console first.
- **T20 knockouts** (`s-titans-mens-t20-ko`, `s-titans-womens-t20-ko`) need PR B (the `tbd:` slot
  type and Set team). **Don't import them on a stage before PR B is deployed to that stage.** The
  CLI rejects them in `--only` until then. The Mens T20 QF/SF (10 Oct) and final (17 Oct) will be
  in the past by then: import them only with union-confirmed teams, otherwise skip.

## Union follow-ups

The union report (`--report-out`, written in steps 1 and 4) is the question list. Send the `.md`.
It covers:

- **Assumed start times** per competition (08:30 juniors, 13:00 seniors/women/vets).
- **98 shared ground-days** where a junior 08:30 game and a senior 13:00 game share a ground. The
  clash gate compares exact start times only, so "08:30 then 13:00 is fine" is an assumption the
  union must confirm. Plus **40 other ground-days** where a provisional time shares a ground with
  a different start time.
- **4 held-back fixtures** (the two double-bookings above). The union says which moves.
- **5 year-typo corrections** (FOURTH rows 58/65/90, FIFTH rows 63/82: 2026 → 2027).
- **Mens T20 Q1** has the literal team `IRENE VILLAGERS 1` in a knockout slot. Confirm.
- **8 ambiguous venue groups** kept separate (The Glen / The Glen High, Southdowns A/B, the
  Lynwood variants, Silver Valke / B, Midstream hockey field, Mayville, Totiusdal, Anton van Wouw
  A) and **6 merged misspellings** to confirm.
- **Women's League Top 6 / Bottom 6** split rounds (5 dates, 34 rows): dated but no fixtures, not
  imported.
- **18 Vets B TBC venues**.
- **Overs for 9 competitions** the entry form and sheets don't state (Premier, Promotion, Sixth,
  Veterans, Women's Junior, U9–U15). The answer is a later re-import with the overs added to
  `TITANS_LEAGUE_OVERS` in `titans-fixture-map.ts`.

## Cleanup

`irene-oval-cricket-ground-de34e6` "irene Oval Cricket Ground" (home club `admin-cc`) is an
existing prod registry row that no fixture or club ground uses. The bootstrap leaves it alone.
The tenant admin should delete or rename it in the console.

## Re-import (amended or second-half workbook)

Fixture ids are stable across re-imports (`reconcileFixtureIds`), so re-running replaces the
drafts in place without forking ids.

- **Union answers on the held-back fixtures:** remove the entries from `HELD_BACK` in
  `titans-fixture-map.ts` (a stale entry is fatal), apply the move in a reissued workbook, then
  dry-run and `--confirm` with `--only s-titans-u11-platinum-b,s-titans-u11-gold-a,…`. `--only`
  takes full series ids and isolates the run: side and name blockers are scoped to those series
  (a playoff id brings its division in, since its participants are the division's), the strict
  clash gate ignores other stored series' TBC fixtures, and only those series are written.
  HELD_BACK problems stay global. `--append-sides --only …` scopes the side plan the same way.
- **Amended workbook:** pass `--file <path>` and update each sheet's expected count in the
  manifest. A stored fixture missing from the new workbook is a blocker. Re-import replaces a
  draft wholesale, so console edits are lost: the dry run lists each series that "differs from
  the stored draft". An approved draft is written back unapproved, and a released series is
  refused (recall it or leave it out with `--only`).
- **Second-half workbook:** new sheets or groups mean a manifest change in
  `titans-fixture-map.ts` first, then the same order: bootstrap (new venues), `--append-sides`,
  import.
