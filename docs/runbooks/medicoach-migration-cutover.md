# Medicoach migration — cutover runbook (your steps, in order)

Everything code-side is done, reviewed and committed locally. This is the exact
sequence of the steps only you can run (pushes/PRs, AWS deploys, prod commands,
external sign-offs), each copy-pasteable. Claude assists at the marked points.

Prepared 1 Oct 2026. Branches: smart-club `main` (local, contains the
medicoach-export merge, typechecked — run the suite in step 1), medicoach
`feat/league-migration-api` @ f491409a1 (38 commits).

---

## 1. Push smart-club

```bash
cd ~/Development/smart-club-platform
cd packages/api && npm test && cd ../..   # expect ~1612 pass / 0 fail
git push origin main
git push origin medicoach-export          # optional: keep the branch remote too
```

Note: this also ships the long-unpushed 3630b81 (Titans contacts CLI) and
6db42af (matchup view) that were already on main.

## 2. Push medicoach + open the PR

```bash
cd ~/Development/medicoach
git push -u origin feat/league-migration-api
gh pr create --base development --head feat/league-migration-api \
  --title "League migration: smart-club → medicoach importer, API readiness, player setup" \
  --body-file docs/league-migration-pr-description.md
```

Team reviews → merge to development → flow to main per your release process.
(The testing-stage deploy guard requires branch `main`.)

## 3. Long-lead items

Nothing is outstanding.

Resolved, no action needed:

- **Meta WhatsApp template**: done. `platform_access_announcement` is
  registered in Meta Business Manager (template id `1098691445984033`) and its
  entry in medicoach's apps/api/src/lib/onboarding-whatsapp-templates.ts has had
  status `"registered"` since 1 Oct 2026.

- **Dolphins structure answers**: all received 1 Oct 2026. These cover the
  Promotion Men's T20 semi pairings (G1vG2, G3vG4) and the Hollywoodbets
  Kingsmead Cup, which is the name of Group 2's 30-over subdivide stage. They
  also confirm the crossed semis for Premier Women's T20 and Veterans Premier
  T20, and the Veterans Promotion final's G1-1 v G2-2 pairing. The export's
  confirm-list is now empty.
- **Promotion Women's League**: it doesn't exist yet, because the union is
  still defining it. The export excludes it by recipe and prints the warning
  `league promotion-women-s-league excluded by recipe: not yet created by the union`.
  The Premier Women's relegation into it is switched off. Revisit when the
  union creates the league: add its recipe in
  packages/api/src/medicoach-recipes/dolphins.ts, restore the commented-out
  relegation, and remove it from `excludeLeagues`.
- **Results**: none are needed. No Dolphins fixtures have been played and the
  season starts after cutover (see step 7).

## 4. Smart-club prod prep

```bash
cd ~/Development/smart-club-platform
npx sst deploy --stage prod
# The one-setup data migration (no-op for real leagues, but run it). It has NO
# npm script: run the file with tsx. Dry run first; extras exit 1 (see its header).
npx sst shell --stage prod -- npx tsx packages/api/scripts/migrate-league-setups.ts
npx sst shell --stage prod -- npx tsx packages/api/scripts/migrate-league-setups.ts --confirm
# REQUIRED for the export (player/coach→team mapping) — pending since Sep.
# The tenant is a REQUIRED positional argument. Dry run first:
npx sst shell --stage prod -- npm --prefix packages/api run sync-club-leagues -- dolphins
npx sst shell --stage prod -- npm --prefix packages/api run sync-club-leagues -- dolphins --confirm
```

## 5. The prod export

```bash
npx sst shell --stage prod -- npm --prefix packages/api run export-medicoach -- \
  --tenant dolphins --out ~/dolphins-bundle.json --confirm
```

Check the summary:

- the `noTeam`/`ambiguous` player counts look sane;
- the confirm-list is empty;
- the only league exclusion is the Promotion Women's warning;
- the host name shows the real branding (not "dolphins").
The file contains PII: keep it local, delete after the prod import.

## 6. Medicoach testing pass (after the PR reaches main + testing deploy)

Medicoach's testing API is `https://testing.api.medicoach.co.za` (prod:
`https://api.medicoach.co.za`). Full reference: medicoach
docs/league-migration-guide.md §9.

Needs medicoach PR #632 (`feat/league-migration-player-dedupe`: matcher,
bindings, duplicate gate, notify `--only`) merged and checked out.

**6a. Match players first (read-only, AWS creds for the medicoach account).**
The importer must not create a second record for a player medicoach already
holds (Dolphins tournament squads, school players). Minors and email-less
players are never caught by the API's own dedupe, so the matcher binds them
up front (§9.11):

```bash
cd ~/Development/medicoach/scripts/league-migration
node match-players.mjs --bundle ~/dolphins-bundle.json --env testing \
  --table MedicoachProductionTable --confirm-table MedicoachProductionTable
# → player-bindings.testing.json (ids only) + player-match-report.testing.csv
#   (PII, 0600, gitignored). Review every "ambiguous" row in the CSV and write
#   overrides.testing.json: {"<externalRef>": "<playerID>" | "new", …}
```

