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

## 25 Aug 2026 revision

The union revised `KZNCU Dolphins Updated Fixtures.xlsx` on 25 Aug 2026 (the REVISED T20
workbook is unchanged since 16 Aug). This is a **re-import over the 16 Aug series** — every
`s-planb-*` id already exists on prod, so every write is an OVERWRITE with lifecycle
preserved (see Reconciliation). The sheet changes the parser now handles:

- **Premier Women Group 2 header.** The sheet dropped the stale `womens` token; the G2
  header regex is now `(?:womens\s+)?`, so both the old and new wordings match and its 5
  fixtures no longer fall out as orphans.
- **Promotion Women is now a WIDE sheet.** Each group plays its 10 matchups across FOUR
  weekends laid out as four parallel 6-wide column blocks (Series 1–4, base columns
  1/7/13/19) instead of one narrow column. `SHEET_LAYOUTS` (in `import-planb-fixtures.ts`)
  drives a per-block cursor that merges the four blocks into **one series per group, round
  = weekend (1–4), 40 fixtures/group** (was 12). The block dates are 2026-10-24/25,
  2026-11-21/22, 2027-01-23/24, 2027-02-20/21; the in-block "Week N" labels are time-slots,
  not rounds, and are ignored for round assignment. **If the union ever reverts Promotion
  Women to the narrow single-column layout, delete the `'Promotion Women'` entry from
  `SHEET_LAYOUTS`** and restore the group `expected` counts.
- **Parkgate** now resolves to the prod club `parkgate-hambanathi-cc` via `NAME_ALIASES`
  (Group B was recut with Parkgate); the bootstrap no longer mints a `parkgate-cricket-club`
  duplicate.

Because the `expected` counts were updated to 40 for the three Promotion Women groups,
**`--allow-count-mismatch` must NOT be needed** for this revision — a count mismatch here
means a parse regression, not a deliberate sheet change, and should be read, not bypassed.

The only substantive venue difference (Hillary Malvern's Premier T20 home games: the sheet
says Kloof CC, prod holds Peace Park under the union's 17 Aug directive) is resolved **in
favour of the platform** — the importer's `VENUE_DIRECTIVES` re-derives Peace Park
automatically, so the dry run shows three `s-planb-premier-men-t20-1` auto-moves
`Kloof CC → Peace Park [union directive]`.

### Operator sequence (25 Aug re-import, prod)

1. **Bootstrap dry run** — expect NO "would create club" line for Parkgate (the prod record
   already exists); `--confirm` only if it wants to set Parkgate's ground to Phoenix
   Stonebridge, or reports a stale legacy Parkgate club to resolve.

   ```bash
   npx sst shell --stage prod -- npm --prefix packages/api run bootstrap-fixture-prereqs
   ```

2. **Import dry run** — must show ga/gb/gc `✓ 40`, g2 `✓ 5`, no orphans; the name-resolution
   sign-off table `Parkgate → Parkgate Hambanathi CC (parkgate-hambanathi-cc)` with zero
   unresolved names; three `s-planb-premier-men-t20-1` auto-moves `Kloof CC → Peace Park`;
   no unresolved clashes; the GENUINE-edits section empty (the INFORMATIONAL date/time list
   will be long — expected, since this revision amends dates); `23` series to write.

   It also prints, right after the name-resolution sign-off, a **"Clubs with no usable
   ground"** block listing every home club whose prod record has no usable ground (empty or a
   junk placeholder like `None`) and which the Venue Allocations sheet doesn't re-base — their
   home fixtures play at the opponent's ground under Rule 4. On this revision expect **two**
   before the bootstrap ground-fix: `parkgate-hambanathi-cc (venue: '')`, 16 home fixtures, and
   `umgababa-cricket-club (venue: 'None')`, 8 home fixtures.
   - **Parkgate is fixed by the bootstrap.** Running `bootstrap-fixture-prereqs --confirm`
     (step 1) sets `parkgate-hambanathi-cc`'s ground to `Phoenix Stonebridge` (union facility
     list), so on the dry run AFTER the confirmed bootstrap the block shows only **one** club
     (Umgababa) and Parkgate's 16 home fixtures land at its own ground.
   - **Umgababa is an open question for the union.** Its ground is the literal text `None`, so
     the importer treats it as groundless and, under Rule 4, plays its 8 home games at the
     opponents' grounds. This is not a blocker — the import proceeds. When the union answers
     where Umgababa hosts, set the ground on the club record in the console and either
     re-import (a re-import overwrites, lifecycle preserved) or hand-edit the 8 fixtures'
     venues directly. The block is informational only — it never changes the exit code.

   ```bash
   npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- \
     --file "…Dolphins…xlsx" --t20 "…REVISED…xlsx"
   ```

