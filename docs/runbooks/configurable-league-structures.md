# Runbook — ship configurable league structures (ADR 0008)

Ships the stage-pipeline model ([ADR 0008](../architecture/0008-configurable-league-structures.md)):
operators author season calendars, competition structures and a venue registry; admins run a
season through its stages and generate fixtures into the existing Series entity.

**No infrastructure change. No data migration. No backfill.** The new config lives on the
existing tenant CONFIG item and the existing single table; season runs and venues are new item
types on keys nothing else uses. Deploys are user-run.

**The safety property that makes this a plain deploy:** every new field is optional, and absent
means the old behaviour. A tenant with no `calendars` keeps the legacy single start/end window
on the create-series form. A league with no `competitions[]` behaves exactly as it does today.
Nothing changes for `dolphins` until an operator configures something.

---

## The setup model (since 27 Sep 2026, read this first)

[ADR 0014 amendment](../architecture/0014-seasons-one-vocabulary-one-path-one-engine.md#amendment-september-2026-one-setup-per-league).
The Competition is gone. Older sections below that mention competitions, quick start or the
Competition defaults card describe the build before this; where they tell you to do
something, they point here.

- **League → one setup → structure + calendar.** `League.setup { structureId, calendarId }`,
  at most one per league. No setup, no season.
- **Format = structure overs.** `CompetitionStructure.overs` (empty = 50). A new series takes
  the structure's name as its series type and its overs as `maxOvers`. There is no match
  format, ball type or format label anywhere else.
- **Two formats = two leagues.** T20 and 50-over for the same clubs are two league entries,
  each with its own setup.
- **Operator only.** The setup is created and changed in one dialog: **Set up** / **Change
  setup** on the league row of the catalogue, or the league row of **Set up a season**. The
  admin console cannot create or change one.
- **Admin side.** **Fixtures → Start a season** lists only set-up leagues. The rest appear under
  "Not set up yet — ask your operator"; a league whose calendar has ended says to ask the
  operator to renew the dates. There is no quick start.
- **Refusals.** `POST /season-runs`: 400 `setup_missing` / `structure_missing` /
  `calendar_missing`, 409 `season_exists` (same league, same season label). Generate never
  checks setup; a frozen season regenerates even if its league lost its setup.
- **Regenerate keeps the stored format.** An existing series keeps its `seriesType` and
  `maxOvers` on regenerate. Only a rebase that changed the structure's name or overs (it stamps
  `formatChanged`) lets the next regenerate adopt the new ones.
- **Re-pointing a calendar mid-season** is allowed; the save warns "N ungenerated season run(s)
  of "<league>" will follow the new dates". Generated runs are frozen and unaffected.
- **Stale consoles.** A stale admin tab cannot wipe or forge a setup (the admin PUT restores
  stored setups by league key). A stale operator console that still edits competitions gets
  409 `console_stale`: refresh it.
- **Gone:** quick start, the competition picker, the Competition defaults card, the DNS /
  go-live card. The live URL still shows on the setup card (`liveUrl` on
  `GET /platform/tenants/:slug`, response-only). Venue aliases and travel are config-only
  (§9).

## 0. Pre-flight

```bash
npm run typecheck && npm test
npm --prefix packages/api run typecheck && npm --prefix packages/api test
npm run lint && npm run format:check
```

All four must be clean. `format:check` has three pre-existing warnings this branch never
touched (`.eslintrc.cjs`, ADR 0007, the OTP runbook) — those are expected.

### 0a. Migrate dev data predating ordinal block refs

