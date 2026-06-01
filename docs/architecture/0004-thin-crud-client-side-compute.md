# ADR 0004 — Thin CRUD API; computation stays client-side

**Status:** Accepted

## Context

The prototype computes everything in the browser from two in-memory arrays (`clubs`,
`series`): cohort stats, per-club overall progress, document completion, the dashboard
leaderboard and at-risk list, phase roll-ups, all list filters/counts, deadline countdowns,
travel cost (haversine + fuel), round-robin fixture generation, and CQI scoring. These are pure
functions in `src/data.jsx` and `src/atoms.jsx` over the raw data.

When adding a backend, we could move this aggregation server-side (reporting endpoints,
materialised stats) or keep it in the browser and have the API just persist and return raw
records.

## Decision

Keep the API a **thin, tenant-scoped CRUD layer**. `GET /clubs` and `GET /series` return the
full per-tenant arrays; the browser keeps computing everything with the existing `data.jsx`
helpers, unchanged.

## Why

- **No rewrite, no divergence.** The compute helpers already exist, are tested by use, and stay
  the single source of truth. Re-implementing them server-side would duplicate logic and risk
  client/server drift.
- **Scale makes it free.** A tenant has tens of clubs and a few hundred fixtures. Fetching the
  whole cohort is a few KB; computing a leaderboard over it is instant. There is no performance
  case for server-side aggregation here.
- **Smaller backend.** No reporting endpoints, no aggregation queries, no caching layer — the
  API is just persistence + authorization, which is the minimum to make the app real.

## Consequences

- **Explicit scale assumption:** "fetch-all is cheap" holds at tens of clubs per tenant. If a
  union ever reaches thousands of clubs, this needs pagination and likely some server-side
  aggregation. Documented as an assumption in [data-model.md](data-model.md).
- Catalogues (`DISTRICTS`, `LEAGUE_OPTIONS`, `CQI_STRUCTURE`) and scorers (`scoreCQI`) stay as
  client-side constants/functions. This is also why per-tenant catalogue overrides are deferred
  — see [ADR 0005](0005-frozen-catalogues-v1.md).
- The client must handle loading/empty/error states that the synchronous prototype never had.

## Alternatives considered

- **Server-side aggregation / reporting endpoints:** justified only at large scale; here it
  adds code and a drift risk for no user-visible benefit. Rejected for v1.
