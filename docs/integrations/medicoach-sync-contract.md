# Medicoach ↔ Smart Club sync contract — v1

This is the source of truth for both repos. Copy the `examples/*.json` files verbatim into
`docs/integrations/medicoach-sync-examples/` in BOTH repos; each repo has a test that parses every
example with its own zod schema (drift fails CI).

## Direction & auth
- Smart club is always the CALLER; medicoach never calls smart club.
- One shared secret: smart club SST secret `MedicoachSyncSecret` == medicoach SST secret `SmartClubSyncSecret`.
  Base URL on smart club: SST secret `MedicoachSyncUrl` (e.g. https://api.medicoach.co.za). Empty secret/url ⇒ the caller
  runs in dry-run mode (logs only); the medicoach endpoints refuse every request (503) when their secret is empty.
- Headers:
  - `X-Sync-Timestamp: <unix epoch ms>`
  - `X-Sync-Signature: sha256=<lowercase hex HMAC-SHA256(secret, `${timestamp}.${METHOD}.${pathAndQuery}.${rawBody}`)>`
    - `pathAndQuery` is the request path + `?` + query string exactly as sent (no host). Empty body ⇒ empty string.
  - Reject if |now − timestamp| > 300 000 ms (401) or signature mismatch (401, constant-time compare).
- `tenant` is the smart club tenant slug (e.g. `dolphins`).

## Refs (shared ids)
- Fixture: `smartclub:<t>:fixture:<seriesId>:<fixtureId>`, or for knockouts generated from a recipe
  `smartclub:<t>:fixture:recipe:<leagueKey>:<stream>:<slotId>`.
- Team: `smartclub:<t>:team:<leagueKey>:<teamId>` (same as the bundle).
- Player: `smartclub:<t>:player:<naturalKey>` (same as the bundle; PERSONAL DATA — never log).
- Smart club never stores medicoach ids; medicoach owns ref ↔ id.

## Field limits
- venue: string | null — at most 200 characters; senders must not exceed it and receivers truncate anything longer.

## 1. GET /integrations/smartclub/changes?tenant=<t>&since=<cursor>&limit=<n>
- `since` = opaque cursor string from a previous `nextCursor`; omit or `0` for a full resync.
- `limit` default 100, max 500. When more remain, `hasMore: true` — the caller loops with `nextCursor`.
- Only fixtures that have an `externalRef` for this tenant are returned, at most one row per `ref`.
- `nextCursor` on the final page is never later than medicoach's "now − 2 minutes", even when that
  is EARLIER than the `since` it was given (a late-committed write inside that window is then still
  picked up). Rows can therefore be re-sent; apply them idempotently by the rules below.

Response 200:
```ts
{
  version: 1,
  tenant: string,
  nextCursor: string,          // opaque; pass back as `since`
  hasMore: boolean,
  fixtures: FixtureChange[]
}
FixtureChange = {
  ref: string,                 // fixture ref
  syncStamp: string,           // ISO-8601 UTC, when medicoach last touched this fixture for sync
  schedule: {
    scheduledTime: string | null,   // ISO-8601 with offset, e.g. "2026-10-04T09:00:00+02:00"
    timeTbc: boolean,
    dateTbc: boolean,
    venue: string | null,           // free text, at most 200 characters (see Field limits)
    postponed: boolean,
    cancelled: boolean,
    changedAt: string               // ISO-8601 UTC: last schedule write in medicoach (any origin);
                                    // "1970-01-01T00:00:00.000Z" when the schedule was never edited in
                                    // medicoach (so any smart club edit is newer)
  },
  teams: {                     // resolved teams as team refs; null = not (yet) a known smart club team
                               // (including a team with no ref in this competition's league)
    homeRef: string | null,
    awayRef: string | null
  },
  result: null | {
    homeScore: string | null,       // display score, e.g. "184/6 (20)"
    awayScore: string | null,
    summary: string | null,         // e.g. "Crusaders won by 23 runs"
    winner: "home" | "away" | "tie" | "none" | null,
    method: "normal" | "run-rate" | "dls" | "no-result" | "abandoned" | "tie" | "forfeit" | null,
    noResult: boolean,
    source: "live" | "manual" | "import",   // import = migration/backfill/service principal → NO captain reports
    recordedAt: string,             // ISO-8601 UTC
    scoringSide: "home" | "away" | null,     // side whose team sheet the captain came from (live only);
                                             // null when the scoring team is not one of the fixture's sides
    captainRef: string | null,      // player ref of that side's captain; null when unknown
    medicoachMatchUrl: string | null,
    medicoachMatchId?: string,      // the linked live match's id; ABSENT (never null) without a linked
                                    // match (manual / imported results). See §3.
    medicoachTournamentId?: string  // the medicoach competition of the fixture; present exactly when
                                    // medicoachMatchId is. Together they address the scorecard (§3).
  },
  resultClearedAt: string | null    // ISO-8601 UTC; set when a previously recorded result was removed/reopened
}
```
Consumer rules (smart club):
- Result: store only if `result.recordedAt` > stored `recordedAt`. Clear only if `resultClearedAt` > stored `recordedAt`.
  A result recorded again after a clear (a live match reopened then completed again, or a fixture
  relinked onto a finished match) always has `recordedAt` strictly after that `resultClearedAt`.
- `cancelled: true` is also how medicoach reports a synced fixture that was removed. Medicoach
  refuses to delete a synced fixture (organisers mark it Cancelled), and never reports a removed
  copy of a fixture over the live one.
- Schedule: apply only if `schedule.changedAt` > smart club's `schedule.changedAt` for that fixture.
- Unknown refs are logged as "unmapped" (log count, never ref values for players).
- Scorecard: when a result carries `medicoachMatchId` + `medicoachTournamentId`, the full scorecard can be
  fetched from §3. Both are opaque medicoach ids: store them as given, never log them alongside refs.

## 2. POST /integrations/smartclub/schedule
Body:
```ts
{
  version: 1,
  tenant: string,
  changes: Array<{
    ref: string,
    schedule: {
      scheduledTime: string | null, timeTbc: boolean, dateTbc: boolean,
      venue: string | null,         // at most 200 characters (see Field limits)
      postponed: boolean, cancelled: boolean,
      changedAt: string            // ISO-8601 UTC: when the change was written in smart club
    }
  }>                              // max 100
}
```
Response 200:
```ts
{ version: 1, results: Array<{ ref: string, status: "applied" | "stale" | "unchanged" | "unmapped" | "error", message?: string }> }
```
Medicoach rules: apply only if `changedAt` > the fixture's `scheduleChangedAt`; applying sets `scheduleChangedAt = changedAt`
(so the next pull does NOT bounce it back as newer) and stamps `syncStamp`. Never soft-delete — `cancelled` is a flag.
A `changedAt` more than 5 minutes ahead of medicoach's clock is refused with `error` (fix the sender's clock).
Gap fill (the one exception to most-recent-wins): when a change is stale BUT medicoach's stored venue is
null/empty AND the incoming venue is non-empty, medicoach writes ONLY the venue (same compare-and-set as an
applied change), sets `scheduleChangedAt` strictly after the stored value, stamps `syncStamp`, and answers
`applied` with message `venue filled`. Every other field medicoach holds stands, and a non-empty medicoach
venue is never overwritten this way. Typical case: smart club withheld the venue, medicoach edited the time,
then smart club revealed the venue — the reveal is stale, but the venue still lands. The next pull returns
medicoach's whole schedule (its time plus the filled venue) with a `changedAt` newer than smart club's.
Every applied change is audited in medicoach under the `smartclub-sync` principal.
`stale`/`unchanged`/`unmapped` are success outcomes for the caller (drop from outbox); `error` = retry later.

