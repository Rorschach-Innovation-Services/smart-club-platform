# Lions (CGL) fixtures import: 2026-27 league workbook and T20 pools

One-time import of the Central Gauteng Lions 2026-27 fixtures into the `lions` tenant: 13
league sheets (1,513 fixtures) plus 6 hand-transcribed T20 pools (72 fixtures), written as
19 draft `s-lions-*` series. This is the critical path for the 10/11 Oct 2026 league start.
For where it sits in the full onboarding sequence, see
[lions-onboarding.md](./lions-onboarding.md).

**Scripts**: `packages/api/src/import-lions-fixtures.ts` (npm alias `import-lions-fixtures`),
`packages/api/src/bootstrap-lions-fixture-prereqs.ts` (alias
`bootstrap-lions-fixture-prereqs`) and `packages/api/src/lions-fixture-map.ts` (sheet
manifest, team-name resolution, T20 transcription, venue alias map; pure, no AWS).

**Purpose-built, not copy-and-trimmed from planb.** It reuses only planb's tenant-neutral
cell helpers (`isoDate`, `isoTime`, the `WrittenFixture` shape). planb's `buildSeries`
resolves names through the dolphins `NAME_ALIASES`/`NAME_REDIRECTS` tables with no injection
point, so this importer pre-resolves every team name through `lions-import-map.ts` and builds
the series itself. Never edit planb's alias or redirect tables to make a lions name resolve:
fix it in the lions map.

Same contract as the rest of the family: `--parse-only` touches no AWS, dry-run is the
default, every abort prints its reason, a JSON backup is written before any write, and
`--revert` undoes it.

## Conversion pre-step (done 2 Oct 2026)

CGL supplied `Final Fixtures 2026-2027.xlsb` and a Sunday grounds sheet as `.ods`. The
importer family reads ExcelJS, which handles neither, so both were converted once with the
repo's SheetJS 0.20.3 into `~/Downloads/Lions/prepared/`. Nothing in the repo changed.

- **Values-only.** 3,926 Home/Away/Venue cells (and some Saturday dates such as `=A40+7`)
  were formulas into an external workbook that isn't in the pack. Written as formulas they
  would recalculate to `#REF!`. The converted file holds each cell's cached value and zero
  formulas.
- **Read UTC, never local time.** ExcelJS returns dates as `Date` at UTC midnight and times
  on the 1899-12-30 epoch (`1899-12-30T09:00:00Z`). SheetJS's JS-Date mode shifted them by
  the SAST offset during inspection (`2026-10-10T22:00Z`). The importer reads UTC components
  and rejects any date outside 1 Sep 2026 to 31 May 2027 as a bad read.
- **Fidelity was checked independently** of the converter (pyxlsb vs openpyxl, then an
  ExcelJS read-back): 0 field diffs and 0 raw-row diffs on all 13 sheets, every time cell
  typed as a time. The full table, first/last row per sheet and the Sunday-sheet diff are
  in `~/Downloads/Lions/prepared/conversion-fidelity-report.md`.

If CGL reissues the workbook, re-run the conversion and the fidelity check before anything
else. Don't hand-edit the `.xlsb` original.

## Sheet manifest and expected counts

| sheet        | series                 |  fixtures | notes                                      |
| ------------ | ---------------------- | --------: | ------------------------------------------ |
| Premier A    | `s-lions-premier-a`    |       132 |                                            |
| Premier B    | `s-lions-premier-b`    |       132 |                                            |
| Presidents A | `s-lions-presidents-a` |       132 |                                            |
| Presidents B | `s-lions-presidents-b` |       132 |                                            |
| Sunday 1     | `s-lions-sunday-1`     |       132 | 2 TBC venues                               |
| Sunday 2     | `s-lions-sunday-2`     |       131 | 4 TBC venues                               |
| Sunday 3     | `s-lions-sunday-3`     |       132 | 5 TBC venues                               |
| Sunday 4     | `s-lions-sunday-4`     |       132 | 17 TBC venues                              |
| Sunday 5     | `s-lions-sunday-5`     |       132 | 2 TBC venues                               |
| Saturday 1   | `s-lions-saturday-1`   |        90 | 4 Macrocomm placeholder rows skipped       |
| Saturday 2   | `s-lions-saturday-2`   |        90 | 4 Macrocomm placeholder rows skipped       |
| Saturday 3   | `s-lions-saturday-3`   |        90 | 4 Macrocomm placeholder rows skipped       |
| Vets SA 1    | `s-lions-vets-sa-1`    |        56 | `Delfos 1`/`Delfos 2` are two Delfos sides |
| **total**    |                        | **1,513** | plus 12 Macrocomm skips = 1,525 rows       |

