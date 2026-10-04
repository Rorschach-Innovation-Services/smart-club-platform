# Medicoach ↔ Smart Club sync contract — v1

This is the source of truth for both repos. Copy the `examples/*.json` files verbatim into
`docs/integrations/medicoach-sync-examples/` in BOTH repos; each repo has a test that parses every
example with its own zod schema (drift fails CI).

## Direction & auth
- Smart club is always the CALLER for fixtures, results and live state (§1–3); medicoach never
  calls smart club except to forward WhatsApp statuses (below).
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
Every applied change is audited in medicoach under the `smartclub-sync` principal.
`stale`/`unchanged`/`unmapped` are success outcomes for the caller (drop from outbox); `error` = retry later.

## 3. GET /integrations/smartclub/live?tenant=<t>&date=YYYY-MM-DD

Read-only, for smart club's admin **Match monitor**: the live-scoring state of every match on one
day that is linked to one of this tenant's fixture refs. Smart club calls it on demand (the admin
page polls every 30 s while it is open), so it is NOT part of the cursor feed and stores nothing.
The `/changes` feed is unchanged: an in-progress match still never produces a `result` there.

- `date` is the SAST calendar day (UTC+2) of the fixture's scheduled date.
- Every match linked to a fixture with an `externalRef` for this tenant on that day; a fixture
  with no linked match is simply absent. Mirror copies are skipped (one row per ref).
- Same signing as the other endpoints. 400 for a malformed `tenant`/`date`.

Response 200 (example: `live-day.json`):
```ts
{
  version: 1,
  tenant: string,
  date: string,                 // as asked
  generatedAt: string,          // ISO-8601 UTC
  matches: Array<{
    ref: string,                // fixture ref
    status: "not_started" | "in_progress" | "innings_break" | "completed" | "abandoned",
    startedAt: string | null,   // first ball of the match (ISO UTC)
    endedAt: string | null,     // completed / abandoned at
    lastInputAt: string | null, // latest scoring save of any kind
    oversPerSide: number | null,
    innings: Array<{            // at most 4, in order
      number: number,           // 1..4
      battingSide: "home" | "away" | null,
      runs: number, wickets: number,
      overs: string,            // cricket overs, e.g. "12.3"
      startedAt: string | null, // first ball of the innings
      endedAt: string | null    // set once the innings is closed
    }>,
    deliveries: number,         // balls scored so far, legal and extras
    medianGapSec: number | null,// median gap between consecutive balls of one innings
    longGaps: Array<{           // gaps >= 120 s between consecutive balls of ONE innings,
                                // longest first, at most 50
      innings: number,
      over: string,             // the ball that ended the gap, e.g. "14.2"
      at: string,               // when that ball was scored (ISO UTC)
      gapSec: number,
      reason: "drinks" | "interruption" | null  // a break the scorer recorded inside the gap
    }>,
    undoCount: number | null,   // times the scorer pressed Undo; null = not tracked for this match
    players: Array<{            // at most 60: both team sheets, then anyone added during play
      side: "home" | "away",
      name: string,             // as the scorer has it (max 120 chars)
      ref: string | null,       // smart club player ref when the player came from smart club
      addedDuringMatch: boolean,// added with "add player" after scoring began
      addedAt: string | null    // when it was first seen in a save (ISO UTC)
    }>,
    medicoachMatchUrl: string | null
  }>
}
```
`players` is PERSONAL DATA (names, and refs that are hashed ID numbers): never logged on either
side. Smart club checks each player against the side's club roster (active registration at this
club / inactive or clearance pending / registered at another club / not registered; a player
with no ref is matched by name) and sends its admin page the status and the name — never the ref.

What medicoach needs to add (neither is recorded today — Undo deletes events and "add player"
writes only a name-map entry):
- `undoCount`: count in `handleSaveLiveScoring`, where the previous blob is already loaded
  (`previousLiveScoringData`): delivery ids present before and missing now, minus ids removed by
  an Edit-Overs delete. Exact counting needs the clients to send an `undoCount` (or an undo log)
  that the save schema keeps — today `SaveLiveScoringSchema` strips unknown fields. Until then
  send `null` rather than a guess.
- `addedDuringMatch` / `addedAt`: on the same save, a player id that appears in
  `batsmenNames`/`bowlersNames` for the first time after the first ball (not in
  `selectedPlayerIds` or the creation-time `guestPlayers`) is "added"; stamp `addedAt` with the
  save time and keep it on the match so it survives later saves.
- `ref`: the player's smart club ref via the ExternalRef reverse rows (`refForInstitution`),
  filtered to the side's institution; `guest-`/`opponent-` ids have none.
Deriving the fields in medicoach (cricket limited-overs, from the linked `PostMatchAnalysis`):
- Ball times are each delivery's `timestamp` (scorer device clock, epoch ms). The innings `start`
  marker can be re-timestamped when the setup is edited, so `startedAt` is the first BALL's time.
- `lastInputAt` = `liveScoringData.lastSaved`; innings `endedAt` = the `inningsComplete` marker
  (or the last ball of a closed innings); `endedAt` = the `gameComplete` marker / completion save.
- `innings_break` = innings 1 closed and innings 2 has no ball yet.
- A gap's `reason` comes from a `drinksBreakStart`/`End` or `matchInterruptionStart`/`End` marker
  between the two balls. A gap across innings is never listed (the break is innings times).
- Runs, wickets and overs as the scorecard shows them (`computeInnings`).

Consumer rules (smart club): nothing is stored; a failure answers the admin page with the day's
fixtures and the reason. Smart club applies its own thresholds (late start, delay, scorer
silence, long break, undo count) on top of these facts and flags every player the roster can't
vouch for.

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
