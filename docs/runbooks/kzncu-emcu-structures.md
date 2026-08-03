# Runbook — building the KZNCU/EMCU leagues from the requirements document

Operator cheat-sheet for turning the union's structure-requirements document into real
structures in the platform's season/structure wizard. Every capability listed below —
multi-stage competitions, seeded/manual splits, group labels, all four cadence kinds,
activate-from dates, and per-stage time slots — already ships (see
[configurable-league-structures.md](./configurable-league-structures.md)). Nothing here is
new capability; it is the mapping from the requirements document's checklist items to the
existing starter templates and controls.

Build calendars and venues first (see
[`configurable-league-structures.md`](./configurable-league-structures.md), step 4, items
1–2), then work down this list league by league in **Structures** and **Leagues →
Competitions**.

## Template quick-reference

| Template id         | Name (in the template gallery)          | Shape                                                                                      |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `split-league-swap` | Split league with mid-season swap       | Two groups double (or single) round, a mid-season swap carrying points, then a final round |
| `pools-to-knockout` | Seeded pools → cross-pool semis → final | Seeded pools round robin, then top finishers cross into a knockout                         |
| `stream-and-cup`    | Stream + knockout cup                   | Two streams round robin; the lower stream then plays a straight knockout cup               |
| — (none)            | Flat season                             | Single round robin, no stages — the default create-series flow                             |

## League-by-league checklist

| League                              | Template            | What to edit                                                                                                                                                                                                                                                                                                           | Block                                                                                                       |
| ----------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| KZNCU Premier Men 50-Over           | `split-league-swap` | Group labels → "Top Six" / "Bottom Six" on both stages. Leave the round format as is — the template's opening stage already defaults to a double round robin and its final round already defaults to a single round robin, matching the doc for this league; confirm cadence stays Weekly.                             | Block 1 → carries into Block 2 (template auto-places stage 2 in the second block when the calendar has one) |
| KZNCU Premier Men T20               | `pools-to-knockout` | Seeded-split, count = 2 groups (12 entrants → 6 each), seeded from the prior season's log/standings. Time slots default to Morning (08:00) / Afternoon (13:30) already — no change needed.                                                                                                                             | Block 1                                                                                                     |
| KZNCU Promotion 50-Over / Kingsmead | `stream-and-cup`    | Group labels → "Top 10" / "Bottom 10" on the streams stage. Kingsmead Cup stage needs no manual entrant-count edit — the 9-team preliminary auto-derives from entrant count (`knockoutShape`, `src/competition/formats.ts`): 9 qualifiers trims to an 8-side main draw via one preliminary among the two lowest seeds. | Block 1                                                                                                     |
| KZNCU Promotion T20                 | `pools-to-knockout` | Seeded-split, count = 4 groups (20 entrants → 5 each). Time slots default to T20 morning/afternoon — no change needed.                                                                                                                                                                                                 | Block 1                                                                                                     |
| KZNCU Premier Women 30-Over         | `split-league-swap` | Group labels → "Top Four" / "Bottom Four". **Change the final-round stage's format from single to double round robin** — this league runs a double round in both halves, unlike the Premier Men template default.                                                                                                      | Block 1 → Block 2                                                                                           |
| KZNCU Premier Women T20             | `pools-to-knockout` | Seeded-split, count = 2 groups (8 entrants → 4 each). Time slots default correctly.                                                                                                                                                                                                                                    | Block 1                                                                                                     |
| KZNCU Promotion Women               | Flat season         | No changes — weekly cadence is the create-series default.                                                                                                                                                                                                                                                              | Block 1                                                                                                     |
| EMCU Division 1                     | Flat season         | No changes — weekly cadence default.                                                                                                                                                                                                                                                                                   | Block 1                                                                                                     |
| EMCU Division 2                     | Flat season         | No changes — weekly cadence default.                                                                                                                                                                                                                                                                                   | Block 1                                                                                                     |
| EMCU Division 3 Stream 1            | Flat season         | No changes — weekly cadence default.                                                                                                                                                                                                                                                                                   | Block 1                                                                                                     |
| EMCU Division 3 Stream 2            | Flat season         | Cadence → "Every 2 weeks" (`every-n-weeks`, n=2). Set a first-round anchor so the stride lands on Saturdays: either set **Scheduling options → First round** to a Saturday, or simply start the season's calendar block on a Saturday.                                                                                 | Block 1                                                                                                     |
| EMCU Division 4                     | Flat season         | Same as Division 3 Stream 2 — cadence "Every 2 weeks", anchor the first round (or the block start) on a Saturday.                                                                                                                                                                                                      | Block 1                                                                                                     |
| EMCU Division 5                     | Flat season         | Cadence → "Set days only", tick Saturday only.                                                                                                                                                                                                                                                                         | Block 1                                                                                                     |
| Juniors U11                         | Flat season         | On the Start flat season form, the standalone **Activate from** field (after Match format, not inside Scheduling options) set to the third week of January.                                                                                                                                                            | Block 2                                                                                                     |
| Juniors U13                         | Flat season         | On the Start flat season form, the standalone **Activate from** field (after Match format, not inside Scheduling options) set to the third week of January.                                                                                                                                                            | Block 2                                                                                                     |

## Notes on specific controls

- **Group counts, not sizes.** The seeded-split and manual-split entrant controls take a
  group _count_ under "Even groups" (the roster splits evenly across that many groups) — so
  "2 groups of 6" means setting count = 2 against a 12-side entrant list, not typing "6"
  anywhere. Use "Exact sizes" only for an uneven split (e.g. `5, 5, 5, 4`), which none of the
  leagues above need.
- **T20 time slots ship as the template default.** `pools-to-knockout`'s two stages now carry
  `T20_SLOTS` (`src/competition/calendar.ts`) — Morning 08:00 / Afternoon 13:30 — out of the
  box for every T20 competition (Premier Men, Promotion Men, Premier Women). No per-league
  edit is needed unless a competition should deviate from the union's stated slots.
- **Kingsmead's preliminary round is automatic.** `knockoutShape` (`src/competition/formats.ts`)
  computes the preliminary/main-draw split from entrant count alone — 9 entrants always
  produces one preliminary among the two lowest seeds and an 8-side main draw. There is no
  "preliminary round" toggle to set by hand.
- **"Every 2 weeks" is the `every-n-weeks` cadence with n=2** — the Choice control's label is
  literally "Every 2 weeks" (`CADENCE_LABELS`, `src/competition/calendar.ts`); the underlying
  `n` isn't operator-editable through the labelled control, which is fine since n=2 is what
  every bi-weekly EMCU division needs.
- **First-round anchoring for bi-weekly cadences** lives under the Start flat season form's
  collapsed "Scheduling options" section, alongside cadence — it defaults to the block's start
  date if left blank, so anchoring on a Saturday only matters when the block itself doesn't
  already start on one.
- **Activate from applies to both flat seasons and structure stages** — the Start flat season
  form has its own standalone "Activate from" field, after Match format and NOT inside
  Scheduling options (used here for the Juniors divisions); a stage inside a structure has the
  same field per-stage, for competitions that need a stage to open late mid-structure.

## See also

- [`docs/runbooks/configurable-league-structures.md`](./configurable-league-structures.md) —
  the ADR 0008 deploy runbook: starter templates, `blockIndex`, cadence kinds, the season
  wizard flow, venues, and the post-deploy operator setup order this doc assumes is already
  done.
- [`docs/guides/league-structures-tutorial.html`](../guides/league-structures-tutorial.html)
  (and its `.pdf` companion) — the illustrated, print-oriented walkthrough of the stage
  pipeline model for anyone who hasn't used the wizard before.
