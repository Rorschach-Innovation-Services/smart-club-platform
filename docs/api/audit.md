# API — Audit trail

Every change made through the API by a person (signed in, or through a public link), plus link
copies and person-triggered message sends, leaves one **audit entry**: who, when, which action,
which records. Union admins read their own union's entries; platform operators read every
union's entries and the platform-level ones. Design and reasoning: ADR 0023
(`docs/architecture/0023-audit-trail.md`).

Status key: **live** is in the code now. Phase 1 recorded who / when / action / record;
Phases 2–3 added field-level old → new values area by area, and every area now has them:
officials (umpires, scorers, fixture appointments), team & access, tenant settings, clubs and
club documents, players and registration, clearances, series and fixtures, competitions,
season runs, venues, postponements, captain's reports, squads and team captains, document
requests, the Match Centre console and the operator portal's imports. See those sections.

## Entry shape (live)

```ts
AuditEntry {
  id: string;                  // uuid
  at: string;                  // ISO instant the request started
  tenant: string;              // union slug, or '*' for platform actions with no union
  requestId?: string;          // API Gateway request id
  actor: AuditActor;
  action: string;              // dotted, e.g. 'umpire.update', 'link.copy', 'player.erase'
  route?: { method: string; pattern: string };   // the route PATTERN, never the raw path
  status: number;              // HTTP status (0 on a 'started' headline)
  outcome: 'started' | 'ok' | 'failed';
  visibility: 'tenant' | 'operator';
  targets: AuditTargetHead[];  // ≤ 25
  counts?: Record<string, number>;   // e.g. { sent, failed, skipped } on a message send
  truncated?: { targets?, changes?, mentions?, values?, rows?, detail? };
  expiresAt: number;           // TTL, epoch seconds (at + 730 days)
}

AuditActor {
  kind: 'user' | 'link' | 'system';
  key: string;                 // signed in: the Cognito sub; link: 'link:<kind>:<recipient|request|shared>'
  sub?: string;
  email?: string;              // snapshot at the time; never stored as ''
  role?: string;               // the membership role in that union ('admin', 'club', …)
  operator?: true;             // holds the platform operator membership
  via: string;                 // 'console' | 'platform' | the link kind
  recipientKind?: string;      // link actors: 'chair' | 'captain' | 'player' …
  recipientId?: string;        // link actors: the recipient's opaque member id
}

AuditTargetHead {
  type: string;   // club, player, clearance, registration-review, club-invite,
                  // veterans-affiliation, veterans-request, postponement, series, fixture,
                  // season-run, fixture-result, scorecard, fixture-officials, captains-report,
                  // squad-request, doc-request, umpire, scorer, user, tenant-config, venue,
                  // competition, signup-link, tenant
  id: string;     // the record id; '' once an erasure blanked it (a player's natural key)
  label?: string;
  op: string;     // 'update', 'merge', 'copy', 'submit' …
  clubId?: string;
  clubIds?: string[]; // a label naming clubs (`<home> v <away>`): the club behind each side,
                      // in label order ('' = no club record, e.g. a typed opponent)
  changeCount: number;
  scrubbed?: true;   // an erasure stripped this target's label and values
}
```

The detail (`GET …/entry/:at/:id`) adds per-target field changes and mentions:

```ts
AuditDetail {
  targets: Array<{ type, id, changes: AuditChange[] }>;
  mentions: Array<{ type, id, label?, clubId? }>;   // e.g. the other side of a merge; clubId:
                                                     // the club the record was on (a player)
}
AuditChange { field, from?, to?, masked?: true, ref?: {type, id}, fromRef?: {type, id}, scrubbed?: true }
```

### What is never stored

- Tokens, query strings and raw paths. A route is stored by its pattern (`/umpires/:id`); link
  routes carry the token in the path or `?t=`, and neither reaches a row. `DELETE
/admin/players/:nk` does not store the natural key.
- Masked fields are recorded as changed with no value: ID number, passport number, addresses
  (a player's postal address, a club's ground addresses, a venue's address, an organisation
  contact's address; a club's named side is recorded by its name only), date of birth,
  emergency contact, document keys and metadata, committee members' details, and free text
  (notes, comments, report text).
- Link actors never carry a person's name or contact. A captain's-report or squad link names
  the recipient by their opaque member id; a document-request link by its random request id;
  self-registration links are `…:shared`.

### What is recorded

- **Signed-in changes:** every POST / PUT / PATCH / DELETE that returns 2xx (`ok`) or 5xx
  (`failed`). A plain 4xx writes nothing unless the handler had already recorded something
  (then `failed`).