## 3. GET /integrations/smartclub/matches/:matchId/scorecard?tournamentId=<id>&tenant=<t>
- Same HMAC signing as §1 and §2; `pathAndQuery` is exactly
  `/integrations/smartclub/matches/<matchId>/scorecard?tournamentId=<tournamentId>&tenant=<tenant>`
  (params in that order; the whole query string is signed, so `tenant` is covered by the signature).
- `matchId` = a result's `medicoachMatchId`; `tournamentId` = its `medicoachTournamentId`. Both are
  `[A-Za-z0-9_-]{1,128}`. `tournamentId` is REQUIRED: medicoach finds the match through that
  competition's synced fixtures (a match has no index by id alone).
- `tenant` is REQUIRED, with the same meaning and format as §1's `tenant` (the smart club tenant slug,
  `[a-z0-9][a-z0-9-]{0,62}`). Only fixtures whose `ref` belongs to that tenant are considered.
- 400 `"<param> is required"` when `tournamentId` or `tenant` is missing or empty; 400
  `"<param> is invalid"` when either is present but malformed; 400 `"matchId is invalid"` when `matchId`
  is malformed.
- 404 when no SYNCED fixture of that tournament (one with a smart club `ref`) OWNED BY THAT TENANT is
  linked to that match, or the match was deleted. Also 404 when the fixture's result was set by a
  medicoach administrator over its live match (a result override): that result is a manual one — §1
  sends it with `source: "manual"` and no `medicoachMatchId` — so its ball-by-ball is not served.
  Clearing the override restores the live result (re-recorded after the clear) and the scorecard.
  Another tenant's match is the same constant 404 as a
  match that does not exist: nothing about it is revealed.