3. **Import** — `--confirm` with **no `--discard-edits` and no `--allow-count-mismatch`**.
   Note the printed backup path; every existing-id line reads `overwrote, lifecycle
preserved` and appends `(withheld: …)` for any series still holding a field back.

4. **Post-import verification** — re-export series+clubs JSON and run
   `compare-planb-fixtures.ts` (see below) → `only-sheet 0`/`only-platform 0`, `✓ matches`
   on the non-T20 slugs, and only alias-form `[import-authored auto-move]` venue diffs plus
   the 3 `Union directive` Peace Park lines (see "Post-import verification" for what to
   read).

5. **Series remain unreleased.** Approve and release from the console, withholding
   venues/times at release if the union hasn't confirmed them yet.

**Risks.** The four Promotion Women weekends pack 10 fixtures/weekend/group across 5 slots
on the same dates as other leagues — review the clash pass, never `--allow-clashes`
blindly. If `parkgate-hambanathi-cc` has no ground, its home games go homeless — the
bootstrap dry run in step 1 is what catches that. The fixture-id churn (`f1..f12 → f1..f40`)
is safe while the series are unreleased and carry no results — this is the last cheap
moment for it.

## 31 Aug 2026 — Gledhow / Crawford North Coast venue directive

The union corrected the home grounds three Promotion clubs share. **The rule now is:**

- **Railways** owns **Crawford North Coast**.
- **Ilembe** and **Dawnheights** ("Don Heights") share **Gledhow Cricket Grounds** as
  their home ground, and their home games must **never** be scheduled at Crawford North
  Coast.

The prod club records already carry the right grounds (Dawnheights →
`Gledhow Cricket Ground`, Ilembe → `Gledhow Cricket Grounds ` with a trailing space,
Railways → `Crawford North Coast`), so no console club edits are needed. The code changes
that enforce this:

- **The two Venue Allocations re-bases are now revoked in code.** The REVISED T20
  workbook's "Venue Allocations" sheet re-bases `Dawnheights → Crawford NC (Ilembe barred)`
  and `Illembe → Crawford NC`; both club ids are in `REVOKED_RE_BASES`
  (`import-planb-fixtures.ts`), so `buildReBaseMap` drops those rows from the re-base map
  **and** from the barred-ground set. Their home fixtures therefore fall back to the club
  record's ground (Gledhow) like any un-re-based club. The dry run prints the dropped rows
  under **`── Venue Allocations re-bases REVOKED by union directive (31 Aug 2026): 2`** —
  confirm both Dawnheights and Illembe appear there.
- **The two Gledhow spellings are one ledger row.** `venue-clash.ts` aliases
  `gledhowgrounds → gledhowground`, so Ilembe's "Gledhow Cricket Grounds" and Dawnheights'
  "Gledhow Cricket Ground" resolve to the same `groundKey` and contest one ground/date/slot
  in the clash pass (and the release gate). The prod registry still has two Gledhow rows;
  `bootstrap-fixture-prereqs` now logs a warning naming both and merges the shared
  facility permission onto one — merge the two rows in the console when convenient (not a
  blocker).

### Saints v Newlands (Top 10 R3, 8 Nov)

