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

**One step: run `bootstrap-fixture-prereqs`.**

```bash
npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-fixture-prereqs            # dry-run
npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-fixture-prereqs -- --confirm
```

This is now the ONLY way to set up prod for the import. **Manually creating leagues or
clubs in the admin console is explicitly WRONG** — an earlier manual club creation is
exactly what produced a duplicate, skeletal `fam-cricket-club` (the sheets' "FAM" turned
out to already exist as `fam-kwamakhutha`; see below). The script is idempotent — existing
leagues/clubs/venues are left untouched and reported, so re-running after a partial write,
or after a console change, is always safe. In one confirmed run it:

- **Creates the 2 veterans leagues** (`Veterans Premier` → `veterans-premier`,
  `Veterans Promotion` → `veterans-promotion`) the import fails closed on. (The
  pre-existing single `veterans` league is deliberately NOT reused: hosting both
  divisions under one key would put plain "Chatsworth Sporting" and "Chatsworth
  Sporting B" in the same league namespace and trip the suffixed/unsuffixed ambiguity
  guard.)
- **Creates the Parkgate club record** (Promotion Women Group B) — deliberately skeletal
  (district/chair are placeholders the admin corrects in the console once the union
  supplies details), but with its ground pre-set to `Phoenix Stonebridge` per the union's
  facility list, so its home fixtures have an effective ground from the first run instead
  of "undeterminable".
