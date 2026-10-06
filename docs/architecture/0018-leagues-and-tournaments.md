# ADR 0018 — Leagues & tournaments: create, draw, table and knockout in Fixtures & Venues

**Status:** Proposed (October 2026). Built on `feature/fixtures-venues-ui`, not yet reviewed.
Builds on ADR 0014 (seasons), ADR 0016 (medicoach sync) and ADR 0017 (match-week office).

## Context

Before this change, a union could only get fixtures in two ways. Either the platform operator
set up a season structure (ADR 0014), or a schedule was imported. The Fixtures & Venues
"Seasons & series" tab showed every series as a card. The cards worked as a filter but said
little: an "Imported schedule" pill, a fixture count and a status. Three things were missing:

- Nobody in the union office could start a league or a cup on their own.
- There was no league table and no results matrix.
- A knockout had no way to fill itself from group tables or results.

The union wants this to be the place where leagues and tournaments live:

> The series: create, edit or delete either a league or tournament. We don't need the card as
> a filter, a simple table once the fixtures are generated. Make sure the automation of
> fixtures is brought into the system.

Agreed with the union:

- The admin creates the league or tournament here.
- Points default to **Win 4 · Tie/No result 2 · Loss 0** and can be changed per competition.

## Decision

### 1. A competition is a set of ordinary series

The design adds **no new entity**. A league or tournament is the set of series that share
`series.competition.id`. Each series carries one block, `CompetitionMeta`
(`packages/engine/src/competition.ts`):

```ts
{
  id: 'c-sunday-t20-1a2b3c',          // c-<slug>-<6 hex>, minted by the API
  type: 'league' | 'tournament',
  name: 'Sunday T20',
  format: CompetitionFormat,           // see below
  schedule: { startDate, everyDays, times[], excludeDates? },
  points: { win, tie, noResult, loss },
  seed?: number,                       // the draw's shuffle; absent = list order
  role: 'league' | 'group' | 'knockout',
  groupLabel?: 'Group A' | …,
}
```

The series ids follow the format:

| Format                                      | Series                                  |
| ------------------------------------------- | --------------------------------------- |
| League (`round-robin`, 1 or 2 legs)         | `<id>` (role `league`)                  |
| Knockout (`knockout`, optional third place) | `<id>` (role `knockout`)                |
| Groups then knockout (`groups-knockout`)    | `<id>-g1…gN` (role `group`) + `<id>-ko` |

Because the members are plain series, everything that already works on a series keeps
working unchanged:

- approve and release, including progressive release (ADR 0011);
- the version check, the approval recall and both clash gates on `PATCH /series/:id`;
- venue allocation;
- officials (umpires and scorers, ADR 0017);
- results and confirmation;
- the medicoach outbox and sync (ADR 0016), as long as `leagueKey` maps.

A series without the block (operator seasons and imported schedules) still shows in the same
table, grouped by `seasonRunId` or standing alone.

### 2. The draw is generated on the server, in the engine

`planCompetition(spec)` in `packages/engine/src/competition.ts` is pure and reuses the
existing generators:

- **League:** `roundRobinRounds` (circle method, one game per team per round, a bye for an
  odd number of teams). With two legs, the second leg reverses home and away.
- **Knockout:** `knockoutRounds` seeds the bracket. A field that isn't a power of two gets a
  preliminary round, and the plan **warns** about it. Later rounds are `win:<fixtureId>`
  slots; the third-place game uses `lose:` slots.
- **Groups then knockout:**
  - Teams are snake-split into groups (1,4,5,8 / 2,3,6,7), each group played as a round robin.
  - The knockout uses `crossPoolRounds`: `pos:<groupSeriesId>:<rank>` slots, with A1 v B2
    and B1 v A2.
  - The knockout starts `everyDays` after the last group date.
- **Dates:** `fixturesFromDates` gives one date per round, starting at `startDate` and stepping
  `everyDays`. A date in `excludeDates` pushes that round on. `times` (up to four) cycle across
  each round's games. Fixture ids run `f1…` within each series.