A second directive targets one Top 10 fixture. Saints v Newlands is pinned to **Newlands
Oval** via a `VENUE_DIRECTIVES` entry (matched on `homeClubId` = Saints **and** `awayClubId`
= Newlands). Before the re-derive the release gate reported the two console-allocator
placements `f11 CHATSWORTH OVAL` (clashing `premier-women-30ov-bottom4/f4`) and
`f28 CHATSWORTH OVAL` (clashing `bottom4/f9`) on 8 Nov 08:30; re-deriving the series moves
Saints v Newlands to Newlands Oval and puts `f28 PTCC v Dawnheights` back at Lahee Park.
`venue-clash.ts` also aliases Saints' club-record ground "Chatsworth, Penguin Grounds" onto
the registry's "PENGUIN STREET GROUND" (`chatsworthpenguingrounds → penguinstreetground`)
so that field is one ledger row too.

### Two more Saints fixtures at Newlands Oval (Top 10 R2 1 Nov, R5 22 Nov) — admin placements

The Penguin alias exposed a real double-booking the platform previously could not see:
Premier Women Bottom 4 plays KCCD's re-based home games at Penguin Street **and** Chatsworth
United at Chatsworth Oval at 08:30 on every Top 10 Sunday, so both of Saints' grounds are
taken whenever Saints hosts. Two Top 10 fixtures therefore had no sanctioned ground once
Gledhow was reserved for the other side's home game:

- `f8` Ilembe v Saints, 1 Nov 08:30 (Gledhow is Dawnheights v Newlands per the union)
- `f23` Saints v Dawnheights, 22 Nov 08:30 (Gledhow is Ilembe v Lindelani)

Newlands Oval is free all day on both dates, so the admin placed both there. They are encoded
as `VENUE_DIRECTIVES` entries whose `why` starts with **`Admin directive —`** (now an
import-authored reason prefix, so a re-import does not mistake them for hand edits). The dry
run must show `✓ no unresolved clashes` for the Top 10 — **never pass `--allow-clashes`**;
if a clash appears, stop and put it to the union/admin.

### Scope — the two unreleased series only

20 of the 25 prod series are already released; **only `s-planb-promotion-men-30ov-top10`
and `s-planb-promotion-women-t20-ga` are unreleased**, and both must be re-derived. The
Women's Group A series currently holds Ilembe women's home games at Crawford NC (now
forbidden) and two of them at Gledhow 08:30 on 25 Oct and 22 Nov — the exact slots the
union wants the Top 10's Ilembe home games in. Re-deriving **both in one `--only` run** lets
the clash pass resolve that contention:

```bash
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- \
  --file "…KZNCU Dolphins Updated Fixtures.xlsx" --t20 "…REVISED.xlsx" \
  --only promotion-men-30ov-top10,promotion-women-t20-ga [--discard-edits] [--confirm]
```

**Priority under `--only` is manifest order, not argument order.** The clash pass processes
the selected series in `SECTIONS` order; the `--only` filter preserves `built`'s original
order (a plain `.filter`), and `promotion-men-30ov-top10` precedes `promotion-women-t20-ga`
in the manifest. So the Top 10 books Gledhow first and the women's fixture that wanted the
same slot **auto-moves** — expected: to the away side's ground under Rule 4. (Do not try to
reorder priority by changing the `--only` argument order; it has no effect.)

**`--discard-edits` is expected for the Top 10, not for Women's Group A.** The console
allocator's venue reasons on the Top 10 ("Home ground", "One of these sides already has a
match that day", "Home ground already booked that day — …") are not import-authored, so the
edit gate flags them as GENUINE edits and demands `--discard-edits`. Before passing it,
**read the printed GENUINE list and confirm every line is one of those allocator strings** —
never discard a real hand-edit. Women's Group A carries only import-authored reasons, so it
alone would not trip the gate.

**Under `--only` the DELETE set is skipped** (every unselected planb slug would otherwise
look stale) — the run prints `── DELETE set: skipped (--only run)`. Prune is unaffected;
the superseded series were pruned with the original import.

