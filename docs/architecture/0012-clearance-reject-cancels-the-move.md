# ADR 0012 — Clearance reject cancels the move, and is reversible

**Status:** Accepted (August 2026).

## Context

A union's **Reject** on a player clearance used to do two different things depending on how
the clearance was created, and one of them was a trap.

For a rep-initiated **request** clearance, reject returned the player to `active` at the source
club — the sensible reading of "reject": the move is off, put them back.

For a **registration-origin** clearance — the player registered with a new club and declared an
on-system previous one, which is every backfilled KZNCU case (see
[the backfill runbook](../runbooks/backfill-declared-club-clearance.md)) — reject did something
else entirely. It kept the player on the **destination** club's roster flagged
`clearance-rejected` (a terminal status with no way back), **deleted** the source club's row,
and purged its ID documents. There was no reactivation endpoint, and for a sourceless clearance
the destination row was the player's only registration record — so a single click permanently
flagged a legitimately registered player and destroyed the source evidence.

That is why the runbook said "never reject" and the server 409'd two whole classes of
clearance (a directory source, and a registration-origin clearance whose source club held no
row). The guard worked, but it left the union office with no clean way to decline a transfer,
and it made a destructive, irreversible operation the default meaning of a button labelled
"Reject".

We wanted one coherent meaning for reject, safe on every clearance shape, that an admin can
undo.

## Decision

**Reject means the move to the new club is cancelled** — the player ends up **active at the
source club**, regardless of how the clearance was created. Reject **purges nothing** and is
**reversible**.

### 1. One reject, six live-state cases

