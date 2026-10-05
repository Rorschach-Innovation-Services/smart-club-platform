# ADR 0017 — The match-week office: fixtures, officials, result confirmation, ground use

**Status:** Proposed (October 2026) — built on `feature/fixtures-venues-ui`, not yet reviewed.
Builds on ADR 0011 (progressive release), ADR 0014 (seasons) and ADR 0016 (medicoach sync).

## Context

The Dolphins opening weekend (3–4 October 2026) ran, but only because the office patched it
by hand: fixtures in the wrong league, squads and scorers unconfirmed before first ball, and
no step that closed the day's results. The resulting SOP fixes a weekly cycle for the union
office:

| Day      | The office…                                                                 |
| -------- | --------------------------------------------------------------------------- |
| Monday   | confirms results, the week's fixtures (time, ground) and any venue changes  |
| Thursday | allocates and confirms **umpires and scorers** (allocations in by Thursday) |
| Weekend  | runs live fixtures; every result is checked and signed off                  |

Fixtures & Venues was built around generating a season, one series at a time. Finding "every
game this weekend", what still lacks an umpire, or which results are unchecked meant opening
each series. This ADR records how the page now serves that weekly cycle, and the back end it
needed.

## Decision

### 1. One fixture index, managed where it is found (frontend)

`src/fixture-index.ts` flattens every series' fixtures (with the joined result and officials)
into one list with names, ground and **checks**: result missing, result to confirm, result
changed since confirmed, ground double-booked, no/one umpire, no scorer (upcoming games only),
no ground, start time TBC, not released. Fixtures & Venues has tabs **This week · All fixtures
· Results · Venues · Seasons & series**; the last is the unchanged editor.

Managing a fixture from those views (`src/FixtureManage.tsx`) goes through **the same writes
the editor uses** — nothing new on the server for add/edit/remove:

- add / edit / remove a fixture → `PATCH /series/:id` (whole series + `version`), so the
  version check, approval recall, both clash gates and the medicoach outbox all still apply;
- umpires / scorers → `PUT /series/:id/fixtures/:fixtureId/officials`.

Ground choices map onto the stored precedence (override → allocated → home): _home ground_
clears both; _a registered ground_ writes `venueId`/`venueName`/coords **and `venueLocked`**
(so a later "Allocate venues" never moves a hand-picked ground); _somewhere else_ writes
`venueOverride`.

### 2. Scorers (smart club register)

Medicoach has no per-person fixture scorer (its scorers hold an institution-wide `Scorer`
role; a fixture only names a scoring team), so the union's roster lives here:

- `SCORER` entity: `TENANT#<t>#SCORER#<id>` / `META`, gsi1 `TENANT#<t>#TYPE#SCORER` by name
  (`keys.ts`). Shape `Scorer { id, displayName, fullName?, phone?, email?, active }`
  (`packages/engine/src/umpires.ts`). Ids `s-<slug>`; an active scorer's name is unique
  (case/punctuation-insensitive).
- Appointments ride on the existing per-fixture officials item (`FIXOFFICIALS#`):
  `scorers?: ScorerRef[]`, at most two (scorer + backup).
- **`PUT …/officials` now replaces only the parts it is sent** (`umpires`, `referee`,
  `scorers`); an absent key keeps what is stored. This also fixes a latent bug: the console's
  umpire picker sent `umpires` only and so dropped any referee the appointments upload wrote.
- Names are refreshed from the register on read (a rename shows at once); a club rep sees
  scorers on its own fixtures, under the same venue-reveal rule as umpires.
- Erasure enumerates scorer rows; `clearCohort` keeps the register (union data, like umpires).

Sending scorers to medicoach is **future work** (it needs a medicoach fixture-level scorer
field and an endpoint; see _Medicoach work_).

### 3. Result confirmation ("checked and validated")

- Own item beside the result: `TENANT#<t>#FIXRESULT` / `RESULTCONF#<seriesId>#<fixtureId>`,
  `ResultConfirmation { seriesId, fixtureId, recordedAt, confirmedAt, confirmedBy, note? }`.
  Never a field on `FIXRESULT#`: the puller replaces that item **whole** on every newer
  result, which would wipe it.
- A confirmation names the `recordedAt` it checked. On read (`toResultView`) it counts only if
  that equals the stored result's `recordedAt`; otherwise the view says
  `changedSinceConfirmed: true` and the fixture is back on the "to confirm" list. No hook has
  to invalidate anything, so a missed or replayed sync event cannot leave a stale tick.
