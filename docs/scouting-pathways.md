# Scouting → Pathways

**Status:** prototype (October 2026), on `feature/pathways` (built on `feature/season-dashboards`).

The third area of the Scouting page (`?view=pathways`): a union's amateur and school cricket as
one pyramid, from its results export, with the professional franchise above it. No player names
are in this data — the pathway story is about competitions, clubs and schools: where the pyramid
is dense or thin, which competitions are competitive enough for a result to mean something,
which institutions field sides all the way up the ladder, and how strong each side is.

## What the staff see

One filter bar over everything (site, gender, tier, age, format, competition, dates, team or
club search, practice games on or off), kept in the URL so a view can be shared. Then five views:

| View         | What it answers                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pyramid      | Matches at every tier, bottom to top, schools v clubs, with the franchise's match-library count above (tap a tier to focus the page on it). A tier × age heat grid shows where the pathway thins out; a tier × format grid shows where T20, 50-over and time cricket are played; the share of girls' and women's cricket per tier.                                                                                 |
| Competitions | "Where results are earned": every competition as a dot — close finishes against how even the ladder is — the top-right being where a result says the most about a side. Close-finish and abandonment rankings. Then one competition in depth: ladder (win %, net run rate, average, last five, biggest win), a batting-v-bowling strength map of its sides against the competition average, and how games are won. |
| Feeders      | Who fields the ladder: a club/school × age-rung grid (number = sides, shade = games). Juniors v seniors: junior win % (to U13) against senior win % (U14 up) per institution — strong juniors with weak seniors is where talent leaks. Tap a row or dot for the institution: win rate by rung, the season's results, net run rate, every side.                                                                     |
| Calendar     | Matches per week — schools, clubs and representative cricket stacked — so overlaps are visible; tiers by month; grounds by matches hosted (gold where representative cricket is played).                                                                                                                                                                                                                           |
| Results      | The filtered results, newest first, with each match's tier, age and format.                                                                                                                                                                                                                                                                                                                                        |

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

`Pyramid` (stacked tier bars, hollow apex), `HeatGrid`, `WeekColumns`, `Figure`; the rest reuse
`pro-charts` (`QuadrantMap` with `shortLabels={false}`, `RankBars`, `Tile`). Navy = schools,
sky = clubs, gold = representative, grey = context.

## Tests

| File                             | What it covers                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/pathways.test.ts`           | Reading every score, overs and result wording; tiers, ages, genders, formats; club naming; ladders; summaries; sample. |
| `src/pathways-page.dom.test.tsx` | The five views on the sample; the filter bar narrowing them; a competition's ladder; a club card; results search.      |

## Open points

1. The export has no player names, so the pathway is institutional. Player-level pathways need
   scorecards from these competitions (the scouting match format) or the register.
2. A results upload for the operator (like the match library) would replace the local files.
3. Where overs aren't recorded (a quarter of club games) there is no run rate; the ladder still
   has win %.
