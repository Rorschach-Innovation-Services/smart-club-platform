# ADR 0023 — Platform audit trail: every change attributable to a person

**Status:** Proposed (November 2026). Phase 1 built on `feat/audit-trail`, not yet reviewed or
deployed. Contract: `docs/api/audit.md`.

## Context

On 2 November 2026 someone used **Edit** on a Dolphins umpire and overwrote one person with
another. The platform recorded _when_ (`updatedAt`) but not _who_, and nothing else (logs,
Sentry) could answer it. Before this change only three narrow audit rows existed (`EXPORT#`,
`PLAYERERASE#`, `OFFICIALERASE#`), about 40 ad hoc `…By` email stamps sat on individual
records, and link copies and merges went to server logs only. No screen read any of it.

The owner's decisions (12 November 2026):

- Record who, when, what, and old and new values; mask ID numbers, addresses and document
  contents; scrub a person's entries when they are erased.
- Operators see every union; each union's admins see their own, including the history of
  individual records.
- Keep entries two years, self-deleting.
- Cover every change made through the API by people (signed in or via a public link), plus
  links and messages sent. Exports, document views, sign-ins, scheduled jobs, the Match Centre
  sync and command-line scripts stay out of scope.

## Decision

### Capture: a safety net plus enrichment

All routes live on one Hono app in `packages/api/src/index.ts`, with no per-route metadata.
Coverage must not depend on each handler remembering to log, so capture has two layers.

- **Safety net** (`src/audit-middleware.ts`). One global middleware, registered right after
  CORS, opens an `AsyncLocalStorage` scope around the request. After the handler it writes one
  entry when the method is mutating and the response is 2xx (`ok`) or 5xx (`failed`), or when
  the handler recorded anything (whatever the method or status; a 4xx then reads `failed`).
  A plain 4xx with nothing recorded writes nothing.
- **Route registry** (`src/audit-routes.ts`). Every mutating route has a key
  `'METHOD /pattern'` → `{ action, entity?, club?, tenant?, bulk?, erases?, redactParams?,
visibility? }` or `{ skip: reason }`. Audited GETs (link copies) are listed too.
  `test/audit-coverage.test.ts` walks `app.routes` and fails on a missing or stale key, so a
  new route cannot ship unaudited. The registry gives the action, a default target from path
  params (never a redacted one), the tenant source and the visibility.
- **Enrichment helpers** (`src/audit.ts`): `auditSet`, `auditTarget`, `auditLabel`,
  `auditMention`, `diffFields`. They are no-ops outside a request scope, so shared seams need
  no extra parameters and CLIs and crons stay unattributed. `auditLabel` names a target the
  route already has (its default target) without changing its op or marking the request as
  recorded, so a later refusal still writes nothing.
- **Bulk routes** (merges, erasures, imports, intake commits, roster commit, appointments
  confirm, fixture-amendments confirm, rebase, regenerate, stage generate, series and
  competition deletes, Match Centre reconcile) also write a `started` headline before the
  handler. A second middleware, registered after the auth prefix middleware and before every
  route, does this once the caller is known; the final entry reuses the scope's id and instant,
  so it overwrites the headline row for row (from then on `auditSet` cannot change the tenant
  or actor). A Lambda timeout (30 s) still leaves who started what. A 400, 401, 403 or 404
  with nothing recorded deletes the started rows instead, so a plainly refused bulk request
  leaves no entry. Any other 4xx (409 …) closes the entry as `failed`: it can follow a write the
  handler did not record. Handlers that know they wrote before a refusal (stage generate, an
  official's erase, a player's erase) record it as well (`auditSet`).
- **Create routes** record the created record (`auditTarget({ type, id, op: 'create' })`)
  after the write, so "which record" is answered and the record's history starts with its
  creation. Bulk creates name the first 25 and carry `counts`.
- **Labels** are set only where the handler already holds the record (no read for a label):
  clubs (name; create and edit), team members (email; invite, edit, removal, resend, email
  correction), venues (name; save), series (name; create, duplicate, edit), competitions
  (name) and season runs (`<leagueKey> <season>`, a run has no name). Erasure and the
  erasing route's own entry strip them as any other label; the erasing route's own target of
  the erased type is also marked `scrubbed`, so it reads "Removed" rather than its id.

### Who

- Signed-in users are keyed on the Cognito `sub` (emails change), with a snapshot of email and
  role. An empty email is never stored. `operator: true` when the caller holds the platform
  operator membership. `via` is `console` or `platform`.
- Public links are keyed on the link kind and the recipient's opaque member id (never the
  token): `link:captains-report:<memberId>`, `link:squad:<memberId>`,
  `link:doc-request:<requestId>`, and `link:<kind>:shared` for self-registration links. The
  six public resolvers set the tenant and this actor. After a captain's report is forwarded,
  the captain's submit names the captain's member id, not the chair's.
- Raw paths, query strings and `redactParams` (every `:token`, the natural key on player
  erasure) are never stored.

### Storage (one table, no new index)