Each sheet's count is asserted (`LEAGUE_SHEETS[].expected`). A sheet off its count, missing,
or with an unparseable row aborts the run.

**Macrocomm rows.** Saturday 1 to 3 each carry four `Macrocomm Round 1` to `4` rows: date and
time in A/B, the label in Home, Away and Venue empty. They are an interleaved T20-cup
placeholder, not teams. `isMacrocommRow` skips that exact pattern only. Any other name that
resolves to no club aborts. The cup gets imported later if CGL supplies its fixtures.

**Out of scope sheets.** `Sunday 6` and `U15` hold only "Not done", and `Saturday 4` and
`Saturday 5` are empty. They aren't in the manifest.

## T20 pools (pool rounds only)

The Hollywoodbets Premier T20 and Ladies Premier T20 came as five PDFs, so their fixtures are
hand-transcribed into `T20_POOLS` in `lions-fixture-map.ts`. Venue-change PDFs are reissues
and were treated as authoritative over the originals.

| series                               | fixtures | teams |
| ------------------------------------ | -------: | ----: |
| `s-lions-hwb-premier-t20-a-group-a`  |       15 |     6 |
| `s-lions-hwb-premier-t20-a-group-b`  |       15 |     6 |
| `s-lions-hwb-premier-t20-b-group-a`  |       15 |     6 |
| `s-lions-hwb-premier-t20-b-group-b`  |       15 |     6 |
| `s-lions-ladies-premier-t20-group-a` |        6 |     4 |
| `s-lions-ladies-premier-t20-group-b` |        6 |     4 |

`verifyT20Pools` checks every run: the count per PDF, one game per team per slot and a
complete round-robin per pool. The transcription was also read back against the PDFs by
hand before freeze.

- **Played rounds import as past fixtures.** The 20 and 27 Sep and 3/4 Oct rounds are in.
  Series fixtures carry no result fields, so these show with no outcome until the
  match-centre programme lands. Set that expectation with CGL.
- **Ladies semis and final (10 Oct) are excluded.** The PDFs only say "Group A winner" and so
  on, and the importer fails closed on unresolved names. Add them with a follow-up pass
  once CGL names the qualifiers (map entry, then `--only` on the affected slug).
- **Multi-side clubs.** A club with two sides in one cup (G&M Old Edwardians, Jeppe, Khosa,
  Lenasia, Old Parktonians, UJ) gets a synthesised `tm_<clubId>_<leagueKey>_<index>` team
  id per side, matching the console's convention. Vets `Delfos 1/2` work the same way.

## Name resolution

The 15 leagues carry 178 distinct (league, raw name) pairs, resolving to 42 clubs. The dry run prints the full
sign-off table, per league, before any gate. Read it before `--confirm`. The judgment calls
CGL is confirming (reply-by 7 Oct, see the onboarding runbook) are:

- Western Warriors/Crescents is one club (`western-warriors-cricket-club`).
- Wits Lions and Wits University are separate clubs. "Wits CC" (Sunday 5) is assumed to be
  Wits University.
- Marks Park and Marks Park Thistles are kept separate.
- Khosa (four spellings), Old Parktonians (three) and EP Ottomans (two) each collapse to one
  club.

An unresolved name aborts. Fix it in `lions-import-map.ts`, never in planb.

## Venue policy

**Sheet-authoritative.** Each fixture keeps the venue CGL wrote. There is no auto-move.

- A venue that resolves to the registry (through `LIONS_VENUE_ALIASES`, never the dolphins
  default alias table) is written locked, with the registry's id and name.
