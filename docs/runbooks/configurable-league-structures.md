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

The wizard (**Set up a season**, from the tenant edit page or the CalendarsCard/SetupCard
empty states) is the primary path — walk that first. The three cards below (Season calendars,
Structure library, Leagues) are the editing surfaces you drop into afterwards to extend a
calendar, tweak a structure in detail, or fix a single binding; walk them standalone too so
you're covering both entry points.

Walk the whole path once:

1. Operator console → **Set up a season** → season dates (add a calendar with two blocks and
   a mid-season break, or extend an existing one) → per-league structure (pick a template,
   an existing structure, or skip) → review the fit verdicts → commit.
2. Operator console → **Venues** → _Sync from club records_, then pin one ground by hand
   (latitude and longitude accept a minus sign and a decimal point — if they don't, stop).
3. Operator console → **Structure library** → confirm the wizard's structure opened here
   edits correctly; separately, build one from scratch and import one from JSON.
4. Operator console → **Leagues** → confirm the wizard's binding shows correctly; separately,
   bind a competition (structure + calendar) to a league by hand.
5. Admin console → **Start a season** → confirm stage-1 entrants → generate → approve →
   release.
6. Club portal → the season reads as **one** heading, not several loose series.
7. Back to the admin console → resolve a later stage → confirm the final round generates.
8. Operator console → edit a calendar block's dates while a series is still scheduled against
   it → confirm the PUT response's toast names the affected series count, and the save is
   **not** blocked.

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
first. All of it is operator-only (`PUT /tenant/config` strips `calendars` and `structures`,
per [ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md)).

**Point the operator at Set up a season first.** It walks calendar → per-league structure →
review in one guided flow and ends in a single PUT, which is the order below anyway — it just
does steps 1, 3 and 4 together instead of as three separate card visits. Venues (step 2) sit
outside the wizard and are still a standalone card.

1. **Season calendars.** The union's real playing blocks. For KZNCU 2026/27 that is
   Block 1 (13 Sep – 13 Dec), the mid-season break, and Block 2 (3rd week Jan – March).
   Strict `YYYY-MM-DD`; a block that ends before it starts is rejected. A new block defaults
   to real chained dates (today → +8 weeks) rather than a blank one.
2. **Venues.** _Sync from club records_ seeds the registry from `club.ground`. Then pin
   coordinates by hand — **there is no geocoder.** The card shows geocode coverage, and the
   allocator switches distance ranking off below 60%, falling back to home-ground preference.
   That threshold is the difference between "the allocator ignored travel" and "the allocator
   picks odd grounds for no reason".
3. **Structures.** Four starter templates cover all thirteen documented structures. JSON
   import is how you seed several without twenty rounds of clicking. The wizard's template
   gallery shows a live fit verdict against the calendar picked in step 1; the standalone
   Structure library card is where you go back to edit one stage by stage.
4. **Leagues → Competitions.** Bind each format stream (e.g. "50 Over Red Ball", "T20 Pink
   Ball") to a structure and a calendar. A league can run several in parallel — that was the
   structural gap in the old model.

Then hand over: the admin runs the season from **Start a season**.

## 5. Verification

```bash
# Config landed and is operator-only.
curl -s https://<host>/tenant | jq '{calendars: (.calendars|length), structures}'
#   calendars: N, structures: null   ← structures are NOT on the anonymous payload
```

In the console: the operator settings page shows the three new cards and the setup checklist
has matching items. The admin console shows **Start a season** beside _Create a series_.

A league with no competition configured must say so plainly ("no structure configured for this
league — contact your platform operator") rather than showing an empty dropdown.

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
   Within-group accepts only 2 groups × 2 qualifiers in this version; anything else 400s
   on save with that message.
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
   - stage added ⇒ appears awaiting entrants.
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
- **Calendars are not rebased.** A calendar edit still doesn't reach a running season's
  `calendarSnapshot`. Only standalone series follow a calendar edit on regenerate.

## Known limitations to communicate

- **Standings are typed by a human.** There is no results model, so a stage that depends on
  finishing order asks an admin to confirm it, quoting the operator's own rule back at them.
  Cross-pool and within-group draws need the pool stage's Position column filled in before
  the bracket means anything. `qualifiersPerGroup` sets how many go through, not who.
- **Scoring-platform sync is not built.** It is the client's stated P0 and remains blocked on
  which platform, what API, what auth, and how team identities map across the two systems.