## Merging duplicate venue rows

The prod `dolphins` registry grew duplicate rows for one physical ground under two
spellings (a club-record spelling beside the union's — e.g. "CHATSWORTH OVAL" vs
"Chatsworth Cricket Oval"). `groundKey()` already collapses each pair to one key via
`VENUE_ALIASES`, so the two rows contend for the same field, but they stay two separate
registry items with two `homeClubIds` lists and two pins. `merge-duplicate-venues` folds
each group into one survivor, repoints every fixture that pointed at the loser, and deletes
the loser. It also removes junk rows named "None"/"N/A"/… that carry no real ground.

```
npx sst shell --stage prod -- npm --prefix packages/api run merge-duplicate-venues            # dry run
npx sst shell --stage prod -- npm --prefix packages/api run merge-duplicate-venues -- --confirm
```

It is generic (groups ALL registry rows by `groundKey`), idempotent (a collapsed group has
one row, so a re-run is a no-op), and dry-run by default. The survivor per group is chosen
deterministically: **more fixtures** first (fewest released-series rewrites), then the
canonical spelling (normalised name equals the group key without going through
`VENUE_ALIASES`), then a real pin (finite lat AND lon), then the lexically smaller id — and
the deciding reason is printed as `keep X (reason) ← merge Y`.

**What to expect from the dry run:** each duplicate group with its keep/merge lines and the
field fills the survivor gains from the loser (homeClubIds unioned; lat/lon and any missing
scalar copied from the loser, never overwriting a survivor value); a per-series count of
fixtures to repoint (series id, RELEASED/draft, count); junk rows to delete; and an
"unhandled reference sites" section. The **only persisted venue-id reference is a fixture's
`venueId`** — TenantConfig, season-run structure/calendar snapshots, club ground records and
series participants all reference venues by NAME — so a fixture that names a loser without a
`venueId` link is listed there rather than silently rewritten. A junk row that is still
referenced by fixtures is a **hard error**: the run prints it and writes nothing (exit 1).

**With `--confirm`** it first writes a JSON backup of every venue row and every series it
modifies to `./venue-merge-backup-<tenant>-<iso>.json`, then writes the repointed series
(version bumped, every other field preserved), the survivor venues, and the loser/junk
deletes — printing each write line.

## Exact field numbering (union, 31 Aug 2026)

The union requires every multi-field complex to be named by its exact field number ("Siripat 1"
/ "Siripat 2", "Crusaders 1" / "Crusaders 2", "Harlequins 1" / "Harlequins 2", "Cato Manor 1"…).
`normalise-venue-names` applies this across the whole `dolphins` tenant in one gated pass.

**What the CLI does**

1. **Renames registry rows (ids kept):** `Siripat Road Grounds → Siripat 1`, `Siripat Grounds →
   Siripat 2`, `Crusaders Sports Club → Crusaders 1`, `Crusaders 2 Field → Crusaders 2`,
   `Danville → Danville 1`, `Van Riebek Park (Harlequins 1/2) → Harlequins 1/2`. It verifies the
   row's current name against the expected old (or already-new) name and **hard-errors on drift**.
   Every fixture pointing at the row by `venueId` gets the new `venueName`; a fixture that names
   the old spelling with no `venueId` is linked (venueId + venueName set).
