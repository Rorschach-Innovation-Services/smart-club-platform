# Player clearances

An inter-club transfer. When a player moves from one club to another, the destination
club can only register them once the **source** club (or the union office on its behalf)
settles fees and misconduct. Source: `packages/api/src/index.ts` (routes) and
`packages/api/src/repo.ts` (`rejectClearance`, `reopenClearance`, `detectRejectCase`,
`resolveClearance`).

See [ADR 0012](../architecture/0012-clearance-reject-cancels-the-move.md) for the reject/reopen
design, [ADR 0017](../architecture/0017-transfer-windows-and-auto-reject.md) for transfer
windows and the auto-rejected creation mode, and the
[backfill runbook](../runbooks/backfill-declared-club-clearance.md) for the
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

A public registration that arrives while every transfer window is closed is **created already
`rejected`** (`rejectedBy: 'system:transfer-window'`, `rejectOutcome: 'not-registered'`) and
never passes through `pending`; reopen works on it like any other reject. See
[Transfer windows & auto-reject](#transfer-windows-and-auto-reject).

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
- `409` — a clearance for this player is already pending; destination club gone; transfers are
  closed (`transfers are closed — next window: <label> (<start> – <end>)`, or `transfers are
closed — no upcoming transfer window is configured`). The window check runs **first**, before
  the clubs or the player are loaded, so it wins over every other 409 while transfers are closed.
- `201` — the created clearance.

Best-effort: the source chairman, the destination chairman and the tenant admins are told
(`notifyClearanceOpened` — see the [notification matrix](#notification-matrix)).

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

A window-closed auto-reject reopens through this same route, and reopen is **not**
window-gated — it is how the union office admits a transfer while transfers are closed. See the
`window-closed` entries in the [reopen contract](#reopen-contract).

### `POST /admin/clearances/:cid/remind` — nudge the source chair (admin)

Body `{ fromClubId }`. Re-sends the pending-clearance notice to the **source** chairman: email,
plus WhatsApp (the `club_clearance_pending` template) when the tenant's `whatsappInvites`
feature is on. Bypasses the creation daily cap.

At most **one reminder per clearance per tenant day**. The route claims the INVITE#-keyspace
marker `clearance-reminder:<clearanceId>:<YYYY-MM-DD>` under the source club, the same key the
[ClearanceReminders cron](#clearancereminders-cron) claims. A second click, from any tab, gets
409, and so does that day's cron run (it counts the clearance as skipped). The claim holds only
once something was delivered: it is released if the send throws, and also when every channel
came back `skipped` (no usable chair contact) or `failed`, so fixing the chair's details and
retrying the same day works.

- `400` — `fromClubId required`.
- `404` — `clearance not found`.
- `409` — `clearance already resolved` (anything but `pending`); `already reminded today`.
- `422` — `source club is not on the system`: the source is an off-system directory entry with
  no club record, so there is no chair to remind. Only the union office can resolve those; the
  cron lists them in its digest.
- `200` — `{ results: SendResult[], reminded: boolean }`, one result per channel. `reminded` is
  true when at least one channel was `sent`; false means nothing was delivered and the claim
  was released.

Comm log: rows of kind `'clearance-reminder'` on the source club, idempotency key
`clearance-<id>-reminder-<date>-<channel>`, `by` the admin's email. A manual reminder also
restarts the cron's 7-day cadence for that clearance (the cron reads the latest `sent`
`'clearance-reminder'` row, whichever sent it). Skipped and failed rows are kept for the audit
trail but never count toward the cadence.

<a id="player-erasure"></a>

### `DELETE /admin/players/:nk` — erase a person tenant-wide (admin)

The union office's POPIA "right to erasure": removes one person, by natural key, from **every
club in this tenant** in one call. Console: the "Erase player" danger zone in the admin
player modal (`PlayerDetailModal`), where the button ("Erase player everywhere") stays disabled
until the person's full name is typed. Implementation: `repo.erasePlayerData`.

**Scope is the tenant only.** Every key is `TENANT#`-scoped, so the same person registered with
another union (another tenant) is untouched. There is no cross-tenant erase.

What it removes:

| Category                      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Player rows                   | Every `PLAYER#` row for the natural key, at every club, via `deletePlayer` (its ID document(s) in S3, its `VETAFFIL#` record, the club's `playerCount`).                                                                                                                                                                                                                                                                                        |
| Clearances                    | Every clearance naming the person is **deleted outright**, canonical + mirror, whatever its status, with its artifacts: snapshot ID documents (including a window-closed auto-reject's `pendingPlayer` document), the certificate PDF, the `CERT#` registry item (its `/verify` lookup now 404s) and the clearance's S3 prefix. Deleting rather than scrubbing means a retained approved clearance can never re-mint a certificate full of PII. |
| Registration reviews          | `REGREVIEW#` rows for the person, plus any held `pendingPlayer` ID document.                                                                                                                                                                                                                                                                                                                                                                    |
| Veterans requests             | Canonical `VETREQ#` + `OUTBOUND_VETREQ#` mirror.                                                                                                                                                                                                                                                                                                                                                                                                |
| Captain's reports             | Reports that name the person (full-name, email or cell match) are **scrubbed in place**, not deleted: matching name fields become `[removed]` and the stored recipient contact is dropped. The report also belongs to the club and the umpires.                                                                                                                                                                                                 |
| Pending `REPORTOPEN#` markers | A marker whose `captainRef` is this person's player ref has **only that field removed**. The marker stays (see below).                                                                                                                                                                                                                                                                                                                          |

Why the marker is scrubbed, not deleted: a `REPORTOPEN#` marker is the retry queue that opens
the captain's reports for **both** clubs in a fixture. Deleting it would silently stop that
fixture's reports from opening at all. With no `captainRef`, the retry resolves no captain, so
the scoring side's report goes to that club's **chair**. If the report had already opened with
the erased captain as recipient, its contact was scrubbed with the report, and the retry
notifies the chair instead, with the chair's wording and no cc.

Order matters for re-runs: S3 objects first (their keys are only derivable while the rows that
name them exist), then clearance/review/request rows, then the report scrub, then the
`PLAYER#` rows last. If a run dies part-way, the surviving rows let a re-run find the person and
finish the job.

Responses:

- `200` — `{ ok: true, counts }`, where `counts` is:

  ```json
  {
    "playerRows": 2,
    "clearances": 1,
    "registrationReviews": 1,
    "veteransRequests": 1,
    "documents": 3,
    "certificates": 1,
    "captainsReportsScrubbed": 1,
    "reportOpenMarkers": 1
  }
  ```

  `documents` counts S3 objects (row ID docs + clearance/review docs + certificate PDFs).
  `reportOpenMarkers` counts markers whose captain ref was scrubbed. The console toast reads
  `<Name> erased — 2 club registrations, 1 clearance, …` (non-zero counts only).

- `404` — `player not found`, **only** when player rows, clearances, registration reviews and
  veterans requests are **all** empty for the natural key. A person with no `PLAYER#` row left
  anywhere but a lingering clearance (say, a window-closed auto-reject) is still erasable. A
  re-run of a completed erasure 404s.
- `409` — `resolve or reject the open clearance first`: a **pending** clearance names the
  person, or any of their rows is `clearance-pending`. Nothing is touched; the gate runs before
  the first write. Resolve it (approve, override or reject) and retry.
- `409` — `player is mid-transfer — refresh and try again`: a clearance moved the row between
  the inventory read and the delete (a conditional write lost the race). Refresh and retry.
- `403` — not an admin of this tenant (the `/admin/*` middleware).

**Audit.** Once everything has landed, one row is written at `TENANT#<t>` /
`PLAYERERASE#<iso>#<id>`: `{ id, kind: 'player-erasure', by, at, counts }`. It is PII-free
(actor email + counts only, never the natural key or name). There is **no read route yet**;
the only reader is `repo.listPlayerEraseLogs(tenant)`.

Caveats and gaps:

- **Name-only matching in captain's reports.** A report field is scrubbed when it equals any
  spelling of the person's full name the inventory holds (case- and whitespace-insensitive).
  A different person with the same name in a captain's report will lose their name too. Email
  and cell matches compare the person's own email and cell (last nine digits), so a bystander's
  contact is only dropped when it is the same address or number.
- **Not covered:**
  - club comm-log entries from past notices (e.g. clearance notices naming the player in a
    chair's comm log);
  - INVITE#-keyspace idempotency markers;
  - data already exported to Medicoach. The confirm modal says this; ask Medicoach to remove it
    separately.

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

There is a seventh `RejectCase`, **`window-closed`**, that the reject route never produces: it
is written only at creation time by `createAutoRejectedClearance` (no rows touched, no count
change, snapshot `{ case: 'window-closed', pendingPlayer }`, `rejectOutcome: 'not-registered'`).
`detectRejectCase` never yields it and `predictedRejectCase` has no value for it. See
[Transfer windows & auto-reject](#transfer-windows-and-auto-reject).

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
  - `not-registered` (window-closed auto-reject) — "The registration with {to} was not
    completed; the player remains unregistered there and stays at their current club, if any."
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
- **window-closed** — put the snapshot's `pendingPlayer` at the destination as
  `clearance-pending` (`attribute_not_exists` guard), dest count +1. If the source club holds an
  **active** row for the player, flip it to `clearance-pending` (the normal registration-origin
  shape); if it holds none, a `ConditionCheck` requires it still absent. **Check, never skip**
  (as in B′): any row for the player other than an active one at the source blocks the reopen,
  because registration-origin approve activates the destination even with no source row.

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
- `the auto-rejected registration was not kept` — window-closed with no `pendingPlayer` on the
  snapshot.
- `the player has registered or transferred since this was auto-rejected` — window-closed, and
  the player now has a row somewhere other than an active one at the source club.
- `the source club record changed; refetch and try again` / `player no longer active at the
source club` — window-closed, the source row changed between the read and the write
  (transactional / dynalite path respectively).

The prediction is derived for **pending** clearances only, so a **rejected** card cannot predict
whether reopen will block — the 409 toast covers it. The console hides Reopen entirely on a
legacy reject (no `rejectOutcome`), showing "Rejected before reopen was supported" instead.

## Notifications

The daily anti-abuse cap on creation notices (`CLEARANCE_NOTICES_PER_DAY = 3`, UTC day) has
two counters. For an **on-system source** it is per source club and counts that club's
`kind === 'clearance' && channel === 'email'` rows. A **directory source** has no club record
to count against, so it is per **destination** club and counts only directory-source inbound
rows: `kind === 'clearance-inbound'`, email, with an idempotency key containing
`-inbound-directory-`. Ordinary inbound notices never consume the directory counter, so a busy
day of on-system transfers can't silence the clearances only the union office can resolve. No
other notice consumes either counter.
Comm-log kinds: `'clearance'` (open, source club), `'clearance-inbound'` (open, destination
club), `'clearance-approved'`, `'clearance-rejected'`, `'clearance-reopened'` (both clubs) and
`'clearance-reminder'` (source club). Admin emails are never comm-logged — no club owns them.

### Notification matrix

| Event                                                                    | Source chair                                                                                                   | Destination chair                                                                                 | Tenant admins                                                                                         | Comm log                                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Created**, on-system source (every creation site, plus admin reassign) | email + WhatsApp `club_clearance_pending` (WA when `whatsappInvites` is on); capped                            | email only; capped — recorded `skipped` (`daily clearance-notice cap reached`) when the cap fires | email; capped — **not sent** when the cap fires                                                       | source `clearance`, key `clearance-<id>-<channel>`; destination `clearance-inbound`, key `clearance-<id>-inbound-email` |
| **Created**, directory source (registration naming an off-system club)   | — (no club record, no chair)                                                                                   | email only; capped per destination club — recorded `skipped` when the cap fires                   | email, saying only the union office can resolve it; capped — **not sent** when the cap fires          | destination `clearance-inbound`, key `clearance-<id>-inbound-directory-email`                                           |
| **Created** via a chair bulk route (`/players/batch`, `/roster/commit`)  | as above, per clearance                                                                                        | as above, per clearance                                                                           | **one summary email per admin per request**, listing every clearance it opened (capped ones included) | as above                                                                                                                |
| **Issued / overridden**                                                  | email                                                                                                          | email                                                                                             | —                                                                                                     | `clearance-approved`, both clubs                                                                                        |
| **Rejected** (admin)                                                     | email, worded by `rejectOutcome`                                                                               | email                                                                                             | —                                                                                                     | `clearance-rejected`, both clubs                                                                                        |
| **Auto-rejected** (window closed)                                        | email, `not-registered` copy (on-system source only)                                                           | email                                                                                             | email ("Clearance auto-rejected — {player}", with the reason)                                         | `clearance-rejected`, both clubs, `by: 'system:transfer-window'`                                                        |
| **Reopened** (incl. an auto-reject)                                      | pending email with reopened preamble + pending WhatsApp                                                        | email only; WA recorded `skipped`                                                                 | —                                                                                                     | `clearance-reopened`, both clubs                                                                                        |
| **Manual remind**                                                        | email + WhatsApp (WA when `whatsappInvites` is on); bypasses the cap                                           | —                                                                                                 | —                                                                                                     | `clearance-reminder`, key `clearance-<id>-reminder-<date>-<channel>`                                                    |
| **Cron remind**                                                          | email + WhatsApp (WA only when `whatsappInvites` is on **and** the template's registry status is `registered`) | —                                                                                                 | one digest email per admin per tenant per run                                                         | `clearance-reminder` + INVITE# marker                                                                                   |

Notes on the matrix:

- **Admins** are resolved by `listTenantAdminEmails` (`notify/admin-emails.ts`): every tenant
  user with an `admin` membership on this tenant, **excluding platform operators** (operator
  auto-admin would otherwise send every tenant's notices to every operator).
- **Directory / deleted clubs are skipped** as chair recipients on every row — an off-system
  source has no chair. A directory-source **creation** still notifies the destination chair and
  the admins (the union office is the only party that can resolve it); the admin email says so.
  If the destination club can't be read to check the directory cap, the check **fails closed**:
  no destination or admin notice (reported to Sentry). The clearance itself is still created and
  the cron digest lists it. Admin reassign calls `notifyClearanceOpened` with `bypassCap`, so it
  always fans out.
- **Bulk routes batch the admin email.** The chair quick-add (`POST /clubs/:id/players/batch`)
  and spreadsheet commit (`POST /clubs/:id/roster/commit`) collect each request's clearances and
  send each admin one summary ("N new clearances — {club}"), so a 30-transfer chunk is one email
  per admin, not thirty. Chair notices stay per clearance (each goes to a different club). The
  summary lists capped clearances too: it is one email per authenticated request, which already
  bounds it. The admin list is resolved once per request (`adminEmailsProvider`, a per-request
  memo), with the profile reads run in parallel.
- **Auto-reject has its own cap.** `notifyClearanceResolved` is normally uncapped (resolutions
  are authenticated admin actions), but the auto-reject fires from the **anonymous** register
  route. The wrapper (`notifyClearanceAutoRejected`) counts today's (UTC) `clearance-rejected`
  email rows by `system:transfer-window` on the **destination** club; at 3 it skips the chair
  and admin notices entirely (a log line, no comm-log rows). If the destination club can't be
  read, the check **fails closed**: no notices, and the error goes to Sentry. The auto-rejected
  clearance is still recorded. The primary guard is upstream: a resubmission in the same closed
  stretch never reaches the notifier at all.

### ClearanceReminders cron

`sst.config.ts` `ClearanceReminders`, `cron(0 5 * * ? *)` — daily at 05:00 UTC (07:00 SAST).
Handler `packages/api/src/crons/clearance-reminders.handler`; it does not import `index.ts`.

Per tenant with the `clearances` module on, over `listAllClearances` filtered to `pending`:

1. **Age.** Tenant days pending, counted from `reopenedAt` if set, else `requestedAt` — a
   reopen **restarts the clock**. Under 7 days (`CLEARANCE_REMINDER_AFTER_DAYS`): ignored.
2. **Chairless (directory-source) clearances** — the source club has no record — are never
   claimed or sent; only the union office can resolve them, so they go into the admin digest.
   They follow the same rule as step 4, read from the **destination** club: included when the
   latest `'clearance-reminder'` row for the clearance there is absent or at least 7 tenant days
   old. Once the digest has gone out (at least one admin email `sent`), the run appends one
   PII-free row to the destination club's comm log (kind `'clearance-reminder'`, channel
   `email`, no `to`, key `clearance-<id>-reminder-<date>-digest`). A digest that failed to send
   records nothing, so the next run tries again. A missed run delays the mention by a day.
3. **No usable chair contact.** A source club on the system whose chair has no valid email
   (and, when WhatsApp is a channel, no valid cell) is handled like step 2: never claimed or
   sent, carried in the digest's own "no usable chair contact" section, with the digest mention
   row written on the **source** club. Its digest cadence reads only `-digest` mention rows;
   the chair cadence in step 4 ignores them, so a fixed contact gets the chair reminded on the
   next run.
4. **Due.** Otherwise the clearance is due when the latest `sent` chair `'clearance-reminder'`
   comm-log row for it on the source club is absent or at least 7 tenant days old
   (`CLEARANCE_REMINDER_EVERY_DAYS`). Reading the last reminder, not a modulo of the age, makes
   the cadence missed-run robust: a failed run delays a reminder by a day, not a week.
5. **Claim → send → complete.** Claim INVITE# `clearance-reminder:<id>:<today>` under the source
   club (the same key as the manual route — a replay counts as `skipped`), send to the source
   chair, complete the marker and append the comm-log rows with `by: 'system:clearance-reminders'`.
   A send fault before anything went out releases the claim so tomorrow (or a manual send) can
   retry. A send where every channel came back `skipped` or `failed` also releases the claim
   (counted as `skipped`; its rows are written but do not start the cadence). Once something
   was delivered the marker stays, so a bookkeeping fault never double-sends.
6. **Digest.** One email per admin listing the clearances nudged this run (at least one channel
   `sent`), the chairless ones, and the ones with no usable chair contact. Nothing to list ⇒ no
   digest. Admin emails only; the only comm-log trace is the digest mention rows from steps 2
   and 3.

Failures are isolated per tenant and per clearance (Sentry, counted, the run moves on); only the
tenant-registry read fails the whole run. The run logs one summary line (`clearance-reminders:
run complete`, with `tenants`, `reminded`, `skipped`, `chairless`, `noContact`, `digests`, `errors`,
`dryRun`).

**Dry runs.** `NOTIFY_DRY_RUN=1` is honoured by the senders, but markers and comm-log rows are
still written, so a dry run is observable end to end — and consumes that day's claim. The
summary line's `dryRun` says which kind of run it was.

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

<a id="transfer-windows-and-auto-reject"></a>

## Transfer windows & auto-reject

Operators may set `TenantConfig.transferWindows` (inclusive SAST date ranges; absent or `[]` ⇒
unrestricted — see [tenant.md](tenant.md) and
[ADR 0017](../architecture/0017-transfer-windows-and-auto-reject.md)). When windows are
configured and none contains today's tenant date, **transfers are closed**. Windows govern
transfers only: a plain first registration (no previous club, not registered elsewhere) is never
blocked, and with the `clearances` module off there are no windows to apply.

| Path                                                             | When closed                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /register/:clubId` (public link, anonymous)                | clearance created **auto-rejected**; `201` with `transferWindow` |
| `POST /clubs/:id/clearances` (rep)                               | `409 transfers are closed — …`                                   |
| Chair portal registration (`POST /clubs/:id/players`, bulk rows) | the same 409 (bulk: per-row `error`)                             |
| `open-clearance.ts` CLI                                          | warns; refuses unless `--ignore-window`                          |

On the registration paths the window gate runs where a clearance is about to open, **after**
the pending-elsewhere check (a player already mid-transfer still gets the usual
`already registered or a transfer is already in progress` 409) and after a destination-roster
check (an identity already at the destination is reported as a duplicate, not auto-rejected).

### The auto-rejected clearance

`createAutoRejectedClearance` writes the canonical (with `gsi1`) + mirror only — **no player
rows, no status flips, no count changes** — so the player is not registered anywhere by it, and
the source club's row (if any) stays `active`. Fields:

```
status:        'rejected'
rejectedAt:    <now>
rejectedBy:    'system:transfer-window'
rejectReason:  'Outside transfer window — next window: <label> (<start> – <end>)'
               | 'Outside transfer window — no upcoming window configured'
rejectOutcome: 'not-registered'
rejectSnapshot (canonical only): { case: 'window-closed', pendingPlayer: <would-be destination row> }
```

`pendingPlayer` is the full `clearance-pending` row the registration would have written,
ID-document metadata included; `clearanceDocObjectKeys` collects its `idDocMeta` /
`previousIdDocMeta` object keys so erasure purges them. The usual
[snapshot containment](#snapshot-containment--retention) applies: it never reaches the mirror or
an HTTP response. Create-then-reject was deliberately not used — reject case D would leave a
directory-source registrant **active** at the destination.

**Resubmissions.** Before creating, the core looks for a window-rejected clearance for the same
identity into the same destination (`findWindowRejectedClearances`, destination mirror
partition) rejected within the **current closed stretch** (from the day after the latest window
that ended). If found, the existing record is returned (`repeat`): nothing is written, nobody is
re-notified, and the 201 is identical. The ID document the form just uploaded for the
resubmission is referenced by nothing, so it is deleted best-effort (only a public-link
`reg-<uuid>-id.<ext>` key, and never one the earlier record's snapshot still names). A reopened clearance no longer matches (reopen clears
`rejectedBy`), and a registration once a window opens is unblocked by construction — no player
row exists for the duplicate-pending guards to see.

### `POST /register/:clubId` response when closed

```
201 → { ok: true, transferWindow: { closed: true, nextWindow?: { label, start, end } } }
```

`nextWindow` is absent when no later window is configured. The source club's hourly
registration quota is **not** charged (nothing landed in its queue). The public form shows its
"recorded, but transfers are closed" copy from this payload, and its pre-submit notice from the
server-computed `transferWindowStatus` on `GET /tenant`.

The console lists the clearance with an "Auto-rejected — window closed" badge and a
`not-registered` outcome; **Reopen** admits it (see the [reopen contract](#reopen-contract)).

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