All rows of a tenant's entries for a month share one partition,
`TENANT#<t>#AUDIT#<yyyy-mm>` (`PLATFORM#AUDIT#<yyyy-mm>` for platform actions):

| Row            | sk                            | Purpose                        |
| -------------- | ----------------------------- | ------------------------------ |
| Headline       | `A#<iso>#<id>`                | Feed, newest first; no values  |
| Detail         | `D#<iso>#<id>`                | Field changes and mentions     |
| Entity pointer | `E#<type>#<encId>#<iso>#<id>` | Record history; erasure lookup |
| Club pointer   | `C#<clubId>#<iso>#<id>`       | Club history; club erasure     |
| Actor pointer  | `U#<actorKey>#<iso>#<id>`     | Everything by one person       |

- One `TransactWriteItems` per entry (≤ 100 rows). Invariant: no personal value is stored
  without its pointer in the same write; when the row budget runs out the value is dropped,
  never the pointer. If the table still refuses the write, it is retried once as the headline
  alone (no targets, mentions or detail).
- Ids over 200 bytes (escaped) sit in pointer sort keys as a 150-byte prefix, `%h` and a
  SHA-256 prefix (`keys.auditKeyId`), well under the 1,024-byte sort-key limit; row bodies
  keep the full id.
- Caps: 25 targets, 40 changes per target, 40 mentions, 200 characters per value, 20 array
  items, detail ≤ 100 KB. Whatever is dropped is counted in `truncated`.
- Every row has `expiresAt = at + 730 days` (TTL); readers hide expired rows too.
- No scans: feeds and per-person reads query month partitions newest first from now back to
  the launch month; record history queries the `E#` prefix.

### Erasure

`repo.scrubAuditForEntity` walks a record's `E#` pointers and strips labels and values;
`repo.scrubAuditForClub` walks a club's `C#` pointers and redacts that club's side.

- Officials (`official-erase.ts`): after the report scrub; in the pending hard-delete branch,
  before the record is deleted. The record id (a name slug) and its pointers stay.
- Players (`repo.erasePlayerData`): before the player rows go; the natural key is blanked in
  the entries and the pointers are dropped. With no player (or clearance, review, request)
  rows left, the erase still runs this scrub when pointers exist and answers 200
  (`counts.auditEntries`); only with no pointers either is it a 404.
- Clubs (`repo.eraseClubData`): via `C#` pointers; an entry also about a surviving club keeps
  that side. A mention may carry the club its record was on (`clubId`: a player's club when the
  entry was written — clearances, veterans requests, registration reviews, document requests);
  it gets its own `C#` pointer and its label goes with that club, while a player of the
  surviving club keeps theirs. A target whose label names clubs (`<home> v <away>`: fixtures,
  result confirmations, captain's reports, squads) carries `clubIds`, the club behind each
  side, each with a `C#` pointer (one row per distinct club per entry); the deleted club's
  side reads `Removed club` and a label that cannot be split is dropped. Changes naming clubs
  carry club `ref`s (fixture `home` / `away`, competition `teams`, one per team); a change
  naming two clubs, one per side, keeps the surviving side. Before the roster rows go, every
  roster player with no player row at any other club (BatchGet key probes, 100 keys a call, 8
  in flight) is erased from the trail through `scrubAuditForEntity` with `dropPointers` (names,
  values and natural key out, pointers dropped — no record of them remains), so entries
  written at an earlier club lose them too; re-runnable (a re-delete re-lists the roster).
  Pointer queries run 8 at a time; reads are batched (BatchGet, 100 keys) and the conditional
  rewrites run 16 at a time, inside the 30 s club delete (200 roster players with 500 entries:
  about 0.5 s against local dynalite).
- Tenants (`repo.eraseTenantData`): every month partition from launch to now.
- Cohort clear (`repo.clearCohort`): entries about cohort records only are deleted; entries
  that stay but name a cohort record have its labels and values stripped.
- The erasing request's own entry is flushed after the scrub, so the middleware strips the
  erased type's labels, values and mention labels from it first (the registry's `erases`
  flag; a player's id is blanked and gets no pointer).

### Failure policy

Fail-open. The change is already committed when the entry is written, so an audit failure
never changes the response. On failure: `Sentry.captureException` and one `console.error`
JSON line with the PII-free skeleton (actor key, instant, method, pattern, action). The
capture inside handlers fails open too: `auditTarget` / `auditSet` / `auditLabel` /
`auditMention`, the local record helpers and every call site that computes a diff run inside
`safeAudit` (Sentry, one `console.error` line naming only the error class, then on), and
reads made only for the trail (a "before" the write does not need) run through
`auditOnlyRead`: a failure is reported the same way and returns an "unknown" marker, and the
target is then recorded with no diff (never a diff from `null`, which would read as a create)
— the entry records less, the route answers exactly as it would without the trail.

Club delete is the exception where the trail can fail the request, on purpose and before
anything irreversible: if the roster players' audit scrub cannot finish (a player-existence
read left unprocessed, or the scrub past its ~15 s budget) the delete answers 500 with the club
intact, and a retry finishes it without redoing what was done.

