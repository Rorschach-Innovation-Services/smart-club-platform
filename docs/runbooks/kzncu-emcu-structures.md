# Runbook — building the KZNCU/EMCU leagues from the requirements document

Operator cheat-sheet for turning the union's structure-requirements document into real
structures in the platform's season/structure wizard. Every capability listed below —
multi-stage structures, seeded/manual splits, group labels, all four cadence kinds,
activate-from dates, and per-stage time slots — already ships (see
[configurable-league-structures.md](./configurable-league-structures.md)). Nothing here is
new capability; it is the mapping from the requirements document's checklist items to the
existing starter templates and controls.

Build calendars and venues first (see
[`configurable-league-structures.md`](./configurable-league-structures.md), step 4, items
1–2), then work down this list league by league: build the structure in **Competition
structures** (set its **Overs**; empty = 50), then **Set up** the league from its row in the
**League catalogue** (structure + calendar). One setup per league, so each format is its own
league: Premier Men 50-Over and Premier Men T20 are two catalogue entries, each set up on its
own structure. See the
[setup model](./configurable-league-structures.md#the-setup-model-since-27-sep-2026-read-this-first).

## Template quick-reference

| Template id         | Name (in the template gallery)          | Shape                                                                                      |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `split-league-swap` | Split league with mid-season swap       | Two groups double (or single) round, a mid-season swap carrying points, then a final round |
| `pools-to-knockout` | Seeded pools → cross-pool semis → final | Seeded pools round robin, then top finishers cross into a knockout                         |
| `stream-and-cup`    | Stream + knockout cup                   | Two streams round robin; the lower stream then plays a straight knockout cup               |
| `flat-round-robin`  | Flat round robin                        | One stage, everyone plays everyone once                                                    |

## League-by-league checklist

| League                              | Template            | What to edit                                                                                                                                                                                                                                                                                                               | Block                                                                                                       |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| KZNCU Premier Men 50-Over           | `split-league-swap` | Group labels → "Top Six" / "Bottom Six" on both stages. Leave the round format as is — the template's opening stage already defaults to a double round robin and its final round already defaults to a single round robin, matching the doc for this league; confirm cadence stays Weekly.                                 | Block 1 → carries into Block 2 (template auto-places stage 2 in the second block when the calendar has one) |
| KZNCU Premier Men T20               | `pools-to-knockout` | Seeded-split, count = 2 groups (12 entrants → 6 each), seeded from the prior season's log/standings. Time slots default to Morning (08:00) / Afternoon (13:30) already — no change needed.                                                                                                                                 | Block 1                                                                                                     |
| KZNCU Promotion 50-Over / Kingsmead | `stream-and-cup`    | Group labels → "Top 10" / "Bottom 10" on the streams stage. Kingsmead Cup stage needs no manual entrant-count edit — the 9-team preliminary auto-derives from entrant count (`knockoutShape`, `packages/engine/src/formats.ts`): 9 qualifiers trims to an 8-side main draw via one preliminary among the two lowest seeds. | Block 1                                                                                                     |
| KZNCU Promotion T20                 | `pools-to-knockout` | Seeded-split, count = 4 groups (20 entrants → 5 each). Time slots default to T20 morning/afternoon — no change needed.                                                                                                                                                                                                     | Block 1                                                                                                     |
| KZNCU Premier Women 30-Over         | `split-league-swap` | Group labels → "Top Four" / "Bottom Four". **Change the final-round stage's format from single to double round robin** — this league runs a double round in both halves, unlike the Premier Men template default.                                                                                                          | Block 1 → Block 2                                                                                           |
| KZNCU Premier Women T20             | `pools-to-knockout` | Seeded-split, count = 2 groups (8 entrants → 4 each). Time slots default correctly.                                                                                                                                                                                                                                        | Block 1                                                                                                     |
| KZNCU Promotion Women               | `flat-round-robin`  | No changes — weekly cadence is the template default.                                                                                                                                                                                                                                                                       | Block 1                                                                                                     |
| EMCU Division 1                     | `flat-round-robin`  | No changes — weekly cadence default.                                                                                                                                                                                                                                                                                       | Block 1                                                                                                     |
| EMCU Division 2                     | `flat-round-robin`  | No changes — weekly cadence default.                                                                                                                                                                                                                                                                                       | Block 1                                                                                                     |
| EMCU Division 3 Stream 1            | `flat-round-robin`  | No changes — weekly cadence default.                                                                                                                                                                                                                                                                                       | Block 1                                                                                                     |
| EMCU Division 3 Stream 2            | `flat-round-robin`  | Cadence → "Every N weeks", N = 2. Rounds step from the block's first day, so start the calendar block on a Saturday for the stride to land on Saturdays.                                                                                                                                                                   | Block 1                                                                                                     |
| EMCU Division 4                     | `flat-round-robin`  | Same as Division 3 Stream 2 — cadence "Every N weeks", N = 2, block starting on a Saturday.                                                                                                                                                                                                                                | Block 1                                                                                                     |
| EMCU Division 5                     | `flat-round-robin`  | Cadence → "Set days only", tick Saturday only.                                                                                                                                                                                                                                                                             | Block 1                                                                                                     |
| Juniors U11                         | `flat-round-robin`  | On the stage's **Schedule** section, set **Activate from** to the third week of January.                                                                                                                                                                                                                                   | Block 2                                                                                                     |
| Juniors U13                         | `flat-round-robin`  | On the stage's **Schedule** section, set **Activate from** to the third week of January.                                                                                                                                                                                                                                   | Block 2                                                                                                     |

## Notes on specific controls

- **Group counts, not sizes.** The seeded-split and manual-split entrant controls take a
  group _count_ under "Even groups" (the roster splits evenly across that many groups) — so
  "2 groups of 6" means setting count = 2 against a 12-side entrant list, not typing "6"
  anywhere. Use "Exact sizes" only for an uneven split (e.g. `5, 5, 5, 4`), which none of the
  leagues above need.
- **T20 time slots ship as the template default.** `pools-to-knockout`'s two stages carry
  the built-in Morning 08:00 / Afternoon 13:30 slots (`packages/engine/src/templates.ts`) for
  every T20 league (Premier Men, Promotion Men, Premier Women). There is no tenant-wide
  slot setting any more; edit a stage's slots only if a league deviates from the union's
  stated times.
- **Kingsmead's preliminary round is automatic.** `knockoutShape` (`packages/engine/src/formats.ts`)
  computes the preliminary/main-draw split from entrant count alone — 9 entrants always
  produces one preliminary among the two lowest seeds and an 8-side main draw. There is no
  "preliminary round" toggle to set by hand.
- **"Every 2 weeks" is the `every-n-weeks` cadence with n=2** — pick **Every N weeks** and set
  the number of weeks to 2 (any whole number from 1 to 12 is accepted).
- **Bi-weekly cadences anchor on the block start.** A stage's rounds step from the first
  day of its block, so an every-2-weeks league lands on Saturdays only if the block starts
  on one. There is no separate first-round field on a structure stage.
- **Activate from is a per-stage field** in the structure editor's Schedule section (used
  here for the Juniors divisions): fixtures are generated up front and stay hidden from
  clubs until that date.
