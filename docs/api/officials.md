# API — Officials (umpires and scorers): erase and self-registration

The umpire and scorer registers (`GET/POST/PATCH /umpires`, `/scorers`, merge, appointments)
gain two lifecycles: **erase** (an admin wipes an official's personal details but keeps an
anonymous stub so past appointments and ratings still resolve) and **self-registration** (an
official fills in their own details through a public link; the record waits as **pending**
until an admin approves or merges it).

Both registers follow the same contract; `:role` below is `umpire` or `scorer`, and error
codes are prefixed with the role (`umpire_erased`, `scorer_erased`, ...).

Status key: **live** is in the code now.

## Record fields (live)

Optional fields on both `Umpire` and `Scorer` (`packages/engine/src/umpires.ts`):

| Field         | Meaning                                                    |
| ------------- | ---------------------------------------------------------- |
| `pending`     | `true` on a self-registration awaiting approval            |
| `source`      | `'self-registration'` when created through the public link |
| `submittedAt` | When the registration was submitted (ISO)                  |
| `consentAt`   | When the person gave POPIA consent (ISO); carried on merge |
| `erasedAt`    | When an admin erased the record (ISO)                      |
| `erasedBy`    | Who erased it                                              |

Pending and erased records are **always `active: false`**, so every existing rule that refuses
an inactive official (appointment, the non-admin list) already excludes them.

## Guards on existing routes (live)

| Route                                                        | Refused with                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `PATCH /{umpires,scorers}/:id` on an erased record           | `409 <role>_erased`, for any field                                |
| `PATCH` with `active: true` on a pending one                 | `409 <role>_pending` (use Approve). Other edits are allowed.      |
| `POST /{umpires,scorers}/:id/merge`, source or target erased | `409 <role>_erased`                                               |
| Captain's report, substitute umpire id                       | `400 unknown umpire` when the registry entry is erased or pending |
| `POST /captains-reports/:id/umpires/:index/attribute`        | `400 unknown umpire` for erased or pending ids                    |

