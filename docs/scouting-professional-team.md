# Scouting → Professional team

**Status:** prototype (October 2026), on `feature/season-dashboards`, not yet reviewed.

The Scouting page has two areas:

- **Player scouting:** competitions, leaderboards, performance maps, teams and the shortlist.
- **Professional team** (`?view=pro`): a franchise's own men's and women's squads, built from
  their match scorecards.

This note covers the professional team and the rebuilt Performance map.

## What the staff see

| Tab       | What it answers                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection | Who to promote, who is at risk, who is moving. A "form v season" map (last five against season, with a diagonal), plus three lanes (Promote · Watch · At risk). Each lane card shows the reasons, a spark of recent innings, and the season and recent indices.                                                                                                                       |
| Squad     | Batters (strike-rate index v runs-per-innings index) and bowlers (economy index v wicket-rate index) as quadrant maps. How each batter used the balls they faced (dots, ran 1–3, fours, sixes). The squad table.                                                                                                                                                                      |
| Form      | Search a player; Batting / Bowling / All-rounder toggle. Cards show every innings or spell against the format average. A deep dive (`?fplayer=`) has: signal and reasons; season v last-5 indices; season by season; every innings and spell (with economy); score bands; position and entry point; ball use and how out; splits by format or season; and against each opponent.      |
| Seasons   | Season on season in one format, each season rated against the same all-seasons average (so a rise is a real rise). It has a season record with changes; trend lines for win rate, run rate, runs per innings, score at the 3rd wicket, dot balls and extras (us v opponents); a "who moved" dumbbell between any two seasons (batting or bowling index); and arrivals and departures. |
| Team      | Results strip, us v opponents, partnerships by wicket, wickets by phase, where the runs come from, how wickets fall, the batting order.                                                                                                                                                                                                                                               |
| Call-ups  | Where the squad needs cover: each at-risk or dipping player with the best-rated scouting options for the role. The squad and the scouting pool shown side by side but **on separate scales**. The pool table with **Track** / **Call up**.                                                                                                                                            |
| Matches   | Results list with the scorecard inline.                                                                                                                                                                                                                                                                                                                                               |

Players watched in Player scouting from senior competitions join the call-up pool, so scouting
and the professional team share one list.

## Data

**Scorecards: the "Scorecard CSV" export, one file per match.**

- Parsed by `src/pro-scorecards.ts` into the scouting match shape, so the scouting derivations
  (dismissals, partnerships, run sources) apply unchanged.
- **Innings are in file order.** The export's "1st/2nd innings" label marks which side batted
  first in the match, not the innings number.
- **Format comes from length.** More than two innings, or more than 50 overs, is Multi-day;
  more than 20 overs is One-Day; anything shorter is T20.
- **Results are worked out from the totals.** A chase cut short with wickets and overs in hand
  is left as "not on the scorecard" (rain or DLS) rather than guessed.
- **Duplicates are dropped**: the same date, teams and totals means the same match.

**Squad detection (`detectSquads`).** For each gender, the squad is the team-name word that
appears on one side of every match. When words tie, the word nearest the end of the name wins,
so "Acme Bank Highveld Hawks" resolves to "hawks", not the sponsor.

**No ball-by-ball.** These files have none, so anything by phase comes only from the fall of
wickets (the over each wicket fell). Medicoach Live ball-by-ball would add per-over runs, shot
zones and phase strike rates. The model already carries `perOver`/`balls` for that.

**Where the data lives**

- **Confidential, git-ignored:**
  - scorecards in `src/scouting-local/pro/*.csv`;
  - scouting pools in `src/scouting-local/pool-*.ts`, each a `ScoutPool` from
    `src/scout-pool.ts`.
- **Sample:** with neither present (CI, deploys, a fresh clone), `src/pro-sample.ts` supplies
  an invented franchise (the "Highveld Hawks") and an invented pool.
- **Loader:** `src/pro-data.ts` chooses between them.
- **A national scouting report** can be turned into a pool file the same way (local only).

## How players are rated (`src/pro-team.ts`)

The ratings follow the national scouting report:

- **The scale.** Every index is 100 = the average of everyone in those matches (both sides), per
  format. With "All formats" selected, each format is rated against its own average, then
  weighted by balls.
- **Small samples are shrunk.** Each rate is blended with the format average as if the player
  had faced 30 / 60 / 120 extra balls (bowled 24 / 48 / 96) in T20 / One-Day / Multi-day.
- **Batting index** = √(runs-per-innings index × strike-rate index).
- **Bowling index** = √(economy index × wicket-rate index).
- **Multi-day weighting.** Runs per innings and wicket rate carry ¾ of the weight, because
  staying in matters more than scoring speed.

**Signals**, on the player's main discipline, comparing the last 5 innings or spells with the
season:

| Signal            | Rule                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Promote / In form | Last 5 ≥ 115 and season ≥ 100. Labelled "Promote" when they've played under 60% of games. |
| At risk           | Last 5 ≤ 80 and season ≤ 92.                                                              |
| Watch             | Dip in form (last 5 ≤ 85), hot streak (last 5 ≥ 120), or too few balls to rate.           |
| Hold              | Everything else.                                                                          |

Each signal lists its reasons in plain words.

**Call-up candidates** carry their **own league's** index. This is not adjusted for league
strength, so the UI never draws the squad and the pool on one axis.

## Performance map (Player scouting)

`PerformanceMap` in `src/scouting-page.tsx` now uses `eventIndices` from `src/scouting.ts`:
the same index method, 100 = that competition's average. It shows three quadrant maps
(batters, bowlers, all-rounders) with:

- named quadrants;
- bubble size for volume (balls faced or bowled);
- a team highlight;
- your watchlist in gold.

## Charts (`src/pro-charts.tsx`)

One small system, after the national report:

- **Colours:** navy = squad, gold = scouted / watchlist, red = at risk, grey = context.
  - Navy `#3B4FA8`, gold `#D08A00` and red `#D04A5B` pass the colour-blind and lightness checks
    as a set (all pairs).
  - Gold is below 3:1 on white, so gold marks always have a direct label or a table.
- **Mark specs:**
  - bars at most 24px thick, with a 4px rounded data end;
  - lines 2px;
  - dots at least 8px, with a 2px white ring;
  - solid hairline gridlines;
  - text never takes a series colour.
- **Tooltips and legends:** every chart has a tooltip; there is a legend whenever there are two
  or more series.

## Tracking

Track and Call up are stored per browser (`localStorage` `smartclub.pro.tracking.v1`), like the
scouting watchlist. **Next step:** persist them through the API, so a franchise's staff share
one list.

## Tests

| File                             | What it covers                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/pro-scorecards.test.ts`     | Parser: every dismissal format, innings order, results, duplicates.                                     |
| `src/pro-team.test.ts`           | Squad detection, ratings and shrinkage, signal rules, phases, team summaries.                           |
| `src/pro-team-page.dom.test.tsx` | The page on the sample: views, women's squad, track → call up → shortlist, separate scales, scorecards. |
| `src/scouting.test.ts`           | Competition indices for the Performance map.                                                            |

## Open points

1. Tracking and call-ups are per browser; they need an API and data model to be shared.
2. A "women's" scouting pool doesn't exist yet. The Call-ups tab says so.
3. Ball-by-ball for professional matches (Medicoach Live) would replace the phase approximation
   from the fall of wickets.
4. Results the scorecard can't settle (rain, DLS) are shown as "–" until a result field is
   added to the export.
