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
- `cqi` must be a number in [0, 100]; `cqiAnswers` a flat object of scalar values
  (≤60 keys, strings ≤200 chars) → `400` otherwise.
- Send the current `version`; mismatch → `409 "club changed; refetch"`.

```
200 → Club   403 locked / wrong club   404   409 version conflict
```

## `POST /clubs/:id/exco` — save exec committee (rep: own only)

Body: the exco object (`chair`, `sec`, `tre`, `vc`, `additionalMembers`). Also sets
`docs.exco = true`, but ONLY when the tenant's catalogue defines `exco` with
`kind: "form"` — a tenant whose committee doc is a file upload must not have the form
save satisfy it (ADR 0009). `200 → Club`.

## Compliance documents — per-tenant catalogue

Valid `:key` values come from the tenant's own catalogue (`TenantConfig.requiredDocs`,
served on `GET /tenant`), not a fixed list; a tenant with no explicit catalogue resolves
to the shared defaults (`constitution`, `agm`, `financials`, `exco`, `codeOfConduct`,
`safeguarding`). Each entry declares its own behaviour — `kind` (`file`/`form`),
`multiFile` + `minFiles`/`maxFiles`, the `allowUnavailable` / `allowMeetingBooked` /
`allowCourseBooked` escape hatches, `accepts` (any of `pdf, doc, docx, xls, xlsx, ods`;
absent ⇒ PDF/Word), and `archived`. See ADR 0009.

New uploads require an **active, non-form** catalogue entry. Reads and deletes accept
the catalogue **∪ keys already stored on the club**, so a retired or archived key's file
stays viewable and removable — that is the cleanup path.

## `POST /clubs/:id/docs/:key/upload-url` — presigned upload

Body: `{ contentType? }` — must be one of the doc's accepted types (absent ⇒ PDF).
Returns a 5-minute S3 presigned PUT; the client must PUT with exactly this Content-Type.

```
200 → { uploadUrl, objectKey, contentType }   400 unknown key / type not accepted
```

Client uploads the file directly to `uploadUrl`, then calls the next route.

## `PATCH /clubs/:id/docs/:key` — mark uploaded

Body: `{ objectKey, size, contentType? }` (max 10 MB). Sets `docs[key] = true` and
records `docMeta[key]`. Single-file docs store `{ objectKey, size, contentType,
uploadedAt }`, replacing (and best-effort deleting) any previous object. Multi-file docs
APPEND into `{ files: [...] }` and only flip `docs[key]` at the doc's `minFiles`
threshold, capped at `maxFiles`. `200 → Club`.

## `DELETE /clubs/:id/docs/:key/file` — remove one stored file

Body `{ objectKey }`, which must be the key ON RECORD for this doc (that check is the
security gate — it is what stops an arbitrary bucket key being deleted). Best-effort
deletes the S3 object after the record write lands.

Multi-file docs drop the named file and recompute `docs[key]` from what remains; an admin
override or a booked course keeps the doc satisfied. Single-file docs drop the whole
record (preserving an admin override if one was set) — this is the **only** way to clear
one, since upload replaces but never removes, and without it an archived single-file doc
could never be cleaned up (ADR 0009). `200 → Club   404 no such file on record`.

## `POST /clubs/:id/docs/:key/view-url` — presigned preview

Body: `{ objectKey? }` (required to disambiguate a multi-file doc; the key must be ON
RECORD — that check is the security gate). Returns a 15-minute presigned GET.
`200 → { viewUrl }   404 no file on record`.

## `POST /clubs/:id/reg-link` — issue a registration link

Generates a server-side `crypto.randomUUID()` token, stores `TOKEN#<token> → {tenant,
clubId}`, and sets `club.playerRegLink`. `200 → { playerRegLink: { token, createdAt } }`.

> The affiliation form locks on `affiliation === "complete"` — submission is the only
> journey gate; the platform tracks no club payments.