- **Creates name the record created:** a create route's entry carries the new record as a
  target with `op: 'create'`, so it is in that record's history: umpires, scorers,
  series (also a duplicate), competitions, season runs, staff users (console and operator
  portal), captain's reports, a club from self-signup or the operator portal, a new client
  (`tenant`, written to that client's own partition, operator-only), players registered
  (with the clearance or registration review the registration opened), clearances,
  postponements, veterans requests and document requests. A bulk create (roster commit,
  quick-add, appointments confirm) names the first 25 records and carries `counts`.
- **Labels before field diffs:** where the handler already holds the record, the target
  carries its name as `label`: clubs (created or edited: the club name), team members
  (invited, edited, removed, invite resent, email corrected: the email) — these two also
  carry field changes now, see below — venues (saved, deleted: the name), series (created,
  duplicated, edited, deleted: the name), competitions (created, edited, regenerated,
  advanced, deleted: the name) and season runs (created, edited, generated, rebased,
  deleted: `<leagueKey> <season>`, e.g. `premier 2026/27`). All of these carry field
  changes too (sections below). Erasure strips labels as below.
- **A `started` entry** reads "In progress" in the console for its first 60 seconds and "Did
  not finish" after that (the request never wrote its final entry).
- **Link copies:** `GET /captains-reports/:id/link`, `GET /admin/squad-requests/:id/link`,
  `POST /admin/doc-requests/link` (`link.copy`); signup links minted or revoked
  (`link.mint` / `link.revoke`).
- **Public links:** player registration, club signup, official signup, captain's-report save /
  submit / forward, squad save / forward, document-request completion. Opening a link (a GET)
  writes nothing.
- **Message sends a person triggers:** fixtures to a club, clearance reminders, squad resends,
  staff invite resends, document requests. `counts` carries `sent` / `failed` / `skipped`
  where the handler knows them.
- **Long or destructive operations** (merges, erasures, imports, intake commits, roster commit,
  appointments confirm, fixture-amendments confirm, rebase, regenerate, stage generate, series
  and competition deletes, Match Centre reconcile) first write a `started` headline, which the
  final entry replaces (same id and instant; its union and actor are fixed from then on). A
  request that never finished (a Lambda timeout) leaves the `started` row. A request refused
  with 400, 401, 403 or 404 before its handler recorded anything (a club rep's 403, a missing
  record, a validation error) deletes its `started` row again, so it leaves no entry, like any
  plain refusal. Any other 4xx (a 409 conflict, say) closes the entry as `failed`, because it
  can follow a write the handler had already made; the handlers that know they wrote before a
  refusal (stage generate, an official's or a player's erase) record it explicitly too.
- **Not recorded:** presign / view-url / parse / preview / clash-hint routes, the WhatsApp
  status webhook, `PATCH /me`, `POST /admin/export-log` (it has its own `EXPORT#` row). The
  full per-route list is `packages/api/src/audit-routes.ts`. Exception: viewing a clearance
  certificate that was never issued issues it, and that view is recorded as
  `clearance.certificate.issue`.
- **When the table refuses an entry** (an over-size key, say), it is retried once as the
  headline alone: no targets or detail, `truncated.rows` counting what was dropped.

## Officials (live)

Umpire and scorer entries carry old → new values (`packages/api/src/index.ts`, officials
block). Diffed fields: `displayName`, `fullName`, `aliases` (umpires), `phone`, `email`,
`active`, `pending`, `mergedInto` (with a `ref` to the record merged into), and for scorers
`idNumber`, `emergencyPhone`, `address` — those three always **masked** (`{ field, masked:
true }`, never a value). Timestamps and the signup bookkeeping (`source`, `submittedAt`,
`consentAt`) are not diffed. A field absent before or after has no `from` / `to`.

| Action                              | Targets (`op`, label)                                                                                | Changes                                                             | Also                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `umpire.create` / `scorer.create`   | the record (`create`, display name)                                                                  | every set field, from nothing                                       |                                                                            |
| `official.signup` (public link)     | the pending record (`create`, display name)                                                          | as create, plus `active: false`, `pending: true`                    | actor `link:official-signup:shared`                                        |
| `umpire.update` / `scorer.update`   | the record (`update`, display name after)                                                            | the diff; none when nothing changed (`changeCount: 0`)              |                                                                            |
| `umpire.approve` / `scorer.approve` | the record (`approve`)                                                                               | `active` false → true, `pending` true → absent                      |                                                                            |
| `umpire.merge` / `scorer.merge`     | the survivor (`merge`, its changes: aliases gained, contacts filled) and the source (`merge-source`) | source: `active` → false, `mergedInto` (ref), umpire `aliases` → [] | mentions both people; `counts: { repointed }`                              |
| `…merge` of a pending submission    | the survivor (`merge`: contacts / full name filled) and the submission (`delete`, no label)          | survivor's filled fields (scorer ID fields masked)                  | mentions both (the submission without a label); `counts: { repointed: 0 }` |
| `fixture-officials.set`             | `fixture-officials` `<seriesId>#<fixtureId>` (`set`, no label)                                       | see below                                                           |                                                                            |
| `umpire.delete` / `scorer.delete`   | the record (`erase`, or `delete` for a rejected pending one); **no label**                           | none                                                                | `counts: { records, vacated, renamed, ledger, reports }` — no names        |

Both records of a merge are targets, so the merge shows in each record's history.

A **pending submission** merged into an existing record is deleted, so it never joins a later
erase of the survivor. Its own entries (the signup, any edits) therefore lose its names and
values when it is merged, just before the delete (as a Reject does), and the merge entry names
it by id only. If the delete is then refused (the person resubmitted meanwhile: 409
`registration_changed`), the survivor is already written: the merge entry stays as `failed`
and the submission's earlier entries stay scrubbed.

**Merge residue.** A survivor keeps what a merge gave it — an umpire's aliases from the merged
duplicate, contacts and full name filled from a pending submission — in the live register and
in the merge entry's survivor changes alike. Erasing only the merged duplicate (its erase set
is the duplicate and anything merged into it, never the survivor) strips the duplicate's own
targets and mentions but leaves those gained values on the survivor's side of the entry, just
as they stay on the survivor's record. They go when the survivor is erased.

**Fixture appointments** are names with a `ref` to the official's record, so the appointment
shows in that umpire's / scorer's history and an erasure finds it. Umpires are a set — one
change per umpire added (`to`) or removed (`from`), field `umpires`. The referee, scorer and
backup scorer are slots (fields `referee`, `scorer`, `backupScorer`): `from` / `to` are the
previous and new holder's names, `ref` the new holder (or the removed one when the slot is
emptied) and `fromRef` the previous holder when the slot changes hands. Re-saving the same
officials records the entry with no changes.

Example `GET /admin/audit/entry/:at/:id` for an edit (`umpire.update`):

```json
{
  "entry": {
    "id": "6f1c…",
    "at": "2026-11-02T09:14:03.120Z",
    "tenant": "dolphins",
    "actor": {
      "kind": "user",
      "key": "<sub>",
      "sub": "<sub>",
      "email": "b@union.org",
      "role": "admin",
      "via": "console"
    },
    "action": "umpire.update",
    "route": { "method": "PATCH", "pattern": "/umpires/:id" },
    "status": 200,
    "outcome": "ok",
    "visibility": "tenant",
    "targets": [
      { "type": "umpire", "id": "u-a-dende", "label": "M.Jooma", "op": "update", "changeCount": 3 }
    ],
    "expiresAt": 1825147243
  },
  "detail": {
    "targets": [
      {
        "type": "umpire",
        "id": "u-a-dende",
        "changes": [
          { "field": "displayName", "from": "A.Dende", "to": "M.Jooma" },
          { "field": "fullName", "to": "Muhammad Jooma" },
          { "field": "aliases", "from": ["adende"], "to": ["mjooma", "muhammadjooma", "adende"] }
        ]
      }
    ],
    "mentions": []
  }
}
```

