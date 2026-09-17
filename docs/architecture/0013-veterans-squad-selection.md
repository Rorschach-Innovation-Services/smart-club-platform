# ADR 0013 — Veterans squad selection by request and confirm

**Status:** Accepted (September 2026). Phase 1.

## Context

Veterans cricket cuts across club boundaries. A veterans side is fielded by one club but drawn
from players who are registered — for their ordinary cricket — at many different clubs. The
union asked for a way for a veterans club to pick those players.

The nearest primitive already on the system is the **veterans second-club affiliation**
(`VETAFFIL#`, the capture-only "also plays veterans for" field on a player's record — see
[the data model](data-model.md) and the veterans-affiliation work). But that field is set by
the player's **own** club on its roster. It gives a veterans club no way to reach a player who
belongs to another club, and there is no concept of a squad, a request, or the other club's
agreement.

Letting a veterans club simply **add** any player it likes would be wrong on two counts. It
would let one club write onto another club's player relationship without consent, and — because
finding a player means searching names across the whole tenant — it would turn the roster into
a tenant-wide directory that any club could enumerate. Under POPIA the player's **primary club**
is the responsible party for that player's data; it must stay in the loop.

We wanted a consented, auditable way for a veterans club to select players from across the
tenant, without leaking the roster and without a heavyweight new transfer machine.

## Decision

**A veterans club _requests_ a player; the player's primary club _confirms_.** The veterans club
finds a player tenant-wide and opens a request; the primary club accepts it in one click. The
union admin may accept or decline as an override. Accept records the existing `VETAFFIL#`
affiliation — it never moves the player, adds a roster row, or changes any count.

### 1. Consent model — request / confirm

A veterans club can never claim another club's player unilaterally. Every affiliation this
feature writes passes through the primary club's confirmation (or a union override standing in
for it). Accept calls the **same** `repo.setPlayerVeteransClub` the capture-only register/edit
paths already use, so the `VETAFFIL#` write-on-activation invariant is untouched: no second
roster row, no `playerCount` change, no demographics or clearance effect.

### 2. The finder returns an opaque handle, never the natural key

Searching for a player is a tenant-wide name search, so it is where the roster could leak. Two
protections apply:

- **Data minimisation.** `repo.listPlayerFinderRows` reads a fixed `ProjectionExpression`
  (`sk, firstName, lastName, status, veteransClubId, team, clubId`) that never touches
  `idNumber`, `dob`, `cell` or `email`. Only the fields needed to show a name + primary club and
  apply the exclusions enter Lambda memory. A test asserts the projection so the field set can't
  quietly grow.
- **Opaque handle.** The finder returns a `candidateId` = `HMAC-SHA256(secret,
tenant|primaryClubId|naturalKey)` — never the natural key itself. It is irreversible and bound
  to the (tenant, primary club, player) triple, so it can only be redeemed against that club's
  rows when the request is created. The `naturalKey` is a sha256 identity hash (legacy rows may
  be plaintext), and an unkeyed hash of an SA ID is brute-forceable from a name plus an age
  guess — hence the keyed HMAC rather than handing the hash out directly.

The HMAC secret is a new `sst.Secret('CandidateHandleSecret')`, exposed to the API as
`CANDIDATE_HANDLE_SECRET` and read through `env.candidateHandleSecret()`. Like `FromEmail`, an
`sst.Secret` defaults to the empty string, so the accessor **fails closed** when it is unset
off-local (it throws, naming the `sst secret set` command); the offline/local stack
(`LOCAL_AUTH=1`) falls back to a fixed dev constant. **The secret must be set before deploy** —
see Consequences.

### 3. The finder gate is not self-grantable

`club.leagues` can be set by any rep on the affiliation form (the server accepts any catalogue
key), so it must **not** be what unlocks a tenant-wide name search. The finder 403s unless the
club is a **participant in a released series whose `leagueKey` is a veterans league**
(`clubFixturedInVeterans` → `listSeries` → `participants[].clubId`) — i.e. the union has actually
fixtured it into veterans cricket. The client-side `clubPlaysVeterans(club.leagues)` predicate
only drives nav visibility and is cosmetic; the server predicate is the authoritative gate. The
two use the same key/label regexes (`isVeteransLeague`), kept in sync between
`packages/api/src/veterans.ts` and `src/leagues.ts`, so a club never sees the nav yet 403s (or
the reverse). Every finder call is logged to CloudWatch (tenant, club, rep, query length, result
count) for the enumeration-risk audit trail. The finder also excludes the club's own players,
non-active rows, players already affiliated to a veterans club, and players already registered
in a veterans league; it caps results at 20 with a `truncated` flag and matches diacritics-
insensitively on "first last" / "last first".

### 4. Two items, mirroring the clearance layout

A request is stored as two items (see [the data model](data-model.md)):

- **Canonical**, under the player's **primary** club (`VETREQ#<id>`): carries the gsi1 entry for
  the admin listing **and** the `playerNaturalKey` the accept path needs to read the primary
  player row.
- **Mirror**, under the **veterans** club (`OUTBOUND_VETREQ#<id>`): **no gsi1** (so the admin
  lists each request once) and **no `playerNaturalKey`** (the requesting club only ever saw the
  opaque handle and must never receive the identity key).

