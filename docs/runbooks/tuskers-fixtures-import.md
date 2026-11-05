# Tuskers fixtures import: KZNICU 2026-27 (Premier T20, Premier 50 Overs, Veterans)

Loads the KZN Inland Cricket Union's 2026-27 fixtures onto the `tuskers` tenant as draft series, then releases them silently. Three CLIs, all in `packages/api/src/`:

| File                                   | Role                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `tuskers-fixture-map.ts`               | Manifest + pure parsers. No AWS.                                  |
| `bootstrap-tuskers-fixture-prereqs.ts` | The 3 veterans-only clubs, the venue aliases, the venue registry. |
| `import-tuskers-fixtures.ts`           | `--parse-only`, dry run, `--confirm`, `--revert`, `--release`.    |

## Source workbooks (read-only)

| Workbook | Default path                                                  | In scope                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mens     | `~/Downloads/Mens Club League Fixtures Season 2026_2027.xlsx` | `Prem T20 Fixtures`, `Prem 50 Overs Fixtures` (visible). The hidden sheets (`Jnr League Teams`, `U11/U13/U16 Fixtures`, a stale `Veterans Fixtures`) must stay hidden; a visible one aborts. |
| vets     | `~/Downloads/Copy of Veterans_Fixtures_2026_2027.xlsx`        | `Veterans Fixtures`, the authoritative veterans source.                                                                                                                                      |

Override with `--file-mens <path>` / `--file-vets <path>`.

## What gets written

| Series                              | League key        | Fixtures | Times                                                                                    |
| ----------------------------------- | ----------------- | -------: | ---------------------------------------------------------------------------------------- |
| `s-tuskers-premier-league-t20`      | `premier-league`  |       28 | Sunday AM 09:00 / PM 13:30 (provisional); 3 evening slots from the side table            |
| `s-tuskers-premier-league-50-overs` | `premier-league`  |       56 | 09:30 (provisional, the sheet has no times)                                              |
| `s-tuskers-veterans-league`         | `veterans-league` |       21 | from the sheet (18:30)                                                                   |
| `s-tuskers-veterans-league-ko`      | `veterans-league` |        2 | Eliminator 30 Jan (`pos:…:2` v `pos:…:3`), Final 6 Feb (`pos:…:1` v `win:f1`), venue TBC |

One side per club per league, so `teamId === clubId`. Series are written `approved: false, released: false`, fixture ids are stable across re-imports (`fixture-identity.ts`), and every write goes through `writeSeriesFromSnapshot` (version-pinned to what the run read).

**Not imported** (each listed in `EXCLUDED_ROWS` with its reason; a stale entry is fatal):

- 50 Overs rows 59/61: Club Champs "Winner Inland vs Winner Coastals" (another competition).
- T20 rows 65–67: Week 5 (1 Nov AM) repeats rows 21–23 of the 1 Nov block exactly. The parser checks they are identical.
- T20 rows 70 and 81: Eliminator and Final, **held back**. The Eliminator was dated 1 Nov, already past; without pool results the `pos:` refs never resolve. `s-tuskers-premier-league-t20-ko` is never written. Confirm the real playoff with KZNICU and add it in the console.
- T20 rows 73/75: Community Cup T20 play-off (another competition).

**Corrections** (manifest data, each must match exactly once):

- T20 side table (rows 57–60, H–M): MCC v Greytown → Fri 16 Oct 18:00, Masibemunye v Young Nats → Fri 23 Oct 18:00, Lancashire v Howick → Sun 25 Oct 17:30, all at PMB Oval. Applied to the Week 4 Sunday-PM fixture, never imported twice.
- 50 Overs row 44 (Week 12): team cell "Howick High" read as Howick CC.
- Team spellings: `MCC` → Maritzburg Cricket Club, `Young Nats` / `Young Nats CC` → Young Natalians Cricket Club. Venue spellings: `Varsity 1` / `Varstiy 1` → Varsity 1 Oval, `Linpark` → Linpark Oval, `Howick` → Howick High. `T.B.C` / `TBC` → venue-less.

One T20 fixture has venue TBC (Masibemunye v Greytown, 11 Oct). It is written venue-less; the release gate places it at the home club's ground.

## Prerequisites

- Tenant `tuskers` exists with the 8 union clubs (from `import-tuskers-compliance`) and league keys `premier-league` and `veterans-league`. A missing key aborts: create it in the console. The bootstrap never mints one.
- **Prod Lancashire** is stored as `lancashire-cricket-club-pmb`. Pass `--map-club lancashire-cricket-club=lancashire-cricket-club-pmb` to the bootstrap AND every importer run on prod.
- `fixtureReminders` disabled and `features.medicoachSync` off on the tenant (checked by `--release`).