- Joined onto `GET /series` for **admins only** (`result.confirmation`,
  `result.changedSinceConfirmed`); reps always see `confirmation: null`.
- Deleted with the series (`deleteSeriesSyncState`), with a removed fixture
  (`applySeriesPatch` cleanup), and by tenant erasure / cohort clear (whole results partition).

### 4. Ground use (pitch-load proxy) — contract v1, additive

The changes feed result gains an optional `play`:
`{ startedAt, endedAt, legalBalls, deliveries }` (ISO UTC / integers, each nullable). Stored on
`FIXRESULT#` with its result; shown on the result and summed per ground on Venues → Ground use
(`groundUsage()` in `fixture-index.ts`): games, minutes on the ground, legal balls, last 7 days,
six weeks of balls per week, and a load: **heavy** (≥ 3 games or ≥ 720 legal balls in 7 days),
**rested** (no game for 14 days). The thresholds are constants to tune with the groundsmen.

A malformed `play` becomes `null` (`.catch(null)` in `SyncPlaySchema`) — a bad ground figure
never fails a sync page or holds up a result. A medicoach that does not send it still syncs.

### 5. Removing a fixture medicoach holds

`PATCH /series/:id` that drops fixtures from a **released, sync-mapped** series is refused
`409 synced_fixture_removed` (`{ fixtureIds }`) unless the body carries
`confirmRemoveSynced: true` (an action key, never stored). Medicoach cannot delete a synced
fixture and contract v1 has no delete, so a silent removal left it live in medicoach's match
centre. The console offers **Mark cancelled** (the supported path) or an explicit **Remove here
only**. Drafts, unsynced tenants and inbound medicoach writes are not gated. Either way the
removed fixtures' officials and confirmations are deleted after the write (best effort).

### 6. Seasons: league readiness and a one-step start (frontend)

Authority is unchanged (ADR 0014 amendment: the operator sets a league's structure and
calendar). The admin's Leagues page now shows each league's readiness —
`src/league-readiness.ts`: _season running_ → _needs operator setup_ (with a copyable request
line) → _needs sides_ (registered vs affiliated, unaffiliated clubs listed) → _ready to start_
— and Start a season is one modal (`StartSeasonModal`, `src/season-run.tsx`), preselected from
a league row. The POST payload is unchanged. Opening it refetches `qk.tenant` (fixes the stale
"not set up" after an operator setup); `structure_missing` / `calendar_missing` now have copy.

## API reference (new or changed)