`detail` is `null` when the entry has no changes and no mentions. After an erasure the same
entry reads `{ "field": "displayName", "scrubbed": true }` (values gone) and the target loses
its `label` and gains `"scrubbed": true`; the record id stays. The erasing request's own entry
(`umpire.delete`, `scorer.delete`, `club.delete`, `player.erase`) is stored the same way: its
target of the erased type has no label and `"scrubbed": true`, so the console reads "Removed"
rather than the record id.

## Team & access (live)

`user` targets (id: the Cognito sub, label: the email) carry the membership in this union,
before → after (`packages/api/src/audit-records.ts`, `membershipChanges`). Fields: `email`
(on an invite of a new account, and the correction), `role`, and `clubIds` — **one change per
club** added (`to`) or removed (`from`), the club's name as the value and a `ref` to the club.
The `ref` puts the change in that club's history (`GET …/audit/entity/club/:id`) and gives the
entry a club pointer, so deleting the club strips the name. Nothing is masked here.

| Action                                    | Target (`op`)       | Changes                                                                                                              |
| ----------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `user.invite` (`POST /admin/users`)       | the user (`create`) | `email` (new account only), `role`, `clubIds` added; a re-invite of a pending member diffs from their old membership |
| `user.update` (`PATCH /admin/users/:sub`) | `update`            | `role` and `clubIds` before → after; none when nothing changed (`changeCount: 0`)                                    |
| `user.email-change`                       | `email-change`      | `email` old → new (label: the new address)                                                                           |
| `user.delete`                             | `delete`            | `role` and every `clubIds` the member had, as `from`                                                                 |
| `user.invite-resend`                      | `invite-resend`     | none; `counts: { sent, failed, skipped }`                                                                            |
| `user.invite-rep` (operator portal)       | `create`            | as `user.invite` (`role: rep`); operator-only                                                                        |
| `user.invite-admin` (operator portal)     | `create`            | `email` (new account only), `role` → `admin`, any rep clubs removed; operator-only                                   |

Staff emails stay a documented residual (see "Retention and erasure").

## Tenant settings (live)

`tenant-config` target (id: the union slug). Diffed field by field
(`tenantConfigChanges`): a nested object is flattened one level into dotted fields
(`branding.name`, `branding.copy`, `features.captainsReports`, `integrations.medicoach`,
`competitionDefaults.travel`); anything deeper is stored whole as capped text. A changed list
is summarised within the caps: a short list of plain values (≤ 20: districts, prefixes) is
stored whole; otherwise `from` holds the items removed and `to` the items added (each capped
as text); a pure reorder lists every item's name (label / name / title / key / id) before and
after.

| Action                                                 | Target (`op`)                                | Fields diffed                                                                                                                                                                                                                                                                                                                                                       | Visibility |
| ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `tenant-config.update` (`PUT /tenant/config`)          | `tenant-config` (`update`)                   | only what a union admin can write: `branding.*`, `submissionDeadline`, `leagues`, `competitionDefaults.*`                                                                                                                                                                                                                                                           | tenant     |
| `tenant-config.support.update` (`PUT /tenant/support`) | `tenant-config` (`update`)                   | `support` (`"Office · email"`) old → new                                                                                                                                                                                                                                                                                                                            | tenant     |
| `tenant.update` (`PUT /platform/tenants/:slug`)        | `tenant-config` (`update`)                   | the above plus `sport`, `seasonLabel`, `districts`, `knownClubs`, `calendars`, `structures`, `requiredDocs`, `tutorials`, `tutorialsNoFallback`, `features.*`, `transferWindows`, `fixtureReminders.*`, `captainsReportsExcludedSeriesPrefixes`, `officialsContactLine`, `scorecardCorrectionRecipients`, `orgContact.*`, `clearanceCertTemplate`, `integrations.*` | operator   |
| `tenant.setup-complete` / `tenant.setup-reopen`        | `tenant` (`setup-complete` / `setup-reopen`) | `setupCompletedAt`, `setupCompletedBy` (the operator's email)                                                                                                                                                                                                                                                                                                       | operator   |

A union admin's entry never holds a field `GET /tenant/config` withholds from them
(`integrations`, `knownClubs`, `adminCount`, `setupCompletedBy`, document `matchHints`, the
notice settings …): `PUT /tenant/config` diffs its writable fields only, and every operator
portal entry is operator-only. **Masked:** `scorecardCorrectionRecipients` (people's email
addresses), any field whose name reads as a credential (token, secret, password, API key,
webhook), any field whose value is an object holding a key so named at any depth (key names
are checked; the text of values is not), and the usual masked names (an
`orgContact.address`). Other organisation contact details (`orgContact.phone` / `.email`,
`officialsContactLine`, the `support` line) are stored as values.
Signup-link tokens, `adminCount` and the table keys are never diffed. A save that changes
nothing records the entry with no changes.

## Clubs (live)

`club` targets (label: the club name after the change) carry the club's fields before →
after (`clubChanges`). Diffed with values: `name`, `district`, `sub`, `affiliation` (status),
`cqi`, `teams`, `women`, `juniors`, `color`, `leagues`, `remindersOptIn`, `amendmentPending`,
`nameChangePending`, `previousName`; per league `leagueTeams.<league>` (the team count) and
`teamRosters.<league>` (the named sides' **names** only — a side's venue, address and pin are
never read); `ground.<field>` for an allow-list only (`venue`, `secondaryVenue`, `suburb`,
`lat`, `lon`, `pitchCount`); the committee's term dates (`exco.<role>.termStart` /
`.termEnd`); and the document fields below. **Masked** (changed, no value): `chair` and every
other committee field (`exco.<role>.name`, `.cell`, `.phone`, `.email`, `.idNumber`, gender,
race, reasons, `exco.additionalMembers` …) — the entry says which office changed (the console
reads "Vice chair · name — Changed (hidden)"), never who holds it, because removing an office bearer is how a departed
member's details are erased and committee members have no record an erasure could find them
by; `notes` (the comm log, free text — a rename appends a note), `cqiAnswers`, `coaches` (they
carry ID numbers), `playerRegLink` (a token), every other ground field (`ground.address`,
`ground.secondaryAddress`, any field not on the allow-list), and any club field whose value is
an object or a list holding one (a backstop: every field above is a plain value or a list of
plain values). A create leaves unset values (empty, `false`, `0`) out.