- **Syncs the venue registry from club grounds** (mirrors the console's "Sync from club
  records"): one venue per distinct ground name, junk names (`None`/`N/A`/`-`/`TBD`/`TBC`)
  skipped, and alias-aware — a club record saying "Phoenix Stonebridge" won't spawn a
  duplicate row beside a registry row that already resolves to the same ground through
  the shared alias table (`groundKey`, `venue-clash.ts`). Existing registry rows are never
  touched.
- **Merges the union's permitted-fields list** (`FACILITY_FIELDS` — "which clubs may play
  at which field when there's a conflict") into the registry as `homeClubIds`, unioned
  onto whatever a field's row already carries; a field with no registry row yet gets one
  created unpinned.
  - **"FAM" resolves to `fam-kwamakhutha`**, not a new club — the registry sync is what
    surfaced that prod already has it (ground "Harlequins", Cato Manor 1). The import's
    `NAME_REDIRECTS` sends "FAM" there.
  - **Erases the duplicate `fam-cricket-club`** an earlier manual/script run created,
    but ONLY while it is still exactly the skeletal record that run wrote (no
    affiliation progress, no players, no ground) — any sign of real use and it's left
    alone with a warning to resolve manually.
- **Confirm "Silver Saints" with the union.** Prod has exactly one saints-like club —
  Saints Cricket Club (`saints-cricket-club`), which "Saints" (30-over) and "Saints B"
  (veterans) already resolve to — so the import redirects "Silver Saints"/"Silver saints"
  (T20 sheets) onto it. This redirect is already live in `NAME_REDIRECTS`; get the
  union's one-line confirmation that these are the same club before `--confirm`-ing the
  import itself (the redirect ships regardless — it's a code change, not a prereq step —
  but don't import silently over an unconfirmed identity).
- **Venue registry coverage is now mostly automatic** via the sync + facility merge
  above. A registry miss still isn't fatal — the fixture still gets a venue via
  `venueOverride` — but it isn't locked or geocoded, so it's worth skimming the dry run's
  "venue registry misses" report for anything neither a club ground nor a facility-list
  field covers before `--confirm`.

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

# Prune — remove the 4 superseded series (old Premier/Premier Women T20 top6/bottom6/
# top4/bottom4). Read "Ordering — prune before release" below: with the server-side
# release gate live, this now normally runs BEFORE releasing the replacement drafts,
# not after.
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
  - **The clash pass runs in two phases.** Phase 1 books every fixture with a
    UNION-AUTHORED explicit venue (REVISED-file venues, Premier T20 pair-map matches,
    Venue Allocations re-bases) FIRST; phase 2 then fills in every venue-LESS fixture
    around what phase 1 already booked. Order matters here — an earlier dry run showed a
    venue-less women's fixture auto-move onto Lahee Park before the Promotion T20
    fixture whose union-fixed venue IS Lahee Park had a chance to book it, bumping the
    union's own placement.
  - **Auto-move candidate chain** when a fixture's ground is already booked, tried in
    order and always registry-first (never a barred ground, never the ground already
    clashed on): away side's allocated ground (union Rule 4) → home club's registered
    secondary ground → away club's registered secondary ground → home club's
    facility-list permitted fields → away club's facility-list permitted fields. A
    fixture from phase 1 (an explicit, union-authored venue) may move ONLY within the
    facility list — that sheet is the union's own stated answer to "where do clubs play
    when there's a conflict", so it's the sole sanctioned escape for a venue the union
    itself fixed; a phase-1 fixture the facility list can't place stays a human decision.
  - Capacity is **surfaces-aware via the venue registry**: a registry-resolved ground
    books against its real `surfaces` count (multiple fixtures can share a multi-surface
    ground at the same slot); an unresolved name stays strict at one surface. The ledger
    keys a booking by the registry venue's id, resolved through the shared alias table
    (`groundKey` in `venue-clash.ts`) — so "Toti Oval" and "Toti 1" (or any other
    alias/variant spelling) are recognised as the same ground and share one ledger row,
    on both the import side and the server-side release gate below.
  - The clash pass checks every fixture in the tenant (not just this import) for a
    ground/date/time conflict, using each fixture's EFFECTIVE ground — its explicit venue
    if set, else the home side's allocated ground — so implicit-venue fixtures and legacy
    prod fixtures (which carry no venue fields at all) are covered, not just fixtures with
    an explicit venue written. A fixture whose effective ground still can't be determined
    is skipped and counted, never silently dropped — the report prints a `skipped, ground
undeterminable: N` line. The 4 superseded `DELETE_SLUGS` series are excluded from the
    ledger seed (they're expected to be pruned; counting their grounds would
    phantom-clash with the replacements). An untimed fixture owns its whole ground-day;
    timed fixtures clash on the same ground + date + exact time. One resolvable clash per
    fixture is auto-moved per the candidate chain above; anything else aborts the run
    (`--allow-clashes` writes anyway and prints the clash table for manual fixing in the
    console).
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
| DELETE (via `--prune`)                 | `premier-men-t20-top6`, `-bottom6`; `premier-women-t20-top4`, `-bottom4`                                                                                   |
| KEEP (untouched by either workbook)    | `promotion-men-50ov-g1`, `-g2`                                                                                                                             |

Pruning a still-released series prints a loud warning; it is still deleted (an admin who
prunes early is explicitly choosing to pull it from club portals).

## The server-side release gate (PATCH /series)

`PATCH /series/:id` with `released: true` refuses to release a series while any
ground/date/time clash exists against **any other series in the tenant, released or
draft** (the same effective-ground logic as the import's own clash pass, sharing
`venue-clash.ts`). On a clash it responds `409` with the clash list (up to 3 shown, a
count of the rest), so the console can show exactly what to fix. Recalls
(`released: false`) are **never** blocked — pulling a series back to draft can't make a
double-booking worse.

**This is a deliberate hard block with no override flag.** A known double-booking must
never reach clubs; there is no "release anyway" escape hatch at the API layer (unlike the
import script's `--allow-clashes`, which is a build-time authoring aid for a dry
run/import, not a publish-time gate). If a release 409s, the fix is always one of: prune
the series that's really superseded, or fix the clashing venue/time — never bypass.

### Ordering consequence — prune before release

The 4 superseded series (`premier-men-t20-top6`/`-bottom6`,
`premier-women-t20-top4`/`-bottom4`) have untimed fixtures, so each one owns its whole
ground-day. As long as they still exist on the tenant — released OR draft — they occupy
those ground-days, and releasing their replacements 409s against them.

Practically: once the replacement drafts are imported and approved, they normally sit as
unreleased drafts pending review (that's the state `recall-release` restores them to if
they were accidentally released early — see below). **While the replacements are still
unreleased drafts, run `--prune --confirm` on the 4 superseded series FIRST**, then
approve/release the replacements from the console. Releasing before pruning will 409
against the superseded series' ground-days every time.

This reverses the pre-gate order. The old runbook told operators to release the
replacements first and prune only after — that was safe when the superseded series were
still live to clubs and there was no gate stopping a release next to them; it minimised
the gap where clubs would see neither schedule. With the gate in place that order no
longer works: prune first, release second.

## `recall-release` — recover from an accidental early release

```bash
npx sst shell --stage prod -- npm --prefix packages/api run recall-release              # dry-run
npx sst shell --stage prod -- npm --prefix packages/api run recall-release -- --confirm
npx sst shell --stage prod -- npm --prefix packages/api run recall-release -- --since 2026-08-17T00:00:00Z [--confirm]
```

If an admin releases the freshly-imported `s-planb-*` drafts before the review pass
happens, this pulls them back to draft so they can be re-reviewed and re-released
deliberately. It lists every released `s-planb-*` series and recalls only those whose
server-stamped `releasedAt` is AFTER a cutoff (default: the timestamp the 16 Aug 2026
import finished, from its backup filename; override with `--since` for a different
import run) — writing `released: false, releasedAt: null`, the same single-field recall
the console's "Recall draft" button performs. `approved` is deliberately left as-is, so
re-releasing after review is one click. Series released BEFORE the cutoff (the long-live
50-over/30-over schedules clubs already use) are listed but never touched.

**Recalling hides the fixtures from club portals immediately, but it cannot un-send any
release notifications (email/WhatsApp) the accidental release already triggered** — those
went out the moment the series was released the first time.

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
