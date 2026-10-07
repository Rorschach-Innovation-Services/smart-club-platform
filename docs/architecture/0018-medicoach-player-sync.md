# ADR 0018 — Medicoach player sync: smart club pushes desired roster state per person

**Status:** Accepted (October 2026). Smart club side built on `worktree-medicoach-player-sync`;
medicoach's `POST /integrations/smartclub/players` ships separately (deploy it first).

## Context

The fixture/result sync ([ADR 0016](0016-medicoach-fixture-sync.md)) keeps fixtures and results
aligned, but players reached medicoach only through the one-off migration bundle
(`export-medicoach.ts` → `import-bundle.mjs`). Anyone registered on smart club after the
migration is missing from the medicoach team roster, so the scorer cannot pick them.

Decisions taken with the union before building:

- a clearance-pending player syncs only once the clearance is approved or overridden; they then
  move to the new club's team and leave the old one;
- inactive or rejected players are removed from their teams (membership soft-removed, history
  kept); POPIA erasure additionally anonymises the medicoach player and drops its ref;
- uncertain matches are held for an admin; exact matches link automatically;
- every active player is backfilled at rollout with a dry-run-first CLI.

## Decision

### Direction, transport, identity

Smart club pushes; medicoach applies — the mirror of `POST /schedule`. Same HMAC
(`signRequest`), same secret, same 15-minute cron and "Sync now". The contract gains one
additive endpoint (§3 of `docs/integrations/medicoach-sync-contract.md`, byte-identical in both
repos and pinned by sha256 in both contract tests).

The person's ref stays `smartclub:<t>:player:<naturalKey>`. Medicoach's external-ref tables
remain the only mapping; smart club stores no medicoach ids (a review's candidate ids are the
one, short-lived exception — see PII).

### Desired state, per person

Each push carries a person's **full current desired placement** — details plus every team ref
they belong on — or `remove` / `erase`. Medicoach compares it with what it has, so a duplicate
or out-of-order push is harmless; `changedAt` orders pushes (last write wins, `>` strictly).

The state is computed **per person** (all rows of the natural key across the tenant), never per
row (`player-placement.ts:syncIntent`):

| Person's rows                                                           | Intent                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ≥1 active (or status-absent) non-placeholder row                        | `upsert`, team refs = union over every eligible row (main + veterans)         |
| a pending clearance: source row + destination row                       | `upsert` with the **source** club's teams; the destination waits for approval |
| a rejected clearance (source reactivated, ADR 0012)                     | `upsert` with the source teams — never `remove`                               |
| all inactive / legacy `clearance-rejected` / placeholder-only / no rows | `remove`                                                                      |
| POPIA erasure via `erasePlayerData` **only**                            | `erase` tombstone                                                             |

A `clearance-pending` row counts only as the SOURCE of a pending clearance naming it.

