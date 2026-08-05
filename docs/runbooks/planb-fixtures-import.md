# Plan B fixture import — union spreadsheet → prod Series

The union supplied a finished 2026/27 fixture schedule ("Smart club fixtures - Plan B.xlsx")
before there was time to configure and battle-test the structured season machinery on
prod. This runbook imports that schedule as plain Series rows for the dolphins tenant —
and removes it again when the season machinery takes over.

## Commands (run from the repo root)

```bash
# Dry run — parses the sheet, maps team names to prod clubs, writes NOTHING:
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- \
  --file "/path/to/Smart club fixtures - Plan B.xlsx"

# Import (after reviewing the dry run):
… --file "/path/to/…xlsx" --confirm

# Revert — list what would be deleted / delete every imported series:
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- --revert
npx sst shell --stage prod -- npm --prefix packages/api run import-planb -- --revert --confirm
```

## What it does

- One Series per sheet section (league × format × group), deterministic id `s-planb-<slug>`
  — 16 series / 270 fixtures as of the 4 Aug 2026 sheet.
- Series land as **drafts**: approve and release each from the admin console
  (Fixtures & Venues). Direct writes never email or WhatsApp anyone; release is what
  makes them visible to clubs.
- Participants are snapshotted from the live prod club records (name, ground, coords),
  so club-portal visibility and travel costs work exactly as generated series do.
- Venue allocation, approve/release, exports and the club portal treat these like any
  other series. Venues can be allocated from the admin console after import.

## Fail-closed rules (the dry run reports each)

- A team name that doesn't resolve to a prod club aborts the run. Aliases for the
  sheet's short names live in `NAME_ALIASES` (import-planb-fixtures.ts) — e.g.
  "Simplex" → simplex-reservoir-hills-crimson, "Rhythm DHS" → rhythm-dhsob-cricket-club.
- Fixture rows under a section header the manifest doesn't know abort the run (this is
  how a new section added to the sheet surfaces instead of leaking into its neighbour).
- Skipped by design: semi-final/final placeholder rows (no teams yet — add them later
  via Add fixture), the Kingsmead Cup (sheet says "(Clarity)"), and the empty
  Promotion Womens / Veterans sheets.
- Date typos (2026-01/02 dates that mean 2027) are corrected and each correction printed.

## Re-running and reverting

- Re-running `--confirm` after a sheet update overwrites the same `s-planb-*` ids,
  **preserving** any approved/released state the admin has set and bumping the version.
- `--revert --confirm` deletes exactly the `s-planb-*` set — including released ones
  (they disappear from club portals). This is the switch-over moment for the structured
  season machinery: revert, then author the competitions per
  [kzncu-emcu-structures.md](kzncu-emcu-structures.md) and start seasons normally.
