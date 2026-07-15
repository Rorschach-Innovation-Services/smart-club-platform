# Runbook — Backfill legacy players' `team` (league key) at single-league clubs

**Owner:** runs in the **medicoach AWS account** (`af-south-1`), against the prod
DynamoDB table. **App code change:** already shipped (demographics endpoints + runtime
fallback) — this is an optional one-time data step, run only if the unattributed
figure is material.

**Why:** `PlayerRegistration.team` is a required, catalogue-validated league key on
both modern registration paths, but legacy rows predate the field. The Season Insights
per-league demographics attribute a no-`team` player at a single-league club to that
league at runtime, so the dashboards are already correct — this backfill only makes
that same answer **durable** on the rows, so it survives the club later entering a
second league.

**When:** check the materiality signal first. `GET /admin/insights/demographics`
returns `unattributed.totalPlayers` (also surfaced as the warning callout on the
admin Insights dashboard). If it is small or zero, skip this runbook entirely.

---

## What the script does (and refuses to do)

- Only clubs entered in **exactly one league** are touched; multi-league and
  zero-league clubs are skipped — attribution there would be a guess.
- Only players with **no `team` attribute at all** are written, guarded by an
  `attribute_not_exists(team)` ConditionExpression, so a stored value can never be
  overwritten.
- **Orphaned** `team` values (league deleted after registration) stay untouched —
  they are registration-time source data and remain honestly "Unattributed";
  re-attributing them would be a separate, explicitly-consented migration.
- Idempotent — a re-run finds no team-less rows at eligible clubs and writes nothing.
  Logs per-club counts either way.

## Run (dry-run first)

```bash
# 1. Dry-run — lists per club how many players WOULD gain a team, writes nothing.
sst shell --stage prod -- npx tsx packages/api/src/backfill-player-team.ts dolphins

# 2. Review the list: only single-league clubs may appear, and the counts should
#    roughly match the dashboard's unattributed figure (multi-league clubs' players
#    stay unattributed by design).

# 3. Apply.
sst shell --stage prod -- npx tsx packages/api/src/backfill-player-team.ts dolphins --confirm
```

`<tenant>` is the union slug (`dolphins` for prod). Swap `--stage prod` for
`--stage dev` to rehearse on dev first.

## Verify

- Re-check `GET /admin/insights/demographics`: `unattributed.totalPlayers` should have
  dropped by the filled count (players at multi-league clubs and orphaned `team`
  values legitimately remain).
- The admin Insights dashboard's unattributed callout shrinks or disappears; the
  per-league drill-down cards absorb the filled players.
- Re-running the script reports 0 candidates (idempotence check).