`StageSchedule.blockId` became `StageSchedule.blockIndex` (structures now reference a block by
position, not id — see the [ADR 0008 addendum](../architecture/0008-configurable-league-structures.md#addendum-2026-08-02-ordinal-block-references-and-the-season-wizard)).
Any structure written before this change is still on the old shape and needs rewriting.

**Run this on dev before the next seed** — `seed-cohort` no longer preserves legacy block ids,
so seeding over unmigrated structures leaves them permanently unresolvable.

The script also migrates every tenant's SEASON RUNS, not just `TenantConfig.structures` — a
run that started before this change carries its own frozen `structureSnapshot` on the old
`blockId` shape, and its next stage-generation throws if left unmigrated. Each run's stages
resolve against that run's OWN `calendarSnapshot` (the run's authoritative calendar), never
the tenant's live calendar list.

```bash
# Dry-run first — reports what would change, writes nothing.
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-block-index.ts

# Once the dry-run report looks right, write it.
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-block-index.ts --confirm
```

Run `--confirm` while no admin is mid-season-edit: the season-run write is whole-object, so a
stage confirmation landing between the script's read and its write would be overwritten.

Read the dry-run's unresolved-stage list before confirming — a stage the script can't resolve
(no competition binds its structure, `structure.calendarId` doesn't cover it either, and no
calendar has a block matching its old id — or more than one does; likewise when several
competitions bind the structure to different calendars) is reported and left untouched rather
than guessed at. Same for a season run: if its `calendarSnapshot` has no
block matching the old id, the run's stage is reported and left untouched.

**Re-seeding a tenant whose calendar predates namespaced block ids** replaces that calendar's
blocks wholesale (`seed-cohort`'s `keepExistingBlockIds` machinery was deliberately deleted —
see the ADR 0008 addendum). Every `Series.schedule.blockId` naming a now-gone block goes
dangling silently unless told: `mergeConfig` logs a loud warning listing the removed block
ids when this happens. Treat that warning as a cue to run this migration and/or reschedule
the affected series — `seed-cohort` does not try to preserve the old ids itself.

**Prod has no ADR-0008 data** (the KZNCU/EMCU launch hasn't happened yet), so this script is
not run there. Don't run it against prod as a precaution — there's nothing for it to migrate,
and "nothing to migrate" is itself worth confirming with the dry-run if you're ever unsure.

> **Verified end to end locally**, including both multi-stage paths: the KZNCU mid-season
> swap (points carried by position) and seeded pools → cross-pool semis. Doing the
> walkthrough in step 1 again is still worth the ten minutes before a prod deploy — the
> worst defect found in this feature was a prefill that proposed relegating an entire
> group, and it was invisible until someone confirmed a stage with clubs that were **not**
> in alphabetical order. Use real club names, not `A/B/C`.

## 1. Local walkthrough (do this first)

```bash
npm run dev:local:demo     # API :3333, vite :3201
```

**Restart the local API after any `packages/api` change — there is no backend hot reload,
and the new routes will 404 until you do.**

There is one way to set a league up and one way to start its season. The operator sets it up
(**Set up a season**, from the tenant edit page or the CalendarsCard/SetupCard empty states,
or **Set up** on a league row of the catalogue); the admin starts it (**Start a season**). The
cards (Season calendars, Competition structures, League catalogue) are the editing surfaces
you drop into afterwards.

Walk the whole path once:

1. Operator console → **Set up a season** → _Season dates_ (a calendar with two blocks and a
   mid-season break, or extend an existing one) → _League structures_ (add a league and pick
   a template or an existing structure for it; nothing is preselected, and the calendar is
   the one from step one. Check the fit verdict, the season narrative and the "Stage N plays
   in Block N" choices; no format is asked here) → _Review & create_ (a league that already
   had a setup shows "Replaces the current setup: …") → commit. Leave at least one league out
   of the wizard, with no setup.
2. Operator console → **Competition structures** → open a structure. It opens in **Preview**
   ("You're previewing — nothing here changes anything"). **Edit structure** → set **Overs**
   (empty = 50) → Esc returns to preview without saving. Edit again and save.
3. Operator console → **Venues** → _Sync from club records_, then pin one ground by hand
   (latitude and longitude accept a minus sign and a decimal point — if they don't, stop).
4. Admin console → **Fixtures** → **Start a season**. The league left out in step 1 must be
   listed as not set up, with "ask your operator", and must not be startable. Pick a set-up
   league → season label → start. The done screen shows the four "What happens next" steps.
5. On the new season's stage card: the status timeline (Awaiting entrants → Ready → Generated
   → Released), "Plays in Block 1 · <dates>", the narrative line and "What the platform needs
   from you". **Confirm entrants** → **Generate N fixtures** (runs on the server) → approve →
   release from the release bar. Release once with venues withheld. The series shows the
   structure's name and the overs from step 2.
6. Club portal → the season reads as **one** heading, and withheld venues show "Venue to be
   confirmed".
7. Resolve a later stage and confirm it generates. Then regenerate a released stage and
   confirm the "Regenerate a released schedule?" prompt appears before anything is replaced.
8. **Start a season** on the same league with the same season label: the server refuses with
   409 `season_exists`. Back in the operator console, on the **League catalogue**, **Set up** the
   league left out in step 1 from its row: structure and calendar both start empty and Save
   stays disabled until both are picked. After a refresh it is startable in the admin
   launcher.
9. Fixtures list → an imported or pre-ADR series shows an **Imported schedule** or
   **Stand-alone series** pill, its fixtures are editable, and nothing offers to regenerate it.
10. Operator console → edit a calendar block's dates while a series is still scheduled against
    it → confirm the PUT response's toast names the affected series count, and the save is
    **not** blocked.

> **"Create a series" is gone (ADR 0014).** The admin console has no create-series form and
> no series-level Regenerate. A one-off cup or festival is a league the operator sets up with
> a structure from the **One-off tournament** template, then started through **Start a
> season** like any other. Imported schedules and stand-alone
> series stay on the Fixtures list and remain editable (add, edit, delete fixtures, allocate
> venues), but they cannot be regenerated: there is no season stage to rebuild them from.

## 2. Deploy

```bash
npm run deploy            # sst deploy --stage prod
```

Nothing to sequence. The frontend and API ship together as usual, and the new routes are
inert until config exists.

New routes, all tenant-scoped and behind the usual membership middleware:

| Route                                       | Auth        |
| ------------------------------------------- | ----------- |
| `GET /venues`                               | rep + admin |
| `PUT /venues/:id` · `DELETE /venues/:id`    | admin       |
| `GET /season-runs` · `GET /season-runs/:id` | rep + admin |
| `POST`/`PATCH`/`DELETE /season-runs[/:id]`  | admin       |
| `POST /season-runs/:id/rebase`              | admin       |
| `GET /tenant/config`                        | any member  |

`GET /tenant/config` is new and is an explicit field allowlist, not the raw row — any tenant
member can call it, so it must stay an allowlist. See [tenant.md](../api/tenant.md).

## 3. New item types (know these before you touch the table)

| Item        | Key                                          | Swept by erasure?                      |
| ----------- | -------------------------------------------- | -------------------------------------- |
| `SeasonRun` | `pk TENANT#<t>#SEASONRUN#<id>`, gsi1 listing | Yes — prefix sweep, plus `clearCohort` |
| `Venue`     | `pk TENANT#<t>`, `sk VENUE#<id>`             | Yes — **explicitly enumerated**        |

> **`VENUE#` sits ABOVE the `TENANT#<t>#…` prefix sweep**, on the same partition as the tenant
> CONFIG row — the same shape as `EXPORT#`. It is deleted only because `eraseTenantData`
> enumerates it by hand (`repo.listVenueKeys`). If you ever add another item under
> `pk TENANT#<t>`, it will survive tenant erasure unless you add it there too. There is a test
> pinning this (`packages/api/test/season-venues.int.test.ts`).

Venues are deliberately **not** cohort data: `clearCohort` wipes season runs but leaves the
ground list, so wiping demo clubs doesn't force the union office to retype every ground.

## 4. Post-deploy operator setup (in this order)

The order is load-bearing — leagues reference structures and calendars, so those must exist
first. Calendars, structures and bindings are operator-only (`PUT /tenant/config` strips `calendars` and `structures`,
per [ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md)).

**Point the operator at Set up a season first.** It walks season dates → league structures →
review & create in one guided flow and ends in a single PUT, which is the order below anyway —
it just does steps 1, 3 and 4 together instead of as three separate card visits. Venues
(step 2) sit outside the wizard as a standalone card; venue aliases and travel (step 5) have
no card at all.

1. **Season calendars.** The union's real playing blocks. For KZNCU 2026/27 that is
   Block 1 (13 Sep – 13 Dec), the mid-season break, and Block 2 (3rd week Jan – March).
   Strict `YYYY-MM-DD`; a block that ends before it starts is rejected. A new block defaults
   to real chained dates (today → +8 weeks) rather than a blank one.
2. **Venues.** _Sync from club records_ seeds the registry from `club.ground`. Then pin
   coordinates by hand — **there is no geocoder.** The card shows geocode coverage, and the
   allocator switches distance ranking off below 60%, falling back to home-ground preference.
   That threshold is the difference between "the allocator ignored travel" and "the allocator
   picks odd grounds for no reason".
3. **Structures.** Six starter templates cover all thirteen documented structures. JSON
   import is how you seed several without twenty rounds of clicking. The wizard's template
   gallery shows a live fit verdict against the calendar picked in step 1; the standalone
   **Competition structures** card is where you go back to edit one stage by stage. Set
   **Overs** on each structure (Edit structure → Overs; empty = 50). That is the match format.
4. **Leagues → Setup.** One setup per league: **Set up** on the league's row in the League
   catalogue (or its row in the wizard) → structure + calendar. Two formats for the same clubs
   (T20 and 50-over) are two league entries, each with its own setup. See
   [The setup model](#the-setup-model-since-27-sep-2026-read-this-first).
5. **Venue aliases and travel.** Config-only; no card. Leave both unset unless the union asks.
   To change them, see §9.

Then hand over: the admin runs the season from **Fixtures → Start a season**. The launcher
lists only set-up leagues; any other league tells the admin to ask the operator. There is no
admin-side way round that, by design.

## 5. Verification

```bash
# Config landed and is operator-only.
curl -s https://<host>/tenant | jq '{calendars: (.calendars|length), structures}'
#   calendars: N, structures: null   ← structures are NOT on the anonymous payload
```

In the console: the operator settings page shows the three new cards and the setup checklist
has matching items. The admin console shows **Start a season** (there is no _Create a series_
any more).

A league with no setup must say so plainly (listed under "Not set up yet — ask your
operator"; a direct `POST /season-runs` gets 400 `setup_missing`) rather than showing an empty
dropdown.

## 6. Rollback

Redeploy the previous build. **No data cleanup is required or wanted:**

- Structures and calendars are inert config. The old code ignores them.
- Season runs and venues are on their own keys. The old code never reads them.
- Series generated by a season run carry `seasonRunId`/`stageSpecId`/`groupId` back-pointers
  and are otherwise ordinary series — the old console renders and edits them fine, it just
  won't group them under one season heading.

The one thing to know: a rolled-back console can still edit and release those series, so a
partially-run season stays usable rather than stranded.

## 7. Pool semis and structure rebase (added 2026-09-25)

Within-group semis, `qualifiersPerGroup`, same-block chaining and the rebase route — see the
[2026-09-25 ADR addendum](../architecture/0008-configurable-league-structures.md#addendum-2026-09-25-within-group-semis-counted-qualifiers-chained-stages-and-rebase).
Every new field is optional; no migration. The rebase route is new, so **restart the local
API** before walking this.

### 7a. Walkthrough: ten teams, two pools, semis either way

The EMCU Division 1 30 Over shape. Use real club names.

1. **Structure.** Start from _Seeded pools → within-group semis → final_ or _Seeded pools →
   cross-pool semis → final_ — it only sets the default pairing, and the union can switch
   it per season at step 5. Pool stage: round robin, two groups (snake-seeded 10 ⇒ 5 + 5).
2. **Knockout stage.** Entrants derive from the pool stage with **Qualifiers per group = 2**.
   The preview now reads an exact 4 entrants and 2 rounds + final, not "up to".
   Within-group accepts a power-of-two number of groups (2, 4, 8) each sending the same
   power-of-two number of sides (2, 4) — the engine's own rule. Anything else (3 groups,
   3 qualifiers) 400s on save with that message.
3. **Same block?** On a single-block calendar, a structure created from a template already
   chains the knockout behind the pools (`startAfter: 'previous-stage'`) — nothing to
   tick. On a two-block calendar the template puts the knockout in the second block
   instead, unchained. A structure built by hand, or with both stages moved into one
   block, needs **Start after the previous stage in this block** ticked on the knockout
   stage, or it dates from the block start and overlaps the pools. Chained semis land on
   the first playing date after the pools' last round, on the same weekday. If the
   combined span doesn't fit the block, the fit verdict says so.
4. **Run it.** Start the season, confirm pool entrants, generate, release as usual.
5. **Confirm qualifiers.** Once the pools finish, record the finishing order in the pool
   stage's **Position** column — that order is what A1/A2/B1/B2 mean. The knockout stage's
   _Confirm entrants_ then prefills the top two of each pool in that order (non-qualifiers
   are not re-added as late entries). Pick the **Semi-final pairing**:

   | Choice                     | Semis                            |
   | -------------------------- | -------------------------------- |
   | Within-group               | A1 v A2, B1 v B2                 |
   | Cross-group                | A1 v B2, B1 v A2                 |
   | Structure default          | whichever the structure declares |
   | Seeded over the full field | ignores pools                    |

   The choice is stored on the season run (`pairingOverride`) and in the stage audit.
   Changing it after generating flips the stage to **Needs regenerating**.

6. **Generate.** Semis plus a final reading "Winner of Semi-final 1 v Winner of Semi-final
   2" in the admin console **and** the club portal. If the stage card shows _Paired as a
   seeded bracket, not within-group_, the confirmed positions don't line up with the
   stage's entrants — fix them and regenerate.

### 7b. Rebase: adopting a structure edit mid-season

Editing a structure mints a new version; running seasons stay on their snapshot. The
season console shows **This season runs structure v{old}; the template is now v{new}.**

1. **Review changes.** Lists each stage as unchanged or changed, with the consequence: adopts
   the new version, drafts will be regenerated, or released — you'll confirm before
   fixtures are replaced. Any server warning (a knockout deriving from a stage that no
   longer exists) shows here — fix the structure first rather than applying over it.
2. **Draft regeneration is opt-in per stage** (default on). It rebuilds fixtures from
   scratch: **allocated venues and hand-edited dates are lost.** Untick any draft stage
   whose venues you've already worked on and regenerate it later, deliberately.
3. **Apply structure v{new}.** On the server:
   - entrant or group-label change ⇒ stage drops to _awaiting entrants_; confirm again (the
     form prefills from the old grouping, kept in the audit);
   - schedule change ⇒ **Needs regenerating**;
   - format change ⇒ any per-season pairing choice is cleared (it's in the audit);
   - stage removed ⇒ its run entry goes, **its series stay**;
   - stage added ⇒ appears awaiting entrants;
   - structure **name or overs** changed ⇒ every surviving stage is marked `formatChanged`,
     and its next generate writes the new series type and overs onto its existing series.
     Without a rebase, a regenerate always keeps a series' stored type and overs.
4. **Released stages** keep their pill and go through the normal released-schedule
   confirm, then the server clash gate. Nothing released is replaced without a click.

A 409 on apply means the structure changed again after you opened the review, or someone
else changed the season. Refetch and review again.

### 7c. Operational notes

- **Regenerating a released series with residual venue clashes 409s** until those clashes
  are fixed. A regenerate mints new fixture ids, so the in-season gate can't tell old
  clashes from new ones. Fix the clashing fixtures (or the other series) first. By
  design — there is no override.
- **Orphaned series still hold their grounds.** A series left behind by a dropped stage or
  group is no longer part of the season's plan but still occupies its ground-days in the tenant
  clash ledger, and will 409 the release of its replacement. Delete it (after recalling,
  if it was released) before releasing the new one — same ordering rule as
  [Plan B's "prune before release"](planb-fixtures-import.md#ordering-consequence--prune-before-release).
- **A stage reset to awaiting entrants keeps its series.** They stay under the same ids,
  the stage card still finds them, and regenerating over the same groups replaces them
  in place. If any are released, generate asks first, as it does anywhere else.
- **Calendars are not rebased once generated.** A calendar edit (or re-pointing a league's
  `setup.calendarId`) doesn't reach a season that has generated fixtures; its
  `calendarSnapshot` is frozen. A season with nothing generated yet follows the live calendar,
  and the operator save warns how many such runs will move. Only standalone series follow a
  calendar edit on regenerate.

## 8. Migrate flat runs (added 2026-09-25)

> **Done, historical.** Ran on dev and prod on 25 Sep 2026 (0 flat runs on either), and the
> script has since been deleted. Any competition it minted is converted to a league setup by
> §10. Quick start, mentioned below, is deleted too; a league with no setup is set up by the
> operator. Do not use this section as instructions.

Flat seasons used to be stored under a sentinel competition id, `__flat__`, with no
competition, structure or (for custom dates) calendar in tenant config. Quick start replaces
them (`POST /season-runs/quick-start`, see [docs/api/series.md](../api/series.md#quick-start)),
and `POST /season-runs` now answers `400` to `__flat__`. Every run already stored under the
sentinel has to be moved onto a real competition **before** a build that rejects `__flat__`
is deployed. Otherwise the new client can't read, regenerate or rebase those runs.

For each flat run, `scripts/migrate-flat-runs.ts`:

- **Structure.** Mints one structure per run (`st-flat-<run id>`, version 1,
  `templateId: flat-round-robin`, `source: migration`). It copies the run's own snapshot,
  so stage `stage-1` and every schedule field stay as they are. The series'
  `stageSpecId`, the run's stages and the series ids stay valid across a later rebase.
- **Calendar.** Chooses a calendar in this order:
  1. The snapshot's id is an operator calendar in config: reuse it.
  2. Some config calendar has the same block dates: reuse it, and rewrite the run's
     `calendarSnapshot.id` and its series' `schedule.calendarId` to that calendar.
  3. Otherwise, append the snapshot as a calendar labelled with the run's season.

  Custom-date flat runs of one league all used the id `cal-flat-<league>`. When two
  seasons of one league have different dates, the second one gets `<id>-<run id>` instead.

- **Competition.** Adds `cmp-flat-<run id>` to the run's league, labelled with the run's
  series type. If the league no longer exists, the run is reported and skipped (it stays
  on `__flat__`).
- **Run.** Rewrites the run onto the new competition and structure, and drops
  `flatFormat`.

Before writing anything, the new config goes through the same calendar, structure and
competition validators the operator route uses. If it fails them, that tenant is skipped
and the reason is reported. Series and runs are written with version checks. A run changed
mid-migration is reported, and re-running finishes it. The run is written last and marks
the run as done, so a re-run after a crash picks up where it stopped. Once a tenant is fully
migrated, a second run finds nothing.

```bash
# dev first. Dry-run prints a per-tenant table (run, league, calendar action, structure,
# competition, series rewritten) and writes nothing.
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-flat-runs.ts
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-flat-runs.ts --confirm
# A second run should report "0 of 0 flat run(s)" unless some runs were skipped (e.g. a deleted league).
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-flat-runs.ts

# Then prod, the same three steps. Do this BEFORE deploying the build that rejects __flat__.
sst shell --stage prod -- npx tsx packages/api/scripts/migrate-flat-runs.ts
sst shell --stage prod -- npx tsx packages/api/scripts/migrate-flat-runs.ts --confirm
```

Read the dry-run's skipped list before you confirm. Skipped runs stay on `__flat__`, and a
client that no longer understands the sentinel can't show them properly. Either restore the
league or delete the run.

**Calendar delete guard.** After migration, the operator portal refuses to delete a calendar
while a season run's `calendarSnapshot.id` still names it (`409 "N season runs were started
on …"`). It already refused while a series was scheduled against it.

## 9. Venue aliases and travel: config-only (revised 2026-09-27)

`TenantConfig.competitionDefaults` now holds two fields, both optional:

| Field          | Shape                                      | Read by                                     |
| -------------- | ------------------------------------------ | ------------------------------------------- |
| `venueAliases` | `{ "<ground spelling>": "<ground name>" }` | release, in-season and clash-check gates    |
| `travel`       | `{ costPerKm, carsPerAwayTrip }` (≥ 0)     | admin and club-portal travel cost estimates |

Match formats, match days and time slots are gone (built-ins only); the server drops them if
sent. **There is no card for either field** — the Competition defaults card was deleted. The
anonymous `GET /tenant` doesn't serve them.

**Editing them.** Operator config PUT, with an operator's Cognito ID token:

```bash
API=https://<api host>; T=<operator id token>; SLUG=<tenant>
# 1. Read what is stored now.
curl -s -H "Authorization: Bearer $T" $API/platform/tenants/$SLUG | jq '.competitionDefaults // {}' > cd.json
# 2. Edit cd.json. Keep BOTH fields in it.
# 3. Write it back.
jq '{competitionDefaults: .}' cd.json \
  | curl -s -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
      --data @- $API/platform/tenants/$SLUG | jq '.competitionDefaults'
```

- **Send the whole object.** `competitionDefaults` is replaced, not merged: a PUT carrying only
  `venueAliases` deletes `travel`, and vice versa. Always read, edit, write back both.
- Keys and values are stored normalised (`Riverside Bowl` → `riversidebowl`); send them as
  written on the sheet. A name that normalises to nothing is a 400. Max 500 aliases.
- Adding or removing an alias can change clash verdicts on the next release or in-season
  edit. Check with the union before removing one.
- The tenant admin's `PUT /tenant/config` accepts the same field through the same validator.
  Prefer the operator route so the change is operator-owned.

- **Venue aliases.** The release, in-season and clash-check gates, and the four venue CLIs
  (`resolve-venue-clashes`, `normalise-venue-names`, `merge-duplicate-venues`,
  `bootstrap-fixture-prereqs`), resolve ground names through the code default
  (`DEFAULT_VENUE_ALIASES`, `packages/engine/src/venue-aliases.ts`) with the tenant's aliases
  merged over it. Aliases are stored normalised (`Riverside Bowl` → `riversidebowl`).

### 9a. Backfill the dolphins aliases into config

> **Done** on dev and prod, 25 Sep 2026 (34 aliases each). Kept for reference.

The code default is every dolphins spelling. Copy it into the dolphins config so an operator
can see and edit it there. This changes no clash result — the gates already merge the two.

```bash
sst shell --stage dev -- npx tsx packages/api/scripts/backfill-venue-aliases.ts            # dry-run: prints the count
sst shell --stage dev -- npx tsx packages/api/scripts/backfill-venue-aliases.ts --confirm
sst shell --stage dev -- npx tsx packages/api/scripts/backfill-venue-aliases.ts            # "already has N venue alias(es)"
# then prod, the same three steps
```

It writes only when dolphins has no `venueAliases` at all; an existing map (even `{}`) is left
alone, and the rest of `competitionDefaults` is kept. **Do not** empty `DEFAULT_VENUE_ALIASES`
in code until this has run on dev **and** prod; that is a separate follow-up change.

## 10. Migrate league setups (added 2026-09-27)

`packages/api/scripts/migrate-league-setups.ts` gives every league that still has
`competitions[]` and no `setup` its one setup, and moves each competition's overs onto its
structure. **Additive**: it writes `setup` and `structure.overs` beside the old data and strips
nothing, so the old build keeps working against a migrated config and rolling back the build
needs no restore. A league that already has `setup` is never touched. Idempotent.

Per league:

- **Kept competition** = the one whose calendar ends latest. Its `{ structureId, calendarId }`
  becomes `setup`.
- **Extras** (every other competition) are reported, and the script exits 1. The league still
  migrates on the kept one.
- **Overs**, for every competition including extras: written onto its structure. A competition
  with no overs of its own counts as the default it played under (the tenant's first match
  format, else 50), never as "no opinion". If two
  competitions sharing a structure disagree, the later one gets a per-league clone
  (`st-<orig>-<league>`, name suffixed " · N overs"); if that was the kept one, `setup` points
  at the clone.

### 10a. Dry-run and read the report

```bash
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-league-setups.ts   # dry-run, writes nothing
```

Read every list before confirming:

| Report               | Means                                                                                                                                                               | Do                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extras`             | league had more than one competition; only one survives as its setup                                                                                                | **Prod: STOP.** See 10b.                                                                                                                                                                                                        |
| `calendarChanges`    | ungenerated run whose followed calendar changes; it will silently re-date                                                                                           | Tell the admin, or fix the kept choice first                                                                                                                                                                                    |
| `formatDrift`        | generated run whose snapshot name/overs differ from the migrated structure                                                                                          | Nothing, usually: existing series keep their stored format on regenerate. A later stage's first generate, or an admin applying **Review changes** (which follows the league's setup, so a clone), takes the migrated name/overs |
| `excludedTeams`      | kept competition had `excludeTeamIds`; the new model ignores them                                                                                                   | Re-cut entrants with **Edit entrants** on the stage                                                                                                                                                                             |
| `pinnedDefaultOvers` | kept competition had no overs of its own; pinned to the old default (the tenant's first match format, else 50), cloning its structure if a sibling stream disagrees | Nothing, usually: this is the format its series already played. Change the structure's Overs if the default was never right for this league                                                                                     |
| `skipped`            | tenant failed validation or read; nothing written for it                                                                                                            | Fix the reason, re-run                                                                                                                                                                                                          |

The last line reads `STOP: N extra competition(s) found — bring this report back for a
split-league decision` when extras exist.

A run whose league was cloned keeps its snapshot (still on the original structure) until an
admin applies **Review changes**. Review changes follows the league's current setup, not the
structure the snapshot came from, so what it offers is the clone: the migrated name and overs
are what a rebase takes, and later edits to the original for other leagues are never offered to
this run.

### 10b. Prod gate: extra competitions

Dry-run prod first. **If `extras` is non-empty, stop.** Each extra is a format stream (e.g. the
T20 beside the 50-over) that would lose its league binding. Decide with the union, per league:
create a second league for that format and set it up (the clone structure the dry-run names is
ready for it), or accept that the stream ends. Only then `--confirm`. The script still exits 1
while extras exist; that exit is the gate, not a failure of the write.

### 10c. Confirm, then deploy immediately

```bash
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-league-setups.ts --confirm
sst shell --stage dev -- npx tsx packages/api/scripts/migrate-league-setups.ts   # re-run: "0 of 0 league(s)", "N already set up"
# dev: re-seed (seed-cohort mints leagues with setups now), deploy, browser check.

sst shell --stage prod -- npx tsx packages/api/scripts/migrate-league-setups.ts             # the gate, 10b
sst shell --stage prod -- npx tsx packages/api/scripts/migrate-league-setups.ts --confirm
npm run deploy    # straight after
```

Deploy right after the prod confirm. Until the deploy the old build is live and still edits
competitions; an operator change in that window lands after the migration read it, and the new
build never sees it. Run `--confirm` while no operator is mid-edit: each tenant config is
re-read and written whole.

### 10d. Backup and restore

`--confirm` writes the full pre-image of each touched tenant config before its put:
`packages/api/league-setups-backup-<tenant>-<ISO>.json` (gitignored; `--backup-dir=<dir>` to
put it elsewhere). **Keep the prod backups.** A tenant whose backup fails is skipped, not
written.

- **Roll back the build:** redeploy the previous build. No restore: `competitions[]` is still
  there and the old build reads it.
- **Restore a config** (only if the migrated config itself is wrong):

  ```bash
  sst shell --stage <stage> -- npx tsx -e "import('./packages/api/src/repo.ts').then(async r => r.putTenantConfig(JSON.parse(require('fs').readFileSync('<backup file>','utf8'))))"
  ```

  This overwrites the whole config, including anything saved since the backup.

## 11. Strip competitions after burn-in (cleanup-competitions)

After prod has run on setups long enough that nobody will roll back to a pre-setup build,
`packages/api/scripts/cleanup-competitions.ts` removes the inert data: `competitions[]`,
`League.note`, and stage `ladder` / `outcome`. Nothing strips them on save; this script is the
only thing that does. **After it runs, rolling back to a pre-setup build is no longer free.**

- Dry-run by default; `--confirm` writes, after a pre-image backup per tenant:
  `packages/api/competitions-cleanup-backup-<tenant>-<ISO>.json` (gitignored;
  `--backup-dir=<dir>` to move it). Restore as in 10d.
- **Refuses a tenant that still has an unmigrated league** (competitions and no `setup`): the
  whole tenant is left untouched, the league is reported, and the run exits 1. Run §10 first;
  a refusal means §10 was skipped or an extra was never resolved.
- No structure versions are bumped and no season runs are touched. Idempotent.

```bash
sst shell --stage dev -- npx tsx packages/api/scripts/cleanup-competitions.ts
sst shell --stage dev -- npx tsx packages/api/scripts/cleanup-competitions.ts --confirm
# then prod, the same two steps, once burn-in is over
```

## Known limitations to communicate

- **Standings are typed by a human.** There is no results model, so a stage that depends on
  finishing order asks an admin to confirm it, quoting the operator's own rule back at them.
  Cross-pool and within-group draws need the pool stage's Position column filled in before
  the bracket means anything. `qualifiersPerGroup` sets how many go through, not who.
- **Scoring-platform sync is not built.** It is the client's stated P0 and remains blocked on
  which platform, what API, what auth, and how team identities map across the two systems.
