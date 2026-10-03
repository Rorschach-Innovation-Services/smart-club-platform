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
    venue: string | null,           // free text
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
    medicoachMatchUrl: string | null
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
      venue: string | null, postponed: boolean, cancelled: boolean,
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
Every applied change is audited in medicoach under the `smartclub-sync` principal.
`stale`/`unchanged`/`unmapped` are success outcomes for the caller (drop from outbox); `error` = retry later.
