# API — Tenant config & current user

## `GET /tenant` — branding (public)

Resolves the tenant from the host (prod) or `x-tenant` / `?tenant=` (dev) and returns the
**public** subset of config: branding (name, title, logo, favicon, color tokens, copy
slots), the submission deadline, the league catalogue, the district list, the tutorial
videos, the per-tenant feature flags, the season calendars, and the compliance-doc
catalogue. `knownClubs` is not exposed here. `districts` and `requiredDocs` are the
resolved lists — a legacy row without the field falls back to the shared defaults; an
explicit `[]` (freshly created client) comes through empty.

```
200 → { tenant, branding, submissionDeadline, leagues, districts, requiredDocs,
        tutorials, features, calendars }
400 → unknown tenant
404 → tenant not found
```

`requiredDocs` rides the public payload ([ADR 0009](../architecture/0009-per-tenant-required-docs.md)):
doc names and behaviour flags are as public as league and district names, and the rep
portal reads only this payload. The operator-only `matchHints` (bulk-intake classifier
keywords) are stripped — they are served solely on `GET /platform/tenants/:slug`.

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
200 → { tenant, branding, submissionDeadline, leagues, districts, requiredDocs,
        tutorials, features, calendars, structures, setupCompletedAt }
401 → not authenticated
404 → tenant not found
```

Deliberately held back: `clubSignupLink` (a live credential, managed via
`/admin/club-signup-link` — see [signup.md](signup.md)), `knownClubs` (reachable via
`/clubs/directory`), `adminCount` (an internal counter for the last-admin guard) and
`setupCompletedBy` (an operator's email). `requiredDocs` moved OFF this held-back list
with [ADR 0009](../architecture/0009-per-tenant-required-docs.md) — it now rides both
here and the public `GET /tenant`, so the admin console needs no second source.

This is where the admin console reads `structures` from. They are deliberately **not** on the
public `GET /tenant`: that route is anonymous and hit on every public page load, and up to 50
structures × 20 stages of competition configuration is payload nobody on that path reads.
`calendars` are on both — the create-series form reads them off the already-fetched public
payload.

## `PUT /tenant/config` — update config (admin)

Body: partial `TenantConfig` (branding, `submissionDeadline`, `knownClubs`). Merged over
the current config. `200 → TenantConfig`. The same strip-and-merge core backs the
operator's `PUT /platform/tenants/:slug`
([ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md)).

> `clubSignupLink` is stripped from patches — it is managed only via
> `/admin/club-signup-link` ([signup.md](signup.md)) so a concurrent Settings save can't
> resurrect a revoked link.

> The `leagues` catalogue IS tenant-editable here (whole-array replace, validated:
> unique string keys, non-blank labels, and each `league.district` must be a tenant
> district or the "All districts" sentinel) and operator-editable via
> `PUT /platform/tenants/:slug` — the operator route additionally rejects (409)
> removing a league clubs are still registered for.
>
> `League.competitions` (the structure/calendar bindings) are **operator-only**, even
> though `leagues` itself is tenant-editable here: a tenant-admin PUT that touches `leagues`
> has each incoming league's `competitions` overwritten with whatever is currently stored
> for that key, so this route can rename or reorder leagues but can never mint or drop a
> binding. Bind competitions via `PUT /platform/tenants/:slug` only.

> `requiredDocs` is **operator-only** (stripped here) and edited via
> `PUT /platform/tenants/:slug`, which validates each entry's shape and rejects (409)
> removing a doc key any club still holds data for — archive the entry instead
> ([ADR 0009](../architecture/0009-per-tenant-required-docs.md)).

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
>
> Each `StageSpec.schedule` names a `blockIndex` (0-based position into whichever calendar
> the competition binds), not a calendar or block id — a structure carries no calendar
> identity of its own, so the same structure is reusable across different calendars. See
> the [ordinal block refs addendum](../architecture/0008-configurable-league-structures.md#addendum-2026-08-02-ordinal-block-references-and-the-season-wizard).
>
> `structure.version` is **server-owned**: a client's `version` in the body is ignored, and
> the server deep-compares incoming content (everything but `version`) against what's
> stored for that id, minting `existing.version + 1` only when something actually changed.
> A no-op resave keeps the existing number; an unrecognised id starts at `1`.

> `calendars` (season calendars — playing blocks, breaks, excluded dates) is
> **operator-only** on the same basis, edited via `PUT /platform/tenants/:slug`, which
> rejects (409) removing a calendar a series is scheduled against. Validated on write:
> ≥1 block per calendar, unique calendar and block ids, and strict `YYYY-MM-DD` dates with
> `end >= start` on every block and break (lenient parsing would roll `2026-02-31` into
> March). Public to READ — playing dates carry no personal data and the create-series form
> reads them off the `GET /tenant` payload. See
> [ADR 0008](../architecture/0008-configurable-league-structures.md).
>
> Editing a calendar's blocks while a series is still scheduled against it is **not**
> rejected — the response gains a `warnings[]` array ("N series are scheduled against
> '<label>'; regenerating them will follow the new dates") when this happens, present only
> when non-empty so an unaffected save's response shape is unchanged. Only removing the
> calendar outright (or a block a stage still needs) 409s; editing its dates is a live
> reference by design — see the addendum linked above.

## Operator bulk document intake (operator only)

Three routes behind the platform gate (`/platform/*` → `authenticate` +
`requirePlatformOperator`), backing the operator console's bulk-intake wizard. They exist
because the tenant-side doc routes are unreachable from the platform host, and because a
100-file drop must not cost 100 read-modify-write cycles.

### `POST /platform/tenants/:slug/doc-intake/presign`

Body `{ items: [{ clubId, docKey, contentType, size }] }`, max 100 (400 beyond). Each item
is validated against the tenant's resolved catalogue (active, `kind: 'file'`, accepted
type, ≤ 10 MB) and its club's existence.

```
200 → { items: [ { ok: true, uploadUrl, objectKey, contentType } | { ok: false, error } ] }
```

Results are **positional** — one entry per request item, in order, so a single bad row
never fails the batch. Object keys use the same `${tenant}/${clubId}/${docKey}-${uuid}.${ext}`
convention as the tenant routes, so view/replace/delete and the erasure helpers all keep
working on intake-uploaded files.

### `POST /platform/tenants/:slug/doc-intake/commit`

Body `{ items: [{ clubId, docKey, objectKey, size, contentType, sourceName }] }`, max 100.
Groups by club and applies **one version-pinned write per club** (retried once on a
version conflict), so a 100-row batch over 12 clubs costs 12 writes. Multi-file docs
append, deduped on `objectKey`; single-file docs replace, best-effort deleting the
superseded object _after_ the write lands. `uploadedBy` (operator email) and `sourceName`
(original filename) are stored as an audit trail.

```
200 → { clubs: [ { clubId, ok: true, docs } | { clubId, ok: false, error } ] }
```

One result row **per club**, not per item: a club's batch is all-or-nothing, but one
club failing never stops the others.

### `POST /platform/tenants/:slug/clubs`

Body `{ name, district }`. Creates a shell club (district validated against the tenant's
list, id/name collision pre-checked) seeded with the tenant's own doc catalogue. **No**
chair, membership or Cognito provisioning — the chair attaches later via the normal
signup link. `201 → Club   400 unknown district / bad name   409 already exists`.

## `GET /me` — current user (authenticated)

Returns the caller's `UserProfile` (`sub`, `email`, `memberships`, `onboardingSeen`),
falling back to token-derived values if no `USER#` record exists yet.

## `PATCH /me` — update onboarding-seen (authenticated)

Body: `{ onboardingSeen: { [clubId]: true } }`. Merged into the user record so the
onboarding modal is shown once per club, per user (not per session).
