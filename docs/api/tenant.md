# API — Tenant config & current user

## `GET /tenant` — branding (public)

Resolves the tenant from the host (prod) or `x-tenant` / `?tenant=` (dev) and returns the
**public** subset of config: branding (name, title, logo, color tokens, copy) and the
submission deadline. `knownClubs` and `requiredDocs` are not exposed here.

```
200 → { tenant, branding, submissionDeadline }
400 → unknown tenant
404 → tenant not found
```

Used at first paint for theming (resolved at the CloudFront edge in prod — see
[ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md)).

## `PUT /tenant/config` — update config (admin)

Body: partial `TenantConfig` (branding, `submissionDeadline`, `knownClubs`,
`requiredDocs`). Merged over the current config. `200 → TenantConfig`.

> `clubSignupLink` is stripped from patches — it is managed only via
> `/admin/club-signup-link` ([signup.md](signup.md)) so a concurrent Settings save can't
> resurrect a revoked link.

> Catalogue overrides (districts/leagues/CQI) are **not** accepted in v1 — those are frozen
> shared defaults. See [ADR 0005](../architecture/0005-frozen-catalogues-v1.md).

## `GET /me` — current user (authenticated)

Returns the caller's `UserProfile` (`sub`, `email`, `memberships`, `onboardingSeen`),
falling back to token-derived values if no `USER#` record exists yet.

## `PATCH /me` — update onboarding-seen (authenticated)

Body: `{ onboardingSeen: { [clubId]: true } }`. Merged into the user record so the
onboarding modal is shown once per club, per user (not per session).