**6b. Import.**

```bash
# Administrator token for testing.internal → export MEDICOACH_TOKEN
node import-bundle.mjs --bundle ~/dolphins-bundle.json \
  --host https://testing.api.medicoach.co.za --env testing --map league-map.testing.json \
  --player-bindings player-bindings.testing.json --player-overrides overrides.testing.json
# review the dry-run plan (it prints "players: N bound, N new, N ambiguous"),
# then the same command + --apply (+ --no-publish until checked on testing.live).
```

`--apply` refuses before writing anything if it would create players without a
bindings file, or if any ambiguous row has no override.

- **Check in a real BROWSER** (CORS lesson): testing.live league tab, a club
  page, admin login.
- Exercise the rollback once. It takes the MANIFEST, not the map:
  ```bash
  node import-bundle.mjs --rollback migration-manifest.testing.jsonl \
    --host https://testing.api.medicoach.co.za --env testing --map league-map.testing.json          # dry run
  # … then the same + --apply. Bound (pre-existing) players only lose the team
  # memberships the import added.
  ```
  Then re-import (6b), and run backfill-participation per §9.9.

## 7. Prod run

```bash
# Find the existing Dolphins institution id (internal platform, or ask Claude
# to look it up via the API with your token).
aws dynamodb create-backup --table-name prod-Medicoach-MedicoachTable \
  --backup-name pre-league-migration-$(date +%Y%m%d) --region af-south-1

# Match against PROD (read-only), then decide every ambiguous row:
node match-players.mjs --bundle ~/dolphins-bundle.json --env prod \
  --table prod-Medicoach-MedicoachTable --confirm-table prod-Medicoach-MedicoachTable
# → player-bindings.prod.json + player-match-report.prod.csv → overrides.prod.json

node import-bundle.mjs --bundle ~/dolphins-bundle.json \
  --host https://api.medicoach.co.za --env prod --map league-map.prod.json \
  --bind-host <DOLPHINS_INSTITUTION_ID> \
  --player-bindings player-bindings.prod.json --player-overrides overrides.prod.json
# dry-run output sane → add --apply (phased with --only if preferred)
# Rollback, if needed, takes the manifest:
#   node import-bundle.mjs --rollback migration-manifest.prod.jsonl \
#     --host https://api.medicoach.co.za --env prod --map league-map.prod.json [--apply]
```
The season starts after cutover, so standings legitimately begin empty and all
scoring happens in medicoach. The importer's `--results` flag stays available
if a backfill is ever needed.

Publish happens automatically when each league reconciles. Then:
```bash
# dry run: masked plan + notify-plan.prod.json
node import-bundle.mjs --notify --bundle ~/dolphins-bundle.json \
  --host https://api.medicoach.co.za --env prod --map league-map.prod.json
# canary: exactly you, nothing else
node import-bundle.mjs --notify --bundle ~/dolphins-bundle.json \
  --host https://api.medicoach.co.za --env prod --map league-map.prod.json \
  --confirm --only <your own staff ref>
# check the message and that the link opens; then the staff wave:
node import-bundle.mjs --notify --bundle ~/dolphins-bundle.json \
  --host https://api.medicoach.co.za --env prod --map league-map.prod.json \
  --confirm --staff-only
# Player wave: optional (records work without logins) and needs your POPIA
# lawful-basis call first: the same with --confirm --players-only.
```

`--only` restricts a run to exactly those refs. Do NOT use `--resend` as the
canary: it is additive (it also sends every unsettled recipient), so the script
refuses `--confirm --resend` unless `--only` or a `--staff-only`/`--players-only`
wave narrows it.

## 8. Post-migration (in medicoach, as admin)

- Set real dates on recipe-generated knockout fixtures (shown as "TBC").
- Add phase-2 fixtures when each boundary fires (50-over swap round,
  30-over sub-groups) — the engine forms the groups; fixtures are added
  against them.
- Warn staff: old placeholder-email invite links may create duplicates to merge.

## 9. Close-out

- Reconciliation report clean; commit `league-map.prod.json` (ids only).
- Delete local bundle copies; confirm the EXPORT# audit entry in
  smart club (`--confirm` wrote it in step 5).
- Tear down the rehearsal stage: `npx sst remove --stage league-rehearsal`
  (Claude can run this on request).

## 10. Player sync (after the import, per tenant)

New registrations reach medicoach rosters through the player sync (ADR 0019). Enable it per
tenant only once that tenant's teams are imported: see
[medicoach-player-sync.md](medicoach-player-sync.md) for deploy order (medicoach's `/players`
route first), the duplicate audit, the coverage warning, the dry-run-first backfill and review
resolution.

## Deferred, deliberately

- **season-simplification**: re-plan against current main before executing —
  the one-setup merge absorbed part of its scope (rebase/setup model).
- Smart-club fixture-domain work (KZNCU draft releases, release-workbook
  branch): triage against the cutover date — post-cutover, medicoach owns
  fixtures.
