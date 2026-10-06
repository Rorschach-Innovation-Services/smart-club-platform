# Scouting: Schools, Pathways and the Lions dashboard

**Status:** prototype, October 2026. Frontend only: no API, schema or infra changes. Ships with
invented sample data; real data is git-ignored (see _Data_).

## Read this first (two minutes)

**What it adds.** The Scouting page gains two areas and one behaviour:

| Area                   | URL              | What it is                                                                                                                                            |
| ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schools**            | `?view=schools`  | School cricket from the union's results export, laid out like Player scouting (ladders, leaderboards, maps, teams, shortlist).                        |
| **Pathways**           | `?view=pathways` | Developmental milestones: the bar at each stage from age-group cricket to the franchise, benchmark players, outliers, improvers; the pyramid beneath. |
| **A union's own view** | any              | For the `lions` tenant, every Scouting area shows the Lions only. Other tenants see everything.                                                       |

**To run it.** `npm run dev:local:demo`, sign in as admin, open Scouting. With no real data it
shows the invented "Highveld" sample and says so. To see the Lions view, sign in to the `lions`
tenant (`?tenant=lions` on a bare host).

**To check it.** `npm run typecheck && npx vitest run` (1,733 tests). Nothing in `packages/api`
changed. `eslint`: 0 errors, the same 103 pre-existing warnings as `main`.

**What needs a decision from you.** Nothing to deploy differently. Two things to know:

1. Real data (scorecards, results, the national report) is read from `src/scouting-local/`,
   which is git-ignored. A production build made on a machine that has that folder bundles the
   data into the JS. The match library (API, PR #4) is the right home for scorecards; results
   exports and the report still need an upload path. See _Open points_.
2. To give another union its own view, add one line to `FOCUS_BY_TENANT` in
   `src/scouting-focus.ts`.

**Files, in reading order.**

| File                             | Role                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/scouting-focus.ts`          | The union filter (`FOCUS_BY_TENANT`, `focusEvents`, `focusPools`, `isOurFranchise`).     |
| `src/pathways.ts`                | Reads a results export; tiers, ages, formats, clubs; ladders, summaries, pipeline. Pure. |
| `src/milestones.ts`              | Stages, the bar at each stage, ratings within a stage, outliers, improvers. Pure.        |
| `src/websports.ts`               | Reads a WebSports ball-by-ball export into the match shape. Pure.                        |
| `src/scouting-build.ts`          | Builds a scouting event from scorecards or from a report's players. Pure.                |
| `src/results-scouting.tsx`       | The Schools page and the pyramid page (one component, optional site lock).               |
| `src/pathways-page.tsx`          | The Pathways page (Milestones · Improvers · Pyramid & leagues).                          |
| `src/pathways-charts.tsx`        | Pyramid, heat grid, weekly columns, milestone ladder, stage strips, percentile track.    |
| `src/scouting-page.tsx`          | The area switch (Player scouting · Schools · Professional team · Pathways).              |
| `scripts/websports-for-union.ts` | Keeps a union's games from a WebSports export; writes them into `scouting-local/`.       |

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
| `src/pro-team-page.dom.test.tsx`    | Includes: the Lions tenant sees only the Lions squads.                                |

## Open points

1. **Uploads.** Results exports, the national report and WebSports files are read from
   `scouting-local/`. An operator upload (like the match library) would replace that, and keep
   real data out of builds.
2. **Player-level pathways from schools.** The results export has no player names, and the only
   Lions school scorecards so far are one festival game. School scorecards in any format the
   platform reads (scorecard CSV, ball by ball, WebSports) would fill the lower stages.
3. **Girls and women** have only the professional stage: no girls' event or women's report yet.
4. **Shortlists and the watchlist are per browser.** They need an API to be shared.