- **Starting the season** is the admin's job once the league is set up: **Fixtures → Start
  a season** lists only set-up leagues → season label → start. The old "Start flat season"
  form, with its Match format and Scheduling options fields, no longer exists.

## Double-headers, non-adjacent cross-pool derivation, and multi-leg finals

The KZNCU spreadsheet asks for three things the structures above don't cover yet:
double-header playing days, a knockout that draws from a pool stage two stages back
instead of the one immediately before it, and a return leg played the same day as the
original. All three shipped on `feat/kzncu-full-expressibility` (`packages/engine/src/calendar.ts`,
`structure.ts`, `fixtures.ts`, `platform-structures.tsx`). This section is the
sheet-by-sheet mapping, in the same style as the table above.

| Sheet                   | Status                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Premier Men             | ✓ Already supported — see the table above, no changes from this branch.                                                                                                                                                                                                                                              |
| Promotion Men           | Kingsmead 3-stage concurrent shape — new, see below.                                                                                                                                                                                                                                                                 |
| Premier Women           | Final stage plays 2 legs, mirrored (the existing default) — see below.                                                                                                                                                                                                                                               |
| Promotion Women 20-Over | AM + PM double-headers, interleaved leg order — new, see below.                                                                                                                                                                                                                                                      |
| Veterans                | Same patterns as the sheets above — no shape this sheet needs that isn't already covered by an existing template or the controls below. Follow whichever of Premier Men / Premier Women / Promotion Men fits its actual format once the union's Veterans fixture list is in hand; nothing here is Veterans-specific. |