| Method + path                                            | Who   | Body                                                       | Answers                                                                                                       |
| -------------------------------------------------------- | ----- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /scorers`                                           | admin | —                                                          | `Scorer[]` by name                                                                                            |
| `POST /scorers`                                          | admin | `{ displayName, fullName?, phone?, email? }`               | 201 `Scorer` · 400 invalid · 409 `scorer_name_taken`                                                          |
| `PATCH /scorers/:id`                                     | admin | any of the above + `active`; `null`/`''` clears            | `Scorer` · 404 · 409 `scorer_name_taken`                                                                      |
| `PUT /series/:id/fixtures/:fid/officials`                | admin | any of `umpires[]`, `referee` (`null` clears), `scorers[]` | the stored officials · 400 unknown/inactive/repeated/too many/empty body · 404 series/fixture                 |
| `POST /series/:id/fixtures/:fid/result/confirm`          | admin | `{ recordedAt, note? }` (the result the admin looked at)   | `ResultConfirmation` · 400 · 404 · 409 `no_result` · 409 `result_changed` (+ current `result`) · 409 sync off |
| `DELETE /series/:id/fixtures/:fid/result/confirm`        | admin | —                                                          | `{ ok: true }` (idempotent)                                                                                   |
| `PATCH /series/:id`                                      | admin | + optional `confirmRemoveSynced: true`                     | + 409 `synced_fixture_removed` `{ fixtureIds }`                                                               |
| `GET /series` (fixture `result`)                         | all   | —                                                          | + `play`, `confirmation` (admins), `changedSinceConfirmed`; `officials.scorers`                               |
| medicoach `GET /integrations/smartclub/changes` (result) | —     | —                                                          | + optional `play` (see the sync contract §1)                                                                  |

## Failure modes (and where each is tested)

| Scenario                                                                  | Behaviour                                                                                     | Test                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Admin confirms after medicoach sent a newer result                        | 409 `result_changed` with the new result; UI shows "check it, then confirm"                   | `match-week-office.int` · `fixtures-hub.dom`             |
| Newer result arrives after confirming                                     | Confirmation ignored on read; fixture back on "to confirm", flagged "changed since confirmed" | `match-week-office.int` · `fixture-index.test`           |
| Puller replays / replaces the result item                                 | Confirmation (own item) survives                                                              | `match-week-office.int`                                  |
| Medicoach clears a result                                                 | No result shown; can't be confirmed (409 `no_result`)                                         | `match-week-office.int`                                  |
| Confirm with the sync off / as a rep / bad body / unknown fixture         | 409 / 403 / 400 / 404                                                                         | `match-week-office.int`                                  |
| Saving umpires after scorers (or vice versa), or an uploaded referee      | The other parts are kept                                                                      | `match-week-office.int`                                  |
| Unknown, inactive, repeated, > 2 scorers; empty officials body            | 400                                                                                           | `match-week-office.int`                                  |
| Scorer renamed                                                            | New name everywhere on next read                                                              | `match-week-office.int`                                  |
| Rep reads a fixture that isn't theirs                                     | No officials, no confirmation                                                                 | `match-week-office.int`                                  |
| Remove a fixture of a released, synced series                             | 409 `synced_fixture_removed`; Mark cancelled or explicit Remove here only                     | `match-week-office.int` · `fixtures-hub.dom`             |
| Remove on a draft / unsynced tenant                                       | Allowed                                                                                       | `match-week-office.int`                                  |
| Stale tab removes a fixture                                               | Plain 409 "series changed" first (never the sync 409)                                         | `match-week-office.int`                                  |
| Removed fixture had officials / a confirmation                            | Deleted after the write                                                                       | `match-week-office.int`                                  |
| Series deleted                                                            | Its confirmations go with its results                                                         | `match-week-office.int`                                  |
| Malformed `play` (negative balls, end before start, bad date, wrong type) | `play: null`; result still stored; page `ok`                                                  | `medicoach-sync-contract.test` · `match-week-office.int` |
| Medicoach without `play`                                                  | Parses and syncs; ground use counts games only and says how many lacked scorecard data        | contract test · `fixtures-hub.dom`                       |
| Ground clash on an edit from This week                                    | Dialog stays open listing the clashes                                                         | `fixtures-hub.dom`                                       |
| Network failure saving officials                                          | Dialog stays open: "check your connection"                                                    | `fixtures-hub.dom`                                       |
| A team set to play itself / missing date or teams                         | Save disabled with the reason; nothing sent                                                   | `fixtures-hub.dom`                                       |

Run: `npx vitest run` (frontend) and `npm test` in `packages/api` (in-process dynalite; the
new suite is `test/match-week-office.int.test.ts`, port 4693).

## Medicoach work

1. **`play` on results** (contract §1, additive): in `buildResult` / the page assembly
   (`apps/api/src/domains/integrations-smartclub/services/changes.ts`), from the linked
   `PostMatchAnalysis.liveScoringData`: first and last delivery `timestamp` (scorer device
   clock), legal balls (`isLegal`) and all deliveries across both innings; `null` for
   manual/no-result fixtures. Add `play` to the **strict** `SmartClubResultSchema`
   (`packages/types/src/smartclub-sync.ts`) and copy the new shared example
   `changes-result-with-play.json`. Because smart club stores a result only when `recordedAt`
   is newer, back-filling `play` onto old results needs a `resultRecordedAt` bump.
2. **Scorers (later):** a fixture-level scorer assignment in medicoach plus a push endpoint, so
   the union's roster reaches the scorer's match list. Not needed for the roster itself.

## Consequences and open points

- Confirmation is per fixture and per result version; there is no bulk "confirm all" on
  purpose (it would defeat checking). A union sign-off of the whole day (the SOP's 19:00
  sign-off) can be built on top of these items later.
- Scorers are names and contacts only; no notifications are sent to them (as with umpires).
- Ground-use thresholds are a starting proxy, not agronomy; tune `HEAVY_WEEK_*` /
  `RESTED_DAYS` with the union.
- Known, unchanged: approving a series can toast success on a failed save; "Series
  duplicated/deleted" toasts fire before the request lands (`admin.tsx` FixtureTable).

## Local demo

```
MEDICOACH_SYNC_URL=http://localhost:4799 MEDICOACH_SYNC_SECRET=local-demo-secret \
  NOTIFY_DRY_RUN=1 npm run dev:local:demo
npx tsx packages/api/scripts/demo-fixtures-week.ts
```

Seeds a realistic match week (two played weekends with results through the real puller,
ground time/balls, some confirmed; umpires and scorers with gaps; a postponement) with
fictional people.