Team placement is the bundle's own rules, extracted from `buildPlayers` into
`desiredTeamRefs` and called by **both** the exporter and the sync, so the two can never place a
player apart (the exporter's output is byte-identical; regression-tested). The sync builds the
same team refs the bundle builds (catalogue + series leagues, `clubTeamsForLeague` sides plus
series participants, club squads).

### Outbox: `PENDINGPLAYERSYNC#<naturalKey>`

In the `TENANT#<t>#SYNC` partition, next to `PENDINGSYNC#`:

- one row per person; repeated changes collapse (conditional on the stored `changedAt` being
  older), and the row is deleted only while it still holds the `changedAt` that was sent — a
  change landing mid-push survives;
- the row holds **natural key + timing only** (`changedAt`, `attempts`, `lastError`, `parked`,
  `resolution`): the payload is rebuilt from live data at flush, so the outbox never holds stale
  personal data;
- `op: 'erase'` tombstones are the exception (the rows are gone). A later enqueue for the same
  person (a re-registration) replaces the tombstone but keeps `eraseFirst`, so the erase still
  goes out first and the new registration then creates a fresh medicoach player.

Every repo write that changes a player row calls `recordPlayerSyncChange` (create, update,
delete, team backfill, every clearance transition incl. resolve/reject/reopen/reassign), so the
API **and** the import CLIs are covered; it is a no-op unless the tenant has the player sync on
and never fails the write it follows. `eraseClubData` enqueues **plain** changes for every person
it touched — club cleanup is not consent-based erasure and the person may still play at another
club (veterans), so the rebuild yields an upsert with fewer teams, or `remove`. `eraseTenantData`
deletes the whole SYNC partition, outbox included.

### Flush

`flushPlayerOutbox` runs in `runTenantSync` after the schedule flush (a failure never stops the
pull), at most 500 rows per run (fresh rows before failing ones; the rest wait for the next
run), in batches of ≤50:

- `created` / `linked` / `updated` / `unchanged` / `removed` / `erased` / `stale` → delete the
  row (`stale` = already applied or superseded);
- `needs-review` → `PLAYERREVIEW#<nk>` with medicoach's candidates; row dropped;
- `unmapped-team` → **parked**: not resent every run (that would repeat personal data every 15
  minutes); retried by the admin or after a bundle top-up;
- `error` / a failed request → `attempts + 1` (stuck at 5, still retried).

Dry run when `MedicoachSyncUrl`/`MedicoachSyncSecret` are empty.

### Duplicate prevention (smart club side)

- **One push per person**, keyed by the tenant-wide natural key; a clearance's two rows are one
  player who moves, not two.
- **Same-person, different-key guard**: before an upsert, another smart-club person with the
  same normalised name + dob under a different natural key (typo'd ID, passport later swapped
  for an SA ID) holds the push as a `smartclub-possible-duplicate` review. "Different people"
  writes `PLAYERDISTINCT#<a>#<b>` so that pair is never flagged again, and pushes both.
- **At registration**: chair add-player, quick-add and roster upload return a soft
  `possibleExistingAt` warning ("possible existing registration at X") on the same match.
- Nothing flows back: the sync never creates smart-club players from medicoach data.

### Admin surface and flag

`GET /integrations/medicoach/status` gains `players` (pending, parked, stuck, reviews, the team
refs parked players need). `GET /integrations/medicoach/player-reviews` and
`POST …/player-reviews/:nk/resolve` with `link` (one of the candidates), `create` (every
candidate acknowledged), `distinct`, `dismiss`; `POST /integrations/medicoach/players/retry`
un-parks/restarts rows. The admin page shows a Players panel.

`TenantConfig.integrations.medicoach.playerSync` (default off, operator-only) requires
`features.medicoachSync`. Switching it on runs a team-coverage probe against the last recorded
medicoach export and warns (never blocks) when players would park.

## PII and POPIA

- Payloads carry names, dob, contact and guardian; **no raw ID number** (as the bundle). Nothing
  logs a payload, ref or natural key — counts only.
- `PLAYERREVIEW#` rows hold medicoach candidates' personal data: they carry a 60-day TTL
  (`expiresAt`), are deleted on resolve, and are deleted by `erasePlayerData` — including other
  people's possible-duplicate reviews that name the erased person as a candidate.
- `erasePlayerData` writes the `erase` tombstone and deletes the person's `PLAYERDISTINCT#`
  pairs. Medicoach then soft-removes memberships, anonymises the player (name → "Erased player";
  dob, contact, guardian, ID and email cleared), releases identity claims and deletes both ref
  rows.
- **Medicoach-side erase tombstone.** Erasing deletes the ref rows, so medicoach keeps a
  short-lived marker on the forward ref recording `erasedAt`. A replayed or delayed `upsert`
  with `changedAt <= erasedAt` answers `stale` (it can never resurrect the erased player); a
  genuinely newer `upsert` is a re-registration — it clears the marker and creates a fresh
  player (smart club's `eraseFirst` makes sure the erase is sent before it).
- **Erasing one of several refs.** When the athlete also carries another smart-club ref (two
  refs, one player), an `erase` removes only the teams that ONLY the erased ref wanted and
  drops that ref; full anonymisation and claim release happen only when the last ref goes.
- **Match statistics are retained** on the anonymised medicoach player. Lawful basis: legitimate
  interest in historical competition records (results, scorecards and standings other players
  and clubs rely on), with every identifier removed so the record no longer relates to an
  identifiable person.

## Consequences

- One extra DynamoDB read (tenant config) per player write, and a full roster read per flush
  that has work (the same reads the exporter does).
- Teams reach medicoach only through the bundle; a club or league added later parks its players
  until a bundle top-up. The runbook makes coverage a precondition of enabling.
- Deploy order matters: medicoach's `/players` route first. Against a 404 the rows go stuck; the
  recovery is `POST /integrations/medicoach/players/retry` (scope `stuck`) once it is live.
- Import CLIs that write player rows outside the repo functions (e.g. the clearance backfills
  that write with raw DynamoDB calls) are not hooked: re-run `enqueue-players --confirm` after
  any such import.