- A venue that misses the registry is written as a `venueOverride` with an equal
  `venueName`, and listed. Today that is **26 fixtures** across 3 strings: "Ferndale High
  School" ×11, "Sir John Adams" ×11 and "Puntans" ×4. They're real grounds that appear on
  neither grounds sheet. Add them to the registry later if CGL wants them locked.
- "TBC" (and TBA, blanks, junk) is written venue-less with `venueStatus: 'unresolved'`,
  excluded from the import's clash scan, and listed. Today that is **31 fixtures**: 30 in
  Sunday 1 to 5 (17 of them in Sunday 4) and 1 in the HWB Premier T20 (3 Oct, Soweto Pioneers
  v Marks Park Thistles).

Expected dry-run venue line: `1585 fixtures → 1528 registry-locked, 26 venueOverride
(registry miss), 31 TBC (venue-less)`.

**TBC fixtures at release.** The API's release gate gives a venue-less fixture its home
club's ground and clash-checks it there. The dry run prints this as a separate,
non-blocking "Release-gate preview". Anything listed there will block the release of its
series, so get a ground from CGL (or set one in the console) before releasing.

**The alias map** (`LIONS_VENUES` in `lions-fixture-map.ts`) reconciles the fixtures
workbook, both grounds sheets, the T20 PDFs and the affiliation facility answers into 66
canonical grounds. Spellings that only differ in case, spacing or generic words ("cricket",
"club", "cc") need no alias. Affiliation answers that could name either of two ovals
("Marks Park", "Hyde Park High School", "Lenasia Tech Grounds", "Sir Lionel Phillips -
Pirates Sports Club", "Dainfern College") are deliberately not aliased. The bootstrap lists
them instead (26 affiliation lines are reported as not registered).

**Nine equivalences are inferred, not spelled out.** They're on the CGL question list for
confirmation. Inference only ever merges names, which can add clashes to the scan but can
never hide one.

| canonical ground          | also treated as                       | basis                                           |
| ------------------------- | ------------------------------------- | ----------------------------------------------- |
| Azaadville Sports Complex | Azaadville cricket ground             | Azaadville's only home ground in the fixtures   |
| Heidelberg                | Heidelburg, Unie Grounds              | Heidelberg CC's only affiliation facility       |
| Kagiso Main               | Kagiso Stadium, Kagiso Sports Complex | Kagiso's only home ground in the fixtures       |
| KHS                       | KHS 1                                 | Vets grounds sheet, beside "KHS 2"              |
| Khosa Main                | Doug Poole                            | Khosa's Sunday home games are all at Khosa Main |
| NWU 1                     | NWU Vanderbijlpark                    | NWU Vaal's only ground                          |
| Old Parks A               | Doug Neilson, Doug Neilson Oval       | all Old Parks' Premier B home games are at A    |
| Old Parks B               | Old Park B, Copper Orr Oval           | Old Parktonians' second oval                    |
| Vereeniging               | Dick Fourie (and variants)            | grounds sheets + Vereeniging CC's affiliation   |

If CGL says one is wrong, split the entry in `LIONS_VENUES`, re-run the bootstrap
(`--confirm`) and re-run the fixtures dry run.

## Clash policy: hard stop

The import runs a season-wide clash scan over every fixture on the tenant, not just this
import, using each fixture's effective ground. Capacity is the registry venue's `surfaces`,
which is 1 for every ground until CGL answers the capacity questions
(`KNOWN_GROUND_CAPACITIES` is empty on purpose; never guess an entry).

**Any unresolved clash aborts the write. There is no `--allow-clashes` flag**, by standing
rule. Unresolved clashes get listed and sent to CGL, never written.

**Known clash (1):** Lens Tech 1, Sun 4 Apr 2027 09:00. Sunday 2 R22 Crosby Legends v Old
Lions and Sunday 4 R22 Sopranos v Khosa are both booked there. It's in the CGL question
list at `~/Downloads/Lions/prepared/lions-clash-and-capacity-questions.md` (regenerate with
`--parse-only --questions-out <md>`), along with the 31 TBC fixtures and the 3 unregistered
venue names.

Ways to clear it, in order of preference:

1. **CGL confirms Lens Tech 1 can host two matches.** Add `'Lens Tech 1': 2` to
   `KNOWN_GROUND_CAPACITIES`, re-run `bootstrap-lions-fixture-prereqs --confirm` (it raises
   `surfaces` on the existing registry row), then re-run the fixtures dry run.
2. **CGL moves one fixture.** Best is a reissued workbook (convert and fidelity-check it
   again). For a single cell, editing the Venue in the prepared values-only copy is
   acceptable. Record the change and CGL's instruction next to the fidelity report, and
   never edit the `.xlsb` original.
3. **Deadline contingency: partial write with `--only`.** If CGL hasn't answered by cutover,
   write every clash-free series and hold the contested one. The scan is scoped to the
   selected series plus whatever is already on the tenant, so leaving out either Sunday 2 or
   Sunday 4 clears it. Hold the one CGL is more likely to move:

   ```bash
   … import-lions-fixtures -- --confirm --only premier-a,premier-b,presidents-a,presidents-b,sunday-1,sunday-2,sunday-3,sunday-5,saturday-1,saturday-2,saturday-3,vets-sa-1,hwb-premier-t20-a-group-a,hwb-premier-t20-a-group-b,hwb-premier-t20-b-group-a,hwb-premier-t20-b-group-b,ladies-premier-t20-group-a,ladies-premier-t20-group-b
   ```

   The held series (here Sunday 4) still won't import until the clash is resolved, because
   the already-written Sunday 2 now sits in the scan. Its first fixture is 11 Oct, so chase
   CGL immediately.

`--only` takes the bare slug (no `s-lions-` prefix). An unknown slug is rejected with the
known list.

## Prerequisites

1. **The `lions` tenant exists** with the four CGL districts, and `import-lions-affiliation
--confirm` has run. The fixtures dry run aborts on any club not on the tenant
   (`run import-lions-affiliation first`).
2. **`bootstrap-lions-fixture-prereqs --confirm` has run.** `--confirm` aborts on an empty
   venue registry or a missing league key. It does three idempotent things and never
   overwrites anything existing:
   - **Leagues**: adds every `LIONS_LEAGUES` key the tenant lacks (the 13 sheet leagues plus
     `hwb-premier-t20` and `ladies-premier-t20`, which are `fixturesOnly`), all under
     "All districts".
   - **Venue aliases**: merges `LIONS_VENUE_ALIASES` into the tenant's
     `competitionDefaults.venueAliases`, so the API's release and in-season clash gates
     resolve ground spellings exactly as the importer does. A key already mapped elsewhere is
     reported, never overwritten.
   - **Venue registry**: one row per canonical ground on the Saturday and Sunday grounds
     sheets (66), with the listing clubs as `homeClubIds`, merged with the affiliation
     facility answers that match. An existing row keeps its name and pin and only gains
     missing `homeClubIds` (and a raised `surfaces` when `KNOWN_GROUND_CAPACITIES` has a
     value). A grounds-sheet club name that resolves to no club aborts.

   The Sunday grounds sheet's Presidents A block has no title row and it has no Sunday 5
   block. Both are tolerated, because the registry only needs club → grounds.

## Commands (run from the repo root)

Inputs default to the prepared files: `prepared/Final Fixtures 2026-2027.xlsx`,
`prepared/Teams per division and Grounds - Sunday.xlsx`, the original Saturday grounds
`.xlsx` and the affiliation export, all under `~/Downloads/Lions`. Override with `--file`,
`--sunday-grounds`, `--saturday-grounds` and `--affiliation`.

```bash
# Parse only: no AWS. Counts, T20 asserts, name sign-off, venue split, and a PROVISIONAL
# clash scan against the would-be registry built from the grounds sheets + affiliation.
npx tsx packages/api/src/import-lions-fixtures.ts --parse-only
npx tsx packages/api/src/import-lions-fixtures.ts --parse-only \
  --questions-out ~/Downloads/Lions/prepared/lions-clash-and-capacity-questions.md

# Prereqs: leagues, venue aliases, venue registry.
npx tsx packages/api/src/bootstrap-lions-fixture-prereqs.ts --parse-only
npx sst shell --stage <stage> -- npm --prefix packages/api run bootstrap-lions-fixture-prereqs
npx sst shell --stage <stage> -- npm --prefix packages/api run bootstrap-lions-fixture-prereqs -- --confirm

# Dry run: reads the tenant's clubs, registry and series. Same report plus the release-gate
# preview and a club-league sync preview. Writes nothing.
npx sst shell --stage <stage> -- npm --prefix packages/api run import-lions-fixtures

# Write (after reviewing the dry run). Backup first, then 19 draft series, then club sync.
… import-lions-fixtures -- --confirm
… import-lions-fixtures -- --confirm --only <slug>[,<slug>…]   # partial write
… import-lions-fixtures -- --confirm --no-club-sync             # skip the club-league sync

# Revert: lists, then deletes, the manifest's series (all 19 slugs).
… import-lions-fixtures -- --revert
… import-lions-fixtures -- --revert --confirm
… import-lions-fixtures -- --revert --all --confirm             # every s-lions-* series
```

`--parse-only` exits non-zero today because of the one Lens Tech 1 clash. That's the gate
working, not a parse failure: every count and assert above it is green.

Flag rules: `--parse-only` and `--confirm` are mutually exclusive, `--all` is revert-only,
and `--revert` takes only `--all` and `--confirm`.

## What a write does

- **Drafts only.** New series land unapproved and unreleased. Re-importing over an existing
  draft keeps its `approved` state and bumps its version.
- **Released series are never overwritten.** An existing released `s-lions-*` series in the
  selection aborts the run. Recall it in the console first, or leave it out with `--only`.
- **Backup**: `packages/api/lions-fixtures-backup-<ts>.json`, a snapshot of every existing
  `s-lions-*` series, written before the first put (gitignored).
- **Club-league sync**: after writing, each participating club's `leagues` (and multi-side
  `leagueTeams`/`teamRosters`) is unioned with the leagues it now has fixtures in, drafts
  included. Without this, Season Insights reads "0 clubs" (the dolphins lesson). The
  affiliation import assigns no leagues on a fresh tenant because none exist yet, so this
  sync is what fills them. It's merge-only and idempotent.
