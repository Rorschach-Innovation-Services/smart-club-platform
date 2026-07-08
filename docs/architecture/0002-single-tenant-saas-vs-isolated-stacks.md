# ADR 0002 — One shared multi-tenant stack

**Status:** Accepted

> **Note (2026-07):** two details evolved. Edge-resolved branding was never built — the SPA
> ships a neutral default theme and applies tenant branding at runtime from `GET /tenant`.
> And "config row + seed" became the operator portal: tenants are created and configured at
> `/platform`, backed by a DynamoDB tenant registry. See
> [ADR 0006](0006-platform-operator-and-tenant-registry.md).

## Context

There are already two near-identical deployments: `dolphins-smart-club` and a
`lions-smart-club` fork. They differ only in branding, seed data, and org copy — there is zero
logic divergence. More unions (e.g. Sharks) are expected. Maintaining a fork per union means
every bug fix and feature lands N times.

The choice: keep deploying an isolated stack per union (parameterised from one codebase), or
run a single shared multi-tenant stack serving all unions.

## Decision

Run **one shared multi-tenant stack** — one DynamoDB table, one Cognito pool, one API, one
front-end build — serving every union. Tenants are isolated **logically** by a `TENANT#<t>#`
key prefix and an authenticated host check. Each union gets its own subdomain and branding.
Adding a union is a **config row + seed + DNS/cert**, not a code fork or a new deploy.

Branding is resolved at the **CloudFront edge** (a function maps host → branding tokens), so
first paint is themed with no blocking API call and no branding flash.

## Why

- **One codebase, fixed once.** Convergence eliminates fork drift; a fix ships to all tenants
  at once.
- **Cheap tenant onboarding.** New union ≈ minutes of config, not a new pipeline.
- **Residency is preserved either way** (single region), so isolation doesn't _need_ to be
  physical for POPIA — logical isolation in one `af-south-1` table is sufficient, and erasure
  is a tenant-prefix query (see [data-model.md](data-model.md)).
- **Edge theming** keeps the static-CDN latency the prototype already had; a runtime
  `GET /config` round-trip on every load would regress first paint and risk a flash of the
  wrong brand.

## Consequences

- **Tenant isolation is now security-critical application logic.** Every query must carry the
  tenant prefix; middleware enforces host ↔ membership ↔ tenant on every request. A missed
  prefix is a cross-tenant leak — covered by tests in the verification plan.
- **Shared blast radius.** One bad deploy affects all tenants; one noisy tenant can affect
  others. v1 accepts this at small scale; per-tenant throttling exists on the public
  `/register` route, and usage tagging is a prerequisite before onboarding paying unions.
- **No per-tenant cost signal** from a commingled on-demand table — acceptable for v1, flagged
  for later.
- **Branding is more pervasive than a logo swap** — org strings, support contacts, titles,
  favicon, and CSS color tokens across `main.jsx`/`index.html` must all become config-driven.

## Alternatives considered

- **Isolated stack per union** (separate table/pool/deploy from one codebase): strongest
  physical isolation and per-tenant residency control, and per-tenant cost visibility, but more
  ops and cost per tenant and harder cross-tenant administration. Rejected for v1 because
  logical isolation in one SA region already satisfies residency, and onboarding cost matters
  more than physical separation at this scale.
