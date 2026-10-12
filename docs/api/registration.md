# API — Player registration

Two ways onto a club's roster, one set of rules. Members self-register through a **public
link**; club chairs register players **from the portal** (one at a time, a quick-add grid,
or a spreadsheet). Every path runs through the same clearance-aware core,
`registerPlayerForClub` (`packages/api/src/register-player.ts`), so a player already
registered at another club opens a clearance whichever way they come in.

Registrations drive the derived `club.players` count.

## Identity and the shared core

The core enforces only the **identity minimum**: `firstName` + `lastName`, and either

- `idType: "sa-id"` (the default) with a 13-digit RSA ID. `dob` is derived from the ID and
  never trusted from the client; or
- `idType: "passport"` with a passport/visa number **and** a `dob` (`YYYY-MM-DD`, not in
  the future).

Anything less is `400 "provide a valid 13-digit RSA ID, or a passport/visa number with date of birth"`.
The rest of the required set is each route's own contract (below).

The row is keyed by a `naturalKey`: a hash of `sa-id-<id>`, or
`passport-<nationality>-<id>` for passports. `isMinor` (under 18) is computed from `dob`;
`consentAt`/`createdAt`, `registeredVia` (`link` | `portal`) and, on portal paths,
`registeredBy` are stamped server-side.

Before writing, the core looks up where this identity is **already** registered across the
tenant. That lookup, not the club the player named, decides the outcome:

| Situation                                                | Result                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active at another club                                   | Row created `clearance-pending` + a registration-origin clearance **from that club**. If they named a different club, the clearance `note` records the mismatch. |
| Already `clearance-pending` elsewhere                    | `clearance-already-open`; nothing written.                                                                                                                       |
| Already on the destination roster                        | `duplicate` (or `clearance-already-open` if that row is still pending); nothing written.                                                                         |
| Nowhere else, declared an on-system previous club        | `clearance-pending` row + a sourceless clearance from that club (roster absence isn't evidence the transfer is fake).                                            |
| Nowhere else, declared a club-directory entry            | The same, flagged `fromClubDirectory` for the Union office to approve or reallocate.                                                                             |
| Nowhere else, no previous club                           | Plain `active` row.                                                                                                                                              |
| Nowhere else, free-text "Other" club with no exact match | `active` row + a best-effort off-system registration review (`review-opened`).                                                                                   |

An exact on-system club name typed into "Other" (`lastClub`) is promoted to `lastClubId`
first, so it takes the clearance path rather than the free-text one. `"—"` means "first
registration" and raises nothing. A declared previous club that has since been removed is
`400 "that previous club is no longer listed — please re-select it"`.

With the tenant's **clearances module off**, the row always lands `active`: a registration
elsewhere is noted on `transferNote`/`lastClub`, never touched, and no clearance or review is
opened. See [clearances.md](clearances.md) for what happens to an opened clearance.

## Public link

Open to the world (alongside the club-signup routes, see [signup.md](signup.md)). A union
admin/rep issues a link (`POST /clubs/:id/reg-link`) and shares it; members register without
an account. The token is global and **self-describes its tenant**, so these routes never
trust the request host for authorization. See
[ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md).

### `GET /register/:clubId?t=<token>` — validate a link

```
200 → { tenant, clubId, clubName, leagues, districts, clubs }
400 → missing token
404 → invalid registration link / club not found
```

`leagues` populates the Team dropdown, `districts` the District dropdown, and `clubs` the
"club for which last registered" dropdown: every other club as `{ id, name }`, plus
club-directory entries (real clubs not on the system yet) as `{ id, name, directory: true }`.

### `POST /register/:clubId/id-doc/upload-url?t=<token>` — presign the ID document

Body `{ contentType }` (JPEG, PNG or PDF; anything else falls back to PDF).
`200 → { uploadUrl, objectKey, contentType }`. The PUT URL expires after 5 minutes.

### `POST /register/:clubId?t=<token>` — submit a registration

Same field set as the chair's single form (below), plus a **required** `idDocMeta`
`{ objectKey, size, contentType }` from the presign step (non-empty, under 5 MB, image or
PDF, and minted for this link's club). Two link-only fields:

- `currentClubId`: register onto a club **other than** the link's club. The link club still
  owns the token, rate limit and ID-doc key.
- `lastClubId`: the previous club (an on-system id or a directory id). It can't equal
  `currentClubId` unless both are the link club, which is a re-registration.

Names are whitespace-collapsed and capped at 60 characters.

```
201 → { ok: true }                                  plain registration (or review raised)
201 → { ok: true, clearance: { fromClubName } }     a clearance was opened
400 → missing fields / identity / guardian / ID document / unknown team, club or position
404 → invalid registration link / club not found
409 → already registered or a transfer is already in progress
429 → rate limited
```

The `409` is deliberately one message for every conflict, so an anonymous caller can't use the
route to learn whether an ID is registered or mid-transfer. Three hourly caps stack on it:
240 per token (shared with the presign route), 30 inbound per destination club when
`currentClubId` differs from the link club, and 60 per named on-system previous club, which is
only charged when a clearance actually opens.

## Chair registration (portal)

Authenticated; a rep may only act on their own club, an admin on any club in the tenant. Rows
are stamped `registeredVia: "portal"` and `registeredBy: <email>`.

### `POST /clubs/:id/players` — register one player

The Union form, field for field:

```jsonc
{
  "firstName": "…", // required
  "lastName": "…", // required
  "idType": "sa-id", // or "passport"; default "sa-id"
  "idNumber": "…", // required (RSA ID or passport number)
  "dob": "YYYY-MM-DD", // passport only; derived from an RSA ID
  "race": "…", // required
  "gender": "…", // required
  "nationality": "…", // required
  "cell": "…", // required
  "team": "<league key>", // required; not a fixtures-only competition
  "district": "…", // required
  "guardianName": "…", // REQUIRED if the player is a minor (POPIA)
  "email": "…", // optional
  "postalAddress": "…", // optional
  "postalCode": "…", // optional
  "lastClubId": "<club or directory id>", // optional previous club
  "lastClub": "…", // optional free-text previous club ("Other")
  "veteransClubId": "…", // optional, veterans module only
  "position": "…", // positions-profile verticals only
  // cricket profile: battingHand, bowlingHand, battingType, bowlerType, isAllRounder, isWk
}
```

Blank strings count as missing. `veteransClubId` is silently dropped when the veterans module
is off; `position` is ignored on a cricket tenant and checked against the vertical's list
otherwise.

```
201 → { ...player, outcome, clearance? }
400 → missing required fields / identity / guardian / unknown team or position
404 → club not found
409 → a player with these details is already registered for this club
409 → a clearance for this player is already in progress
```

`outcome` is `created`, `review-opened` or `clearance-opened`. On `clearance-opened` the
response adds `clearance: { id, fromClubId, fromClubName }` and the row is
`clearance-pending`. The ID document is attached afterwards through
`POST /clubs/:id/players/:nk/id-doc/upload-url`.

### Bulk routes: quick-add and spreadsheet

Both bulk routes deliberately **relax** the required set to the identity minimum. Cell,
district, race, team, guardian name and (for SA IDs) nationality are optional, because a
club's historical register usually lacks them; the chair fills them in per player afterwards.
Any gender, race or team that _is_ supplied is still validated (canonical gender/race sets,
tenant league keys).

Rows are processed in submitted order, each through the core, so a row registered elsewhere
opens a clearance exactly as a single registration would. One bad row never aborts the
request; each gets its own result:

```jsonc
{
  "results": [
    {
      "index": 0, // position in the request
      "rowNumber": 4, // roster commit only
      "sheet": "Players", // roster commit only
      "outcome": "created", // | clearance-opened | clearance-already-open | skipped-duplicate | error
      "naturalKey": "…",
      "fromClubName": "…", // clearance-opened
      "error": "…", // error
    },
  ],
  "summary": {
    "created": 0,
    "clearance-opened": 0,
    "clearance-already-open": 0,
    "skipped-duplicate": 0,
    "error": 0,
  },
  "playerCount": 42, // the club's reconciled count, once per request
}
```

Re-sending rows is idempotent: a player already on the roster comes back
`skipped-duplicate`, and one whose transfer an earlier request opened comes back
`clearance-already-open`. Both routes respond `200` with `Cache-Control: no-store`.

### `POST /clubs/:id/players/batch` — quick-add grid

Body `{ rows: [...] }`, 1–25 rows. Each row is `{ firstName, lastName, idNumber, gender?,
race?, team? }` for an RSA ID, which must pass the Luhn check, or
`{ idType: "passport", idNumber, nationality, dob, ... }` for a passport. Names are capped at
80 characters. `400` if `rows` is empty or over the cap.

### `POST /clubs/:id/roster/parse` — read a spreadsheet (no writes)

Upload as `multipart/form-data` (`file` = the `.xlsx`, optional `ageGroupMap` as a JSON
string), or JSON `{ dataBase64, ageGroupMap? }`. 2 MB cap; a legacy `.xls` is rejected with a
"save it as .xlsx" message.

Uses the operator roster-intake parser with the club forced to `:id`. It is strict on
identity: a row without a valid RSA ID becomes an exception, never a dob-only row. A blank Age
Group cell means a senior player. `ageGroupMap` maps raw age-group labels to the tenant's
junior league keys. The response mirrors the operator intake parse
(`{ parseable, sheets[], dobOnlyCount, juniorLeagueKeys, ageGroupRaws }`, each sheet with
`rows`, `exceptions` and unrecognised gender/race values), plus a `conflict` on each row the
chair should see before committing:

- `{ type: "in-club-duplicate" }`: already on this roster; commit will skip it.
- `{ type: "cross-club", clubId, clubName, status }`: registered at another club. `active`
  means commit opens a clearance from that club; `clearance-pending` means a transfer is
  already in flight.

### `POST /clubs/:id/roster/commit` — commit one chunk of reviewed rows

Body `{ items: [{ rowNumber, firstName, lastName, dob, idNumber, gender?, race?, team?,
sheet? }] }`, 1–50 items. The client sends chunks one after another, so a dropped connection
loses at most one chunk and a retry is safe. Any `clubId` on an item is ignored. Each item is
validated like the operator intake (`rowNumber` present, Luhn-valid ID, `dob` matching the ID,
known gender/race/team) and must carry an `idNumber`. Results use the bulk shape above.

### Roster template

`public/roster-template.xlsx`, served at `/roster-template.xlsx` and linked from the portal's
upload step. The **Players** sheet has the columns Player First Name, Player Surname, ID
Number, Date of Birth (optional when the ID is filled in), Gender, Race and Age Group (juniors
only, e.g. `U11`; blank for seniors). A second sheet, **How to fill this in**, explains each
column. `packages/api/test/roster-template.test.ts` parses the template, so it can't drift
from the parser.

## Privacy

- **Consent:** `consentAt` is stamped server-side on every path. See
  [popia-compliance.md](../guides/popia-compliance.md).
- **Minors:** the single-player routes (public and chair) reject a minor without
  `guardianName` (`400 "guardianName required for minors (POPIA)"`). The bulk routes don't
  require it; the chair completes it per player.
- **PII responses:** the roster parse and both bulk routes send `Cache-Control: no-store`.