- Scorecards are computed from the ball-by-ball record on every call (never stored); Time Cricket reads
  its paged ball log. Cricket only.

Response 200 — a match with no ball bowled yet:
```ts
{ available: false, matchId: string }
```
Response 200 — otherwise (example: `scorecard-live-match.json`):
```ts
{
  available: true,
  matchId: string,
  matchState?: string,              // e.g. "Umzinto won by 8 runs"; limited overs, once decided
  innings: Array<{                  // batting order; innings with no ball, run or batter are left out
    battingTeamName: string,        // the fixture's side name
    totalRuns: number, wickets: number,
    overs: string,                  // over.ball, e.g. "19.4"
    extras: { byes: number, legByes: number, wides: number, noBalls: number, penalties: number, total: number },
    batters: Array<{
      order: number,                // 1-based order at the crease
      name: string,
      runs: number, ballsFaced: number, fours: number, sixes: number,
      strikeRate: number,           // 2 dp
      howOut: string,               // "c E. Dlamini b D. Mokoena", "not out", "run out (A. Smith)"
      dismissal?: string            // dismissal type ("caught", "bowled", "retired hurt"…); absent while not out
    }>,
    bowlers: Array<{
      order: number,                // 1-based order of first appearance
      name: string,
      overs: string,                // "4.0"
      maidens: number, runsConceded: number, wickets: number,
      economy: number,              // 2 dp
      wides: number, noBalls: number   // deliveries, not runs
    }>,
    fallOfWickets: Array<{ wicket: number, runs: number, overs: string, batterName: string }>
  }>
}
```
- Players are NAMES ONLY: no player ids, emails or refs ever appear. A player with no usable name on
  record (blank, or an email in the name slot) reads `"Unknown"`.

## 4. POST /integrations/smartclub/players
Desired-state player push: each entry carries the player's FULL current desired placement
(details + the smart-club-mapped teams they should be on), or asks for removal/erasure.
Replays and out-of-order deliveries are harmless; ordering is guarded by `changedAt` per player
(compare-and-set against the player's stored `smartClubSyncChangedAt`, `>` strictly, one retry —
same discipline as /schedule). PERSONAL DATA: never log payload bodies; log refs only as counts.

