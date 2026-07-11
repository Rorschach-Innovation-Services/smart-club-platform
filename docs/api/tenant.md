# API — Tenant config & current user

## `GET /tenant` — branding (public)

Resolves the tenant from the host (prod) or `x-tenant` / `?tenant=` (dev) and returns the
**public** subset of config: branding (name, title, logo, favicon, color tokens, copy
slots), the submission deadline, the league catalogue, the tutorial videos, and the
per-tenant feature flags. `knownClubs` and `requiredDocs` are not exposed here.

```
200 → { tenant, branding, submissionDeadline, leagues, tutorials, features }
400 → unknown tenant
404 → tenant not found
```

Used at first paint for theming: the SPA ships a neutral default theme and applies
`branding` (colors, copy, favicon, `--hero-image`) at runtime — see
[ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md). `features` is a
boolean map read via `useFeature`/`hasFeature`, so each flag carries its own default and an
empty map means "all defaults".

## `PUT /tenant/config` — update config (admin)

Body: partial `TenantConfig` (branding, `submissionDeadline`, `knownClubs`,
`requiredDocs`). Merged over the current config. `200 → TenantConfig`. The same
strip-and-merge core backs the operator's `PUT /platform/tenants/:slug`
([ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md)).

> `clubSignupLink` is stripped from patches — it is managed only via
> `/admin/club-signup-link` ([signup.md](signup.md)) so a concurrent Settings save can't
> resurrect a revoked link.

> The `leagues` catalogue IS tenant-editable here (whole-array replace, validated:
> unique string keys, non-blank labels) and operator-editable via
> `PUT /platform/tenants/:slug` — the operator route additionally rejects (409)
> removing a league clubs are still registered for. Districts and CQI remain frozen
> shared defaults per [ADR 0005](../architecture/0005-frozen-catalogues-v1.md).

## `GET /me` — current user (authenticated)

Returns the caller's `UserProfile` (`sub`, `email`, `memberships`, `onboardingSeen`),
falling back to token-derived values if no `USER#` record exists yet.

## `PATCH /me` — update onboarding-seen (authenticated)

Body: `{ onboardingSeen: { [clubId]: true } }`. Merged into the user record so the
onboarding modal is shown once per club, per user (not per session).