An umpire **appointed** to the fixture (from the report's `umpiresSnapshot`) always passes,
erased or not, so an open report naming an erased umpire can still be submitted.

## Appointment notices: held past fixtures (live)

The OfficialNotices cron HOLDS a still-`queued` ledger row whose fixture date is before the
tenant's today (SAST): nothing is sent, no attempt is counted and the row is not written
(`heldPast` in the run summary). Undated fixtures keep waiting; a `dateTbc` fixture is never
treated as past; a fixture re-dated to today or later sends normally. This stops a notice
that waited on missing contact details from announcing a match already played once a phone
or email is added. `GET /series/:id/officials/notify-status` returns `reason: 'expired'` for
such rows, DERIVED at read time and never stored (`status` stays `queued`); the only stored
reason is `'backfill'`. Type: `reason?: 'backfill' | 'expired'`.

## Lists

**Erased stubs (live).**
`GET /umpires` and `GET /scorers` (admin) keep returning erased stubs, flagged `erased: true`,
so name lookups and rating roll-ups still resolve. An erased stub carries only:

```json
{
  "id": "u-a-ngubane",
  "displayName": "Removed umpire",
  "active": false,
  "erased": true,
  "erasedAt": "...",
  "erasedBy": "...",
  "mergedInto": "..."
}
```

(Plus `createdAt`/`updatedAt`; `aliases: []` on umpires; `mergedInto` only when set.) No name, phone, email, ID number,
emergency contact or address. Clients hide stubs from every tab and from merge targets. The
club-facing umpire list (active only) never includes them.

**Pending records (live).** Pending records carry `pending: true` (plus `source`,
`submittedAt`, `consentAt`) and, for admins only, a ranked `possibleMatches` list and a
`pendingDuplicates` list:

```json
"possibleMatches": [
  { "id": "u-z-phone", "displayName": "Z.Phone", "reason": "phone" },
  { "id": "u-a-ngubane", "displayName": "A.Ngubane", "reason": "name" },
  { "id": "u-ayanda", "displayName": "Ayanda Ngubane", "reason": "surname-initial" }
]
```

`reason` is `'phone' | 'name' | 'surname-initial'`, best first, at most 5, drawn from active,
unmerged, unerased records only (`packages/engine/src/officialMatches.ts`). `name` is an exact
normalised match on display name, full name or (umpires) alias; `surname-initial` is the same
last name and first initial, so `A.Ngubane` meets `Andile Ngubane`. Nothing is preselected.

```json
"pendingDuplicates": [
  { "id": "u-a-ngubane-3f2a9c", "displayName": "A.Ngubane", "submittedAt": "2026-11-10T08:00:00.000Z" }
]
```

`pendingDuplicates` lists the OTHER pending, unerased records of the same role whose cell
matches this one's (compared as `0XXXXXXXXX`), oldest submission first; `[]` when none
(`findPendingDuplicates`). Same-cell submissions are never folded together, so the admin
decides which (if any) is genuine.

## Erase (live)

### `GET /{umpires,scorers}/:id/erase-preview` (admin)

```json
{
  "vacated": [
    { "seriesId": "...", "fixtureId": "...", "date": "2026-11-15", "label": "Home v Away" }
  ],
  "counts": { "today": 1, "upcoming": 4, "played": 12 }
}
```

### `DELETE /{umpires,scorers}/:id` (admin)

Erases the record and every record whose `mergedInto` chain ends at it
(`packages/api/src/official-erase.ts`). Fixtures dated tenant-today (SAST) or later, undated,
or `dateTbc` lose the official (vacated; an officials item left empty is deleted); played
fixtures keep the slot with the placeholder name (`Removed umpire` / `Removed scorer`).
Ledger rows on not-yet-played fixtures are deleted whatever their status; elsewhere only
unsent (queued/exhausted) rows go. For umpires, every captain's report naming the id has
`umpiresSnapshot[].name`, `umpires[].name` and `umpires[].attributed.freeTextName` rewritten;
a PENDING report on a not-yet-played fixture drops the snapshot entry and the matching card
instead. Ratings stay keyed to the id. Each run writes a PII-free `OFFICIALERASE#` audit row.

A pending record with no fixture, report or ledger reference is hard-deleted instead (this is
Reject; `hardDeleted: true`). Re-running on an already-erased record repeats every step and
keeps the first `erasedAt`, so a half-done erase completes. `404` for an unknown id.

```json
{ "erased": ["u-a-ngubane"], "hardDeleted": false, "vacated": [ ... as preview ... ] }
```

## Self-registration (live)

### Admin link — `/admin/official-signup-link/:role` (`role` = `umpire` | `scorer`)

One live link per role; the URL is `<app>/officials/register?t=<token>`. Responses are
`Cache-Control: no-store`; the audit log never records the token. Unknown role: `404`.

| Call     | Response                                                                               |
| -------- | -------------------------------------------------------------------------------------- |
| `GET`    | `{ "url": "..." , "createdAt": "..." }` or `{ "url": null }`                           |
| `POST`   | `{ "url": "...", "createdAt": "..." }`: mints, or rotates (the old token dies at once) |
| `DELETE` | `{ "ok": true }`: revokes; idempotent                                                  |

The pointer (`officialSignupLinks` on the tenant config) is server-owned: Settings saves strip
it, it never rides `GET /tenant` or `GET /tenant/config`, and tenant erasure deletes the
tokens.

### Public — `GET /official-signup?t=<token>`

`200 { "role": "umpire" | "scorer", "tenantName": "KZN Dolphins" }`. Missing token `400`;
unknown, rotated or revoked token `404 { "error": "invalid signup link" }`. The role always
comes from the token.

### Public — `POST /official-signup?t=<token>`

```json
{
  "firstNames": "Andile",
  "surname": "Ngubane",
  "phone": "082 123 4567",
  "email": "andile@example.org",
  "consent": true,
  "idNumber": "...",
  "emergencyPhone": "...",
  "address": "..."
}
```

Required: `firstNames`, `surname`, `phone` (a South African cell, stored `0XXXXXXXXX`) and
`consent: true`. `email` is optional; `idNumber`, `emergencyPhone` (a SA cell) and `address`
are read for scorers only. Names are whitespace-collapsed, each at most 60 characters.
`fullName` = `"<firstNames> <surname>"`; `displayName` = the full name for scorers, the sheet
form `A.Ngubane` for umpires. Failures are `400 { "error": "<message>" }`; more than
`OFFICIAL_SIGNUPS_PER_HOUR` (120) submissions per token per hour is `429`, and so is a NEW
submission once the role already has `MAX_PENDING_OFFICIALS` (300) pending records. The cap
counts every pending record, same-cell ones included.

The record lands `active: false, pending: true, source: 'self-registration'` with
`submittedAt` and `consentAt`. Every submission files its OWN pending record (an id suffix on
a name collision): a public submission never modifies an existing record, even one with the
same cell, so a link holder who knows someone's number cannot overwrite their registration.
Every accepted submission answers
`200 { "ok": true }`, whether or not the person is already on the register.

### Stale-review guard (approve and pending-merge)

Both calls below must echo the record's `submittedAt` as read: missing is `400 "submittedAt is
required"`; a different stored value is `409 { "code": "registration_changed" }` and nothing
is written. Re-read the list and review again. A resubmission no longer changes a record (it
creates a new one), so this now guards against concurrent admin actions only.

### `POST /{umpires,scorers}/:id/approve` (admin)

Body: `{ "submittedAt": "<as read>" }`. `200` with the record: `active: true`, `pending` removed, `source`/`submittedAt`/`consentAt`
kept. `409` codes: `umpire_not_pending` / `scorer_not_pending`; `umpire_erased` /
`scorer_erased`; on a clash with an active record `umpire_alias_taken` (`umpireId`,
`displayName`) or `scorer_name_taken` (`scorerId`, `displayName`).

### Merging a pending record — `POST /{umpires,scorers}/:id/merge` (admin)

When the SOURCE is pending the merge takes this path (a classic merge is unchanged). The
target must be active (`409` otherwise; `umpire_erased` / `scorer_erased` for a stub). Blank
target fields are filled from the submission (`fullName`, `phone`, `email`, and for scorers
`idNumber`, `emergencyPhone`, `address`); other held fields keep the target's value. Where
the target holds a **different** phone or email, the request must choose:

```json
{
  "targetId": "u-a-ngubane",
  "submittedAt": "<the pending record's submittedAt, as read>",
  "contact": { "phone": "source", "email": "target" }
}
```

Without a choice for a conflicting field the answer is:

```json
{
  "error": "choose which contact details to keep",
  "code": "contact_choice_required",
  "conflicts": [
    { "field": "email", "source": "andile@example.org", "target": "office@example.org" }
  ]
}
```

and nothing is written. A choice other than `source` / `target` is `400`. For umpires, a
filled-in `fullName` joins the target's alias set exactly as an Edit would (display + full
name over the target's existing aliases); if another active umpire already answers to it the
merge is `409 umpire_alias_taken` (`umpireId`, `displayName`) and nothing is written. No other
alias is moved from the source; `consentAt` and `source` are carried onto the target; the target is written, then the
pending source is hard-deleted. Response:

```json
{
  "target": { "...": "record" },
  "previous": { "phone": null, "email": "office@example.org" },
  "repointed": 0
}
```

`previous` holds the target's contact values before the merge (`null` when blank), so a wrong
merge can be undone.

### Reject

`DELETE /{umpires,scorers}/:id` on a pending record nobody references hard-deletes it
(`hardDeleted: true`), see Erase.

## Client (live)

`src/officialsAdmin.tsx` holds what the admin Umpires and Scorers pages share: erased stubs
are left out of every tab, count, picker and merge target (they stay in the list used for name
lookups and the umpire rating roll-up); Pending is its own tab with Approve, Merge into…
(candidates from `possibleMatches` first, nothing preselected; a `contact_choice_required`
reply opens a per-field choice dialog), Edit and Reject; Delete opens a confirm that loads
`erase-preview` and needs the display name typed; "Registration link" manages the per-role
link. The public form is `src/OfficialSignupPage.tsx` at `/officials/register`.
