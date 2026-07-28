# API — Tenant config & current user

## `GET /tenant` — branding (public)

Resolves the tenant from the host (prod) or `x-tenant` / `?tenant=` (dev) and returns the
**public** subset of config: branding (name, title, logo, favicon, color tokens, copy
slots), the submission deadline, the league catalogue, the district list, the tutorial
videos, the per-tenant feature flags, and the season calendars. `knownClubs` and
`requiredDocs` are not exposed here. `districts` is the resolved list — a legacy row
without the field falls back to the shared defaults; an explicit `[]` (freshly created
client) comes through empty.

```
200 → { tenant, branding, submissionDeadline, leagues, districts, tutorials, features, calendars }
400 → unknown tenant
404 → tenant not found
```

Used at first paint for theming: the SPA ships a neutral default theme and applies
`branding` (colors, copy, favicon, `--hero-image`) at runtime — see
[ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md). `features` is a
boolean map read via `useFeature`/`hasFeature`, so each flag carries its own default and an
empty map means "all defaults".

## `GET /tenant/config` — tenant setup config (authenticated)

An explicit allowlist, not the raw row. Any tenant member may read it (reps included), so
it is a projection by construction — a denylist would expose every field later added to
`TenantConfig`. Writing is admin-only.

```
200 → { tenant, branding, submissionDeadline, leagues, districts,
        tutorials, features, calendars, structures, setupCompletedAt }
401 → not authenticated
404 → tenant not found
```

Deliberately held back: `clubSignupLink` (a live credential, managed via
`/admin/club-signup-link` — see [signup.md](signup.md)), `knownClubs` (reachable via
`/clubs/directory`), `requiredDocs` (served with the club record that uses it), `adminCount`
(an internal counter for the last-admin guard) and `setupCompletedBy` (an operator's email).

This is where the admin console reads `structures` from. They are deliberately **not** on the
public `GET /tenant`: that route is anonymous and hit on every public page load, and up to 50
structures × 20 stages of competition configuration is payload nobody on that path reads.
`calendars` are on both — the create-series form reads them off the already-fetched public
payload.

## `PUT /tenant/config` — update config (admin)

Body: partial `TenantConfig` (branding, `submissionDeadline`, `knownClubs`,
`requiredDocs`). Merged over the current config. `200 → TenantConfig`. The same
strip-and-merge core backs the operator's `PUT /platform/tenants/:slug`
([ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md)).

> `clubSignupLink` is stripped from patches — it is managed only via
> `/admin/club-signup-link` ([signup.md](signup.md)) so a concurrent Settings save can't
> resurrect a revoked link.

> The `leagues` catalogue IS tenant-editable here (whole-array replace, validated:
> unique string keys, non-blank labels, and each `league.district` must be a tenant
> district or the "All districts" sentinel) and operator-editable via
> `PUT /platform/tenants/:slug` — the operator route additionally rejects (409)
> removing a league clubs are still registered for.

> `districts` is **operator-only** (stripped here like `features`/`tutorials`/`adminCount`,
> ADR 0006) and edited via `PUT /platform/tenants/:slug`, which rejects (409) removing a
> district that clubs or leagues still reference. A tenant row without the field resolves
> to the shared defaults at read time; a freshly created client starts at `[]` (club signup
> blocked until configured). CQI remains a frozen shared default per
> [ADR 0005](../architecture/0005-frozen-catalogues-v1.md) (amended — see its status note).

> `structures` (competition structures — the stage pipelines leagues bind to) is
> **operator-only** and edited via `PUT /platform/tenants/:slug`. Validated on write:
> ≥1 stage, unique structure and stage ids, known format / entrant / cadence kinds, and —
> the load-bearing one — a stage's `derivedFrom.fromStage` must name an **earlier** stage.
> A forward or self reference is a cycle, and a season built from one would be
> permanently unresolvable with no obvious cause. Deleting a structure a league's
> `competitions[]` still binds to is rejected (409); a running season is unaffected either
> way because it holds its own snapshot. A league's `competitions[]` are cross-checked
> against the post-patch view of structures and calendars, so one PUT may legitimately add
> a structure and the competition that uses it together. Read via the authenticated
> `GET /tenant/config`, not the public `GET /tenant`.

> `calendars` (season calendars — playing blocks, breaks, excluded dates) is
> **operator-only** on the same basis, edited via `PUT /platform/tenants/:slug`, which
> rejects (409) removing a calendar a series is scheduled against. Validated on write:
> ≥1 block per calendar, unique calendar and block ids, and strict `YYYY-MM-DD` dates with
> `end >= start` on every block and break (lenient parsing would roll `2026-02-31` into
> March). Public to READ — playing dates carry no personal data and the create-series form
> reads them off the `GET /tenant` payload. See
> [ADR 0008](../architecture/0008-configurable-league-structures.md).

## `GET /me` — current user (authenticated)

Returns the caller's `UserProfile` (`sub`, `email`, `memberships`, `onboardingSeen`),
falling back to token-derived values if no `USER#` record exists yet.

## `PATCH /me` — update onboarding-seen (authenticated)

Body: `{ onboardingSeen: { [clubId]: true } }`. Merged into the user record so the
onboarding modal is shown once per club, per user (not per session).
