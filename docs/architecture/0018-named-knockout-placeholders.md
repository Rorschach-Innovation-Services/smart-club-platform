# ADR 0018 — Named knockout placeholders (`tbd:`) and Set team

**Status:** Accepted (October 2026).

## Context

Knockout fixtures are stored before their teams are known. ADR 0008 gave them reserved-prefix
sides: `win:f3` / `lose:f3` (the winner or loser of another fixture in the same series) and
`pos:<seriesId>:<rank>` (a group finishing position). Every consumer treats any of these as "not
a team" through one predicate, `isSlotRef`, and shows them through one labeller, `slotRefLabel`.

The Titans T20 workbook has knockout slots no rule can compute: "Best 3rd place", "Second best
3rd place", "Runner-up 1/2/3" (ranked across groups) and "Community Cup winner" (another
competition). A human decides them. Before this there was also no way to put the decided team
in: the fixture editor showed a placeholder side read-only, and only the medicoach puller could
fill one.

## Decision

1. **A fourth prefix, `tbd:<label>`.** The label is URI-encoded (`tbdOf('Best 3rd place')` →
   `tbd:Best%203rd%20place`) so the id is one opaque token whatever the union wrote. `isSlotRef`
   includes it, so it is never booked, never counted as a team and never mapped to a club;
   `slotRefLabel` returns the decoded words. Malformed escapes fall back to the raw text rather
   than throwing in a render. It is not a fixture reference (`slotSource` is null), so the
   medicoach export skips a fixture with a `tbd:` or `pos:` side as `unresolved-side` until a
   team is set.
2. **Set team is a server action.** `PATCH /series/:id` with
   `{ setSide: { fixtureId, side, teamId | null }, version }` (admin-only, version required,
   sibling keys ignored like `reveal`). It replaces a placeholder side with a team and keeps the
   placeholder in `fixture.slots[side]` (the puller's convention), never overwriting a stored
   one, so `teamId: null` reverts exactly. A team from outside the series joins `participants`
   (snapshot of name, club and venue) and `teams[]`. On a legacy series (no participants) only a
   club can go in. The result goes through the in-season clash gate's subset rule on drafts
   **and** released series: a knockout usually has no venue, so setting the home team moves the
   fixture onto that team's ground.
3. **PATCH refuses new orphan sides.** A fixtures/participants/teams write may not introduce a
   side that is not a series team or participant, not a placeholder, and not filled from a
   stored placeholder. Only new orphans are refused, so older data stays editable.
4. **Importers keep identity.** A re-import matches fixtures by `slots[side] ?? side` and keeps
   the console's Set-team sides when the sheet still has the same placeholder.

## Consequences

- `tbd:` data must not reach a stage before this code does: older code reads `tbd:` as an
  unknown team id. The Titans importer writes T20 knockouts only with `--include-t20-ko`, and
  the runbook makes "PR B deployed to that stage" a hard precondition.
- Revert keeps a participant that was added by Set team. Removing it could orphan another
  fixture that uses it, and an unused participant is harmless.
