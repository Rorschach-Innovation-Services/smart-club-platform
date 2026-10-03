# ADR 0016 — Medicoach fixture sync: smart club pulls, each side owns its fields

**Status:** Accepted (October 2026). Slices 0–4 built: results, captain's reports, inbound
schedule apply (Slice 3) and the outbound schedule push (Slice 4).

## Context

Dolphins' clubs, fixtures and members were moved to medicoach with a one-way file bundle
(`export-medicoach.ts` → medicoach `import-bundle.mjs`). Since then the two systems drift:
a reschedule in one is invisible in the other, results scored on medicoach never reach
smart club, and nothing starts smart club's post-match workflow (captain's reports).

Medicoach's identity work (PR #448) offers no machine-to-machine auth, id mapping or webhook
signing, so this sync depends on none of it. It borrows only that ADR's rule: **each app owns
its data**.

## Decision

### Ownership

| Field                                              | Owner                   | In smart club                                      |
| -------------------------------------------------- | ----------------------- | -------------------------------------------------- |
| Schedule: date, time, venue, postponed, cancelled  | both — most recent wins | the series fixture (Slice 3 applies inbound edits) |
| Result: scores, summary, winner, method, no-result | medicoach               | `FIXRESULT#` item, read-only in every UI           |
| Knockout sides once resolved                       | medicoach               | the slot fixture's `home`/`away`                   |
| Fixture existence, ids, sync refs                  | smart club              | the series fixture                                 |

A medicoach schedule change that would introduce a venue clash in smart club is **held for
admin review**, never applied (Slice 3) — there is no `--allow-clashes` path.

### Transport: smart club pulls, every 15 minutes

Smart club is always the caller; medicoach never calls smart club.

- One `sst.aws.Cron` (`MedicoachSyncPuller`) at `rate(15 minutes)`, all day — worst-case
  15 minutes' delay at about 672 runs a week. It runs the puller for every tenant with
  `features.medicoachSync`.