### Read API

`GET /admin/audit`, `/admin/audit/entity/:type/:id`, `/admin/audit/entry/:at/:id` for union
admins (own tenant, `visibility: 'tenant'` only); the same three under
`/platform/tenants/:slug/audit…` for operators (every visibility); `GET /platform/audit` and
`GET /platform/audit/entry/:at/:id` for platform-level entries. Entries from the operator
portal are operator-only. Reads are not audited.

The feed's person filter (`actor`) takes an actor key or an email. An email is resolved
through the tenant's user markers (one GSI query, as Team & Access reads) to that member's sub,
whose `U#` pointers are read. An email matching no current member (removed, or more than one)
falls back to the headlines, kept when the entry's actor email snapshot matches
(case-insensitive); like the type filter, that can return short pages while a cursor remains.

## Consequences

- Every change request gets one extra write before it responds (one small
  `TransactWriteItems` of a few rows; about 1.3 ms against local dynalite when measured).
  Bulk routes get a second, earlier write.
- A new mutating route fails the coverage test until it has a registry decision.
- Phase 3 is complete: every audited area records field-level old → new values (contract:
  `docs/api/audit.md`). A save that changes nothing is recorded with zero changes.
- One suite that counts every item in the test table (`resolve-duplicate-players`) ignores
  `#AUDIT#` partitions; the captain's-report suites' "stored nowhere" scans include them.

### Not covered

- Scheduled jobs (crons), the Match Centre sync, command-line scripts and direct table edits.
  `POST /integrations/medicoach/sync-now` records who triggered a sync, not what it changed.
  The actor model leaves room for a `system:` / `cli:` actor later.
- Exports, document views and sign-ins.
- Anything before deploy: the 2 November change cannot be attributed.
- It is an application-level record, not tamper-proof: someone with AWS access to the table
  can alter it.

### Residual risks

- A repeated player `DELETE` re-scrubs whatever its pointers still find: with no rows left the
  erase runs the audit scrub alone, so an entry flushed after the first erase (it brings its
  own pointer) is found and scrubbed. The remaining gap is narrow: an entry whose pointer was
  written after the first erase read the pointers but before it deleted them loses that
  pointer unscrubbed and is not found again. Officials keep their pointers, so a repeated
  official `DELETE` re-scrubs everything.
- Merge residue: a survivor keeps what a merge gave it (an umpire's aliases from the merged
  duplicate; contacts and full name filled from a pending submission), in the register and in
  the merge entry's survivor changes. Erasing only the merged duplicate leaves those values on
  the survivor's side, as they stay on the survivor's record; they go with the survivor's
  erase. A pending submission merged in is deleted and never joins an erase set, so its own
  entries are scrubbed at the merge, before its delete (as Reject does).
- Staff emails stay (owner's decision): `user` targets are labelled with the person's email and
  every entry snapshots `actor.email`; neither is scrubbed by `DELETE /admin/users/:sub`.
  Deleting a club also deletes accounts whose only membership was that club, and their `user`
  entries carry no club pointer, so the club's redaction does not reach them. All of these
  expire with the 730-day TTL or go with a tenant erase.
- Cohort clear strips cohort records' names and values from the entries it keeps but leaves
  their ids and `E#` pointers (a player's natural key among them) until the entry expires or
  that player is erased.
- Scrub vs final overwrite race: an erasure scrubs before the erasing request's own entry is
  written, and a concurrent request about the same person can flush after the scrub.
- Official record ids (name slugs such as `u-a-dende`) are kept after erasure, like the
  register stub and `OFFICIALERASE#`. If a record was overwritten with another person and the
  first person is later erased under a different record, their old name inside the first
  record's history is not found until that record is erased or the entry expires.
- Typed names with no record behind them stay as typed: an unlisted match's opponent in a
  captain's report or squad label, and a fixture's `venueOverride`. A report's or squad's
  opponent whose club the audit-only series read cannot resolve (a failed read, a fixture no
  longer in the series, or a fixture whose current opponent no longer carries the name the
  report or squad snapshotted — the opponent's club id is not stored on the record) is
  labelled without its club and survives that club's delete.
- A deleted club's id (a name slug) stays in record ids, `ref`s, `clubIds`, pointer keys and a
  series' `teams` values; the operator club directory (`knownClubs`) in settings entries keeps
  club names as values.
- Committee members (`exco`, the club's `chair`) have no record an erasure could find them by,
  so their details are always masked; only the term dates are values.
- Organisation contacts in tenant settings (`support`, `officialsContactLine`,
  `orgContact.phone` / `.email`) and the operator's `setupCompletedBy` are stored as values.
  Credential masking checks key names (at any depth inside a value), not the text of values.
- A self-registration through a shared link is attributed to the link, not to a named person.
- Captain's reports and squads: a forward names the new recipient (with a `ref` to the player)
  but not the previous one (a chair or a portal user has no player record to scrub it by);
  a free-text umpire's name is masked until an admin attributes it to a registry umpire. The
  link's member id appears only as the actor's `recipientId`.
