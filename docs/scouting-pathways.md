# Scouting: Schools, Pathways and the Lions dashboard

**Status:** prototype, October 2026. Frontend only: no API, schema or infra changes. Ships with
invented sample data; real data is git-ignored (see _Data_).

## Read this first (two minutes)

**What it adds.** The Scouting page gains two areas and one behaviour:

| Area                   | URL              | What it is                                                                                                                                                                                                                     |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Schools**            | `?view=schools`  | School cricket from the union's results export, laid out like Player scouting (ladders, leaderboards, maps, teams, shortlist).                                                                                                 |
| **Pathways**           | `?view=pathways` | Milestones (the bar at each stage), **Players** (performance and participation by age bracket), **Route to professional** (where each player is, came from, and where the pipeline leaks), Improvers, and the pyramid beneath. |
| **A union's own view** | any              | For the `lions` tenant, every Scouting area shows the Lions only. Other tenants see everything.                                                                                                                                |

**To run it.** `npm run dev:local:demo`, sign in as admin, open Scouting. With no real data it
shows the invented "Highveld" sample and says so. To see the Lions view, sign in to the `lions`
tenant (`?tenant=lions` on a bare host).

**To check it.** `npm run typecheck && npx vitest run` (1,766 tests on a fresh clone). Nothing in `packages/api`
changed. `eslint`: 0 errors, the same 103 pre-existing warnings as `main`.

**What needs a decision from you.** Nothing to deploy differently. Two things to know:

1. Real data (scorecards, results, the national report) is read from `src/scouting-local/`,
   which is git-ignored. A production build made on a machine that has that folder bundles the
   data into the JS. The match library (API, PR #4) is the right home for scorecards; results
   exports and the report still need an upload path. See _Open points_.
2. To give another union its own view, add one line to `FOCUS_BY_TENANT` in
   `src/scouting-focus.ts`.

**Files, in reading order.**

| File                             | Role                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/scouting-focus.ts`          | The union filter (`FOCUS_BY_TENANT`, `focusEvents`, `focusPools`, `isOurFranchise`).      |
| `src/pathways.ts`                | Reads a results export; tiers, ages, formats, clubs; ladders, summaries, pipeline. Pure.  |
| `src/milestones.ts`              | Stages, the bar at each stage, ratings within a stage, outliers, improvers. Pure.         |
| `src/websports.ts`               | Reads a WebSports ball-by-ball export into the match shape. Pure.                         |
| `src/scouting-build.ts`          | Builds a scouting event from scorecards or from a report's players. Pure.                 |
| `src/results-scouting.tsx`       | The Schools page and the pyramid page (one component, optional site lock).                |
| `src/pathways-page.tsx`          | The Pathways page (Milestones · Players · Route to professional · Improvers · Pyramid).   |
| `src/journeys.ts`                | Player journeys: tallies, bracket benchmarks, outliers, climbers, flow, funnel. Pure.     |
| `src/journeys-sample.ts`         | The invented players (seeded, stable) behind the sample views.                            |
| `src/journeys-data.ts`           | Real player records from `scouting-local/journeys*.ts`, or the sample.                    |
| `src/journeys-page.tsx`          | The Players and Route to professional views.                                              |
| `src/journeys-charts.tsx`        | Bracket ladder, participation, boom and bust, innings columns, flow, funnel, route strip. |
| `src/pathways-charts.tsx`        | Pyramid, heat grid, weekly columns, milestone ladder, stage strips, percentile track.     |
| `src/scouting-page.tsx`          | The area switch (Player scouting · Schools · Professional team · Pathways).               |
| `scripts/websports-for-union.ts` | Keeps a union's games from a WebSports export; writes them into `scouting-local/`.        |

Everything with a `.test.ts` / `.dom.test.tsx` beside it is tested on invented data.

---

## The union's own dashboard

`src/scouting-focus.ts`. `FOCUS_BY_TENANT` maps a tenant to its franchise word and its
provincial union(s); today `lions` → franchise "lions", union "Gauteng". With a focus:

- **Player scouting** offers the union's events, plus its club players from each scouting
  report as a report-style event (players and clubs, no matches): for the Lions, the 101
  Gauteng players in the national report. In a mixed event (a festival) the scorecards keep both
  sides but only the union's players are listed.
- **Professional team** shows only the franchise's squads (Lions men, Lions women). Other
  franchises' games still set the format averages. Call-ups and exits use only the union's
  players.
- **Pathways** rates only the union's players; the pyramid's professional apex counts the
  franchise's matches.
- **Schools** is the union's own results export already.

The focus applies to real data only; with the samples nothing is filtered (a fresh clone still
has something to show). `ScoutingEvent` gained two optional fields for this: `union` and
`ourTeams` (codes of the union's sides).

## Pathways → Milestones and Improvers

`src/milestones.ts`. No source has dates of birth, so a **stage is a level of cricket**:

| Stage                   | Source                                    | Note                                                   |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------ |
| An age group (e.g. U13) | Age-group events in `scouting-local/*.ts` | Juniors qualify on half the senior sample.             |
| Senior club             | Club and university matches               | A stage is drawn only with 8+ qualifying players.      |
| Scouted club            | The national report (`pool-*.ts`)         | Its selection: the top of club cricket, not all of it. |
| Professional            | The match library                         | Everyone in those games unless a focus narrows it.     |

Per stage, format and gender: the spread of each measure (10th–90th percentile, middle half,
median) and the **top-10% mark, the benchmark**; every player **rated within their own stage**
(100 = the stage median; √ of the two core indices, shrunk on small samples with the national
report's 30/60/120 and 24/48/96 balls); **outliers** (both core measures 15%+ above the stage);
the **benchmark players** (top 10%); **players seen at two stages**, by percentile within each
(age-group names are never matched to senior names); and **improvers**, franchise players rated
within each season, latest against the one before.

Raw numbers are not compared across stages: the opposition gets harder going up (franchise T20
batters strike more slowly than the report's club batters), so standing within a stage is what
carries to the next.

## Pathways → Players and Route to professional (player journeys)

The results export has teams and no players, so these two views run on a different input: **one
record per player, season by season, across every setting** they appear in (school, club,
representative weeks, the franchise). The rules and numbers are in `src/journeys.ts`.

**Players** (`?view=pathways&pw=players`). From the youngest age bracket (U9) to the franchise:

- the bar at each age bracket: every rated player's batting average (or economy) as a dot, the
  middle half as a box, the median, and the top-10% benchmark; click a dot to follow that player
  up the ladder;
- participation: median balls faced and bowled per player each season, per bracket;
- boom and bust: the share of innings under / over a mark that grows with the age group
  (`BANDS`);
- outliers (top tenth on average _and_ quicker than the middle on strike rate; for bowlers, top
  tenth on economy _and_ quicker than the middle to a wicket) and climbers (30+ percentile points
  higher at the next bracket they were rated in);
- a table of every player at every bracket (balls faced, average, median, strike rate, bust and
  boom share, a percentile rating, the eye) and a detail card for one player: the journey, each
  bracket, and every innings in order.

A rating is always the percentile among players at the **same age bracket, format and gender**
(50 = typical); raw numbers are never compared across brackets. Rated means 5+ innings, 60+ balls
faced and 3+ dismissals (batting), or 8+ overs in 4+ spells with a wicket (bowling); below that a
player is listed, not ranked (`MIN_BAT`, `MIN_BOWL`).

**Route to professional** (`?view=pathways&pw=route`). Where every player is in the system:

- who is playing this season, who was first seen this season, who was last seen earlier, and who
  has a gap season;
- the **watch list** (the eye, shared with Player scouting): for each watched player, the school or
  club they came from, games played in each setting, and a season-by-season strip (age group, and
  school / club / representative / franchise games);
- who comes in and who goes, season by season; the pipeline bracket by bracket, with the biggest
  drop-off marked (the step into the franchise is always narrow, so it isn't flagged);
- school scene against club scene: the share of each bracket's games played in each setting;
- how the franchise players got there (the order they first appeared in school, club and
  franchise cricket, median seasons and games before) and where players started (per school: seen,
  also in club cricket, reached the franchise);
- a table of everyone, filterable by status, school and name.

Only what the data says is shown: "left the data" means no games recorded since before the latest
season, which may mean they stopped or moved to cricket that isn't recorded. **Location is not in
yet.**

**School players in the Schools tab** (`?view=schools`). The same player data, school games only,
so Schools is about players first: the Overview has "School players to watch" (the school
cricketers who stand out at their age bracket, with the eye); Leaderboards opens on a player
leaderboard (school, age group, balls faced, average, median, rating; a school filter; click a
player for their journey and every innings) with the schools' own table behind a switch; a
school's card under Teams lists its players. A school player is rated only against school players
of the same age group. `schoolOnly` and `teamsOf` (`src/journeys.ts`) do the narrowing; the page
pieces are `PlayerPerformance({ scope: 'school' })`, `SchoolPlayersGlance` and `SchoolRoster` in
`src/journeys-page.tsx`. The invented players attend the same invented schools as the sample
results (three primaries to U13, five high schools after).

**The data.** `src/journeys-data.ts` reads `src/scouting-local/journeys*.ts` (git-ignored), each
exporting `JOURNEY_PLAYERS: JourneyPlayer[]`:

```ts
{ id, name, gender: 'men' | 'women',
  rows: [{ season, setting: 'school'|'club'|'rep'|'pro', team, level, bracket: 'U9'…'Pro',
           format, games, bat: [{ r, b, out }], bowl: [{ b, r, w }] }] }
```

with no such file it shows 245 **invented** players (eight schools, six clubs, one franchise,
2016–2026) and says so. The sample is seeded, so the pages and the tests are stable. Turning real
records into this shape (an upload, or a reader for the union's scorecards) is the open piece; see
_Open points_.

## Schools, and Pathways → Pyramid & leagues

`src/results-scouting.tsx`, laid out like Player scouting (Overview · Matches · Leaderboards ·
Performance map · Teams · Shortlist) with sides and institutions where that page has players.
One filter bar over everything (site, gender, tier, age, format, competition, dates, search,
practice games), kept in the URL.

- **Overview**: the pyramid (matches per tier, schools v clubs, the franchise above), a tier ×
  age heat grid, formats by tier, matches per week, a competition table; with a competition
  chosen, its ladder, a batting-v-bowling strength map and how its games are won.
- **Leaderboards**: sides or institutions on win %, net run rate, runs per over, runs conceded,
  average score, close games won; minimum-games control.
- **Performance map**: every side's scoring rate v runs conceded (100 = the selection's average);
  competitions by close finishes v ladder evenness.
- **Teams**: who fields the ladder (club × age rung), juniors v seniors, a card per institution.
- **Shortlist**: institutions followed across the season (per browser, like the watchlist).

## Data

| Source                   | Format                                                               | Reader                         | Lives in                         |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------ | -------------------------------- |
| Union results export     | CSV, one row per match (Site, Competition, Division, teams, scores…) | `parseResults` (`pathways.ts`) | `scouting-local/results/*.csv`   |
| Age-group / club events  | `ScoutingEvent` modules                                              | —                              | `scouting-local/*.ts`            |
| National scouting report | `ScoutPool` module                                                   | `linesFromPool`                | `scouting-local/pool-*.ts`       |
| Franchise scorecards     | Match library (API) or the exports' CSVs                             | `match-import.ts` (PR #4)      | `scouting-local/pro/*.csv`       |
| WebSports ball by ball   | CSV of the Match Centre feed, one row per delivery                   | `parseWebSports`               | `scouting-local/websports/*.csv` |

Rules worth knowing in the results reader: Team 1 is the side batting first; tiers come from
competition and division names (`tierOf`; one line to move a competition); age from "U13A" /
"Under 13"; format from the allotted overs, else the words, else the longer innings, else "not
recorded" (about a quarter of club games); clubs grouped by name with grade, age, side number,
gender and season tokens stripped (`clubName`, a heuristic, and the UI says so); a close finish
is 10 runs or 2 wickets or less.

WebSports: runs off the bat are separated from extras (the feed's `RunsOffBall` includes them);
dismissals and shot areas come from the description (six areas onto six of the wheel's eight
zones); a non-striker run out is recorded against the striker because the feed names only the
striker. `scripts/websports-for-union.ts <websports.csv> <results.csv> <out-dir> <slug> [union]`
keeps a union's games (a side is the union's when its club or school played 10+ league games in
the union's results) and writes the CSV and an event module into `scouting-local/`.

Samples: `src/pathways-sample.ts` (an invented union's results, in the export's own layout),
`src/scouting-sample.ts`, `src/pro-sample.ts`. The real-data flags (`PATHWAYS_IS_SAMPLE`,
`SCOUTING_IS_SAMPLE`, `POOLS_ARE_SAMPLE`, `PRO_IS_SAMPLE`) decide when the focus applies.

## Tests

| File                                | Covers                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `src/pathways.test.ts`              | The results reader, tiers, ages, formats, club naming, ladders, summaries, sample.    |
| `src/milestones.test.ts`            | Lines from scorecards and pools, quantiles, ratings, outliers, benchmarks, improvers. |
| `src/websports.test.ts`             | Ball codes, extras, dismissals, zones, fall of wickets, results, keeping games.       |
| `src/scouting-focus.test.ts`        | The Lions focus; building events from scorecards and from a report.                   |
| `src/results-scouting.dom.test.tsx` | The six views, the filter bar, a ladder, leaderboards, a club card, the shortlist.    |
| `src/pathways-page.dom.test.tsx`    | Milestones, Improvers, the pyramid underneath.                                        |
| `src/journeys.test.ts`              | Tallies, bust/boom, journeys, ratings, outliers, climbers, flow, funnel, routes.      |
| `src/journeys-page.dom.test.tsx`    | The Pathways tabs, Players (ladder, table, detail), Route (watch list, filters).      |
| `src/pro-team-page.dom.test.tsx`    | Includes: the Lions tenant sees only the Lions squads.                                |

## Open points

1. **Uploads.** Results exports, the national report and WebSports files are read from
   `scouting-local/`. An operator upload (like the match library) would replace that, and keep
   real data out of builds.
2. **Player records for the lower stages.** The Players and Route views are built and shown on
   invented players. The results export has no player names, and the only Lions school
   scorecards so far are one festival game. Real records (school, club and representative games
   per player, each with innings and spells) in the shape above, from scorecards in any format the
   platform reads, would replace the sample. Also still to do: players' **location**, and an
   automated, blind provisional-selection view on top of these ratings.
3. **Girls and women** have only the professional stage: no girls' event or women's report yet.
4. **Shortlists and the watchlist are per browser.** They need an API to be shared.