The effect is decided from the **actual** rows at reject time by `detectRejectCase`
(`repo.ts`), never from the stored `fromClubDirectory` flag — a club may have signed up under a
directory slug and rostered the player since the clearance opened. The
[API reference](../api/clearances.md#reject-cases) has the full table; in summary:

- **A** `request` — rep-initiated, no destination row: source row `clearance-pending` → active.
- **B** `dest-deleted` — source holds the player's real pending row: destination row deleted,
  source reactivated, dest count −1.
- **B′** `dest-deleted` — source already holds an active row (the portal has no cross-club
  dedup): destination deleted, source untouched, dest count −1.
- **B″** `moved-over-placeholder` — the source holds only a **placeholder** row (a name/ID-only
  stub written by the backfill script or a reassign — **every backfilled KZNCU clearance is this
  shape**): the destination's real registration **replaces** the placeholder at the source
  (active, with its ID document), destination deleted, dest count −1 only (the placeholder was
  already counted).
- **C** `moved-to-source` — the source club exists but holds no row (roster not digitised): the
  destination registration is **moved** to the source club (full row incl. ID-doc metadata,
  active, `lastClub` cleared), source +1, dest −1.
- **D** `dest-activated` — the source is an off-system directory entry: the player stays at the
  destination, active in place.

The placeholder case (B″) is why detection cannot be a client-side boolean. A backfilled source
row is a stub with no contact details and no ID document; reactivating it (case B) would have
activated the stub and deleted the real registration — the ID document included. `isPlaceholder`
recognises the stub, by an explicit `placeholder: true` marker (written by the reassign route
and the backfill script from now on) or by heuristic for legacy stubs (pending, no ID document,
no contact details, no capture path).

### 2. The console predicts the case server-side

`GET /admin/clearances` returns `predictedRejectCase` (`A | B | B-placeholder | B-active | C |
D`) per clearance, computed from the **same** `detectRejectCase` the reject runs. The console
words its confirm dialog from it and — because cases C and B-placeholder create or replace a row
at another club — **fails closed**: Reject is disabled only when the prediction is absent
(derivation failed, or a deploy skew), with copy telling the admin to refresh. The console never
infers the case from a boolean, so it cannot disagree with what the reject will actually do.

### 3. Reject is reversible via a snapshot on the canonical

The reject stores a `RejectSnapshot` on the **canonical** item, and **Reopen** (`POST
/admin/clearances/:cid/reopen`) restores the pre-reject rows from it, returning the clearance to
`pending`. Reject → reopen may repeat.

The snapshot carries the deleted destination registration (B / B′, restored byte-equal) or the
replaced placeholder (B″); C and D carry neither, because reopen moves the **live** row back so
post-reject edits survive. Reopen clears `rejectedAt/By/Reason/Outcome/Snapshot`, sets
`reopenedAt/By`, and keeps `feesCleared/misconductCleared` as they were — the source rep is not
asked to re-tick.

Because the snapshot must keep the objects for reopen, **reject purges nothing** — a departure
from the old behaviour, which deleted the source row and its documents outright.

### 4. The snapshot is contained — canonical only, stripped at the read layer

The snapshot holds the destination's self-asserted contact and ID data, which the **source**
rep must never see. It rides the canonical only: `clearanceItems` strips it from the mirror,
the repo read layer (`getClearance` / `listClearancesForSource` / `listAllClearances`) strips
it, and `publicClearance` strips it from every HTTP response. One reader keeps it —
`getClearanceRaw`, for reject / reopen / rollback / erase.

### 5. Both chairs are notified; the reopen notice is split

Reject notifies both chairs (`notifyClearanceResolved`), the resolved email body worded by
`rejectOutcome` — "the move is cancelled", "moved back to {from}", or "stays at {to}".

Reopen (`notifyClearanceReopened`) adds a fourth comm kind, `'clearance-reopened'`, and gives
the two chairs **different content**, because the pending copy tells the recipient _their_ club
must act — true only for the source. The source chair gets the pending email (with a reopened
preamble) plus the **pending WhatsApp template**; the destination chair gets an email-only
notice, and its WhatsApp channel is recorded `skipped` so the comm log stays honest. There is
**no new WhatsApp/Meta template** — reopen reuses the pending one, and the daily anti-abuse cap
(which counts `kind === 'clearance'` only) is bypassed. See
[whatsapp-templates.md](../runbooks/whatsapp-templates.md).

### 6. No new code writes `clearance-rejected`

The legacy player status `'clearance-rejected'` is kept read-only so rows written before this
change still render; activation paths still scrub the flag. Legacy rows are not migrated.

## Consequences

- **Junk disposal stays override-then-delete.** Reject now _moves_ a registration to the named
  club, so it can no longer discard a bogus one — reject would hand the junk to that club. A
  junk registration is still disposed of by **override & approve with a reason, then delete the
  player** (deletion is blocked while pending, so the override lands first). The case-C confirm
  copy and the runbook both steer the admin there. Reject is not a disposal tool.
- **Legacy rejects cannot be reopened.** A clearance rejected before this change has no
  snapshot, so reopen returns 409 `rejected before reopen was supported`. The console hides
  Reopen on such a card (no `rejectOutcome`) and shows "Rejected before reopen was supported"
  rather than a button that always 409s.
- **Retention (POPIA).** A rejected-and-never-reopened clearance retains the snapshot — and,
  through it, the destination registration's ID-document object keys — on its canonical
  indefinitely. Erasure paths now collect these via `clearanceDocObjectKeys`, reading the
  canonical (`getClearanceRaw`) rather than the snapshot-stripped mirror. This includes the
  **destination-club** erase path (`eraseClubData(toClubId)`), which walks inbound mirrors: it
  reads each mirror's canonical to gather the keys before deleting, so the objects can't leak. A
  retention/discard job for never-reopened rejects is a follow-up, not in scope.
- **Consent nuance.** The player consented to the **destination** club processing their data.
  Cases C and B″ hand that row — and its ID document — to the declared **previous** club: C
  moves the destination registration to the source club (where it becomes the source club's
  record to manage), and B″ replaces the source placeholder with the destination's full
  registration. That is the union's call — reject means "the move is cancelled, this belongs to
  the previous club" — but it moves personal data between clubs, so it is stated explicitly here
  and in the case-C confirm copy rather than left implicit.
- **A case-C record becomes the source club's.** After a case-C reject the row lives at the
  source club, and its rep may delete the player — which purges the ID document (the only copy)
  and makes a later reopen block. Consistent with "the move is cancelled", but stated so it is
  not a surprise.
- **The transactional (prod) branch is untested by the harness.** dynalite has no
  `TransactWriteItems`, so the offline path runs a sequential fallback with explicit rollback.
  The transaction item arrays are single-sourced with the local ops so the two can't drift; the
  code-review step diffs them.

## Rejected alternatives

- **Keep the "never reject" guard and add a separate cancel/void route.** Two operations for
  what the admin reads as one decision ("decline this transfer"), and it would have left the
  destructive registration-origin reject in place behind the guard. One reject with a coherent
  meaning, reversible, is simpler to reason about.
- **Infer the reject case client-side from `sourceRostered`.** A boolean can't distinguish a
  real source row from a placeholder stub (case B vs B″), and getting it wrong deletes a real
  registration. The server predicts the case from the live rows and the console fails closed
  when it can't.
- **Purge on reject and re-fetch on reopen.** Reopen needs the deleted destination row's exact
  content (ID-doc metadata included) to restore it byte-equal; nothing else holds it once the
  row is deleted. The snapshot is the only reversible option, at the cost of retention handled
  above.