| Action                                      | Target (`op`)                             | Changes                                                                                                                 |
| ------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `club.update` (`PATCH /clubs/:id`)          | the club (`update`)                       | the diff, including side effects (affiliation promoted, a registration link minted — masked); none when nothing changed |
| `club.exco.update` (`POST /clubs/:id/exco`) | `update`                                  | which committee fields changed (masked; term dates with values) — a role sent as `null` reads as its fields changed     |
| `club.note.add` (`POST /clubs/:id/notes`)   | `add`                                     | `{ field: 'note', masked: true }` — "note added", never the text                                                        |
| `club.signup` (public link)                 | the new club (`create`)                   | its fields from nothing (name, district; the chair and committee masked)                                                |
| `club.create` (operator portal)             | `create`                                  | as signup; operator-only                                                                                                |
| `club.delete` (`DELETE /clubs/:id`)         | the club (`delete`; no label, `scrubbed`) | none; `counts: { players, clearances, series, seriesFailed, users }`                                                    |

Every club value sits on a target of that club or carries a club `ref` (each with a `C#`
pointer), so deleting the club strips them all: its own entries, the access changes naming it
(`clubIds`), and its documents. Where ANOTHER record names it, only its side goes: a match
label (`<home> v <away>`, with `clubIds`) reads `Removed club v <other>` (a label that does not
split into one part per side is dropped); a change naming two clubs, one per side (`fromRef`
names `from`, `ref` names `to`), has the deleted club's side replaced by `Removed club`; any
other change naming it loses its values (`scrubbed`). A player on the deleted club's roster
who has no player row at any other club is also erased from the trail through their own
pointers, as a player erasure does it: their name and values go from entries written at an
earlier club too, their natural key is blanked and their `E#` pointers are dropped (no record
of them remains). A player still registered at another club keeps their natural key, their
pointers and every entry recorded at another club; entries recorded AT the deleted club (a
target or mention of theirs with that `clubId`) still lose their name with the rest of that
club's side. A player removed from the roster before the club delete is not on it, so the
delete does not reach them: their natural key stays in entry ids and pointers until
`DELETE /admin/players/:nk` (which runs the audit scrub even when no player row is left). The
deleting request's own entry holds counts only.

Ordering and failure: the roster players' scrub runs before anything is deleted, and the club
delete stops with a 500 (`internal error`) BEFORE any delete when it cannot finish — a
roster-existence read DynamoDB left unprocessed after its retries, or the scrub still running
after about 15 seconds. The club, its roster and its record are then intact and the delete can
be retried: work already done is kept and not redone (players already scrubbed have no
pointers left to find). What a failed delete has already done stays done: the club's
registration link is revoked, club reps lose their access to it, players held
`clearance-pending` by its clearances are reset to `active`, its veterans affiliates lose
their pointer to it, and — when a later step fails after the scrub — the scrubbed players are
already out of the trail (names, natural keys and history) although their club still exists.
The retry completes the rest.

## Club documents (live)

On the `club` target of `club.doc.update` (`PATCH /clubs/:id/docs/:key`, `op: update`) and
`club.doc.delete-file` (`DELETE /clubs/:id/docs/:key/file`, `op: delete-file`):

- `docs.<key>` — the satisfied flag, before → after;
- `docMeta.<key>.<field>` with values: `fileCount` (multi-file documents), `size`,
  `contentType`, `uploadedAt`, `uploadedByRole`, `markedCompliant`, `at`, `courseBooked`,
  `courseDate`, `meetingBooked`, `meetingDate`, `unavailable` and expiry dates;
- **masked**: `objectKey`, `files` (the stored file list), uploader details (`uploadedBy`),
  file names and every other document field. Object keys embed the doc key and a random id and
  file names can be user-supplied, so neither is ever stored.

Re-recording a multi-file upload that is already on record records the entry with no changes.

## Players and registration (live)

`player` targets (id: the natural key; label: the player's name; `clubId`: the club whose
roster row it is) carry the row's fields before → after (`playerChanges` in
`packages/api/src/audit-records.ts`). **With values:** `firstName`, `lastName`, `status`,
`clubId` (with a `ref` to the club), `team`, `position`, `battingHand`, `bowlingHand`,
`battingType`, `bowlerType`, `isAllRounder`, `isWk`, `registeredVia`, `veteransClub` (the
name, with a `ref` to the veterans club). **Masked** (changed, no value): `idNumber`,
`passportNumber`, `dob`, `isMinor`, `nationality`, `gender`, `race`, `cell`, `email`,
`guardianName`, `postalAddress`, `postalCode`, `lastClub` (free text), `transferNote`,
`clearanceRejectedReason`, `idDocMeta`, `previousIdDocMeta` (object keys). Nothing else is
compared. A registration leaves unset values out.

