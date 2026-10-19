# Captains-report resend to captains + CSA premier scorecard import (17–18 Oct 2026)

Two scripts, run in this order. Both default to a dry run and write a JSON backup; `--confirm`
is refused while a notify channel is in dry-run or the link base is local. The `--stage` flag
must match the `sst shell` stage.

## 1. Import the CSA premier scorecards

The KZNCU T20 Premier Men/Women matches are scored on cricketpvcms.co.za, not Match Centre, so
the 10 scorecards of 18 Oct come from the scraped workbook. The import stores them as
FIXSCORECARD rows (`medicoachMatchId: csa-…`, `terminal: true` — the sync never fetches over
them) so the report form shows the card and requires the captain's confirm/correction answer.

```bash
# Dry run — expect TEAM_ALIASES gaps on the first pass (hard stop, nothing written):
npx sst shell --stage prod -- npx tsx packages/api/scripts/import-csa-scorecards.ts \
  --stage=prod --file="/Users/carlton/Downloads/Scorecards - Dolphins (KZN Coastal).xlsx" \
  --date=2026-10-18
```

Paste any "no candidate fixture" output back so `TEAM_ALIASES` in the script can be filled
(likely gaps: Hollywoodbets Crusaders, RHYTHM DHSOB, Harlequins CC DBN, KCCD MANCOSA). Re-run
the dry run until all 10 matches resolve, then:

```bash
npx sst shell --stage prod -- npx tsx packages/api/scripts/import-csa-scorecards.ts \
  --stage=prod --file="/Users/carlton/Downloads/Scorecards - Dolphins (KZN Coastal).xlsx" \
  --date=2026-10-18 --fill-summaries --confirm
```

`--fill-summaries` copies the workbook result onto each side's PENDING report's result line
(never a submitted one, never over an existing value). Spot-check one report link or the
portal: the scorecard section should show the innings and a "View on the scoring site" link.

## 2. Resend the unsubmitted reports to captains

Selects the weekend's pending auto reports. The captain comes from the club's most recent
SUBMITTED report's captain name, matched against the active adult roster (ambiguous names —
including namesakes who are minors/inactive — are never guessed). Each resend gives the report
a fresh link; the chair's original link keeps working, and the chair is cc'd on a captain's
email (WhatsApp has no cc — the chair only sees the re-address in email).

```bash
# Dry run — review every planned recipient and the UNRESOLVED / FALLBACK list at the end:
npx sst shell --stage prod -- npx tsx packages/api/scripts/resend-captains-report-notices.ts \
  --stage=prod --dates=2026-10-17,2026-10-18
```

Review in the output: the planned captain + channels per report, `<<< DIFFERENT COMPETITION`
flags (captain name sourced from another league's report), `initialOnly=YES` (initial-form
name match — eyeball it), and the fallback list. Then:

```bash
npx sst shell --stage prod -- npx tsx packages/api/scripts/resend-captains-report-notices.ts \
  --stage=prod --dates=2026-10-17,2026-10-18 --allow-chair-fallback --confirm
```

Drop `--allow-chair-fallback` to send only to resolved captains, or use `--only=<reportId,…>`
to limit the run. A report whose send fails on every channel is retried by simply re-running;
already-reached recipients are skipped. Exit 1 means at least one failure — the output names
each report. Backups land next to `packages/api` (`captains-report-resend-backup-*.json`,
`csa-scorecard-import-backup-*.json`).
