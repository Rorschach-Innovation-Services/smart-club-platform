# ADR 0005 — Districts, leagues, and CQI are frozen shared defaults in v1

**Status:** Accepted

## Context

The platform is multi-tenant and unions want room to customise. Branding, the submission
deadline, the known-clubs onboarding list, and the required-documents list are cheap and safe
to vary per tenant. The harder question is the cricket **catalogues**: `DISTRICTS`,
`LEAGUE_OPTIONS_BY_DISTRICT`, and especially `CQI_STRUCTURE` (the questions and scoring
weights).

Two facts make catalogue overrides costly:

1. **The code reads catalogues as module-level constants.** `scoreCQI` (`src/atoms.jsx`) and
   the league lookup tables (`LEAGUE_OPTIONS`, `LEAGUE_LABEL_BY_KEY`, `_LEAGUES_BY_CLUB`, …)
   are computed once at import from the static data in `src/data.jsx`. They cannot see a
   per-tenant override fetched at runtime without refactoring every scorer and lookup to take
   the resolved catalogue as input and threading it through all call sites.
2. **Overriding CQI weights breaks score comparability.** `club.cqi` is a single number scored
   against a fixed 100-point rubric. If a tenant changes weights or questions, previously stored
   scores become incomparable to new ones, and the dashboard's `avgCqi`, leaderboard, and
   hardcoded band cutoffs silently mix rubrics. Correct handling needs a `cqiVersion` stamped on
   every club plus recompute/flag logic.

## Decision

In v1, **`DISTRICTS`, `LEAGUE_OPTIONS`, and `CQI_STRUCTURE` are shared, frozen defaults** in
code. Per-tenant overrides are limited to **branding/colors, `submissionDeadline`,
`knownClubs`, and `requiredDocs`**. The tenant-config layer and override resolver are built so
catalogue overrides can be added later without re-architecting.

## Why

- **Removes a large, risky refactor from v1.** No `scoreCQI`/league-helper rewrite; `data.jsx`
  compute stays verbatim ([ADR 0004](0004-thin-crud-client-side-compute.md)).
- **Avoids silent data corruption.** No mixed-rubric scores, no `cqiVersion` migration needed
  yet.
- **Matches reality.** Dolphins and Lions already use identical catalogues, so nothing is lost
  today.
- **Leaves the door open.** Because overrides resolve through the same config layer, a phase-2
  "catalogue editors" feature can add district/league/CQI overrides once the scorer refactor and
  `cqiVersion` are in place.

## Consequences

- A union needing different leagues or a different CQI rubric cannot be onboarded until phase 2.
- Phase 2 must: refactor `scoreCQI`/`cqiBand`/league lookups to accept a resolved catalogue,
  thread it through call sites, and add `cqiVersion` to clubs for comparability.

## Alternatives considered

- **Full catalogue override in v1:** maximum flexibility, but the scorer refactor plus
  score-versioning is significant work and risk for a capability no current tenant needs.
  Deferred.
