# Plan B fixture import — union spreadsheets → prod Series

The union supplied a finished 2026/27 fixture schedule across **two workbooks** before
there was time to configure and battle-test the structured season machinery on prod.
This runbook imports that schedule as plain Series rows for the `dolphins` tenant — and
removes it again when the season machinery takes over.

1. **Dolphins file** (`KZNCU Dolphins Updated Fixtures.xlsx`) — the whole season: Premier
   Men, Promotion Men (30-over only), Premier Women, Promotion Women, Veterans Premier,
   Veterans Promotion. Has start times, no venues.
2. **REVISED file** (`KZNCU_2026-27_T20_Fixtures_Premier_and_Promotion_REVISED.xlsx`) —
   Men's T20 only, with exact per-fixture venues and a Venue Allocations sheet. Promotion
   Men T20 comes **entirely** from this file (the Dolphins file has no T20 groups for
   Promotion Men); Premier Men T20 keeps its matchups/dates/times from the Dolphins file
   and only borrows venues from this one, matched by unordered team pair.

## Prerequisites (before the first dry run)

- **Create the 3 new leagues in the prod admin console**, typing the labels **exactly**
  as below — the console derives a kebab-case key from the label
  (`slugifyLeagueKey`, `src/leagues.ts:117-123`), so a different label produces a
  different key and the import will refuse to write (fails closed on an unconfigured
  league key):
  - `Promotion Women` → `promotion-women`
  - `Veterans Premier` → `veterans-premier`
  - `Veterans Promotion` → `veterans-promotion`
  - (`premier`, `promotion`, `premierWomen` already exist and are reused as-is.)
- **Confirm the "Saints" cluster with the union before running anything.** The sheets use
  "Saints" (30-over), "Silver Saints"/"Silver saints" (T20), and "Saints B" (veterans) —
  genuinely ambiguous whether these are the same club or different ones. The script
  deliberately has **no alias** for this cluster, so it will show up as unmatched names
  in the dry run until the union confirms and an alias (or separate clubs) is added.
- **Check the venue registry covers the REVISED file's ground names** (ACC 1, Chatsworth
  Oval, Chatsworth 217, Crawford NC, Kingsmead Oval, Tills, Hammond, Kloof CC, Penguin
  Street, Phoenix Stonebridge, Northcroft, Siripat 1/2, Lahee Park, Forest Hills CC,
  Danville 1, Harlequins 1, Crusaders 1, …). A registry miss isn't fatal — the fixture
  still gets a venue via `venueOverride` — but it isn't locked or geocoded, so the dry
  run's "venue registry misses" report is worth clearing first.

## Commands (run from the repo root)

```bash
# Parse only — parses both workbooks, prints the full report (sections, per-fixture
# listings, pair-map, expected-count checks, Venue Allocations table), touches NOTHING
# in DynamoDB. No sst shell needed.
npx tsx packages/api/src/import-planb-fixtures.ts \
  --file "/path/to/KZNCU Dolphins Updated Fixtures.xlsx" \
  --t20 "/path/to/KZNCU_2026-27_T20_Fixtures_Premier_and_Promotion_REVISED.xlsx" \
  --parse-only

# Dry run — also resolves team names to prod clubs, allocates venues, runs the
# season-wide clash pass, and prints the reconciliation report. Writes NOTHING:
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- \
  --file "/path/to/KZNCU Dolphins Updated Fixtures.xlsx" \
  --t20 "/path/to/KZNCU_2026-27_T20_Fixtures_Premier_and_Promotion_REVISED.xlsx"

# Import (after reviewing the dry run):
… --file "…Dolphins…xlsx" --t20 "…REVISED…xlsx" --confirm

# Extra flags for the cases the dry run is designed to surface:
…  --discard-edits       # overwrite existing series even though they carry GENUINE admin edits
…  --allow-clashes       # write even with unresolved venue clashes (fix in the console after)
…  --allow-count-mismatch # write even though a section/group's parsed count != its expected
                           #   count — the escape hatch for a deliberate future sheet revision

# Prune — after the replacement drafts are approved AND released, remove the 4
# superseded series (old Premier/Premier Women T20 top6/bottom6/top4/bottom4):
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- --prune
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- --prune --confirm

# Revert — list / delete every imported series (excludes the keep-list unless --all):
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- --revert
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- --revert --confirm
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- --revert --all --confirm
```

