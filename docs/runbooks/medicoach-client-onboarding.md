# Onboarding a Smart Club client to Medicoach (incl. fan-out placement)

One sequence for every new Smart Club tenant whose leagues Medicoach runs, and the order every
**season carry** follows afterwards. The detail of each step lives in the runbook it links; this
page is the order and the stop conditions.

Why the order matters: the player sync places every eligible player on **all** of their club's
competition sides (fan-out, contract §4 in
[medicoach-sync-contract.md](../integrations/medicoach-sync-contract.md)). A fan-out ref that names a
team Medicoach does not have PARKS the player (`unmapped-team`: no writes for that person at all).
So Medicoach must hold a league's teams **before** Smart Club classifies that league.

## Onboarding sequence

1. **Bundle export** (Smart Club): `export-medicoach --tenant <t>` dry run, read the summary, then
   `--confirm`. See [medicoach-migration-cutover.md](medicoach-migration-cutover.md).
2. **Medicoach import** (Medicoach repo, `scripts/league-migration/`): teams + leagues + fixtures,
   then the ExternalRef backfill. Every team a player can be placed on now resolves by ref.
3. **Write the tenant recipe** (`packages/api/src/medicoach-recipes/<tenant>.ts`, registered in
   `index.ts`):
   - a `category` for every league Medicoach **imported** in step 2: `senior-open`, `womens`,
     `veterans` or `junior`. Leave out anything Medicoach does not hold (sub-union leagues, a
     registration-only league): unclassified never fans out.
   - `placement: { fanOut: true }`, with `seniorMinAge` / `womensMinAge` / `veteransMinAge` only
     when the union's age rules differ from 15 / 15 / 40.
   - Run `npm --prefix packages/api test`: the classifier lint flags a category that disagrees
     with the women's / veterans label matchers or the Juniors group. Fix the recipe, never the
     test. (The matchers never decide a category; they only catch typos.)
   - Explicit categories are what make day-one enablement safe for a client whose league naming
     the regexes would not recognise. Fan-out stays opt-in per tenant.
4. **Deploy** Smart Club with the recipe.
5. **Enable** `features.medicoachSync` + `integrations.medicoach.playerSync` for the tenant
   ([medicoach-player-sync.md](medicoach-player-sync.md) §3).
6. **Dry run**: `npm --prefix packages/api run enqueue-players -- --tenant <t>` (with the sync
   secrets set, so Medicoach predicts). Read:
   - `fan-out: players gaining sides` / `memberships (add-only)`: plausible for the club sizes;
   - `fan-out: rows missing gender/dob`: these players get their registered side only — chase
     the data with the clubs, it is not a blocker;
   - `fan-out: unclassified leagues`: every key listed must be one you meant to leave out;
   - the Medicoach prediction.
7. **Review — stop conditions.** Expect adds only. **Stop and investigate before `--confirm`** if
   the prediction shows ANY of:
   - `unmapped-team` (the dry run lists the missing TEAM refs): a classified league or a side
     Medicoach lacks — import it in Medicoach, or remove the category;
   - `held removals`, or `updated` diffs you cannot explain;
   - a fan-out membership count far above the club pools (a mis-classified league).
8. **Confirm**: `enqueue-players -- --tenant <t> --confirm`. The cron drains ~500 per 15 minutes
   (about an hour for a full tenant).
   - **Start the first drain with a small batch.** A first-placement push (new memberships on
     every fan-out side) measured ~3 s per player, and each POST must finish under Medicoach's
     API Gateway limit (29 s). Before confirming, set `MEDICOACH_SYNC_BATCH_SIZE=10` in the
     sync cron function's `environment` (`sst.config.ts`, beside `MEDICOACH_SYNC_URL`; it is
     not passed through by default) and deploy (integer, clamped to 1..50; unset = 50, the
     contract cap). Watch the first runs'
     per-batch latency and timeouts, then raise it (or unset it) once batches finish well inside
     the limit — steady-state pushes are mostly `unchanged` and fast.
9. **Roster health**: Medicoach `/league-roster-health` (and its 06:00 SAST check) shows only real
   club-registration gaps. A short **managed** side is fixed in Smart Club (register the player),
   never by hand-adding in Medicoach.

## Season carry order

1. **Medicoach import first** (the new season's competitions/teams, then the ExternalRef backfill).
2. **Then the Smart Club structure import** (e.g. [emcu-fixtures-import.md](emcu-fixtures-import.md)).
   Every series created or re-participated, every season run created, and every club
   `leagues` / `leagueTeams` / `teamRosters` change enqueues the affected clubs' active players
   automatically (the repo structure hook) — the new sides fill on the next cron runs with no
   hand-fill and no manual enqueue.
3. **A genuinely new league key?** Add its `category` (one recipe line) **after** step 1, deploy,
   then run the `enqueue-players` dry run → review → `--confirm` above (a recipe change is
   deploy-time: no write fires the hook).
4. Roster health confirms.

If the structure import ran BEFORE the Medicoach import, the enqueued players park
`unmapped-team`; once Medicoach has the teams, retry them from the admin Players panel ("Retry
now") or re-run `enqueue-players --confirm`.

## Never

- Hand-fill a Smart-Club-managed side in Medicoach: it is structurally safe now (fan-out and
  hand-adds are never removed by an upsert), but it hides a registration gap the club must fix.
- Classify a league Medicoach has not imported.
- Treat a whole-pool side above 100 players as a bug: league-side reports above
  `REPORT_SQUAD_CAP` are unsupported by decision.