Body:
```ts
{
  version: 1,
  tenant: string,
  dryRun?: boolean,              // true ⇒ compute and return outcomes, write NOTHING
  players: Array<{
    ref: string,                 // player ref (see Refs)
    op: "upsert" | "remove" | "erase",
    changedAt: string,           // ISO-8601 UTC: when this desired state was produced in smart club
    // upsert only (omitted for remove/erase):
    institutionRef?: string,     // primary club ref
    firstName?: string, lastName?: string,
    dob?: string,                // "YYYY-MM-DD"
    gender?: string,
    email?: string,              // may be absent; see email rules below
    cell?: string,
    isMinor?: boolean,
    guardianName?: string,
    teamRefs?: string[],         // the COMPLETE set of smart-club-mapped teams the player belongs on
    veteransInstitutionRef?: string,
    resolution?:                 // admin's answer to an earlier needs-review, rides on the re-push
      | { action: "link", playerId: string }
      | { action: "create", acknowledgedCandidates: string[] }   // medicoach player ids the admin saw
  }>                             // max 50
}
```
Response 200:
```ts
{
  version: 1,
  results: Array<{
    ref: string,
    status: "created" | "linked" | "updated" | "unchanged" | "removed" | "erased"
          | "stale" | "needs-review" | "unmapped-team" | "error",
    message?: string,
    candidates?: Array<{         // needs-review only
      playerId: string, name: string, dob: string | null, institutionName: string | null
    }>,
    missingTeamRefs?: string[],  // unmapped-team only
    fieldDiffs?: Array<{ field: string, from: string | null, to: string | null }>
                                 // dryRun+updated only: what a real push would change (values redacted
                                 //   to "<set>"/"<cleared>" for email/cell/guardianName)
  }>
}
```
Medicoach rules:
- Resolve `ref` → player id via the external-ref table. On a miss, match in this order:
  1. SA-ID-hash equality (ref's natural key vs hashed `idNumber`) across ALL of the tenant's
     smart-club-mapped institutions, CORROBORATED by matching surname or dob → link. An
     uncorroborated or dob-conflicting hash match → `needs-review` (a mistyped ID must never
     merge two people). An uncorroborated hash candidate does not block a `resolution.create`.
  2. Exact normalised name + dob WITHIN the target institution only → link. The same match at a
     DIFFERENT institution → `needs-review`.
  3. Anything weaker, or MORE THAN ONE candidate at any tier → `needs-review` with `candidates`.
  4. No candidate → create. A 409 identity-claim conflict on create is NOT a link: link only when
     the claim-holder's dob or SA-ID hash agrees AND the holder belongs to one of the tenant's
     smart-club-mapped institutions; otherwise `needs-review` with the holder as candidate.
  A `resolution` skips matching: `link` binds the ref to that player id; `create` creates unless
  new tier-1/2 candidates have appeared since (then `needs-review` again).
- Creation is race-safe: reserve the ref with a conditional put (pending), create, finalise.
  A lost race reads the winner and links. Pending reservations older than 10 min may be taken over.
- On link/create, write both the forward and reverse ref rows (with institution ids).
- Teams: resolve every `teamRefs` entry via the external-ref table; ANY miss ⇒ `unmapped-team`
  with `missingTeamRefs` and NO writes for that player. Otherwise add the player to each desired
  team (idempotent; reactivates soft-deleted memberships) and soft-remove memberships ONLY on
  smart-club-mapped teams no longer desired. Teams without a smart club ref are NEVER touched.
- Where a linked league/competition team keeps a projection player list, append/remove the player
  there too (new entries unticked), preserving existing squad ticks.
- Details: update only name, dob, contact and guardian fields. Name/email changes go through the
  identity-claim rekey in the same transaction. Email is asymmetric: fill a placeholder, never
  replace a real email (and never once the player's account is active). Names compare normalised
  (single `name` vs "firstName lastName"; case/space/middle-name tolerant).
- `remove`: soft-remove all smart-club-mapped memberships; the player row is untouched.
- `erase`: soft-remove mapped memberships; anonymise the player (name → "Erased player"; clear
  dob/gender/race/nationality/contact/guardian/idNumber/email); release identity claims; delete BOTH ref rows. Stats stay
  on the anonymised id. An erase whose ref is already gone is `erased` (idempotent no-op), never
  a matcher run.
- `stale`, `unchanged`, `removed`, `erased` are success outcomes for the caller (drop from outbox);
  `needs-review` drops to the caller's review queue; `unmapped-team` parks; `error` = retry later.
- A `changedAt` more than 5 minutes ahead of medicoach's clock is refused with `error`.
- Every write is audited under the `smartclub-sync` principal.

## Import/carry endpoints (v1)

Read-only ground truth for smart club's "released in smart club but never carried to medicoach"
check (Match Centre Connection Console, ADR 0020): fixtures awaiting a carry come from these
answers, never from the absence of write events. Versioned separately from sync v1 as import
contract v1 (`MEDICOACH_IMPORT_VERSION` in smart club, `SMARTCLUB_IMPORT_VERSION` in medicoach);
the payloads carry no `version` field. Both endpoints are signed exactly like §1/§2 (same headers,
same shared secret, same 401/503 rules) and write nothing. A medicoach that has not deployed them
answers 404; smart club treats that (and any other failure) as "medicoach not reachable for
reconciliation" and changes nothing.

### 5. GET /integrations/smartclub/import/connection-summary?tenant=<t>
- `pathAndQuery` is exactly `/integrations/smartclub/import/connection-summary?tenant=<tenant>`.

Response 200:
```ts
{
  tenant: string,
  generatedAt: string,           // ISO-8601 UTC
  competitions: Array<{
    ref: string,                 // competition ref medicoach has mapped (sorted by ref)
    fixtureCount: number         // mapped fixture refs in that competition's medicoach tournament
  }>,
  totals: {
    competitions: number,
    fixtures: number             // every mapped fixture ref of the tenant
  }
}
```
- Built from the external-ref table's tenant index (competition refs + fixture refs); never a scan.
- A fixture is attributed to a competition by the medicoach tournament both refs point at.
  `totals.fixtures` counts every mapped fixture ref, so it can exceed the sum of `fixtureCount`
  when a fixture's tournament has no mapped competition ref.
- An unknown tenant is not an error: `competitions: []`, zero totals. A malformed `tenant` is 400.

### 6. POST /integrations/smartclub/import/check-refs
Body:
```ts
{
  tenant: string,
  refs: string[]                 // 0..500; every ref must start with `smartclub:<tenant>:`
}
```
Response 200:
```ts
{
  mapped: string[],              // refs medicoach holds a live mapping for
  unmapped: string[]             // everything else (request order, duplicates collapsed)
}
```
- Every requested ref lands in exactly one list. An empty `refs` list is a reachability probe.
- 400 when the body is not the shape above (including more than 500 refs) or when ANY ref belongs
  to a different tenant than the body's `tenant` (a signed caller cannot probe another tenant).
- "Mapped" = a live external-ref row: not deleted, not an erase tombstone, not a pending player
  reservation. A ref of a kind medicoach doesn't map is `unmapped` (the fixture needs a bundle
  carry/top-up).
- Any ref kind may be checked. Player refs are PERSONAL DATA: medicoach never logs them.
- Smart club sends every fixture ref of its released, sync-mapped series (fixtures with a
  `pos:`/`tbd:` side are never exported and never sent), in chunks of ≤500, at most once a day per
  tenant from the sync cron, and on demand from the operator console.

## WhatsApp status forwarding (medicoach → smart club)

Smart club sends its WhatsApp notices through medicoach's Meta app/WABA, and a Meta app
has ONE callback URL per subscribed field — so smart club's delivery statuses (sent /
delivered / read / failed) arrive on medicoach's webhook. After its own Meta-signature
check passes, medicoach forwards them, fire-and-forget:

- `POST ${SmartClubBaseUrl}/integrations/whatsapp/status`
- Body: `{"statuses": [ ...Meta status objects, unchanged... ]}` — at most 500 per request.
- Headers: the v1 signing scheme and the SAME shared secret
  (`X-Sync-Timestamp`, `X-Sync-Signature: sha256=<hex HMAC-SHA256(secret,
  "${ts}.POST./integrations/whatsapp/status.${rawBody}")>`).
- Only statuses whose `value.metadata.phone_number_id` is smart club's sending number are
  forwarded. While the two platforms share one number, medicoach's own statuses are
  forwarded too; smart club ignores message ids it doesn't know (200 with counts).
- Fire-and-forget: ~3s timeout, no retries, never changes medicoach's response to Meta.
  Statuses only move a delivery forward (sent < delivered < read; failed is final), so
  drops and duplicates are both harmless.
- Skipped silently when `SmartClubBaseUrl` or the shared secret is unset on that stage.