`--file`/`--t20` are both required for an import run; `--prune` and `--revert` take
neither. `--parse-only` is the only mode that never touches the repo/DynamoDB layer, so
it's also the only one that runs without `sst shell` — useful for iterating on the sheet
parsing itself before worrying about prod club/venue data.

## What it does

- One Series per league × format × group, deterministic id `s-planb-<slug>` — 23 series
  from this import (19 from the Dolphins file's manifest + 4 Promotion Men T20 groups
  from the REVISED file), on top of the 2 kept 50-Over Promotion series (see keep-list
  below).
- **Times**: every fixture carries a `time` (`HH:MM`) alongside its `date` where the
  sheet has one — shown on admin and club-portal fixture views as `date · time`.
- **Venues**:
  - Promotion Men T20 (4 groups) — exact venue from the REVISED file for every fixture.
  - Premier Men T20 (2 groups) — matchups/dates/times from the Dolphins file; venue
    looked up by unordered team pair against the REVISED file's Premier sheet.
  - Everything else — implicit (the UI falls back to the home team's registered ground)
    **unless** the home club is re-based per the Venue Allocations sheet, in which case
    the fixture carries an explicit venue with status `alternative` and a reason
    explaining the barred/unlisted original ground.
  - A season-wide clash pass then checks every fixture in the tenant (not just this
    import) for a ground/date/time conflict, using each fixture's EFFECTIVE ground —
    its explicit venue if set, else the home side's allocated ground — so implicit-venue
    fixtures and legacy prod fixtures (which carry no venue fields at all) are covered,
    not just fixtures with an explicit venue written. A fixture whose effective ground
    still can't be determined is skipped and counted, never silently dropped — the
    report prints a `skipped, ground undeterminable: N` line. The 4 superseded
    `DELETE_SLUGS` series are excluded from the ledger seed (they're about to be pruned;
    counting their grounds would phantom-clash with the replacements). An untimed
    fixture owns its whole ground-day; timed fixtures clash on the same ground + date +
    exact time. One resolvable clash per fixture is auto-moved to the OTHER
    participating club's allocated ground (the union's Rule 4, refused if that ground is
    itself barred); anything else aborts the run (`--allow-clashes` writes anyway and
    prints the clash table for manual fixing in the console).
  - Before every abort gate, the dry run prints a deduplicated **name-resolution sign-off
    table** per league — every raw sheet name, the club it resolved to, and the
    synthesised teamId when one was created — so every alias/redirect outcome can be
    reviewed before `--confirm`.
- Overwritten series (same deterministic id as before) **preserve** any approved/released
  state the admin has set and bump the version. Brand-new series land as **drafts**:
  approve and release each from the admin console (Fixtures & Venues). Direct writes
  never email or WhatsApp anyone; release is what makes them visible to clubs.
- Participants are snapshotted from the live prod club records (name, ground, coords) —
  multi-team sides ("Simplex A/B/C", "Rhythm DHS B/C", "Umlazi A/B", "Meadowridge A/B")
  synthesise a `tm_<clubId>_<leagueKey>_<index>` id per side, matching the console's own
  convention for a club that later gets a real multi-team roster.

## Reconciliation — what changes on prod

| Action                                 | Series                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OVERWRITE (lifecycle preserved)        | `premier-men-50ov-top6`, `-bottom6`; `promotion-men-30ov-top10`, `-bottom10`; `premier-women-30ov-top4`, `-bottom4`                                        |
| OVERWRITE (from REVISED, exact venues) | `promotion-men-t20-g1..g4`                                                                                                                                 |
| CREATE (new, land as drafts)           | `premier-men-t20-1/-2`; `premier-women-t20-g1/-g2`; `promotion-women-t20-ga/gb/gc`; `veterans-premier-t20-1/-2/-30ov`; `veterans-promotion-t20-1/-2/-30ov` |
| DELETE (via `--prune`, not this run)   | `premier-men-t20-top6`, `-bottom6`; `premier-women-t20-top4`, `-bottom4`                                                                                   |
| KEEP (untouched by either workbook)    | `promotion-men-50ov-g1`, `-g2`                                                                                                                             |

