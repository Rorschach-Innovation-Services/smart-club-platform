# Scouting → Professional team

**Status:** prototype (October 2026), on `feature/season-dashboards`, not yet reviewed.

The Scouting page has two areas:

- **Player scouting:** competitions, leaderboards, performance maps, teams and the shortlist.
- **Professional team** (`?view=pro`): a franchise's own men's and women's squads, built from
  their match scorecards and ball by ball, from the platform's match library.

This note covers the professional team, the match library and the rebuilt Performance map.

## What the staff see

| Tab       | What it answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection | Who to promote, who is at risk, who is moving. A ranked "season → last 5" line per player (coloured by signal, every player named), plus three lanes (Promote · Watch · At risk) with the reasons for each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Squad     | Batters (strike-rate index v runs-per-innings index) and bowlers (economy index v wicket-rate index) as quadrant maps. How each batter used the balls they faced (dots, ran 1–3, fours, sixes). The squad table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Form      | Search a player; Batting / Bowling / All-rounder toggle. Cards show every innings or spell against the format average. A deep dive (`?fplayer=`) has: signal and reasons; season v last-5 indices; season by season; every innings and spell (with economy); score bands; position and entry point; ball use and how out; splits by format or season; and against each opponent.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Seasons   | Season on season in one format, each season rated against the same all-seasons average (so a rise is a real rise). It has a season record with changes; trend lines for win rate, run rate, runs per innings, score at the 3rd wicket, dot balls and extras (us v opponents); a "who moved" dumbbell between any two seasons (batting or bowling index); and arrivals and departures.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Team      | Results strip, us v opponents, partnerships by wicket, wickets by phase, scoring by phase (run rate, dot balls, boundary balls — from the ball by ball), where the runs come from, how wickets fall, the batting order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Call-ups  | Cover for each at-risk or dipping player. It names the player's weakest measure (percentile among the squad) and ranks scouted options on the same measures (percentile among the pool), the weakest measure counting double — the "fit" (`src/pro-callups.ts`). Maps of the pool's batters and bowlers; squad and pool shown side by side but on separate scales; the pool table with Track / Call up.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Matches   | Results list; each match opens in depth (`?pmatch=`, `src/pro-match.tsx`): header and result, us-v-them tiles, the worm (the score after every over with the ball by ball; at every wicket from the scorecard alone), runs in each over (limited overs, ball by ball), standouts, side by side, and per innings how each batter used the balls faced, partnerships, bowlers' economy against the format average and the scorecard.                                                                                                                                                                                                                                                                                                                                                                               |
| Exits     | Who has stopped playing for the squad and where they are now (`src/pro-exits.ts`, `src/pro-exits-view.tsx`). Status counts squad games missed in the formats the player plays (a T20 specialist isn't "gone" because the four-day season started first): in the squad = missed 3 or fewer, dropped out = more, gone = more and nothing for a year before the newest game in the files. "Where now" searches for the same name in other franchises' scorecards after they left, the scouting pools, senior scouting competitions, and the Smart Club register and clearances (exact name match, accents and case ignored; every sighting shows its source). There's also a squad-flow chart (kept / new / left per season, with the newest season flagged while under way) and a careers grid (games per season). |

Players watched in Player scouting from senior competitions join the call-up pool, so scouting
and the professional team share one list.

## Match library (platform operator)

One library of professional matches for the whole platform; every union's scouting reads it.

- **Upload:** Platform → Match library (`/platform/matches`, `src/platform-match-library.tsx`).
  The operator drops any number of files, in any order. They are read in the browser
  (`src/match-import.ts`) and each file is shown with what it will do before anything is
  saved:
  - **New match**;
  - **Adds ball by ball** / **Adds scorecard** to a game already there (the two are merged:
    the scorecard's cards, the ball by ball's deliveries, per-over runs and competition);
  - **Duplicate · skipped** (the same game is already there, or twice in one drop);
  - **Doesn't add up · skipped** (a ball by ball far from its scorecard; a scorecard whose
    totals differ from the library's copy — remove that first to replace it);
  - **Not a match file** / **Couldn't read**.
    Totals that differ by a few runs between the two exports are saved with a warning.
- **Accepted files** (detected from the content, not the name): the "Scorecard CSV"; the
  "Ball by Ball" CSV (match_id, competition, date, innings_no, over_ball, outcome …); a
  standard match file (.json).
- **The same game** = same date, gender and teams, and a first-innings total within 6 runs
  (two scorecards) or within the larger of 6 runs or 8% (a ball by ball can be an over
  short). A second game the same day gets its own key.
- **Standard match** (`LibraryMatch`): the scouting match shape plus `key`
  (`date_teams_gender[_n]`), `v`, `competition`, `externalId`, `sources`, `hasBalls`.
- **API** (`packages/api/src/index.ts`, `repo.ts`): stored platform-wide at
  `TENANT#*#PROMATCH` / `PROMATCH#<key>`, one item per match (380 KB cap).
  - `GET /admin/pro/matches?cursor=` — union admins, 15 per page with ball by ball.
  - `GET /platform/pro/matches[?summary=1]`, `POST /platform/pro/matches` (≤ 25 per call),
    `DELETE /platform/pro/matches/:key` — operator only.
- **The page** loads the library once (`src/pro-library.ts`, `useProMatches`) and falls back
  to the local files, then the sample, when the library is empty. The page header says which.

**Ball by ball** (the "Ball by Ball" export):

- Outcome codes: `●` dot, `N` runs, `Nwd`, `Nlb`, `Nb`, `nb`, `nb+N`, `W`, `NW`, `N?`, `wd+W`.
- How out comes from the commentary ("OUT! Caught, …", Bowled, Leg Before, Stumped, Run Out,
  Hit Wicket). Retired hurt is "retired not out"; a "W" with no dismissal written is a
  retirement, not a wicket.
- **Run-outs at the non-striker's end:** the export sometimes logs these against the striker.
  If the "dismissed" batter faces again, the run-out moves to their partner.
- Format comes from the competition name (Pro20/T20 → T20, Pro50/One-Day → One-Day,
  4-Day/First Class → Multi-day), else from the length.

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

**Squad detection (`detectSquads`).** For each gender, every team on one side of at least 40%
of the matches is a squad (the library can hold several franchises' exports; opponents who
turn up now and then are not squads). Teams are grouped with sponsor and gender words
stripped, so "Momentum Multiply Titans" and "Fidelity Titans Ladies" are the Titans men and
women. The squad switch lists them all; `?squad=lions-men` picks one.

**Phases.** Matches with ball by ball give run rate, dot and boundary balls by phase, the
worm after every over and the runs in each over. Matches with only a scorecard give phases
from the fall of wickets alone (the over each wicket fell).

**Where the data lives**

- **Confidential, git-ignored:**
  - scorecards and ball by ball in `src/scouting-local/pro/*.csv` (read and paired exactly
    as an upload would be);
  - scouting pools in `src/scouting-local/pool-*.ts`, each a `ScoutPool` from
    `src/scout-pool.ts`.
- **Sample:** with neither present (CI, deploys, a fresh clone), `src/pro-sample.ts` supplies
  an invented franchise (the "Highveld Hawks") and an invented pool.
- **Loader:** `src/pro-data.ts` chooses between them; `src/pro-library.ts` prefers the match
  library over both.
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

Charts measure their container (`useWidth`) and draw at that width, so text and marks stay the same size on a phone and a wide monitor.

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

| File                                        | What it covers                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/pro-scorecards.test.ts`                | Parser: every dismissal format, innings order, results, duplicates.                                     |
| `src/match-import.test.ts`                  | Ball-by-ball outcomes and dismissals, run-out reassignment, pairing, duplicates, conflicts, phases.     |
| `src/platform-match-library.dom.test.tsx`   | The upload page: the plan before saving, conflicts, batches of 25, remove after confirming.             |
| `packages/api/test/pro-matches.int.test.ts` | Library API: operator-only writes, admin reads with paging, validation and size cap.                    |
| `src/pro-team.test.ts`                      | Squad detection, ratings and shrinkage, signal rules, phases, team summaries.                           |
| `src/pro-team-page.dom.test.tsx`            | The page on the sample: views, women's squad, track → call up → shortlist, separate scales, scorecards. |
| `src/scouting.test.ts`                      | Competition indices for the Performance map.                                                            |

## Open points

1. Tracking and call-ups are per browser; they need an API and data model to be shared.
2. A "women's" scouting pool doesn't exist yet. The Call-ups tab says so.
3. The upload page loads the whole library to check for duplicates (about 3 MB for 90 matches
   with ball by ball). A summary with the innings totals would do once the library is large.
4. One ball-by-ball file (a men's game in October 2024) doesn't add up to its scorecard and is
   left unattached; the export needs checking at the source.
5. Results the scorecard can't settle (rain, DLS) are shown as "–" until a result field is
   added to the export.
