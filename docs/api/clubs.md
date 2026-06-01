# API — Clubs

A club is the central entity: affiliation state, compliance docs, CQI, exco, coaches,
ground, and leagues. `players` is **derived** from registration count at read time (the
stored value is ignored). Writes use optimistic concurrency (`version`; `409` on conflict).

## `GET /clubs` — list (admin)

Returns all clubs in the tenant, each with a derived `players` count.

```
200 → Club[]
403 → not an admin of this tenant
```

## `POST /clubs` — onboard (admin)

Body: `{ name, district?, sub?, chair?, exco? }`. Builds a club with a slug id, neutral
state (`affiliation: "not_started"`, `paid: false`, `cqi: 0`, empty docs), `version: 1`.
A duplicate name (case-insensitive) within the tenant is rejected.

```
201 → Club
409 → a club with that name already exists
```

## `POST /clubs/bulk` — bulk onboard (admin)

Body: `Club[]`-shaped spec array. Per-spec and non-atomic: duplicates/invalid names are
skipped rather than aborting the batch.

```
201 → { created: Club[], skipped: [{ name, reason }] }
```

## `GET /clubs/:id/players` — list registrations (rep: own only)

Returns the club's player registrations. `200 → PlayerRegistration[]` · `403` for a rep's
other club.

## `GET /clubs/:id` — read (rep: own only)

`200 → Club` (with derived `players`) · `403` if a rep requests another club · `404`.

## `PATCH /clubs/:id` — update (rep: own only)

Partial update of affiliation, `cqi` + `cqiAnswers`, `ground` (incl. `lat`/`lon`),
`leagues`, `coaches`. Notes:

- `paid` is stripped here — use `PATCH /clubs/:id/paid` (admin).
- A rep **cannot** patch affiliation fields (`affiliation`, `exco`, `coaches`, `ground`,
  `leagues`) once `affiliation === "complete"` → `403 "affiliation is locked"`. Admins may.
- Send the current `version`; mismatch → `409 "club changed; refetch"`.

```
200 → Club   403 locked / wrong club   404   409 version conflict
```

## `POST /clubs/:id/exco` — save exec committee (rep: own only)

Body: the exco object (`chair`, `sec`, `tre`, `vc`, `additionalMembers`). Also sets
`docs.exco = true`. `200 → Club`.

## `POST /clubs/:id/docs/:key/upload-url` — presigned upload

`key ∈ {constitution, agm, financials}`. Returns a 5-minute S3 presigned PUT for a PDF.

```
200 → { uploadUrl, objectKey }
```

Client uploads the file directly to `uploadUrl`, then calls the next route.

## `PATCH /clubs/:id/docs/:key` — mark uploaded

Body: `{ objectKey, size }`. Sets `docs[key] = true` and records `docMeta[key]`
(`objectKey`, `size`, `uploadedAt`). `200 → Club`.

## `POST /clubs/:id/reg-link` — issue a registration link

Generates a server-side `crypto.randomUUID()` token, stores `TOKEN#<token> → {tenant,
clubId}`, and sets `club.playerRegLink`. `200 → { playerRegLink: { token, createdAt } }`.

## `PATCH /clubs/:id/paid` — toggle paid (admin)

Body: `{ paid: boolean }`. Audited (`changedBy`/`changedAt`). `200 → Club`.

> The affiliation form locks on `affiliation === "complete"`, **not** on `paid` (payments
> are deferred; `paid` is a manual admin action). See the plan's data-gap fixes.