**`--prune` is a separate, later pass by design.** Deletes are never part of the
`--confirm` import write — the 4 superseded series (old Premier/Premier Women T20) stay
live on prod, including in club portals, until an admin has approved and released the
replacement drafts. Only then run `--prune --confirm`. Pruning a still-released series
prints a loud warning; it is still deleted (an admin who prunes early is explicitly
choosing to pull it from club portals).

## Safety rails (the dry run reports each)

- A team name that doesn't resolve to a prod club aborts the run. `NAME_ALIASES` maps
  sheet short names straight to a club id; `NAME_REDIRECTS` corrects sheet typos and
  cross-file naming differences (e.g. the REVISED file's "Harlequins CC DBN 1st XI" vs
  the Dolphins file's "Harlequins") before that lookup runs.
- A manifest section that parses to 0 fixtures aborts the run (a regex drift must never
  demote an intended overwrite into a silent no-op).
- A section/group whose parsed fixture count doesn't match its expected count also
  aborts the run by default — same fail-closed reasoning as the 0-fixture case, one
  level less severe. Pass `--allow-count-mismatch` to write anyway if a sheet revision
  has deliberately changed a count (e.g. a bye week added).
- A duplicate or asymmetric Premier T20 pair between the two files aborts the run — the
  premise that both files schedule the same 15+15 matchups must hold exactly. This now
  includes a duplicate pair WITHIN the Dolphins file's own Premier T20 sections, not
  just duplicates on the REVISED side.
- A Venue Allocations club name that doesn't resolve to a prod club aborts the run.
- A barred ground with no allocation on the Venue Allocations sheet aborts the run
  (fail-closed rather than silently booking a ground the union has ruled out).
- A REVISED Promotion T20 `stage` cell with no round digit aborts the run rather than
  silently writing `round: 0`.
- **Admin-edit diff — GENUINE edits gate `--discard-edits`, date/time is informational
  only.** Before overwriting an existing series, the script splits its diff into two
  sections:
  - **Genuine edits** (gate the write): a fixture no longer `scheduled`, a hand-set venue
    (`venueOverride`/`venueId`/`venueLocked`) whose `venueReason` ISN'T one the import
    itself authors (reasons starting `Union T20 schedule`, `Allocated ground —`, or
    `Moved to avoid` are the import's own prior writes, never an admin edit), or a
    fixture that exists only on prod (hand-added, e.g. a knockout the old runbook told
    admins to add). Any of these abort the write unless `--discard-edits` is passed.
  - **Date/time differences** (informational only, never gates): this import
    deliberately amends dates and adds times across the whole sheet, and fixture ids
    (`f1..fN`) are regenerated from row order every run, so an id-based date comparison
    can't tell an import amendment from an admin correction. These are printed for the
    operator to read, not blocked on.
  - **`--discard-edits` also erases completed statuses/results** on any series it
    overwrites — read the genuine-edits list carefully before passing it; a fixture with
    a non-`scheduled` status (e.g. a captured result) is exactly the kind of thing it
    discards.
- **Backup**: on `--confirm`, the script first dumps every existing `s-planb-*` series to
  a timestamped JSON file in the current directory (path printed) before writing
  anything — the run is restorable without needing PITR. Enabling PITR on the table in
  `sst.config.ts` is a worthwhile follow-up but a separate decision.
- Date typos (2026-01/02–04 dates in the Veterans Promotion 30-over sheet that mean 2027)
  are corrected and each correction printed.

## Re-running, reverting, and the keep-list

- Re-running `--confirm` after a sheet update overwrites the same `s-planb-*` ids,
  **preserving** any approved/released state the admin has set and bumping the version.
  The write loop is a sequence of plain puts — a crash mid-run leaves mixed state, which
  is fine because re-running is idempotent.
- The DELETE-set assertion accepts any SUBSET of the 4 superseded series (including
  empty) and only aborts if a stale slug falls OUTSIDE that expected set — so re-running
  after `--prune` (when some or all of them are already gone) works cleanly instead of
  tripping an exact-match check.
- `promotion-men-50ov-g1`/`-g2` are the **keep-list**: this import never touches them (no
  workbook covers 50-over promotion), and `--revert` excludes them by default —
  `--revert --all` is the true switch-over wipe that also removes them.
- `--revert --confirm` deletes every other `s-planb-*` series — including released ones
  (they disappear from club portals). This is the switch-over moment for the structured
  season machinery: revert, then author the competitions per
  [kzncu-emcu-structures.md](kzncu-emcu-structures.md) and start seasons normally.