2. **Merges generic complex rows into a numbered field, lowest free first.** The generic rows
   `Cato Manor`, `Cator Manor` (typo), `Harlequins` and `Highbury grounds` are ambiguous — they
   name a complex, not a field. Each fixture on a generic row is re-booked onto the **first
   candidate field with no clash** at its date+time, using a season-wide ledger seeded with every
   other fixture of the tenant (same effective-ground rules as the import's clash pass), processed
   in date order so earlier bookings inform later ones. If no candidate is free for a fixture the
   run **hard-errors and writes nothing**. The generic row's `homeClubIds` are unioned onto the
   first candidate (e.g. Chesterville + Lamontville → Cato Manor 1, FAM → Harlequins 1, Merebank →
   Highbury 1) and the generic row is deleted.
3. **Renames the ground names on club records** (`venue` / `secondaryVenue`), verifying the old
   value (trimmed, case-insensitive) before setting. Fixtures with **no explicit venue** take the
   home club's ground name at display time, so renaming a club record automatically renames those
   implicit fixtures — the CLI prints "N implicit fixtures follow the club record" and writes no
   fixture for them.
4. **Creates reserved `Commons 1` / `Commons 2`** registry rows (no pin, `note: 'Reserved for
   Premier Women (union, 31 Aug 2026)'`, `homeClubIds` = the Premier Women participants).
   Idempotent — skipped if a row with the same ground key already exists.

**The clash gate (mandatory).** After computing every in-memory change the CLI runs a whole-tenant
clash scan on the post-change state and compares it to the same scan on the pre-change state. It
prints both counts — `pre-existing clashes: N (unchanged), new clashes: 0`. If the changes would
introduce **any** clash not present before, it **hard-errors and writes nothing**.

```
npx sst shell --stage prod -- npm --prefix packages/api run normalise-venue-names            # dry run
npx sst shell --stage prod -- npm --prefix packages/api run normalise-venue-names -- --confirm
```

Dry-run by default; `--confirm` first writes a JSON backup of every venue row and every
series/club it will modify to `./venue-normalise-backup-<tenant>-<iso>.json`, then writes the
repointed series (version bumped), the renamed/merged venues, the generic deletes, the renamed
clubs and the new Commons rows. It composes with `merge-duplicate-venues` and the alias flips in
`venue-clash.ts` (old spellings now alias forward onto the numbered canonical names).

**Follow-up — "Reserved" is by convention only.** Commons 1/2 are marked reserved via club
permissions (`homeClubIds`) plus the `note`; the data model has **no per-league venue
restriction**, so nothing in the allocator prevents another league from booking Commons. Enforcing
a true per-league reservation is a separate change.

## Resolving residual venue clashes

After the import and the exact-field-numbering pass there can still be a few ground/date/time
double-bookings the union's own directives never covered — two series that happen to land the same
field on the same day, a promotion game sharing a ground with a premier one, or the two Gledhow
50-over groups. `resolve-venue-clashes` sweeps the **whole `dolphins` tenant** (every series, any
lifecycle, skipping only `cancelled` fixtures; effective ground = `venueOverride` || `venueName` ||
the home club's ground via participants — the same scan normalise-venue-names Step 5 runs), and
moves **one fixture per clash** onto a clash-free ground.

**Which fixture moves** (deterministic, printed with the reason for each clash):

1. If exactly one of the two fixtures sits on its **own home club's ground** (implicit or
   explicit), the one **not** at home moves.
2. Else if the pair is from **different series** and one series slug contains `promotion` and the
   other `premier`, the **Promotion** one moves.
3. Else if the two carry different **group/series numbers** (`-g2` vs `-g1`, `-2` vs `-1`), the
   **higher-numbered** moves (for the Gledhow 50-over pairs, g2 = Ilembe moves).
4. Else the **later fixture id** moves (f37 vs f40 → f40).

Clashes are processed in date order; each move is booked into the ledger so later decisions see it,
and a fixture that would clash again after already being moved this run is a **hard error**. The
destination is the first clash-free ground in the importer's candidate chain — away side's allocated
ground, home then away club's secondary venue, then the home and away clubs' union permitted-fields
lists — never the ground being clashed on, a junk name, or a red-listed / bad-condition ground.

**The clash gate (mandatory).** The CLI re-scans the whole tenant on the post-change state and
prints `pre-existing clashes: N, post-change clashes: 0`. It **refuses to write** — hard-errors and
writes nothing — unless the post-change scan has **zero** clashes (and likewise if any fixture has
no free candidate ground).

```
npx sst shell --stage prod -- npm --prefix packages/api run resolve-venue-clashes            # dry run
npx sst shell --stage prod -- npm --prefix packages/api run resolve-venue-clashes -- --confirm
```

Dry-run by default; `--confirm` first writes a JSON backup of every touched series to
`./venue-clash-resolve-backup-<tenant>-<iso>.json`, then writes each affected series with its
version bumped.

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
- **Ensures the Parkgate club record** (Promotion Women Group B). The sheets' bare
  "Parkgate" resolves through `NAME_ALIASES` to the prod club `parkgate-hambanathi-cc`, so
  the bootstrap finds the existing record (by id or normalised name) and leaves it
  untouched. Only if that record is genuinely absent does it create one — deliberately
  skeletal (district/chair are placeholders the admin corrects in the console), with its
  ground pre-set to `Phoenix Stonebridge` per the union's facility list so its home
  fixtures have an effective ground immediately instead of "undeterminable". A stale
  `parkgate-cricket-club` from an earlier run is reported for manual cleanup, never
  auto-erased.
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
…  --only <slug>[,<slug>…] # import mode only — restrict the run to those built series (by
                           #   seriesSlug). Everything downstream scopes to the selection;
                           #   the DELETE set is skipped. Use it to re-derive one/few
                           #   unreleased series without touching the released ones. Not
                           #   valid with --prune/--revert.

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
  - After the clash pass the dry run prints a **same-club same-slot overlap** report: every
    club id booked into two fixtures at the exact same date+time across the whole
    post-import tenant. Cross-series hits (the bulk) are **informational only** — a club
    fields separate squads (men's/women's/veterans) that all share one club id, so these
    are different teams playing at once, never a ground clash and never moved or aborted on.
    A **same-squad double-booking** (one squad — same side/teamId, so a club's A and B sides
    are not confused for it — in two fixtures in one slot) is a genuine sheet error and is
    printed first and loudly (`✗ same squad double-booked`), though it too is non-fatal.
- Overwritten series (same deterministic id as before) **preserve** any approved/released
  state the admin has set and bump the version. Brand-new series land as **drafts**:
  approve and release each from the admin console (Fixtures & Venues). Direct writes
  never email or WhatsApp anyone; release is what makes them visible to clubs.
- Participants are snapshotted from the live prod club records (name, ground, coords) —
  multi-team sides ("Simplex A/B/C", "Rhythm DHS B/C", "Umlazi A/B", "Meadowridge A/B")
  synthesise a `tm_<clubId>_<leagueKey>_<index>` id per side, matching the console's own
  convention for a club that later gets a real multi-team roster.
- **Bad-condition grounds** (`BAD_CONDITION_GROUNDS`): the RED rows of the union's
  "facility updated.xlsx" (Asherville, Bayview, Chatsworth 306/3B/1111, Lt King Park,
  Verulam Recreation Ground, the Phoenix Blackhaven/Rainham/Sterngrove/Tynebridge
  fields, …) plus grounds the union's follow-up directives ruled out (Kloof CC,
  Lindelani's "129 dukuza street" tennis court). Never offered as candidates; any
  fixture assigned or defaulting onto one is force-relocated even when no clash exists.
  The bootstrap scrubs their registry rows too (permissions cleared, warning note), so
  the console allocator matches. Orange rows (Chatsworth 515A/B, Himalaya Road,
  SL Singh 1–3) are treated as USABLE until the union says otherwise.
- **Union venue directives** (`VENUE_DIRECTIVES`, 17 Aug 2026): four fixture-level
  moves with RESTRICTED candidate lists — Hillary Malvern's Premier T20 games off
  Kloof CC (→ Peace Park / Fairfield Park / Malvern Park), anything at dukuza street in
  Premier Women's T20 G2 or the 30-over Top 10 (→ Kingsmead Oval / Newlands Oval /
  Siripat 1–3), and FAM's Promotion Women G B home games (→ Harlequins 1/2). First free
  slot in the listed order wins; a matched fixture with no free candidate is an
  unresolved clash (fail-closed as usual). West's "Mpumalanga Township Cricket Stadium"
  is currently unused by any fixture (West is re-based to Lahee Park) — nothing to do
  until the union confirms its availability.

