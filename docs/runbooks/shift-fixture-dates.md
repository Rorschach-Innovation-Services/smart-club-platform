# Runbook: shift-fixture-dates (dry-run reschedule tool)

**Status: build-only, for dry-run use while the union decides.** This tool moves fixtures
in bulk from one date (or weekend) to another and cascades the later rounds. It exists so
the union can _see_ the resulting calendar before committing. It was built for KZNCU item 4
(17 Sep 2026 batch: move the 12/13 Dec fixtures to 16/17 Jan), which is **ON HOLD** — do not
run it with `--confirm` for that move.

## What it does

- `--from-date`/`--to-date` pair positionally, so a weekend maps Sat→Sat and Sun→Sun. Within
  a series, only the from-date that side actually plays matches; that round's fixtures move to
  the paired to-date. If a single `--to-date` is given, its day-offset from the first
  from-date is applied to every from-date.
- `--cascade` controls what happens to later rounds after the move:
  - `slot` (default): while the moved date lands on an existing later playing date, that
    later round shifts to the **next existing playing date** in the series (calendar gaps are
    preserved); the last displaced round gets **old last date + 7 days**.
  - `weeks`: every fixture dated ≥ the earliest to-date (and not itself moved) shifts **+7
    days** (the whole tail slides a week, keeping its gaps).
  - `none`: only the targeted fixtures move; a resulting same-day collision is left as-is.
- `time`, venue fields (`venueOverride`/`venueName`) and fixture ids are always preserved.
- Prints a per-series `Round → old date → new date` table and the count of fixtures touched.
- Runs the season-wide `findClashes` on the would-be state of **all** tenant series and
  prints every clash. If the change **introduces** a clash (a pair-on-ground not present
  before, by the same subset rule the in-season venue gate uses), it **refuses to write**
  even with `--confirm`.

## Dry-run (default)

```sh
npx sst shell --stage <stage> -- npm --prefix packages/api run shift-fixture-dates -- \
  --tenant <slug> \
  --series <s-id,s-id,…> \
  --from-date <YYYY-MM-DD[,YYYY-MM-DD]> \
  --to-date <YYYY-MM-DD[,YYYY-MM-DD]> \
  [--cascade slot|weeks|none]
```

No `--confirm` ⇒ nothing is written; you get the table and the clash report only.

### The dolphins 12/13 Dec → 16/17 Jan case (ON HOLD — dry-run only)

```sh
npx sst shell --stage prod -- npm --prefix packages/api run shift-fixture-dates -- \
  --tenant dolphins \
  --series s-planb-premier-men-50ov-top6,s-planb-premier-men-50ov-bottom6,s-planb-veterans-promotion-30ov \
  --from-date 2026-12-12,2026-12-13 --to-date 2027-01-16,2027-01-17
```

Expected: Premier Men Top 6 / Bottom 6 R7 (Sun 13 Dec) → Sun 17 Jan (R8 is 24 Jan, so no
cascade needed there); Veterans Promotion R3 (Sat 12 Dec) → Sat 16 Jan, which collides with
its existing R4 (16 Jan) → the `slot` cascade pushes R4 onward. Read the printed table and
clash report with the union before deciding.

## Writing (only once the union has approved a specific move)

Append `--confirm`. On write the tool first backs up the touched series to
`./shift-fixture-dates-<tenant>-<timestamp>.json`, then calls `repo.updateSeries` per series
with the read `version` (optimistic concurrency). It will still refuse if the change would
introduce a venue clash.

There is **no date-change notification** — clubs are not messaged when a fixture date moves.
Communicate any confirmed move to clubs out of band.
