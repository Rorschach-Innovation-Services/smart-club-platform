# Scouting → Schools and Pathways

**Status:** prototype (October 2026), on `feature/pathways` (built on `feature/season-dashboards`).

The Scouting page has four areas: Player scouting · **Schools** · Professional team ·
**Pathways**.

- **Schools** (`?view=schools`): school cricket from the union's results export, laid out like
  Player scouting (`src/results-scouting.tsx` with `site="school"`).
- **Pathways** (`?view=pathways`): developmental milestones from age-group cricket to the
  franchises (`src/pathways-page.tsx`, `src/milestones.ts`), and underneath, the whole school
  and club pyramid (the same results-scouting page, schools and clubs together).

## Pathways → Milestones and Improvers

There are **no dates of birth** in any source, so a _stage_ is a level of cricket, not an age:

| Stage                                 | Source                                                    | Notes                                                      |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| U13 (and any age group with an event) | Age-group events (`src/scouting-local/*.ts`)              | Juniors qualify on half the senior sample (short innings). |
| Senior club                           | Club and university matches                               | Drawn only with 8+ qualifying players.                     |
| Scouted club                          | The national scouting report (`pool-*.ts`)                | Its _selection_ — the top of club cricket, not all of it.  |
| Professional                          | The match library (franchise scorecards and ball by ball) | Everyone in those games, opponents included.               |

Per stage, format (T20, One-Day, Multi-day) and gender:

- **The bar at each stage** — strike rate, runs per innings, boundary balls %, economy, wickets
  per 10 overs: 10th–90th percentile, middle half, median and the **top-10% mark (the
  benchmark)**. "Place a player" marks a searched player on their stage's row.