## Reconciliation — what changes on prod

| Action                                                                              | Series                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OVERWRITE (lifecycle preserved)                                                     | `premier-men-50ov-top6`, `-bottom6`; `promotion-men-30ov-top10`, `-bottom10`; `premier-women-30ov-top4`, `-bottom4`                                        |
| OVERWRITE (from REVISED, exact venues)                                              | `promotion-men-t20-g1..g4`                                                                                                                                 |
| CREATE on first import / OVERWRITE on re-import (lifecycle preserved, version bump) | `premier-men-t20-1/-2`; `premier-women-t20-g1/-g2`; `promotion-women-t20-ga/gb/gc`; `veterans-premier-t20-1/-2/-30ov`; `veterans-promotion-t20-1/-2/-30ov` |
| DELETE (via `--prune`)                                                              | `premier-men-t20-top6`, `-bottom6`; `premier-women-t20-top4`, `-bottom4`                                                                                   |
| KEEP (untouched by either workbook)                                                 | `promotion-men-50ov-g1`, `-g2`                                                                                                                             |

After the 16 Aug import, **all 23 `s-planb-*` series already exist on prod** — so the 25 Aug
re-import (and any later revision) OVERWRITEs every one of them, preserving each series'
approved/released lifecycle (and its `withheld`/`revealedAt` masking) and bumping the
version.

