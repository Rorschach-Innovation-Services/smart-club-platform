# Deploying fixture create/delete sync (contract §2 ops, 2026-10-18)

Fixture creates and deletes in smart club now propagate to medicoach through the
schedule push (`op: "create" | "delete"` on §2). Branches:

- smart club: `feat/fixture-create-delete-sync`
- medicoach: `feat/smartclub-fixture-create-delete`

## Deploy order — medicoach FIRST, smart club second

Medicoach's inbound schemas are strict: an old medicoach answers an op row with
HTTP 400. The medicoach build accepts the new fields but old smart club never sends
them, so medicoach can ship alone safely. The smart club deploy is the
activation — the moment it's live, every `features.medicoachSync` tenant starts
propagating creates and deletes. There is no feature flag.

1. Merge + deploy **medicoach** (testing, then prod per the usual medicoach flow).
2. Verify an ordinary schedule push still applies (any pending upsert, or wait
   one 15-min flush and check the SYNCLOG push row is `ok`).
3. Merge + deploy **smart club** (dev, then prod).
4. Watch the first few flushes: new SYNCLOG push counts `created`, `deleted`,
   `convertedToCreate`. `unmapped` answers on creates mean a competition/team
   needs a bundle carry — they land in MCAWAIT (connection console) as before.

## Rollback

- Rolling back **smart club** alone is always safe (medicoach's additions are
  dormant without senders).
- Rolling back **medicoach** after smart club is live breaks op pushes: op rows
  are batched separately from plain upserts, so schedule upserts keep flowing,
  but create/delete rows will fail with 400s and retry every 15 min until
  medicoach is rolled forward again (or smart club is rolled back too). No data
  is lost — the outbox retries indefinitely.

## Behaviour changes to know

- Removing a fixture from a released synced series (confirm dialog, now
  "Remove from both") **deletes the medicoach copy, including any recorded
  result**. Same for deleting a whole series or competition. The destroyed
  result's full payload is kept in medicoach's `SMARTCLUB_FIXTURE_DELETE`
  audit row; recovery beyond that is DynamoDB PITR.
- A fixture added to a released synced series syncs automatically within one
  flush when its create payload derives (League · Stream · Group naming or a
  season run); otherwise it goes to MCAWAIT as before.
- Upserts that bounce `unmapped` now convert to creates when derivable
  (`convertedToCreate`), so new series released under an already-carried
  competition self-serve instead of waiting for a bundle top-up.
- Regenerating a competition deletes the old draw's medicoach copies; the new
  draw's reused fixture ids deliberately go to MCAWAIT (medicoach refuses to
  graft a different match onto an old ref), and brand-new ids convert to
  creates on release.

## Known gaps (accepted)

- A fixture that was exported, then had a side reverted to a `pos:`/`tbd:`
  placeholder, then removed, sends no delete (the diff can't see it). The daily
  reconcile / connection console remains the net.
- EMCU's importer `deleteSeriesFully` (import-emcu-fixtures.ts, the stale-series
  prune and its revert) bypasses delete propagation: no delete rows are queued,
  so a deleted series' fixtures stay in medicoach. It refuses released series, so
  the risk is low, but note that EMCU writes into the **dolphins** tenant, which
  has `features.medicoachSync` on. Not fixed (documented only). The fix, if it is
  ever needed, is the Titans one below: route the delete through
  `deleteSeriesWithSync` + `queueSeriesDeletes` (medicoach-sync/schedule.ts).
  Until then, delete a stale EMCU series that medicoach holds from the console
  (DELETE /series propagates), not with the importer.
- **Fixed:** the Titans importer's `--revert` (import-titans-fixtures.ts,
  `deleteSeriesFully`) now refuses `--confirm` when the tenant has
  `features.medicoachSync` on, unless `--propagate-deletes` is passed. With it,
  each series goes through the same `deleteSeriesWithSync` the console's
  DELETE /series uses (extracted into medicoach-sync/schedule.ts): delete rows
  are built from the stored series first, then the series, officials and sync
  state are deleted (`deleteSeriesSyncState` drops the series' outbox rows),
  and only then are the rows written with `queueSeriesDeletes`. Writing them
  before the wipe would delete them again. The rows carry `origin: 'cli'`.
- Group names for Plan-B creates are positional among sibling series; siblings
  added or removed after a carry can shift the label on later creates.

## Notification copy audit for new sync tenants (5 Nov 2026)

Before titans, lions and tuskers get `features.medicoachSync`, the sync-gated
notices were spot-checked for Dolphins/KZNCU copy that would reach another
union. None found. `captains_report_due`, `squad_selection_due` and
`official_appointed_v2` take the union name as a parameter, filled from
`orgCopy(config).name` (tenant `branding.name`, then `branding.title`, then the
tenant slug) in captains-reports.ts, squad-requests.ts and
medicoach-sync/schedule.ts. The officials contact line ({{6}}) comes from the
tenant's `officialsContactLine`, defaulting to the neutral "Medicoach - 066 344
6443". The scorecard-correction email (operators only) names the tenant from
config. The ops digest uses `orgCopy` too. The URL buttons point at
`platform.club.medicoach.co.za`, which resolves the tenant from the signed
token, so they are tenant-neutral. The only hardcoded Dolphins/KZNCU strings
are code comments and the `dolphins_*` / `emcu_*` broadcast templates, which
only the one-off CLIs send. Retired v1 `official_appointed` still hardcodes
`info@medicoach.co.za` (Medicoach, not Dolphins). Before connecting a tenant,
check that `branding.name` is set, because that is the name every one of these
notices uses.