| Action                                                                            | Target (`op`)                                                                | Changes                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player.register` (public link), `player.create` (`POST /clubs/:id/players`)      | the player (`create`)                                                        | the registered fields from nothing; a clearance or registration review it opened is a second target (`create`, with its fields — see below) naming the player by a mention                                |
| `player.batch-create`, `roster.commit` (bulk)                                     | the first 25 players (`create`)                                              | as above for those; `counts` (the chair results summary); the rest only counted (`truncated.targets`)                                                                                                     |
| `roster-intake.commit` (operator portal, bulk)                                    | the first 25 players created                                                 | as above; `counts: { created, alreadyPresent, crossClubConflicts, clubs }`; operator-only                                                                                                                 |
| `player.id-doc.update` (`PATCH /clubs/:id/players/:nk/id-doc`)                    | the player (`update`)                                                        | `idDocMeta` masked                                                                                                                                                                                        |
| `player.remove` (`DELETE /clubs/:id/players/:nk`)                                 | the player (`remove`)                                                        | what the row held, as `from` (masked fields without values)                                                                                                                                               |
| `veterans-affiliation.set` / `.remove` (`PUT` / `DELETE …/veterans-club`)         | the player (`set` / `remove`)                                                | `veteransClub` old → new with a `ref`; none when nothing changed                                                                                                                                          |
| `veterans-request.create` / `.accept` / `.decline` / `.withdraw` (club and admin) | the request (`clubId`: the path club, or the player's club for admin routes) | `status`, `leagueKey`, `primaryClub` and `veteransClub` (names with `ref`s); `note` and `declineReason` masked; mentions of the player and both clubs. An accept also records the player's `veteransClub` |
| `registration-review.ack`                                                         | the review (`ack`)                                                           | `status`, `resolution`; a mention of the player                                                                                                                                                           |

A registration review opened by a registration (an off-system previous club) is recorded on
that registration's entry as a `registration-review` target (`create`; `clubId`: the
registering club) with `kind`, `status` and `destClub` (the registering club's name, `ref` the
club); `typedPreviousClub` (the club the player typed) and `previousClub` (an on-system club
held by name only) are masked. Its history reads the create, then the ack.
| `player.erase` (`DELETE /admin/players/:nk`) | none naming the player | counts only (the erasure's own entry is stored without the player's name or natural key) |

Every player value sits on a `player` target or mention keyed by the natural key, so erasing
the player scrubs labels, change values and mention labels and blanks the key. Player targets
carry `clubId`, and so do player mentions (the player's club when the entry was written), so
deleting the club redacts them too.

## Clearances (live)

`clearance` targets (id: the clearance id; **no label** — the player is named only by a
`player` mention, which erasure scrubs; `clubId`: the destination club when a club or a
registration opened it, else the source club) carry (`clearanceChanges`): `status` old → new, `fromClub` / `toClub` (club names
with a `ref` to each club), `team`, `origin`, `feesCleared`, `misconductCleared`,
`rejectOutcome`, `certificateDeclined`, `certificate` (the serial). **Masked:** `note`,
`rejectReason`, `overrideReason`. Every clearance entry also mentions the player (natural key +
name) and both clubs, so it is in the player's and both clubs' histories.

| Action                                                                         | `op`                             | Changes                                                                    |
| ------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------- |
| `clearance.create` (`POST /clubs/:id/clearances`, or opened by a registration) | `create`                         | from nothing: `status: pending`, both clubs, `team`, `note` (masked)       |
| `clearance.update` (`PATCH /clubs/:id/clearances/:cid`)                        | `update` / `issue`               | `feesCleared` / `misconductCleared`; an issue: `status` pending → approved |
| `clearance.override` / `.reject` / `.reopen`                                   | `override` / `reject` / `reopen` | `status` transition, the reason masked, `rejectOutcome`                    |
| `clearance.reassign`                                                           | `reassign`                       | `fromClub` old → new (`fromRef` the old club, `ref` the new one)           |
| `clearance.certificate.revoke`                                                 | `revoke-certificate`             | `certificateStatus` issued → revoked, `reason` masked                      |
| `clearance.remind`                                                             | `remind`                         | none; `counts: { sent, failed, skipped }`                                  |

The `player` mention carries the club the player was on (`clubId`: the source club for a
club's request while it is pending, the destination once approved or when a registration
opened it), with its own club pointer. Deleting that club strips the player's name from the
entry; the other club's side and a player of the surviving club keep theirs. The same holds
for the player mentions of veterans requests (the player's own club), registration reviews
(the destination) and document requests (the request's club).

## Series and fixtures (live)

Every series write that goes through the shared series write (`PATCH /series/:id`, and the
routes that reuse it: competition edits and advance, postponement accept / override, Match
Centre conflict apply, the stage generate's overwrite) records:

- the `series` target (label: its name) with its top-level fields old → new: `name`,
  `startDate`, `endDate`, `dateMode`, `activateFrom`, `teams`, `leagueKey`, `seriesType`,
  `maxOvers`, `schedule`, `seasonRunId`, `stageSpecId`, `groupId`, `approved`, `released`,
  `withheld`;
- one `fixture` target per fixture added (`create`), removed (`delete`) or changed
  (`update`), id `<seriesId>#<fixtureId>` (as fixture officials), label `<home> v <away>`
  (team names from the series' participants) with `clubIds` (the club behind each side).
  Fields: `date`, `time`, `slot`, `round`, `home`, `away` (team names, each with a `ref` to
  the club behind it — `fromRef` the old one when the side changed club), `venue` (the ground
  name, with a `ref` to the venue — `fromRef` the old one), `venueOverride`, `venueStatus`,
  `status`, `originalDate`, `dateTbc`,
  `homeScore`, `awayScore`, `winner`. The scope keeps the first 25 targets (the series is the
  first) and 40 changes each; the rest are counted in `truncated`;
- `counts: { fixturesChanged, fixturesAdded, fixturesRemoved }`, summed over every series the
  request wrote. A stage generate records the series without per-fixture diffs (the series
  it creates as `create` targets with their top-level fields).

`PATCH /series/:id` (registry action `series.patch`) is recorded as what it did, in this
order: `series.reveal` (a reveal), `series.set-side` (Set team), `series.release`,
`series.recall`, `series.approve`, `series.fixtures.edit` (any fixture added, removed or
changed — including an edit of an approved draft, which withdraws the approval: the
`approved` true → false change is still on the series target), `series.unapprove` (approved
true → false with no fixture touched), else `series.update` (a save that changes nothing has
zero changes). Routes with a
more specific action (postponement accept, competition edit …) keep it.

| Action                                  | Target (`op`)                             | Changes                                                                                            |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `series.create` (`POST /series`)        | the series (`create`)                     | its fields from nothing; `counts: { fixturesAdded }`                                               |
| `series.duplicate`                      | the original + the copy (`create`)        | the copy's fields; `counts: { fixturesAdded }`                                                     |
| `series.delete`                         | the series (`delete`, labelled)           | none; `counts: { fixturesRemoved }`                                                                |
| `fixture-result.confirm` / `.unconfirm` | `fixture-result` `<seriesId>#<fixtureId>` | `confirmed`, `recordedAt`, `homeScore`, `awayScore`, `winner`; `note` masked; the series mentioned |

Both result entries are labelled `<home> v <away>` with `clubIds`. A withdrawal reads the series
for the label (audit only, alongside its read of the confirmation; a failed read records the
entry without a label and never changes the answer).

## Competitions (live)

`competition` targets (label: the name) carry the competition's config old → new
(`competitionChanges`): `name`, `type`, `leagueKey`, `overs`, `format`, `schedule`, `points`,
`seed`, and `teams` — one change per team removed (`from`) or added (`to`): its name with a
`ref` to the club behind it (a team with no club is masked; a reorder is not a change). The
generated fixtures are not diffed one by one.

| Action                   | `op`         | Changes                                                                                          |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------ |
| `competition.create`     | `create`     | the config from nothing; `counts: { series, fixturesAdded }`                                     |
| `competition.update`     | `update`     | `name` / `points` old → new; each series written is a `series` target                            |
| `competition.regenerate` | `regenerate` | the config old → new; `counts: { seriesRemoved, series, fixturesRemoved, fixturesAdded }`        |
| `competition.advance`    | (default)    | `counts: { filled }`; the knockout series and the fixtures it filled as series / fixture targets |
| `competition.delete`     | `delete`     | the config it had, as `from`; `counts: { series, fixturesRemoved }`                              |

## Season runs (live)

`season-run` targets (label `<leagueKey> <season>`) carry (`seasonRunChanges`):
`leagueKey`, `seasonLabel`, `calendarFrozenAt`, `structure` (`<name> v<version>`),
`calendar` (its label) and per stage `stages.<specId>.status`, `.groups`
(`<label> (<entrants>)`), `.pairingOverride`, `.staleSchedule`, `.formatChanged`,
`.carriedPoints`. The stages' decision log (it names staff) is not diffed.

| Action                | `op`       | Changes                                                                                                                                                                                              |
| --------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `season-run.create`   | `create`   | the run from nothing                                                                                                                                                                                 |
| `season-run.update`   | `update`   | the diff; none when nothing changed                                                                                                                                                                  |
| `season-run.generate` | `generate` | the stage's status and groups; `counts: { series }`; the series it created (`create`, labelled) and overwrote as targets (no per-fixture diffs); past 25 targets the rest are counted in `truncated` |
| `season-run.rebase`   | `rebase`   | `structure`, stages reset / marked, `calendarFrozenAt`                                                                                                                                               |
| `season-run.delete`   | (labelled) | none; `counts: { seriesKept }` (its series are not deleted)                                                                                                                                          |

## Venues (live)

`venue` targets (label: the name) carry (`venueChanges`): `name`, `suburb`, `lat`, `lon`,
`homeClubIds`, `surfaces`, `unavailable` (each window as `<start> – <end>`; its reason is free
text and never stored), `unavailableWeekdays`. **Masked:** `address`, `note`. `venue.save`
(`PUT /venues/:id`, `op: save`) diffs against the stored venue (a new one from nothing);
`venue.delete` records what the venue held, as `from`.

## Postponements (live)

`postponement` targets (id: the request id; no label; `clubId`: the path club, or the
canonical (opposing) club for an admin ruling) carry (`postponementChanges`): `status`,
`awaiting` (whose turn), `requestingClub` / `opposingClub` (club names with a `ref` each),
`originalDate`, `originalTime`, the proposal on the table — `proposedDate`, `proposedTime`,
`proposedVenue` (with a `ref` to the venue when it has an id), `proposedBy`
(`requesting` / `opposing` / `admin`) — `proposals` (how many), `agreedDate` (once applied or
ruled) and `acknowledged.<clubId>` (`ref` the club). **Masked:** `reason`, the proposal's
`note`, `declineReason`. Who typed what is never stored as a value (the actor says who). Every
entry mentions both clubs and the fixture and series (unless they are targets already), so it
is in both clubs', the fixture's and the series' histories.

| Action                               | `op`                   | Changes                                                                                                        |
| ------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `postponement.create`                | `create`               | from nothing: `status: open`, both clubs, the original and proposed date, `awaiting`, `reason` masked          |
| `postponement.counter`               | `counter`              | `proposedDate` / `proposedTime` old → new, `proposedBy`, `awaiting`, `proposals`, `note` masked                |
| `postponement.accept`                | `accept`               | `status` open → applied, `agreedDate`, `awaiting`; **plus the fixture's own change** (below)                   |
| `postponement.withdraw` / `.decline` | `withdraw` / `decline` | `status` open → withdrawn / declined; `declineReason` masked                                                   |
| `postponement.acknowledge`           | `acknowledge`          | `acknowledged.<clubId>` → true                                                                                 |
| `postponement.override`              | `override`             | `status` → admin-final, the ruled date / time / venue (`ref`), `agreedDate`; **plus the fixture's own change** |

An accept or a ruling moves the fixture through the shared series write, so the same entry
(action `postponement.accept` / `.override`) also holds the `series` target and the `fixture`
target with `date` (and `time`, `venue`, `originalDate`, `status`) old → new — one target per
record, never repeated as a mention.

## Captain's reports (live)

`captains-report` targets (id `<seriesId>~<fixtureId>~<clubId>`; label `<club> v <opponent>`
with `clubIds` — the reporting club, and the opponent's club read from the fixture (audit
only; an unlisted match's typed opponent, or an opponent the read cannot resolve, has none);
`clubId`: the reporting club) carry (`captainsReportChanges`): `status` (pending → submitted),
`submittedVia`, `ref` (the CR number), `declaration`, `scorecard` (the answer: confirmed /
correction), `recipientKind`, `forwardCount`, and per umpire card (numbered from 1)
`umpires.<n>.umpire` (the name), `.substitute`, `.ratings` (`decisions 4, pressure 3, …`),
`.concerns` (the ticked areas). Every per-card change carries a `ref` to the registry umpire it
rates (`fromRef` when the card named another), so the report shows in that umpire's history and
erasing the umpire strips its name and ratings. **Masked:** `captainName` (a person typed in),
`general`, `scorecardFeedback`, each card's `otherConcern` and `comments`, and a **free-text**
umpire's name (no registry record to scrub it by).

| Action                                                 | `op`               | Changes                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `captains-report.create` / `.create-unlisted` (portal) | `create`           | the filed report from nothing (it is created and submitted at once)                                                                                                      |
| `captains-report.save` (portal or link)                | `save` / `submit`  | the diff; a submit adds `status` pending → submitted and the CR number. A link save is attributed to the link's recipient (actor `link:captains-report:<memberId>`)      |
| `captains-report.forward` (portal or the chair's link) | `forward`          | `recipientKind` (e.g. chair → captain), `recipient` (the player's name, `ref` the player's natural key), `recipientContact` masked, `forwardCount`, `captainName` masked |
| `captains-report.attribute-umpire` (admin)             | `attribute-umpire` | `umpires.<n>.umpire` typed name → registry name and `umpires.<n>.attribution` (`registered` / `linked`), both with a `ref` to that umpire                                |

The previous recipient's name is not repeated on a forward (a chair or a portal user has no
player record to scrub it by). The link's member id is the actor's `recipientId`, never a value.

## Squads and team captains (live)

`squad-request` targets (id `<seriesId>~<fixtureId>~<teamId>`; label `<team> v <opponent>`
with `clubIds`, resolved as for reports; `clubId`: the team's club) carry (`squadRequestChanges`): `status`, `recipientKind`,
`forwardCount`, `voidReason`, `selection.players` and `selection.guests` (counts — guest names
are free text and never stored), `selection.captain` (the name, `ref` the player) and one
`selection.player` change per player added (`to`) or removed (`from`), each with a `ref` to the
player (the 40-changes-per-target cap applies; the rest are counted in `truncated.changes`).

| Action                                                           | `op`              | Changes                                                                                                                              |
| ---------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `squad-request.save` (link)                                      | `save` / `submit` | the selection diff; a submit adds `status` pending → submitted                                                                       |
| `squad-request.forward` (the chair's link)                       | `forward`         | as a report forward: `recipientKind`, `recipient` (`ref` the player), `recipientContact` masked                                      |
| `squad-request.resend` (admin)                                   | `resend`          | `recipientKind` when the ladder now picks someone else; `counts: { sent, failed, skipped }`                                          |
| `squad-request.void` (admin)                                     | `void`            | `status` → void, `voidReason`                                                                                                        |
| `club.team-captain.set` (`PUT /clubs/:id/teams/:teamId/captain`) | `set` (the club)  | `captain.<teamId>.<scope>` old → new: the names, `ref` the new captain and `fromRef` the old (natural keys); a clear has `from` only |

## Document requests (live)

| Action                                          | Target (`op`)                                                                                       | Changes                                                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc-request.send` (`POST /admin/doc-requests`) | each request made (`create`, or `resend` when a pending one was extended; label: the document name) | a new request: `status` → pending, `document`; each player mentioned (name, `clubId`); `counts: { players, playersSkipped, sent, failed, skipped }` |
| `link.copy` (`POST /admin/doc-requests/link`)   | the request (`copy`)                                                                                | none; the player mentioned (name, `clubId`)                                                                                                         |
| `doc-request.complete` (public link)            | the request (`complete`)                                                                            | `status` pending → completed only — never the object key or the document                                                                            |

## Match Centre console (live)

Admin decisions only (`/integrations/medicoach/*`). **The sync itself is never attributed:**
`sync-now` runs the sync outside the request's audit scope (`runUnaudited`), so the entry says
only who started it (`medicoach.sync-trigger`, no targets) — whatever the sync then pulls,
pushes or opens is not recorded, exactly as for the cron.

| Action                             | Target (`op`)                                                 | Changes                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `medicoach.conflicts.apply`        | the fixture (`update`, as written by the shared series write) | the fixture's field changes, plus `medicoach.conflict` → `applied` (or `unchanged`), `medicoach.conflictRef`                                                                                                                               |
| `medicoach.conflicts.discard`      | the fixture (`medicoach-conflict`)                            | `medicoach.conflict` → `discarded`, `medicoach.conflictRef`                                                                                                                                                                                |
| `medicoach.outbox.retry` / `.drop` | the fixture (`medicoach-outbox`)                              | `medicoach.outbox` → `retried` / `dropped`, `medicoach.outboxRef`                                                                                                                                                                          |
| `medicoach.players.retry`          | none                                                          | `counts: { requeued }` (who was re-queued is not named)                                                                                                                                                                                    |
| `medicoach.player-review.resolve`  | the player (`resolve`, natural key)                           | `medicoach.review` reason → the choice (`link` / `create` / `distinct` / `dismiss`), the Match Centre player id or the number of candidates shown; `distinct` mentions the other people by natural key; `counts: { sent, queued, review }` |
| `medicoach.sync-trigger`           | none                                                          | none                                                                                                                                                                                                                                       |

## Operator routes (live)

All operator-only (`visibility: 'operator'`), tenant from `:slug`.

| Action                       | Targets                                                            | Changes / counts                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc-intake.commit`          | each club written (first 25; `update`)                             | the club's document fields as in "Club documents" (object keys, file names masked); `counts: { items, clubs, clubsFailed }`                                             |
| `roster-intake.commit`       | the first 25 players created                                       | as in "Players and registration"; `counts: { created, alreadyPresent, crossClubConflicts, clubs }`                                                                      |
| `structure-intake.commit`    | `tenant-config` (`leagues` added) and each club written (first 25) | `leagues` (items added); the club's `leagues`, `leagueTeams`, `teamRosters`, `teams`, `women`, `juniors`, `ground.*`; `counts: { leaguesAppended, clubs, clubsFailed }` |
| `fixture-amendments.confirm` | each series written and its fixtures (first 25 targets)            | as in "Series and fixtures"; `counts: { fixturesAmended, draftMoves, clashesOverridden, fixturesChanged, … }`                                                           |
| `medicoach.reconcile`        | none                                                               | `counts: { checkedRefs, unmapped, unreachable }`                                                                                                                        |
| `club.create`                | the club (`create`)                                                | as in "Clubs"                                                                                                                                                           |
| `tutorial.upload`            | `tenant-config` (`upload`)                                         | none (the object key is not stored); `counts: { parts }`                                                                                                                |

## Visibility (live)

- Entries from the operator portal (`/platform/*`) are `visibility: 'operator'`: operators
  only. They hold settings the code deliberately hides from union admins.
- An operator acting inside a union's console is `visibility: 'tenant'`, with
  `actor.operator: true` (union admins already see operators in Team & Access).

## Routes (live)

Reads are not themselves audited. All responses are JSON.

| Route                                                | Who                      | Returns                                       |
| ---------------------------------------------------- | ------------------------ | --------------------------------------------- |
| `GET /admin/audit`                                   | union admins (own union) | feed page, `visibility: 'tenant'` only        |
| `GET /admin/audit/entity/:type/:id`                  | union admins             | one record's history, `tenant` only           |
| `GET /admin/audit/entry/:at/:id`                     | union admins             | `{ entry, detail }`; 404 for operator entries |
| `GET /platform/tenants/:slug/audit`                  | operators                | that union's feed, every visibility           |
| `GET /platform/tenants/:slug/audit/entity/:type/:id` | operators                | that record's history, every visibility       |
| `GET /platform/tenants/:slug/audit/entry/:at/:id`    | operators                | `{ entry, detail }`                           |
| `GET /platform/audit`                                | operators                | platform-level feed (tenant `'*'`)            |
| `GET /platform/audit/entry/:at/:id`                  | operators                | one platform-level entry `{ entry, detail }`  |

Club reps get 403 on `/admin/*` (requireAdmin); union admins get 403 on `/platform/*`. The
partition read is always the caller's own union (or the operator's `:slug`).

### Feed query parameters

| Param    | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `from`   | ISO date or instant (`2026-11-01`, `2026-11-12T08:00:00Z`); inclusive |
| `to`     | ISO date or instant; inclusive (a date covers the whole day)          |
| `actor`  | an actor key (a sub, or `link:…`) or an email: that person's entries  |
| `type`   | a target type: entries touching at least one record of that type      |
| `cursor` | the `cursor` of the previous page                                     |
| `limit`  | entries per page, 1–200 (default 50)                                  |

`actor` as an email (case-insensitive) is resolved through the union's team (the users Team &
Access lists) to that member's sub. An email that matches no current member — someone since
removed — instead keeps the entries whose recorded actor email matches; those pages can be
short while a cursor remains (see Paging). On `GET /platform/audit` an email always filters
by the recorded email.

The entity route takes `cursor` and `limit`. Composite ids are URL-encoded (`s1%23f1` for
series `s1`, fixture `f1`). A club's history (`…/audit/entity/club/:id`) reads the club's
`C#<id>` pointers: every entry with the club as a target or a change `ref`, or naming it in a
label or a `clubId` / `clubIds` (each `E#club#<id>` pointer is written together with a `C#`
one, so nothing is missed) — a fixture edit of X v Y is in both X's and Y's history. Each entry
is listed once, newest first, paged like any other history. `:at` in the entry route is the
entry's `at`, URL-encoded.

### Paging

`{ items: AuditEntry[], cursor?: string }`, newest first. The cursor is opaque; `cursor`
absent means nothing older. Without a filter a page is one read of `limit` rows. With a
filter that applies after the read (`type`, an `actor` email matched against the recorded
email, the visibility filter, or `from` / `to` together with an `actor` key), the request keeps
reading until `limit` entries match or about 2,000 rows were read, and the cursor resumes
right after the last row it looked at. So a filtered page can still be short (or empty) while a
cursor remains — keep following it ("load more"). A cursor the API did not issue, a
malformed `from` / `to`, or a `limit` below 1 is **400**. So is a cursor naming a month outside
the query's range (before the launch month, beyond next month, or not a month) or a position
outside the query's own key range.

### Errors

| Status | When                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 400    | bad cursor, malformed `from` / `to`, bad `limit`                       |
| 403    | a club rep (admin routes) or a non-operator (platform routes)          |
| 404    | entry route: no such entry, expired, another union's, or operator-only |

## Retention and erasure (live)

- Every row expires 730 days after the entry (DynamoDB TTL); reads also hide expired rows.
- Erasing an umpire or scorer strips their names and values from every entry naming them; the
  record id (a name slug) stays. Erasing a player blanks their natural key as well and drops
  their record pointers, even when no player row is left (removed from a roster, or the club
  deleted). Deleting a club redacts that club's side of every entry, including its name in
  other records' match labels and values; an entry also about a surviving club keeps that
  side. Every player on its roster who is registered at no other club is erased from the
  trail as a player erase would (names, values and natural key out, pointers dropped),
  wherever they were recorded. The erasing request's own entry is stored without the
  erased record's names or values (and without a player's natural key). Clearing the cohort
  removes entries about cohort records only, and strips the names and values of cohort
  records from the entries that stay (a staff entry mentioning a player, say). Erasing a union
  removes all its audit rows.
- **Staff emails are kept** (owner's decision): a `user` target is labelled with the person's
  email and every entry snapshots `actor.email`. Neither is scrubbed when a team member is
  removed (`DELETE /admin/users/:sub`). Deleting a club also deletes accounts whose only
  membership was that club; their `user` entries keep the label and email — the club's
  redaction strips only the `clubIds` changes naming that club (they carry a club `ref`). All
  of these go with the 730-day expiry or when the union is erased.
- Record ids longer than 200 bytes are shortened in pointer sort keys (a prefix plus a hash);
  entries keep the full id and record history still finds them.

### Not covered, and residuals

- **Not attributed to a person:** crons (reminders, the 15-minute Match Centre sync, captain's
  report openings, squad openings and sweeps), the sync a "Sync now" triggers, CLI scripts and
  direct table edits. History before the trail went live (12 Nov 2026) is not reconstructed.
- **Staff emails** are kept (above), as are the operator's email in `setupCompletedBy` and
  organisation contact details in tenant settings (`support`, `officialsContactLine`,
  `orgContact.phone` / `.email`) — the union's published contacts, stored as values.
- **Typed names with no record:** a captain's report or squad for an unlisted match names the
  opponent as typed, and a fixture's `venueOverride` is stored as the admin typed it (a ground
  name, which could be a street address); no club or venue delete reaches either.
- **A report's or squad's opponent the audit read cannot resolve** (the series read failed,
  or the fixture is no longer in the series) is labelled without its club, so deleting that
  club leaves its name in that label.
- **A deleted club's id stays:** ids are name slugs (`umzinto`), kept in record ids, `ref`s,
  `clubIds`, pointer keys and a series' `teams` values, like an erased official's id.
- **The union's club directory** (`knownClubs`, operator settings entries) lists club names as
  values; deleting a club does not reach them (directory entries are not club records).
- **Names inside earlier values:** a forward does not repeat the previous recipient's name; a
  free-text umpire's name is masked until an admin attributes it to a registry umpire (from
  then on it sits under that umpire's `ref`).
- **Merge residue** (see "Officials").