Pruning a still-released series prints a loud warning; it is still deleted (an admin who
prunes early is explicitly choosing to pull it from club portals).

## Post-import verification (`compare-planb-fixtures.ts`)

After `--confirm`, re-export the prod series and clubs to local JSON and diff them against
the sheets with the read-only `compare-planb-fixtures.ts` (touches no AWS — both sides come
from files on disk, exit code always 0):

```bash
# Export series + clubs (raw DynamoDB Query JSON) — medicoach profile, prod table:
aws dynamodb query --profile medicoach --table-name <prod-table> \
  --index-name gsi1 --key-condition-expression 'gsi1pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"TENANT#dolphins#TYPE#SERIES"}}' > series.json
aws dynamodb query --profile medicoach --table-name <prod-table> \
  --index-name gsi1 --key-condition-expression 'gsi1pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"TENANT#dolphins#TYPE#CLUB"}}' > clubs.json

npx tsx packages/api/src/compare-planb-fixtures.ts \
  --file "…Dolphins…xlsx" --t20 "…REVISED…xlsx" \
  --series-json series.json --clubs-json clubs.json
```

Expect `only-sheet 0` and `only-platform 0` (the summary TOTAL row), and `✓ matches` on
every non-T20 slug. The **six T20 slugs DO show venue diffs** — do not expect zero. Almost
all are cosmetic: the tool compares the sheet's short venue name against the platform's
registry-resolved fuller name (e.g. sheet `Hammond` vs platform `Hammond Cricket Oval`,
`Tills` vs `Tills Crescent Ground`), and both alias to the same ground via `groundKey`.
Those lines are tagged `[import-authored auto-move]` — they are the import's own writes, not
a real mismatch. The only SUBSTANTIVE diffs are exactly **3 Hillary Malvern lines** carrying
`(platform reason: "Union directive — Kloof CC unavailable")` (sheet Kloof CC vs the
platform's directive-derived Peace Park). Read any venue-diff line that is **neither**
`[import-authored auto-move]` **nor** a `Union directive` line — that would be a genuine
divergence. (On the 25 Aug snapshot: 56 alias-form lines + 3 directive lines, 59 total.)

**Fixture ids are reassigned every import** (`f1..f12` became `f1..f40` for the
wide Promotion Women groups). For the narrow sheets that ordering is just row order; for
the wide Promotion Women sheet the rows are sorted first by round, then date, then time, so
its ids follow (round, date, time, then row order). That churn is harmless while the series are unreleased and
carry no results. It does shape the import's own edit gate, though: `diffAdminEdits` flags a
prod-only fixture id as a GENUINE edit **only when a section SHRINKS** — so a future
revision that DROPS fixtures will fail closed and must be **read**, not waved through with
`--discard-edits` by reflex. Re-import also **preserves `withheld`/`revealedAt`** — the
lifecycle-preserve block carries them — so a released-but-withheld series is never silently
un-withheld by a re-import.

## Local rehearsal (e2e test)

`packages/api/test/import-planb.e2e.test.ts` drives the whole flow end-to-end against an
in-process dynalite table seeded from a read-only snapshot of the prod `dolphins` tenant —
parse-only, dry run, `--confirm`, the post-import compare, idempotent re-run, lifecycle/
progressive-release preservation, and every fail-closed gate (count mismatch, orphan
sections, unresolved names, pair asymmetry, venue clash, the genuine-edit gate, prune/
revert, flag validation). It runs the real CLI as a child process and asserts on exit codes,
stdout, and the rows read back through `repo.ts` — no mocks.

It is **environment-gated** so CI and `npm test` skip it (the workbooks and the prod snapshot
contain club-contact PII and never enter the repo). Provide two directories:

```bash
cd packages/api
PLANB_SHEETS_DIR=/path/to/dir-with-both-xlsx \
PLANB_SEED_DIR=/path/to/dir-with-three-raw-json \
  npx tsx --test test/import-planb.e2e.test.ts
```

- `PLANB_SHEETS_DIR` must contain both workbooks under their exact names
  (`KZNCU Dolphins Updated Fixtures.xlsx` and
  `KZNCU_2026-27_T20_Fixtures_Premier_and_Promotion_REVISED.xlsx`).
- `PLANB_SEED_DIR` must contain the three raw DynamoDB Query exports
  (`prod-series-raw.json`, `prod-clubs-raw.json`, `prod-tenant-raw.json`).

With either var unset the suite registers a single skipped test explaining how to run it. The
importer's `planb-backup-*.json` is written to a throwaway temp cwd, never the repo. Backups
and perturbed workbook copies live under the OS temp dir and are cleaned up after the run.

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

## Progressive release (ADR 0011)

An admin may **withhold** venues and/or start times when releasing an `s-planb-*` series —
dates and matchups go out to clubs while grounds or kick-offs are still being settled (see
[ADR 0011](../architecture/0011-progressive-fixture-release.md)). This changes nothing about
the import or the gate above: the series item always stores the **real** venue and time, and
the clash gate evaluates those real grounds — a withheld release is gated on the same
double-booking check as a fully-visible one, so withholding can never sneak a clash past the
gate. Withholding is chosen only at the release moment; recall (`released: false`), including
the `recall-release` script and any other `released: false` write, **clears** `withheld` and
`revealedAt`, so a recalled series carries no mask to silently re-apply when it is next
released. To reveal a withheld field later, use the console's "Reveal venues" / "Reveal times"
action, which sends the `reveal` key on `PATCH /series/:id` — never write `withheld`/
`revealedAt` directly from a repo script, since only the API path stamps `revealedAt` and
leaves `releasedAt` untouched. A re-import preserves both fields (see the post-import section
above), so re-running the importer over a released-but-withheld series never un-withholds it.

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
  - **A DROPPED row needs `--allow-count-mismatch` AND `--discard-edits`.** When a section
    SHRINKS against an already-imported tenant, `--allow-count-mismatch` clears the count
    gate but the missing row leaves a prod-only fixture id (`f30` when 30 became 29), which
    the admin-edit gate flags as a GENUINE edit and aborts on (`existing series carry admin
edits`) — the deliberate "a revision that drops fixtures must be READ" rail. So a real
    row-drop revision needs **both** flags. Remember `--discard-edits` also erases captured
    statuses/results, so read the genuine-edits list before passing it. (A section that only
    GAINS rows trips neither gate beyond the count one, so `--allow-count-mismatch` alone
    suffices there.)
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