### Promotion Men — the Kingsmead 3-stage concurrent shape

The `stream-and-cup` template (row 31 above) covers a straight streams-then-cup pipeline
adjacent stage to adjacent stage. Kingsmead is the harder case the union's document
actually describes: **Pools → an unrelated intermediate stage → the Kingsmead Cup**,
where the Cup's entrants are drawn from Pools, not from the stage immediately before it.
`crossPoolSourceStage` (`packages/engine/src/structure.ts`) resolves this by reading
`entrants.derivedFrom.fromStage` directly, so a stage can name any earlier stage in the
structure, not just its neighbour.

To author it in the Structures editor:

1. Build three stages in order: **Pools** (seeded-split, the union's pool sizes),
   **Streams** (whatever intermediate stage sits between them in the union's document —
   it plays no part in the Cup's derivation), then **Kingsmead Cup** (knockout,
   pairing = cross-pool).
2. Open the Cup stage's **Teams** section and turn on **Teams come from an earlier
   stage**. The **Draws from** picker lists every EARLIER stage in the structure, not
   just the one directly before it — pick **Pools**, even though Streams sits between
   them in the list.
3. Write the rule sentence the admin will read at confirm time (e.g. "Top two from each
   pool") in the **detail** box. This is prose only — nothing here executes the rule; it
   documents it for the human confirming the pool stage.
4. Save. The preview rail and `describeStage` don't change based on which stage is
   named — the Cup stage still reads as a cross-pool knockout either way.

What the admin sees at season time: because a later stage (the Cup) draws a cross-pool
bracket from Pools, `feedsPoolKnockout` marks Pools as `ranked` — **Pools' own confirm
step**, not Streams' and not the Cup's, gets the **Position** column asking for each
side's finishing position within its pool. That position is what the Cup's bracket reads
(pool winner against another pool's runner-up) once the admin confirms the Cup stage
itself. If the Cup stage were instead left with no `derivedFrom.fromStage` set at all,
`crossPoolSourceStage` falls back to the stage immediately before it (Streams) — the
pre-existing adjacent behaviour, kept for structures saved before this field existed. Set
`fromStage` explicitly for Kingsmead; don't rely on the fallback.

### Premier Women — a two-leg final stage

Premier Women's final round (row 33 above, `split-league-swap` with the format bumped to
a double round robin) plays each pairing twice — that's `format.legs: 2` on the
`round-robin` format. Leg order defaults to **mirrored**: the whole first leg plays out,
then the whole thing repeats with home and away swapped, matching what both unions have
always done. There is nothing to change here from this branch — mirrored is the default
and needs no `legOrder` key at all (`roundRobinRounds` in `packages/engine/src/formats.ts`
treats an absent `legOrder` as mirrored). The **Leg order** control only appears once a
stage's format plays 2 or more legs, so it won't show at all on a single-leg stage.

### Promotion Women 20-Over — AM + PM double-headers

This is the sheet that needs the new **Time slots** third option and the **Leg order**
control together. Authoring it end to end:

1. On the stage's **Schedule** section, set **Time slots** to **AM + PM
   double-headers** (the third option, after "No set times" and "Morning & afternoon
   starts"). This writes both `slots` (defaulting to the T20 pair, 08:00 / 13:30 — edit
   the labels or times if the union's sheet states different starts) and
   `roundsPerDay: 2` onto the stage's schedule. The calendar engine responds by planning
   half as many playing DAYS and running two full rounds on each one.
2. If the format plays 2 legs, a **Leg order** control appears under Format. Choose
   **Same opponents back-to-back** to write `legOrder: 'interleaved'` — with
   double-headers on, this plays a side's morning fixture and its PM return leg against
   the _same_ opponent, rather than saving the return leg for a later day. Leaving the
   default (**Full round, then return round**) still works with double-headers on; it
   just means the return leg is a different day's double-header, not the same day's PM
   slot. The union's document asks for the same-day return, so pick interleaved here.
3. Save and generate. What comes out: each double-header day produces two consecutive
   rounds sharing that date — round _N_ gets every fixture at the first slot (08:00),
   round _N+1_ gets every fixture at the second slot (13:30), and — because leg order is
   interleaved — the pairing in round _N+1_ is the same two sides as round _N_, home and
   away swapped. The fixture table (admin and club portal) shows the slot label and start
   time beside each row, with a time tiebreaker on same-date sorts, so the AM/PM pair
   reads in the right order.
4. Venue allocation already accounts for this: the ledger keys on date _and_ slot, so a
   side playing both the AM and PM fixture on one date is not flagged as double-booked,
   and a single-surface ground can legitimately host both fixtures on the same day.

## Operational notes

- **Prior-log seeding is a manual confirm, not automatic.** Nothing in the platform reads
  a previous season's finishing positions on its own — there is no results/standings
  model. A ranked stage (feeding a cross-pool draw, or a seeded knockout in its own
  right) always starts from a suggestion the admin can accept or override, entered by
  hand through the **Position** column on that stage's confirm step at the start of the
  season. Treat "seed from the prior log" as a per-season admin task, every season, not a
  one-time setup step.
- **Deploy the API before the web app.** (The old flat-series **Regenerate** button this
  note used to lean on is retired — ADR 0014; regenerates now run through the season
  stage card's server generate route, which rebuilds from the run's frozen structure
  snapshot.) The rule stands for the same underlying reason: `roundsPerDay` only survives
  a regenerate if it was validated and stored in the first place
  (`packages/api/src/config-validation.ts`, `index.ts`). Deploy web first and a schedule
  save can reach an API that doesn't recognise the field yet — silently storing a
  structure with no `roundsPerDay` even though the operator picked "AM + PM
  double-headers", so every season started from it single-headers. Ship the API first,
  so every write of `roundsPerDay` lands on an API that keeps it.
- **Running seasons keep their existing `structureSnapshot`.** A `SeasonRun` freezes the
  structure it was started against (src/main.tsx) — editing a structure's schedule to add
  `roundsPerDay`, a non-adjacent `derivedFrom.fromStage`, or a different `legOrder` only
  applies to a season **started or a stage regenerated after the edit**. A season already
  mid-way through its stages carries on exactly as it was generated; there is no
  retroactive migration, and this is deliberate, existing behaviour — not a caveat this
  branch introduces.

## See also

- [`docs/runbooks/configurable-league-structures.md`](./configurable-league-structures.md) —
  the ADR 0008 deploy runbook: starter templates, `blockIndex`, cadence kinds, the season
  wizard flow, venues, and the post-deploy operator setup order this doc assumes is already
  done.
- [`public/guides/league-structures-tutorial.html`](../../public/guides/league-structures-tutorial.html) (served at `/guides/league-structures-tutorial.html`)
  (and its [`.pdf` companion](../guides/league-structures-tutorial.pdf)) — the illustrated, print-oriented walkthrough of the stage
  pipeline model for anyone who hasn't used the wizard before.