- **Nothing is sent.** Neither the import nor the console release sends email or WhatsApp.
  Club chairs push fixtures to their players themselves from the portal.

## Verification checklist (after `--confirm`)

1. The admin console lists 19 `s-lions-*` series (fewer if you used `--only`), all drafts.
   Fixture counts match the manifest tables above.
2. Spot-check the first and last fixture of a few sheets against the fidelity report's
   first/last-row table, including the time (09:00 Sunday sheets, 13:00 Saturday/Vets).
   A 22:00 previous-day date means a local-time read crept in.
3. Open a fixture at a `venueOverride` ground (Ferndale High School) and a TBC one (Sunday
   4, 11 Oct, EP Ottomans v VUT). The first shows the ground unlocked, the second shows no
   venue.
4. Vets SA 1 shows Delfos as two sides. The HWB Premier T20 shows Jeppe, Khosa, Lenasia and
   UJ as two sides each.
5. Season Insights shows non-zero clubs for each league.
6. Re-run the dry run. The tenant line should show the written series, and the clash scan
   should be clean (a series never clashes with its own stored copy).

## Revert

`--revert` deletes the manifest's 19 series (`--all`: every `s-lions-*` series). It backs up
first and warns loudly for any released series, since deleting one pulls it from club
portals immediately. It leaves the leagues, venue registry, aliases and the club-league sync
in place. Those are harmless without fixtures and reused on the next import.

In the full rollback order, fixtures come after contacts and compliance and before
affiliation. See [lions-onboarding.md](./lions-onboarding.md#revert-order).

## Follow-ups

- Ladies Premier T20 semis and final, once CGL names the qualifiers.
- The Macrocomm T20 cup, if CGL supplies its fixtures.
- `KNOWN_GROUND_CAPACITIES` and the nine inferred equivalences, from CGL's answers.
- Grounds for the 31 TBC fixtures, set in the console as CGL supplies them.
- Results for the played T20 rounds, once the match-centre programme can hold them.
