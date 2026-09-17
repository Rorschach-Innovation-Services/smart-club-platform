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

## Veterans squad selection

Veterans cricket is cross-club: a veterans side is fielded by one club but drawn from players
registered at many. These routes let a veterans club **request** a player and the player's
**primary** club **confirm** — see [ADR 0013](../architecture/0013-veterans-squad-selection.md).
Accept records the capture-only second-club affiliation (`VETAFFIL#`); it never moves the
player, adds a roster row, or changes any count.

### `PUT /clubs/:id/players/:nk/veterans-club` — set affiliation (own club / admin)

The player's **own** club sets the second club they play veterans cricket for (the capture-only
path — the roster field, not the request flow). Body `{ veteransClubId }` (required, non-empty).
The value is resolved to a real club and must not be the player's own club.

```
200 → PlayerRegistration   400 veteransClubId required   403 wrong club   404 player not found   409 player changed; refetch
```

### `DELETE /clubs/:id/players/:nk/veterans-club` — clear affiliation (own club / admin)

Clears the affiliation. `200 → PlayerRegistration   403 wrong club   404 player not found   409 player changed; refetch`.

### `GET /clubs/:id/veterans-affiliates` — list affiliates (own club / admin)

Players from **other** clubs who play veterans cricket for this club. The projection **omits**
`naturalKey` (the veterans club is not the player's own club and must not see that PII). Removal
of a bogus declaration stays with the union / primary club. `200 → VeteransAffiliatePublic[]`.

### `GET /clubs/:id/veterans-candidates?q=` — finder (own club / admin)

Search players tenant-wide to request for veterans cricket. **Gated**: 403 unless this club is a
participant in a **released veterans series** (not gated on `club.leagues`, which any rep can
set). Requires `q` ≥ 3 characters. Returns only an opaque `candidateId` HMAC handle + display
name + primary club — never the natural key, ID number, dob or contact. Excludes the club's own
players, non-active rows, players already affiliated to a veterans club, and players already in a
veterans league. Capped at 20 with a `truncated` flag. Every call is logged to CloudWatch.

```
200 → { candidates: VeteransCandidate[]; truncated: boolean }
400 → search needs at least 3 characters
403 → club is not entered in a released veterans series
```

### `POST /clubs/:id/veterans-requests` — open a request (veterans club)

Body `{ primaryClubId, candidateId, leagueKey?, note? }`. Resolves the opaque `candidateId` back
to a player over the primary club's projected rows, re-runs the finder exclusions, and 409s a
duplicate pending request for the same player. `201 → VeteransRequestPublic` (no natural key);
the primary chair is emailed.

### `GET /clubs/:id/veterans-requests` — list a club's requests (own club / admin)

`200 → { inbound: VeteransRequestPublic[]; outbound: VeteransRequestPublic[] }` — `inbound` are
the requests this club must action (it is the primary club), `outbound` the requests it has sent
(it is the veterans club).

### `POST /clubs/:id/veterans-requests/:rid/accept | decline` — primary club resolves

The player's **primary** club confirms or declines. Decline body `{ reason?, version? }`; accept
body `{ version? }`. Accept re-validates against the live player row and writes the affiliation.
The veterans chair is emailed the outcome. `resolvedVia: 'portal'`.

### `POST /clubs/:id/veterans-requests/:rid/withdraw` — veterans club withdraws

The **veterans** club retracts its own pending request (it reads the mirror for the primary club
id). `200 → VeteransRequestPublic`.

**Error table (request-resolution routes):**

| Status | When                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Admin route missing `primaryClubId`                                                                                                                                                                                             |
| `403`  | A rep acting on a club that is not theirs                                                                                                                                                                                       |
| `404`  | The request id does not exist (`veterans request not found`)                                                                                                                                                                    |
| `409`  | Stale `version`, or the request is already resolved (`veterans request already resolved`), or (accept only) the player is no longer registered / not active / already plays veterans for another club — show the server message |

### Admin overrides

`GET /admin/veterans-requests` → `VeteransRequestPublic[]` (every request once, via the canonical
gsi1). `POST /admin/veterans-requests/:rid/accept | decline` carry `{ primaryClubId, reason?,
version? }`, resolve with `resolvedVia: 'admin'`, and email **both** chairs. Same error table
(plus `400` when `primaryClubId` is absent).