Both partitions are a club's own, so a rep only ever queries their own pk. The public shape
returned by every route (`VeteransRequestPublic`) strips `playerNaturalKey`; the mirror already
lacks it, and the canonical is projected through `publicVeteransRequest` before it leaves the
API.

### 5. Accept is player-first and idempotent

`acceptVeteransRequest` reads the canonical (must be `pending`), then `getPlayer`, and 409s if
the player is missing, not an active row, or already affiliated to a **different** veterans club.
It then writes the affiliation via `setPlayerVeteransClub` (skipped when the row already points
at this veterans club — the retry-after-crash case) and only then flips the request to
`accepted` via `resolveVeteransRequest`. Player-first means a crash between the two steps leaves
a still-`pending` request that a retry completes; accept re-validates against the **live** player
row each time, so there are no hooks to add in the delete/clearance paths.

### 6. OCC on resolve; terminal rows self-expire

`resolveVeteransRequest` writes under a condition of `version = :v AND status = pending`, so a
stale version or an already-resolved request 409s rather than last-write-wins. Resolving sets a
90-day `expiresAt` (epoch-seconds TTL) on both rows, so terminal (accepted/declined/withdrawn)
requests self-expire; pending requests have no TTL.

### 7. Routes and notifications

The **club portal** routes (all `assertClubAccess`): `GET /clubs/:id/veterans-candidates?q=`
(the gated finder), `POST /clubs/:id/veterans-requests`, `GET /clubs/:id/veterans-requests`
(`{ inbound, outbound }`), `POST …/:rid/accept | decline` (the **primary** club), and
`POST …/:rid/withdraw` (the **veterans** club, which reads the mirror for the primary club id).
The **admin** routes: `GET /admin/veterans-requests`, and `POST /admin/veterans-requests/:rid/accept
| decline` carrying `{ primaryClubId, reason?, version? }` — recorded with `resolvedVia: 'admin'`.

All notifications are **email-only** (no WhatsApp/Meta template): opening a request emails the
primary chair; resolving it emails the veterans chair (both chairs on an admin override). Sends
are best-effort with an idempotency key and never fail the request.

## Consequences

- **Deploy step — set the secret before deploying.** The candidate-handle HMAC fails closed when
  `CANDIDATE_HANDLE_SECRET` is unset, so **before** the first deploy of this feature to a stage,
  run:

  ```sh
  sst secret set CandidateHandleSecret $(openssl rand -hex 32) --stage <stage>
  ```

  Set it on **dev** before the portal end-to-end test and on **prod** before the prod deploy.
  Rotating the secret invalidates outstanding finder handles (a new search re-issues them);
  stored requests are unaffected because they carry the resolved player, not the handle.

- **Depends on Group B (club-league sync).** The client nav predicate reads `club.leagues`, so
  the "Veterans squad" nav only appears in prod once the club-league sync has put the veterans
  keys onto the clubs. The server gate does not depend on it (it reads released series), so the
  feature is safe before the sync — the entry point is just hidden.
- **Residual enumeration risk.** The finder is a name search over the tenant. The gate (released-
  series participation), the 3-character minimum, the 20-row cap, the projection, and the
  CloudWatch audit log narrow it, but a fixtured veterans club can still probe names. This is an
  accepted residual risk for phase 1, logged for review; phase 2's player-OTP consent removes the
  need for the club to search at all.
- **No transaction-critical invariant.** Unlike a clearance, accept flips no player status and
  moves no row — it writes a capture-only affiliation. So the two-item write uses the ordinary
  create/resolve path (a transaction in prod, a single-sourced sequential fallback on dynalite,
  as `createClearance` does), with no rollback machinery beyond the idempotent player-first
  ordering.
- **Erasure covers both rows.** Tenant, cohort and single-club erasure enumerate `VETREQ#` and
  `OUTBOUND_VETREQ#` alongside `VETAFFIL#`; single-club erasure deletes each request's counterpart
  row under the other club in both directions, as it does for clearances.

## Rejected alternatives

- **Direct add (a veterans club sets the affiliation itself).** No consent from the primary club
  and it leaks club membership — the whole reason for request/confirm.
- **Player-OTP consent.** The cleanest consent model, but roster rows often lack a verified cell
  or email, so it can't be relied on yet. Deferred to phase 2.
- **A single row plus a gsi1 for the veterans club's list.** Breaks the own-partition read
  guarantee (a club would query a shared index for its outbound requests). The canonical +
  mirror keeps every read on the club's own pk.
- **Reuse the clearance machinery.** Far too heavy — clearances move a registration between
  clubs with a transactional player swap, ±count, snapshots and reversibility. A veterans request
  writes a capture-only affiliation and needs none of it.
- **Gate the finder on `club.leagues`.** Self-grantable on the affiliation form, so it would make
  a tenant-wide name search available to any club. Gated on released-series participation
  instead.
- **Age eligibility on accept.** Veterans age rules are not encoded anywhere on the system, so
  the request/confirm flow does not enforce them; the union confirms eligibility off-system.
  Future work.

## Future work

- **Phase 2 — player-OTP consent** so a player confirms their own affiliation and the veterans
  club need not search the roster at all.
- **Encoded age eligibility**, so accept can validate a veterans player's age rather than leaving
  it to the union.
- **A squad view** on top of accepted affiliations, once clubs have enough of them to manage as a
  team rather than a list.