- Admins also get `POST /integrations/medicoach/sync-now` (same code path, caller's tenant).
- `GET /integrations/smartclub/changes?tenant=&since=<cursor>&limit=` returns only fixtures
  medicoach touched since the cursor; the puller loops while `hasMore` and stores the cursor
  (`SYNCCURSOR#<t>`) after each page it has fully applied. A failed page leaves the cursor
  where it was, so the next run retries it.
- Every write is idempotent per fixture, so a full resync (no cursor) is always safe.
- Requests are HMAC-SHA256 signed: `X-Sync-Signature: sha256=<hex HMAC(secret,
"${timestamp}.${METHOD}.${pathAndQuery}.${rawBody}")>` with `X-Sync-Timestamp` (epoch ms,
  ±5 min skew). One shared secret: smart club `MedicoachSyncSecret` == medicoach
  `SmartClubSyncSecret`; the base URL is `MedicoachSyncUrl`.
- **Empty secret or URL ⇒ dry run**: the puller logs the request it would make and calls
  nothing. Rollout runs one match weekend like that before the secrets are set.

The wire contract is versioned (`MEDICOACH_SYNC_VERSION = 1`): zod schemas in
`packages/api/src/medicoach-sync-contract.ts` (smart club) and
`packages/types/src/smartclub-sync.ts` (medicoach), and shared JSON examples in
`docs/integrations/medicoach-sync-examples/` that both repos parse in CI. The examples are
byte-for-byte copies across the repos (prettier-ignored here).

### Refs: the fixture ref is the only shared id

- A fixture's ref is `fixture.syncRef ?? smartclub:<t>:fixture:<seriesId>:<fixtureId>`.
- The 13 recipe knockouts (T20 semis and finals medicoach built from the tenant recipe)
  carry `syncRef = smartclub:<t>:fixture:recipe:<leagueKey>:<stream>:<slotId>`. They are
  created in smart club by `create-recipe-knockouts.ts` as `s-mc-ko-<leagueKey>-<stream>`
  series with placeholder sides (`pos:<groupSeriesId>:<rank>`, `win:<fixtureId>`), a
  `dateTbc` placeholder date and no venue. The medicoach exporter skips these series.
- Teams are `smartclub:<t>:team:<leagueKey>:<teamId>`, as in the bundle. A resolved knockout
  side is written only when it names one of that series' own team ids; the placeholder it
  replaced is kept in `fixture.slots`.
- Smart club never stores medicoach ids; medicoach owns ref ↔ id. Smart club keeps only
  the `medicoachMatchUrl` a result carries.

Because the fixture id is half of the ref, **fixture ids must never shift**. The Plan-B
importer used to mint `f1..fN` from sheet row order on every run; it now matches incoming
rows to stored fixtures (date + unordered pair, kick-off time breaking ties; then, for a row
whose date moved — on the sheet or by an applied medicoach reschedule — the unordered pair
alone, same round first, then the nearest date), keeps their ids, numbers new rows above the series' highest id, and reports stored fixtures the sheet
no longer has instead of dropping them (`fixture-identity.ts`). Sync-owned fixture fields
(`syncRef`, `schedule.changedAt`) are carried across every rewrite. On a sync-enabled
tenant the importer's destructive modes (`--revert`, `--prune`, `--discard-edits`) refuse
to run without `--allow-sync-break`, which prints every ref that would orphan.

### Results live in their own items

A result is stored as `TENANT#<t>#FIXRESULT` / `FIXRESULT#<seriesId>#<fixtureId>`, never
inside the series item: results arrive at any moment, and a whole-series admin PATCH (or an
importer's `putSeries`) would overwrite them or lose them to a version conflict.

- **Ordering** — a pulled result is stored only if its `recordedAt` is newer than the stored
  item's `orderAt`; a `resultClearedAt` newer than it leaves a tombstone. The conditional
  Put is the guarantee, so a replay, an out-of-order page or a concurrent cron + "Sync now"
  can never let an older change win.
- `GET /series` joins results onto fixtures as a response-only `result` (scores, summary,
  medicoach link — never captain data) and a fixture with a result reads as completed. For
  admins on a synced tenant it also marks `syncMapped` fixtures, where the console locks the
  manual "completed" status. Both keys are stripped from anything a client writes back.
- A newly stored result (never a replay) calls the puller's `onResultStored` hook, which
  opens the captain's reports. It skips `source: 'import'` results, matches before
  `integrations.medicoach.goLiveDate` (operator-only config) and matches more than 7 days
  old. A corrected result (newer `recordedAt`, no clear) updates the summary on pending
  reports and notifies nobody again.
- **Delivery** — the store writes a `REPORTOPEN#<ref>` marker first and deletes it once the
  reports opened and were notified; a failure leaves it for the next run (at most
  `REPORT_OPEN_MAX_ATTEMPTS`, then Sentry). The `NOTIFY#` ledger is claimed per report AND
  recipient (`recipient#<memberId>`), so a report voided by a clear and re-opened by a
  re-recorded result notifies its new recipient once, and a replay never re-sends. A notice
  that reached nobody (every channel tried failed) releases its claim and is retried; one
  delivered channel is done. The admin sync page shows "notices failed" for retries waiting
  on that.
- **WhatsApp link host** — the `captains_report_due` template's URL button has the PROD host
  baked in by Meta's approval (only the token suffix is dynamic), so a link sent from a
  non-prod stage would open on prod. Accepted: non-prod stages run notices dry
  (`NOTIFY_DRY_RUN` / no WhatsApp secrets), so none is sent there; email links use the
  stage's own host.
- **Filing by hand** — a club files from the portal only for a match already played (a
  future-dated fixture is 400 `match_in_future`). The `CR-<year>-NNNN` number is allocated
  after the first-submit-wins write landed, so a losing or failed submit never burns one.

### Captain's reports have no due date

The 3rd-business-day deadline came from the misconduct clause, which was removed, so there is
no due date and no "late" status (old reports' stored `deadline` is ignored and never served).
The emailed/WhatsApp link is single-submission: drafts are allowed, and the first submit
(link or portal) closes it (410). It expires at 23:59:59 SAST on the 7th day after the
match (410, pointing the chair at the club portal). Reports therefore only auto-open for
matches up to 7 days old; the chair can file from the portal at any time.

### Audit

Each notable run writes one `SYNCLOG#` row (90-day TTL): counts of results stored, stale and
cleared, unmapped refs, slots filled and schedule differences, plus the refs whose schedule
differs. A quiet run writes nothing at all.

### Quarantine

Nothing the sync cannot place is guessed at:

- an unknown fixture ref is counted as `unmapped` and skipped;
- a team ref outside the slot's series is ignored;
- a response that fails the v1 schema stops the run without advancing the cursor (the error
  names the failing field paths only, never values);
- an inbound schedule change whose venue does not resolve, or that the clash gate refuses, is
  held as `SYNCCONFLICT#` for the admin (see below), never applied.

### Schedule both ways (Slices 3 and 4)

Schedule (date, time, venue, postponed, cancelled, plus `dateTbc`) is most-recent-wins on each
side's `changedAt`; smart club keeps its own as the fixture's `schedule.changedAt`
(`medicoach-sync/schedule.ts`). Medicoach sends epoch `1970-01-01T00:00:00.000Z` for a fixture
it never edited; a smart-club fixture with no `schedule.changedAt` (never edited since import)
counts as that same epoch inbound, so medicoach's never-edited rows never apply over it while
any real medicoach edit does.

- **Inbound.** After a page's results and knockout slot fills, every fixture whose medicoach
  schedule differs and is newer is applied with the gates an admin edit passes: the
  in-season subset clash gate on a released series (`introducedClashes`, shared with
  PATCH /series), the approval recall on a draft, a version-checked write retried 3 times.
  Release and withheld state are never touched. A venue is resolved by `groundKey` against
  the tenant's ground list. An unresolved venue or a refused clash writes
  `SYNCCONFLICT#<ref>` instead (latest proposal per ref) and emails the tenant admins once
  per proposal (platform operators are left out — they see the inbox in the console; a
  failed email is retried when the same proposal is pulled again). An older change is dropped and listed in SYNCLOG (`scheduleStaleRefs`).
- **Admin inbox** (console "Medicoach sync", shown only with the feature on): Apply writes the
  proposal through `applySeriesPatch` (the clash gate runs again; still clashing ⇒ 409);
  Discard re-stamps the fixture and queues smart club's schedule, so the proposal can never
  win later. "Edit fixture" opens the fixtures page.
- **Outbound.** Every write that changes a mapped fixture's schedule — PATCH /series, stage
  generate, and the series CLIs (import-planb, shift-fixture-dates, recall-fixture-release,
  resolve-venue-clashes, normalise-venue-names, merge-duplicate-venues) — goes through
  `recordScheduleDiff`: it stamps `schedule.changedAt = now` in the same write and, once the
  write landed, collapses the snapshot onto `PENDINGSYNC#<ref>`. Origin `medicoach` (the
  inbound apply) is skipped, so nothing echoes. A fixture whose id now names a different
  match is never pushed. A fixture the write ADDS to a mapped series (or every fixture of a
  new mapped series) is not pushed either — the v1 contract has no create — but is reported
  as "new fixture not in medicoach (needs bundle top-up)" on the CLI/log and in a
  `new-fixtures` SYNCLOG row the admin page lists.
- **Bulk CLIs write against what they read.** `import-planb`, `resolve-venue-clashes`,
  `normalise-venue-names` and `merge-duplicate-venues` build a working copy from one read of
  the series, so they write through `writeSeriesFromSnapshot` (`medicoach-sync/cli-write.ts`):
  a Put conditional on the version that read saw, with the schedule diff taken from that read
  (the CLI's own change), never from a fresh re-read. A series edited in between (an admin, a
  medicoach apply) is skipped and the run exits 1 asking for a re-run. The runbook
  (`docs/runbooks/planb-fixtures-import.md`) says to pause the cron's rule for the window.
- **Flush.** Each cron run and "Sync now" first flushes the outbox in batches of ≤100 to
  `POST /integrations/smartclub/schedule` (signed; dry run with the secret empty), then pulls,
  then retries pending captain's reports (`REPORTOPEN#`). `applied|stale|unchanged|unmapped`
  delete the row (only if it still holds the snapshot sent); `error` and request failures keep
  it with `attempts` and `lastError`. `stale` means medicoach's newer edit wins; the pull brings
  it back.
- **Drafts and withheld venue/time (ADR 0011).** Medicoach's match centre is public and the
  v1 contract has no draft or withheld flags, so a row whose series is not released (a draft,
  or recalled) or currently withholds venue and/or time is never sent. It is kept as
  `heldUntilReveal` (flagged at enqueue and re-checked against the live series on every
  flush, so a recall holds rows queued before it) and shown on the admin page as "held until
  released/revealed". The release (false→true) of a series that withholds nothing, and the
  reveal that clears the last withheld field, re-queue every fixture of a mapped series with
  its real schedule and its EXISTING `schedule.changedAt` — never re-stamped, so a medicoach
  edit made while the series was a draft or withheld still wins (most recent change wins). A
  fixture smart club never edited goes out at `1970-01-01T00:00:00.001Z`: one millisecond
  after medicoach's never-edited epoch, so smart club's real values (a newly revealed venue
  medicoach never had) still win over a never-edited medicoach row. A row already held for the
  fixture carries the same or a newer `changedAt`, so the conditional enqueue keeps it (the
  flush un-holds it). A row whose series no longer exists is dropped, never
  pushed. Inbound changes still apply to a draft or withheld series (they leak nothing). The
  initial migration bundle carries `venueWithheld`/`timeWithheld` on its own.
- **Generate/rebase guard.** On a sync tenant, regenerating a stage, or rebasing a run whose
  changed stages have released synced series, answers 409 `sync_resync_required` with the
  refs that would be orphaned, unless the caller passes `allowResync: true` (then the 200
  lists `orphanedRefs`).

### PII

A player ref (`smartclub:<t>:player:<naturalKey>`) is an unsalted hash of the person's SA ID
number — effectively the ID number. So:

- it is **never logged**: the puller prints counts and fixture refs only, SYNCLOG rows carry
  no player refs, and contract errors name field paths, not values;
- the result's `captainRef` is **never stored on the `FIXRESULT#` item** (the write strips
  it, and a pull scrubs one an older item still carries). Reports resolve their recipient at
  open time from the pulled result in memory; the ref is kept only on the `REPORTOPEN#`
  marker while that opening is pending (so a retry can still address the captain) and goes
  with the marker. It is never returned by any route;
- `FIXRESULT#` and the `SYNC` partition are enumerated by tenant erasure (`FIXRESULT#` by
  cohort clearing too); club erasure (`eraseClubData`) deletes the club's captain's reports
  and their `NOTIFY#` ledger rows.

## Consequences

- One more Lambda (the cron) and one Query per `GET /series` (the tenant's result partition).
- A fixture's identity is now a contract: anything that rewrites fixtures (importers, CLIs,
  season-run rebase) must keep ids or knowingly orphan refs. Rebase and generate on synced
  released stages need `allowResync` (Slice 4).
- Promotion Women's (excluded from the export) keeps a manual "completed" status; every
  exported league's results come only from medicoach.
- Push (smart club → medicoach schedule changes, Slice 4) reuses the same contract, secret
  and cron.
