# Player clearances

An inter-club transfer. When a player moves from one club to another, the destination
club can only register them once the **source** club (or the union office on its behalf)
settles fees and misconduct. Source: `packages/api/src/index.ts` (routes) and
`packages/api/src/repo.ts` (`rejectClearance`, `reopenClearance`, `detectRejectCase`,
`resolveClearance`).

See [ADR 0012](../architecture/0012-clearance-reject-cancels-the-move.md) for the reject/reopen
design, and the [backfill runbook](../runbooks/backfill-declared-club-clearance.md) for the
declared-previous-club population every registration-origin clearance came from.

## Model

A clearance is stored as **two items written together** (see
[data-model.md](../architecture/data-model.md), rows "Clearance (canonical)" / "(mirror)"):

- the **canonical** item under the **source** club (`sk CLEARANCE#<id>`), carrying the sole
  `gsi1` entry so the admin console lists every request in one query;
- the **mirror** under the **destination** club (`sk INBOUND_CLEARANCE#<id>`, no `gsi1`), so
  each club reads only its own partition — never a tenant-wide scan.

Both items are kept in sync inside the same transaction.

### How a clearance comes to exist (`origin`)

- **`request`** (absent `origin`) — the destination rep initiated it (`POST /clubs/:id/clearances`).
  There is no destination player row until the clearance is issued.
- **`registration`** — opened automatically when a player registered with a new club and
  declared an on-system previous one. The destination row already exists, status
  `clearance-pending`, holding the player's self-asserted data. Every backfilled KZNCU
  clearance is this shape.

`fromClubDirectory: true` marks a source that was an off-system directory entry when the
clearance opened (no source club record, no source player row). It drives listing and UX
only — resolve/reject/reopen branch on the **actual** source row, because a club may sign up
under the directory slug and roster the player after the clearance opens.

### Status lifecycle

```
pending ──issue (source)──────────────► approved
        ──override (admin)────────────► admin-override
        ──reject (admin)──────────────► rejected ──reopen (admin)──► pending
```

`rejected` is now **reversible**: reopen returns it to `pending`, and reject → reopen may
repeat. `approved` and `admin-override` are terminal.

### Player status

A rejected clearance no longer writes any player status. The legacy `PlayerStatus`
`'clearance-rejected'` is kept read-only so rows written before this change still render;
no new code sets it.

## Routes

Admin routes live under `/admin/*` (admin-only, enforced by middleware). Club routes require
the rep to own the path club (`assertClubAccess`).

### `POST /clubs/:id/clearances` — initiate a request (rep, destination club)

The path club must be the **destination**. Body `{ fromClubId, idNumber | playerNaturalKey,
note? }`. The source player is loaded to confirm they exist; the rest of the source roster is
never read.

- `400` — `fromClubId` and an `idNumber` (or `playerNaturalKey`) required; source and
  destination the same club.
- `404` — club not found; player not found at source club.
- `409` — a clearance for this player is already pending; destination club gone.
- `201` — the created clearance.

Best-effort: the source chairman gets an email/WhatsApp heads-up (`notifyClearanceOpened`).

### `GET /clubs/:id/clearances` — a club's queue (rep or admin)

Returns `{ incoming, outbound }`: `incoming` is the clearances this club must action (it is
the source), `outbound` is the ones moving to it (it is the destination, read from its own
mirror items). The `rejectSnapshot` is **never** present — it is stripped at the repo read
layer, so the source rep never sees the destination's self-asserted contact/ID data.

### `PATCH /clubs/:id/clearances/:cid` — act on a request (rep, source club)

Only the source club may act. Body `{ feesCleared?, misconductCleared?, action?: 'issue',
version? }`. `action: 'issue'` requires both confirmations and atomically moves the player to
the destination.

- `403` — only the source club may action this clearance.
- `404` / `409` — not found / already resolved.

### `GET /admin/clearances` — the console list (admin)

Every clearance in the tenant, one row per request (canonical items only). Each row is a
`PlayerClearance` plus two derived, never-stored fields:

- **`sourceRostered?: boolean`** — set only for **pending registration-origin** clearances:
  does the source club actually hold this player? Absent ⇒ unknown (older API, the derivation
  failed, or this row's source probe was unresolved), which the console treats as its own state,
  never as `false` — "could not check" must not read as "not rostered".
- **`predictedRejectCase?: 'A' | 'B' | 'B-placeholder' | 'B-active' | 'C' | 'D'`** — what a
  reject would do, computed server-side from the **same** `detectRejectCase` the reject runs
  (see the case table below). In the listing `destPending` is always true, so a case is always
  derivable once the source probe resolves; absent therefore means the derivation **failed** —
  either the whole batch (a fault reading the probes/clubs) or, per row, a source probe the
  throttled `BatchGet` could not resolve (never guessed as "not rostered"). The console uses
  this to word the confirm dialog and to fail **closed** (Reject disabled) when it is absent —
  cases C and B-placeholder create or replace a row at another club, so the admin must see the
  prediction before confirming.

`rejectSnapshot` is never returned.

### `POST /admin/clearances/:cid/override` — issue on the clubs' behalf (admin)

Body `{ fromClubId, version?, reason? (≤500 chars) }`. Approves a still-pending clearance,
moving the player to the destination. `reason` is stored as `overrideReason` and shown on the
resolved card to both clubs. Override is also the **disposal** path for a clearance that
should never have existed — see [Disposing of junk](#disposing-of-junk) below.

### `POST /admin/clearances/:cid/reassign` — reallocate the source (admin)

Body `{ fromClubId, newFromClubId, version? }`. Moves a **sourceless** registration-origin
clearance to the club the player actually left, backfilling a placeholder source row. Refused
once the current source club holds the player, or once a real club owns a directory slug.

- `400` — missing ids; new source equals current or the destination; not registration-origin.
- `409` — that club is now on the system / holds this player (its rep must action it);
  `clearance changed; refetch`; player already at target; destination gone.
- `404` — clearance / target club not found.

### `POST /admin/clearances/:cid/reject` — cancel the move (admin)

Body `{ fromClubId, version?, reason? (≤500 chars) }`. Rejecting means **the move to the new
club is cancelled** — the player ends up active at the source club, regardless of how the
clearance was created. The exact effect is one of six cases, decided from the **live** row
state ([case table](#reject-cases)). Reject **purges nothing** (the snapshot needs the
objects) and is **reversible** via reopen.

- `400` — `fromClubId` required; `reason` must be a string ≤500 chars.
- `404` — clearance not found.
- `409` — `clearance already resolved`; `clearance changed; refetch`
  (`VersionConflictError` — a double reject, or the destination row no longer pending); the
  destination club is gone (`DestinationClubGoneError.message`); the source club is gone
  (`SourceClubGoneError.message`, case C's count guard).
- `200` — `publicClearance(rejected)`, carrying `rejectOutcome` (snapshot stripped).

Reject is **always available on a pending clearance** — there is no longer a source-rostered
or directory guard (both were removed with this change, because reject now moves such a
registration to the named club rather than discarding it). Junk registrations are disposed of
via override-then-delete instead, not reject.

Best-effort: **both** chairs are notified (`notifyClearanceResolved(…, 'rejected', …)`); the
per-outcome wording rides the email only. The reject-notice idempotency key carries a
`-v<version>` suffix so a re-reject after a reopen is a distinct send.

### `POST /admin/clearances/:cid/reopen` — undo a reject (admin)

Body `{ fromClubId, version? }`. Restores the pre-reject rows from the snapshot the reject
stored on the canonical, returning the clearance to `pending`. Reopen **clears**
`rejectedAt` / `rejectedBy` / `rejectReason` / `rejectOutcome` / `rejectSnapshot`, sets
`reopenedAt` / `reopenedBy`, and keeps `feesCleared` / `misconductCleared` as they were (the
source rep is not asked to re-tick). Reject → reopen may repeat.

- `400` — `fromClubId` required.
- `404` — clearance not found.
- `409` — one of:
  - `clearance is already open` (status `pending`);
  - `an issued clearance cannot be reopened` (status `approved` / `admin-override`);
  - `clearance changed; refetch` (`VersionConflictError` — stale `version`);
  - `player already registered at destination club` (`PlayerExistsAtDestinationError` — the
    player re-registered at the destination between reject and reopen);
  - `destination club no longer exists` (`DestinationClubGoneError`);
  - a `ClearanceReopenBlockedError.message` — the rows are no longer in their post-reject
    state, or the clearance was **rejected before reopen was supported** (a legacy reject with
    no snapshot). See [reopen block reasons](#reopen-block-reasons).
- `200` — `publicClearance(reopened)`.

Best-effort: **both** chairs are notified (`notifyClearanceReopened`), but with **different
content** — see [Notifications](#notifications).

## Reject cases

The reject case is decided from the **live** row state by `detectRejectCase`, never from
`fromClubDirectory` — the same function the console's `predictedRejectCase` runs through. The
snapshot named below rides the **canonical only** and is what reopen restores.

| Case                            | `predictedRejectCase` | Situation                                                                                         | Rows touched                                                                                                                                        | Counts                                    | Snapshot                                                                                                 | `rejectOutcome`        |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------- |
| **A** `request`                 | `A`                   | rep-initiated transfer (no destination row)                                                       | source row `clearance-pending` → `active`                                                                                                           | —                                         | `{ case: 'request' }`                                                                                    | `source-reactivated`   |
| **B** `dest-deleted`            | `B`                   | registration-origin; source holds the player's **real** pending row                               | source → `active`; destination row **deleted**                                                                                                      | dest −1                                   | `{ case: 'dest-deleted', destRow, sourceReactivated: true }`                                             | `source-reactivated`   |
| **B″** `moved-over-placeholder` | `B-placeholder`       | source holds only a **placeholder** (backfill / reassign stub — every backfilled KZNCU clearance) | the destination row (real registration) **replaces** the placeholder at the source, `active`, `lastClub` cleared (as in C); destination row deleted | dest −1 (placeholder was already counted) | `{ case: 'moved-over-placeholder', placeholderRow }`                                                     | `moved-to-source`      |
| **B′** `dest-deleted`           | `B-active`            | source already holds an **active** row (portal has no cross-club dedup)                           | source untouched; destination row deleted                                                                                                           | dest −1                                   | `{ case: 'dest-deleted', destRow, sourceReactivated: false }`                                            | `source-reactivated`   |
| **C** `moved-to-source`         | `C`                   | source club exists but holds **no** row (roster not digitised)                                    | destination row **moved** to the source club (full row incl. ID-doc metadata, `active`, `lastClub` cleared); destination row deleted                | source +1, dest −1                        | `{ case: 'moved-to-source' }` (no row — reopen moves the **live** row back so post-reject edits survive) | `moved-to-source`      |
| **D** `dest-activated`          | `D`                   | source is a directory entry with **no club record**                                               | player stays at the destination, `active` in place                                                                                                  | —                                         | `{ case: 'dest-activated' }`                                                                             | `stays-at-destination` |

A `ConditionCheck` on D that the source key is **absent** stops D applying after a club claimed
the directory slug and rostered the player; a refetch then predicts B′.

`isPlaceholder(row)` = `row.placeholder === true` OR (no `idDocMeta` AND no `cell` AND no
`email` AND no `registeredVia`). The explicit `placeholder: true` marker is written by the
reassign route and `backfill-registration-clearance.ts` from now on; the heuristic recognises
legacy stubs written before the marker existed.

### Who is notified

Both chairs, best-effort, on every reject and reopen (never failing the request):

- **Reject** → `notifyClearanceResolved(…, 'rejected', …)`. The resolved email body is worded
  by `rejectOutcome`:
  - `source-reactivated` — "The move is cancelled and they remain registered at {from}."
  - `moved-to-source` — "…their registration has been moved to {from}, and they no
    longer appear on {to}'s roster." (Both B″ — replacing the placeholder — and C share this
    copy; the email cannot tell them apart, and "moved to {from}" is true for both.)
  - `stays-at-destination` — "{from} is not on the system, so their registration stays at
    {to}."
  - every rejected body ends "The union office can reopen this clearance if it was rejected in
    error."
- **Reopen** → `notifyClearanceReopened` — the two chairs get **different** content (see below).

## Reopen contract

`reopenClearance(tenant, fromClubId, id, { at, by, expectedVersion })` restores each case's
pre-reject rows:

- **A** — source row → `pending`.
- **B** — re-put the deleted destination registration byte-equal (`attribute_not_exists` guard),
  source → `pending`, dest count +1.
- **B′** — re-put the destination registration, but only **check** the source is still active
  (never touch it), dest count +1. Without that check, a player transferred out of the source
  between reject and reopen would end up active at two clubs once the reopened clearance is
  approved.
- **B″** — move the live row back to the destination (`clearance-pending`), restoring `lastClub`
  (the reject cleared it, as in case C), and restore the placeholder at the source, dest count +1.
- **C** — move the **live** row back to the destination (so post-reject edits survive),
  restoring `lastClub`; delete it from the source; source −1, dest +1.
- **D** — destination row → `clearance-pending`.

<a id="reopen-block-reasons"></a>Reopen **blocks** (409, `ClearanceReopenBlockedError.message`) when the rows are no longer in
their post-reject state or the reject predates snapshots:

- `rejected before reopen was supported` — legacy reject, no snapshot.
- `player no longer available at the source club` — A / B source row gone (B″ throws
  `the record at the source club was removed` instead).
- `player no longer active at the source club` — B′ source row no longer active.
- `the record at the source club was removed` — C / B″ live row gone.
- `the source club record changed; refetch and try again` — B″ source row version moved, or it
  is now held `clearance-pending` by a new transfer the source rep opened after the reject.
- `the record at the source club changed; refetch and try again` — C source row version moved.
- `player no longer available at the destination club` — D destination row gone.

The prediction is derived for **pending** clearances only, so a **rejected** card cannot predict
whether reopen will block — the 409 toast covers it. The console hides Reopen entirely on a
legacy reject (no `rejectOutcome`), showing "Rejected before reopen was supported" instead.

## Notifications

The daily anti-abuse cap counts `kind === 'clearance'` only, so resolution and reopen notices
never consume it. Comm-log kinds: `'clearance'` (open), `'clearance-approved'`,
`'clearance-rejected'`, `'clearance-reopened'` — recorded on **both** clubs.

**Reopen sends the two chairs different content**, because the pending copy tells the recipient
_their_ club must act, which is only true for the source:

- **source chair** — the pending email with the preamble "The union office has reopened a
  previously rejected clearance — it needs your club's decision again." plus the **pending
  WhatsApp template** (there is no new Meta template — see
  [whatsapp-templates.md](../runbooks/whatsapp-templates.md));
- **destination chair** — email only, its own body ("The union office has reopened {player}'s
  clearance from {from} to your club; the move is under review again and {from} will decide.");
  the WhatsApp channel is recorded `skipped` with `error: 'no destination template for reopen'`
  so the comm log stays honest.

Directory / deleted clubs are skipped, as in `notifyClearanceResolved`. The reopen idempotency
key is `clearance-<id>-reopened-v<version>-<channel>`; it bypasses the daily cap.

<a id="disposing-of-junk"></a>## Disposing of junk

Reject now **moves** a registration to the named club, so it is no longer a way to discard a
junk registration (a leaked-link signup, or a player who named a club they never played for) —
reject would hand that registration to the named club. The disposal path is unchanged:
**override & approve with a reason, then delete the player** (the delete purges the ID document
from S3). Deletion is blocked while `clearance-pending`, so the override must land first. See
the [backfill runbook](../runbooks/backfill-declared-club-clearance.md#disposing-of-a-clearance-that-should-never-have-existed).

## Snapshot containment & retention

`rejectSnapshot` holds the destination's self-asserted contact/ID data (the deleted
registration a reopen restores). It **rides the canonical only**:

- `clearanceItems` strips it from the **mirror**;
- the repo read layer (`getClearance` / `listClearancesForSource` / `listAllClearances`)
  strips it; `getClearanceRaw` is the one reader that keeps it, for reject / reopen / rollback /
  erase;
- `publicClearance(c)` strips it, applied by every route that returns a clearance.

A rejected-and-never-reopened clearance retains that snapshot — and, through it, the
destination registration's ID-document object keys — on its canonical indefinitely (POPIA).
Erasure paths therefore read the canonical (`getClearanceRaw`) and collect
`clearanceDocObjectKeys(c)`, including the **destination-club** erase path
(`eraseClubData(toClubId)`), which walks inbound mirrors that no longer carry the snapshot — so
it reads each mirror's canonical to gather the keys before deleting. A retention/discard job for
never-reopened rejects is a follow-up, not in scope.
