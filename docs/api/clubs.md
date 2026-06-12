# API — Clubs

A club is the central entity: affiliation state, compliance docs, CQI, exco, coaches,
ground, and leagues. `players` is **derived** from registration count at read time (the
stored value is ignored). Writes use optimistic concurrency (`version`; `409` on conflict).

Clubs are created by their own reps via the public signup link — see
[signup.md](signup.md). There is no admin create route.

## `GET /clubs` — list (admin)

Returns all clubs in the tenant, each with a derived `players` count.

```
200 → Club[]
403 → not an admin of this tenant
```

## `GET /clubs/:id/players` — list registrations (rep: own only)

Returns the club's player registrations. `200 → PlayerRegistration[]` · `403` for a rep's
other club.

## `GET /clubs/:id` — read (rep: own only)

`200 → Club` (with derived `players`) · `403` if a rep requests another club · `404`.

## `PATCH /clubs/:id` — update (rep: own only)

Partial update of affiliation, `cqi` + `cqiAnswers`, `ground` (incl. `lat`/`lon`),
`leagues`, `coaches`. Notes:

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

> The affiliation form locks on `affiliation === "complete"` — submission is the only
> journey gate; the platform tracks no club payments.