- **Randomise draw:** `seed` drives a seeded shuffle (mulberry32, `shuffleWithSeed`) of the
  team order. The same seed always gives the same draw.
- **Problems:** `competitionProblems(spec)` lists **every** problem in plain words (no name,
  bad overs, a team listed twice, too few teams for the groups, bad times, bad points, …).
  `planCompetition` returns `{ ok: false, problems }` rather than throwing.

Grounds: each team's home ground travels as `participants[].venue`. Allocation and hand-picks
then work as for any series.

### 3. API: `/competitions` (admin only)

Routes are in `packages/api/src/index.ts`; parsing and read-side helpers are in
`packages/api/src/competitions.ts`.

| Route                               | Does                                                                                                                                                                 | Refuses                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /competitions/preview`        | Plans the draw. **Writes nothing.** Returns `{ id, series, summary, warnings, clashes }`. `clashes` are ground double-bookings against everything already scheduled. | 400 `invalid_competition` (`problems[]`), 400 `unknown_team` (not one of this union's clubs), 403 for a rep |
| `POST /competitions`                | Writes the series as **drafts** through `createSeries`. If one write fails, the series already written are removed again.                                            | 409 `competition_exists` (id or series id taken)                                                            |
| `PATCH /competitions/:id`           | Name and/or points, applied to every member through `applySeriesPatch` (version-checked).                                                                            | 400 bad points, 404 unknown                                                                                 |
| `POST /competitions/:id/regenerate` | A new spec or seed replaces the series whole. Officials and sync state on the old draw are deleted.                                                                  | 409 `competition_released` (recall first), 409 `has_results`                                                |
| `DELETE /competitions/:id`          | Deletes every member series, its officials and its sync state.                                                                                                       | 409 `competition_released`                                                                                  |
| `GET /competitions/:id/standings`   | One table per league or group series, from the stored medicoach results.                                                                                             | 404                                                                                                         |
| `POST /competitions/:id/advance`    | Fills the knockout (see §5) and writes it as an admin edit of the knockout series.                                                                                   | 409 `no_knockout`                                                                                           |

**Preview is the draw that gets saved.** The client sends back the same spec, with the same
`id` and `seed`, so the server regenerates the identical draw. The draw is pure and
deterministic, so nothing has to be stashed between the two calls.

### 4. League table (one function for API and console)

`computeStandings` is in `packages/engine/src/standings.ts`. Both
`GET /competitions/:id/standings` and the console's Table tab call it.

- **Points:** `DEFAULT_CRICKET_POINTS = { win: 4, tie: 2, noResult: 2, loss: 0 }`, or the
  competition's own `points`.
- **Net run rate:** parsed from medicoach's score strings, e.g. `"184/6 (20)"` or
  `"120 (18.3)"`:
  - A side **bowled out** is charged its full quota (`maxOvers`), the ICC rule.
  - No-results, forfeits, scores without overs, and impossible overs such as `20.6` stay out
    of the run rate.
- **Sort order:** points, then NRR, then wins, then name.
- `form` lists the last five results (W/L/T/N).
- Knockout slots and cancelled games are ignored.

### 5. Knockout advance

`advanceKnockout(fixtures, groups, { allowIncomplete })` is in the engine.

- **`pos:` slots** fill only from a group whose games are all in. With `allowIncomplete`
  ("Fill from tables as they stand"), they fill from the table as it stands.
- **`win:` and `lose:` slots** fill from the knockout's own results. A tie waits; the union
  decides it.
- The original slot is kept in `fixture.slots`, so a fill can be traced and redone.
- The call returns `{ filled, waiting[] }`. `waiting` lists what is holding things up, in
  plain words.

### 6. The console: Fixtures & Venues → Leagues & tournaments

The tab key stays `series`, so old `?tab=series` links still work. The tab is now
`src/CompetitionsPanel.tsx`, with the grouping, matrix and balance logic in
`src/competitions.ts`.

- **Table, not cards.** There is one row per competition, operator season or loose series:
  name, type (League / Tournament / Season / Imported schedule / Stand-alone series), format,
  teams, fixtures with how many have been played, dates and status. The status reads Draft,
  Approved, Released, or **Partly released** when only some members are released. A loose
  series keeps its origin pill and "What is this?" explainer.
- **+ Create league / + Create tournament** open one dialog:
  - type, name, catalogue league (optional; prefills that league's teams), overs and format;
  - team checkboxes (with All and None), first round, an interval of a week, two weeks, a
    day for festivals, or three days, start times and dates to skip;
  - points, folded away under their defaults.
  - **Preview fixtures** is required before saving. Any edit after a preview discards it.
    **Randomise draw** previews with a new seed. The dialog shows the summary, the warnings,
    any ground double-bookings and every fixture by date.
- **One competition.** A breadcrumb leads back to the list. Part chips (Group A, Group B,
  Knockout) switch between members. Then the tabs:
  - **Fixtures:** the existing `FixtureTable` editor and release bar, unchanged.
  - **Table:** qualifiers are highlighted.
  - **Bracket** (knockout only): with **Advance knockout** and **Fill from tables as they
    stand**.
  - **Results matrix:** home rows by away columns.
  - **Home / away:** flags any imbalance over one.
  - **Settings:** rename, points, **Regenerate fixtures…**, **Delete**. Delete needs a second
    click, and both are disabled with the reason when released or when results are in.
- **Status** pills (Draft, Released, Withheld …, Activates …) sit beside the name. Approve,
  release, reveal and recall stay in **one** place, the release bar.
- **The open competition rides on `?series=<id>`.** "Open series" from any game row and a
  reload both land on it.
- The **league catalogue** (`AdminLeagues`, `embedded`) is a second view of the same tab. The
  Leagues nav page still works.
- **Operator seasons** (`SeasonRunsPanel`) sit under the table. The section opens on its own
  while a season is running.

## Failure modes and where they are tested

| Failure                                                        | Behaviour                                                                                | Test                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Spec invalid in several ways                                   | 400 with **every** problem; the dialog shows them all and Create stays disabled          | engine `competition.test.ts` "lists every problem at once"; API "refuses an invalid spec…"; DOM "lists every reason a draw is refused" |
| A team that isn't one of the union's clubs                     | 400 `unknown_team`                                                                       | API "refuses an invalid spec…, an unknown club, and a rep"                                                                             |
| A rep calls `/competitions/*`                                  | 403                                                                                      | same                                                                                                                                   |
| Saving without a preview, or after editing one                 | Create disabled; editing clears the preview                                              | DOM "randomises the draw…"                                                                                                             |
| Preview ≠ stored draw                                          | Impossible by construction (pure + same id/seed). Asserted.                              | API "the preview draw is the draw stored, as a draft"                                                                                  |
| Name or id already taken                                       | 409 `competition_exists`; dialog stays open with the reason                              | API (create); DOM "keeps the dialog open when the save is refused…"                                                                    |
| Server unreachable                                             | "Could not reach the server — check your connection."; nothing changes                   | DOM same test                                                                                                                          |
| A member series fails to write                                 | The ones written are deleted again (no half competition)                                 | code path in `POST /competitions` (not fault-injected; see open points)                                                                |
| Ground double-booked against existing fixtures                 | Reported on preview as a warning; release refuses it as for any series                   | API "reports ground double-bookings…"                                                                                                  |
| Field not a power of two                                       | Preliminary round + warning                                                              | engine "a knockout cup…"                                                                                                               |
| Regenerate a released competition, or one with results         | 409 `competition_released` / `has_results`; Settings disables the button with the reason | API "regenerate is refused once results are in"; DOM "locks the draw once results are in…"                                             |
| Delete a released competition                                  | 409 `competition_released`; button disabled                                              | API "a released competition must be recalled…"; DOM same                                                                               |
| Regenerate leaves officials pointing at old fixtures           | Officials and sync state of the old series are deleted                                   | API "a new seed replaces the draw in place; officials on the old draw go"                                                              |
| Advance before the groups finish                               | Fills nothing from that group; `waiting` says why                                        | engine "fills group places only from finished groups"; API "advance waits…"; DOM "advances the knockout…"                              |
| A tied knockout game                                           | Its `win:` slot waits for the union                                                      | engine "fills the final from the semis' results"                                                                                       |
| Advance on a league                                            | 409 `no_knockout` → warning toast                                                        | API "a league has no knockout"; DOM                                                                                                    |
| Rename or re-point                                             | Applied to every member, version-checked; bad points 400                                 | API "rename and points apply…"; DOM "renames and re-points it…"                                                                        |
| Bowled-out side / no overs / forfeit / impossible overs in NRR | Full quota / excluded / excluded / excluded                                              | engine `standings.test.ts`                                                                                                             |

## How to run it

```bash
npm run dev:local:demo
```

This starts the SPA on :3201 and the API on :3333 against dynalite. Then seed a fictional
match week:

```bash
cd packages/api && npx tsx scripts/demo-fixtures-week.ts
```

Open `/admin/fixtures?tab=series`, then use **+ Create league**.

Tests:

```bash
npx vitest run packages/engine/src/competition.test.ts packages/engine/src/standings.test.ts src/competitions.test.ts src/competitions-panel.dom.test.tsx
```

```bash
cd packages/api && npx tsx --test test/competitions.int.test.ts
```

The API integration tests use in-process dynalite on port 4695.

## Files

| Layer  | File                                              | What                                                                                                                              |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Engine | `packages/engine/src/competition.ts`              | spec, problems, `planCompetition`, `advanceKnockout`, seeded shuffle                                                              |
| Engine | `packages/engine/src/standings.ts`                | `parseScore`, `computeStandings`, default points                                                                                  |
| API    | `packages/api/src/competitions.ts`                | body parsing, member lookup, results join, tables, advance                                                                        |
| API    | `packages/api/src/index.ts` (`/competitions…`)    | the routes above                                                                                                                  |
| Client | `src/api.ts`                                      | `previewCompetition`, `createCompetition`, `regenerateCompetition`, `patchCompetition`, `deleteCompetition`, `advanceCompetition` |
| Client | `src/competitions.ts`                             | grouping into rows, standings/matrix/home-away for one series                                                                     |
| Client | `src/CompetitionsPanel.tsx`                       | the tab, the dialog, the detail views                                                                                             |
| Client | `src/admin.tsx` (`AdminFixtures`), `src/main.tsx` | wiring, the embedded catalogue, `onCompetitionsChanged`                                                                           |

## Open points for review

1. **Release is per series.** A groups-then-knockout tournament is released part by part, and
   the table shows "Partly released" until all parts are out. A "release all parts" action
   would be a small client loop over the existing release dialog.
2. **Deleting a single member series** through the fixture editor's "Delete series" is still
   possible. For a groups-then-knockout tournament, that leaves `pos:` slots that point
   nowhere. Consider hiding that button for competition members, so Settings → Delete is the
   only path.
3. **Results and confirmations are not removed** when a competition is deleted or
   regenerated. Medicoach owns results (ADR 0016), and drafts are rarely synced. The orphaned
   `FIXRESULT#`/`RESULTCONF#` items are harmless (nothing joins them) but could be swept.
4. **Rollback on a failed create** is best effort and not fault-injected in tests.
5. **Standings are computed on read**, in both API and client, from the same function. That
   is fine at union scale (tens of fixtures per series). Cache only if a tenant grows far
   beyond that.
6. **Advance writes the knockout through `applySeriesPatch`.** On a released knockout, this
   triggers the in-season clash gate and the medicoach outbox like any edit. That is
   intended, but worth a reviewer's eye.