## Commands, in order

Dev first, then the same on prod. The user runs every prod `--confirm`.

```bash
cd packages/api

# 1. Parse only, no AWS. Counts must match the manifest; writes the report.
npx tsx src/import-tuskers-fixtures.ts --parse-only --report-out /tmp/tuskers-fixtures-report.md

# 2. Prereqs: dry run, then apply.
npx sst shell --stage dev -- npx tsx src/bootstrap-tuskers-fixture-prereqs.ts
npx sst shell --stage dev -- npx tsx src/bootstrap-tuskers-fixture-prereqs.ts --confirm

# 3. Import: dry run (expect 0 venueOverride, clash scan clean), then write drafts.
npx sst shell --stage dev -- npx tsx src/import-tuskers-fixtures.ts
npx sst shell --stage dev -- npx tsx src/import-tuskers-fixtures.ts --confirm --backup-dir ~/tuskers-backups

# 4. Club league keys from the written series.
npx sst shell --stage dev -- npx tsx src/sync-club-leagues-from-series.ts tuskers --include-drafts --confirm

# 5. Silent release: dry run (gate preview), then write.
npx sst shell --stage dev -- npx tsx src/import-tuskers-fixtures.ts --release
npx sst shell --stage dev -- npx tsx src/import-tuskers-fixtures.ts --release --confirm
```

On **prod**, step 5 is deferred into the medicoach rollout's uniform order: after the MC bundle carry, before the tenant's sync flags go on.

`--only <series id or slug>[,…]` restricts import, revert and release. `--today YYYY-MM-DD` sets the "past" cut-off for the report (past fixtures are imported normally, just listed).

## Silent release (`--release`)

- Prints `fixtureReminders.enabled` and `features.medicoachSync` and **refuses** if either is on. A CLI release skips the console's medicoach requeue, so it is only valid while sync is off and the bundle carry owns the initial load.
- Re-reads only the manifest's writable series (`WRITABLE_SERIES_IDS`, narrowed by `--only`) — never a `s-tuskers-*` prefix sweep, so a console-created series such as `s-tuskers-premier-league-t20-ko` is never released by this CLI — and runs the console's release gate per series: `findClashes` against every tenant series with the tenant's aliases. A series with any clash is **held** and listed; the rest get `approved: true, released: true, releasedAt`.
- Sends nothing. Release fires no notices server-side, and this CLI imports nothing from `notify/`.
- Exit code 1 when anything was held or changed mid-run.

## STOP conditions

Stop and report; do not work around:

- any parse error or count mismatch (the workbook changed: re-measure, never edit counts to fit);
- any clash in the scan or a held series in `--release`. There is no `--allow-clashes`. Resolve with KZNICU or fix the venue/time in the console;
- a registry miss on `--confirm` (bootstrap not run, or a new ground);
- `club "…" is not on the tenant` (compliance import or `--map-club` missing);
- an existing series is RELEASED (the importer never overwrites one);
- `--release` refuses on reminders / medicoach sync.

## Revert

```bash
npx sst shell --stage dev -- npx tsx src/import-tuskers-fixtures.ts --revert            # dry run
npx sst shell --stage dev -- npx tsx src/import-tuskers-fixtures.ts --revert --confirm  # backup, then delete
```

Deletes the series, their umpire appointments and their medicoach-sync state. A released series needs `--include-released`. Refuses outright when `features.medicoachSync` is on (deletes would not reach medicoach; delete from the console instead). Not reverted: bootstrap clubs, aliases, venues and club league keys.

## Re-import (amended workbook)

Re-measure with `--parse-only`, update the manifest counts and rules, then dry run and `--confirm`. Matched fixtures keep their ids (and medicoach refs); new fixtures get ids above the series' high-water mark; stored fixtures the sheet no longer has are listed in the dry run. A released series must be recalled or reverted first.

## Open with KZNICU (non-blocking)

- The 3 T20 side-table rows treated as reschedules.
- The T20 playoff outcome (Eliminator was 1 Nov), to add via the console.
- Veterans Eliminator/Final venues (TBC).
- 50 Overs 09:30 and T20 AM/PM start times (provisional).
- Canonical names and district for Midlands, Zingari and Cosmos. They are created with `leagues: []` and no contacts. Seed chair contacts (or exclude the vets series from captains' reports) before captains' reports are switched on for tuskers.
