# API — Audit trail

Every change made through the API by a person (signed in, or through a public link), plus link
copies and person-triggered message sends, leaves one **audit entry**: who, when, which action,
which records. Union admins read their own union's entries; platform operators read every
union's entries and the platform-level ones. Design and reasoning: ADR 0023
(`docs/architecture/0023-audit-trail.md`).

Status key: **live** is in the code now (Phase 1: who / when / action / record). Field-level
old → new values arrive per area in Phases 2–3; until then a save is recorded as a save.
Officials (umpires, scorers, fixture appointments) have field-level values now (see
"Officials").

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
  changeCount: number;
  scrubbed?: true;   // an erasure stripped this target's label and values
}
```

The detail (`GET …/entry/:at/:id`) adds per-target field changes and mentions:

```ts
AuditDetail {
  targets: Array<{ type, id, changes: AuditChange[] }>;
  mentions: Array<{ type, id, label? }>;   // e.g. the other side of a merge
}
AuditChange { field, from?, to?, masked?: true, ref?: {type, id}, fromRef?: {type, id}, scrubbed?: true }
```

### What is never stored

- Tokens, query strings and raw paths. A route is stored by its pattern (`/umpires/:id`); link
  routes carry the token in the path or `?t=`, and neither reaches a row. `DELETE
/admin/players/:nk` does not store the natural key.
- Masked fields are recorded as changed with no value: ID number, passport number, addresses,
  date of birth, emergency contact, document keys and metadata, and free text (notes,
  comments, report text).
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
  carries its name as `label` (no field changes yet): clubs (created or edited: the club
  name), team members (invited, edited, removed, invite resent, email corrected: the email),
  venues (saved: the name), series (created, duplicated, edited: the name), competitions
  (created, edited, regenerated, advanced, deleted: the name) and season runs (created,
  edited, generated, rebased: `<leagueKey> <season>`, e.g. `premier 2026/27`). Deletes of a
  venue, series or season run read nothing, so they carry no label. Erasure strips labels as
  below.
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
series `s1`, fixture `f1`). `:at` in the entry route is the entry's `at`, URL-encoded.

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
  deleted). Deleting a club redacts that club's side of every entry; an entry also about a
  surviving club keeps that side. The erasing request's own entry is stored without the
  erased record's names or values (and without a player's natural key). Clearing the cohort
  removes entries about cohort records only, and strips the names and values of cohort
  records from the entries that stay (a staff entry mentioning a player, say). Erasing a union
  removes all its audit rows.
- **Staff emails are kept** (owner's decision): a `user` target is labelled with the person's
  email and every entry snapshots `actor.email`. Neither is scrubbed when a team member is
  removed (`DELETE /admin/users/:sub`). Deleting a club also deletes accounts whose only
  membership was that club; their `user` entries carry no club pointer, so the club's
  redaction does not reach them either. All of these go with the 730-day expiry or when the
  union is erased.
- Record ids longer than 200 bytes are shortened in pointer sort keys (a prefix plus a hash);
  entries keep the full id and record history still finds them.