- **Outliers at every stage** — every player rated against their own stage (100 = the stage
  median; rating = √ of the two core indices, shrunk on a small sample with the national
  report's 30/60/120 and 24/48/96 balls). Gold = both core measures 15%+ above the stage.
- **The benchmark players** — the top 10% of each stage (at least three).
- **Where the players who went up stood below** — players found at two stages (same name),
  by percentile within each stage. Age-group names are never matched to senior ones (a shared
  name is almost always a different person; on the real files one U13 shares a franchise
  player's name). In the real files four bowlers went from the scouted club group to a
  franchise; below the step they sat at the 66th–76th percentile.
- **Improvers** — franchise players rated within each season, latest season against the one
  before: a season-on-season map (above the diagonal = improved; gold up 15+, red down 15+),
  the biggest improvers and drops, and a player's measures season against season. Only the
  squads with whole seasons in the files (Titans, Lions); opponents appear only in their games
  against them.

**Raw numbers are not compared across stages.** The opposition gets harder going up — franchise
T20 batters strike more slowly than the report's club batters — so standing within a stage is
what carries to the next one.

## Schools, and Pathways → Pyramid & leagues

Laid out like Player scouting — Overview · Matches · Leaderboards · Performance map · Teams ·
Shortlist — with sides and institutions where that page has players. One filter bar over
everything (site, gender, tier, age, format, competition, dates, team or club search, practice
games on or off), kept in the URL so a view can be shared.

| View            | What it answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview        | The pyramid: matches at every tier, schools v clubs, the franchise's match-library count above (tap a tier to focus the page). A tier × age heat grid for where the pathway thins; formats by tier; matches per week (schools, clubs, representative); a competition-by-competition table (close finishes, abandonments, batting-first wins, average first innings). With a competition chosen: its ladder (win %, net run rate, last five, biggest win), a batting-v-bowling strength map of its sides, and how its games are won. |
| Matches         | The filtered results, newest first, each with tier, age and format.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Leaderboards    | Sides or institutions ranked on win %, net run rate, runs per over, runs conceded per over, average score or close games won, with a minimum-games control. Tap a bar for the institution.                                                                                                                                                                                                                                                                                                                                          |
| Performance map | Every side with 3+ games and overs recorded: scoring rate against runs conceded, both indexed to the selection's average (100). "Where results are earned": competitions by close finishes against how even the ladder is. Close-finish and abandonment rankings.                                                                                                                                                                                                                                                                   |
| Teams           | Who fields the ladder (club/school × age-rung grid), juniors v seniors win rates, and a card per institution: win rate by rung, the season so far, net run rate, every side.                                                                                                                                                                                                                                                                                                                                                        |
| Shortlist       | Clubs and schools shortlisted from a ladder, a leaderboard or a card (per browser, like the scouting watchlist): followed across the whole season whatever the filters, gold on every map. Plus the grounds hosting the most cricket.                                                                                                                                                                                                                                                                                               |

## Data

**The results export** — one row per match: Site, Competition, Division, Match Type, Date, both
teams with score and overs, Result, Venue, Status, Match ID. Read by `src/pathways.ts`
(`parseResults`), which also places every match on the pyramid.

- **Team 1 is the side batting first** (every "won by wickets" result in the real file goes to
  Team 2). Batting-first win rates rely on this.
- **Scores** "181/5"; time cricket "196/10 & 105/10". **Overs** "12.2/20" (faced / allotted), or
  just "59" when the allotment wasn't recorded.
- **Results** read: won by N runs / wickets (with D/L), by an innings, tie, draw, abandoned, no
  result, forfeits ("Forfeited. Winner: …" and "Winner: …"), games in progress. Anything else
  is `unknown` and counts for nothing.
- **Tier** comes from the competition and division names (`tierOf`): trials, provincial, SA20
  schools, regional/area weeks and district events are _representative_; school competitions are
  _primary_ or _high school_ by their age groups; club competitions are _juniors & youth_,
  _Saturday & Sunday leagues_ (incl. women's promotion and development leagues), _Presidents_
  or _Premier_. A misplaced competition is a one-line change to those rules.
- **Age** from "U13A", "Under 13", "U15s"; senior sides and school 1st XIs are _Open_.
  **Gender** from women/ladies/girls in the names. **Format** from the allotted overs, else the
  words (T20, 35 over, Time, 100's), else the longer innings when that settles it (over 36 overs
  → 40–50; 21–36 → 25–35; a full 20 or 10 → T20 / T10); otherwise _not recorded_ — about a
  quarter of the real file.
- **Clubs and schools** are grouped by name with grade, age, side number, gender and season
  tokens stripped (`clubName`): "GM Old Summit U13 Prem 2025" → "GM Old Summit",
  "St Judes 3rd XI 2025" → "St Judes". Heuristic; the club card says so. A **side** keeps its
  grade but drops the season, so one side is one ladder row.
- **Close finish** = decided by 10 runs or 2 wickets or less, or a tie. **Dominance** = top
  side's win % minus the median side's, among sides with 3+ games. **Net run rate** only where
  both sides' overs were recorded.

**Where it lives.** Real exports in `src/scouting-local/results/*.csv` (git-ignored); with none
present the invented "Highveld" sample (`src/pathways-sample.ts`, written in the export's own
layout so the same reader runs) is used and the filter bar says so. `src/pathways-data.ts`
chooses.

## Charts (`src/pathways-charts.tsx`)

`Pyramid` (stacked tier bars, hollow apex), `HeatGrid`, `WeekColumns`, `Figure`, and for the milestones `MilestoneLadder` (the spread and top-10% mark per stage), `StageStrips` (every player rated within their stage) and `PercentileTrack` (standing stage by stage); the rest reuse
`pro-charts` (`QuadrantMap` with `shortLabels={false}`, `RankBars`, `Tile`). Navy = schools,
sky = clubs, gold = representative, grey = context.

## Tests

| File                                | What it covers                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pathways.test.ts`              | Reading every score, overs and result wording; tiers, ages, genders, formats; club naming; ladders; summaries; sample.                        |
| `src/results-scouting.dom.test.tsx` | The six views on the sample; the filter bar; a competition's ladder; leaderboards; a club card; the shortlist; Schools locked to schools.     |
| `src/milestones.test.ts`            | Reading scorecards and pools into lines; quantiles; junior samples; ratings, outliers, benchmarks; improvers; matching players across stages. |
| `src/pathways-page.dom.test.tsx`    | Milestones (stages, measures, formats, placing a player, girls and women), Improvers, the pyramid underneath.                                 |

## Open points

1. The export has no player names, so the pathway is institutional. Player-level pathways need
   scorecards from these competitions (the scouting match format) or the register.
2. A results upload for the operator (like the match library) would replace the local files.
3. Where overs aren't recorded (a quarter of club games) there is no run rate; the ladder still
   has win %.
