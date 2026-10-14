# ADR 0017 — Transfer windows: outside them, registrations are recorded auto-rejected

**Status:** Accepted (October 2026).

## Context

Unions only accept inter-club transfers during set periods of the year. Until now any player
could open a clearance at any time: a rep could request one from the club portal, and a public
registration that named (or was found at) another club opened one automatically. The union office
had no way to say "transfers are closed until 1 March" short of rejecting every clearance by hand.

Two things made the obvious designs wrong:

- **The public registration link is anonymous.** Its user fills in a form, uploads an ID document
  and leaves. If the server simply refused the submission, the player and their club would get an
  error page and the union office would never learn the registration was attempted. An anonymous
  submission must not vanish.
- **Reject is not "discard".** Since [ADR 0012](0012-clearance-reject-cancels-the-move.md), reject
  means "the move is cancelled" and is decided from the live rows. For an off-system (directory)
  source, that is case D `dest-activated`: the player **stays active at the destination**. So the
  tempting "create the clearance normally, then reject it" would admit every registrant who named
  an off-system previous club, which is exactly the transfer the window exists to block.

## Decision

### 1. Operator-only, per-tenant windows

`TenantConfig.transferWindows?: { label, start, end }[]` lists the periods in which a clearance
may be opened.

- **Absent or `[]` means unrestricted.** An empty list must never lock a tenant out, and every
  existing tenant keeps today's behaviour without a migration.
- **Dates are inclusive tenant wall-clock dates** (`YYYY-MM-DD`, SAST), never converted, per
  [ADR 0008](0008-configurable-league-structures.md). "Is it open" compares strings against the
  tenant's calendar day (`tenantDate`), so at 23:00 SAST on a window's last day it is still open
  and at 00:00 SAST the next day it is closed, even though UTC is still on the earlier date.
- **Operator-only.** Only `PUT /platform/tenants/:slug` writes it (`validateTransferWindows`: at
  most 12 windows, label 1–60 characters, real calendar dates, `start ≤ end`, no unknown keys;
  stored sorted by start). The tenant-admin `PUT /tenant/config` strips it. Overlapping windows
  are allowed; status math treats them as a union.
- **The server computes the status.** `GET /tenant` (anonymous) and `GET /tenant/config` serve
  the windows plus `transferWindowStatus: { open, current?, next? }`, computed on the tenant's
  day. The public form shows its "transfers are closed" notice from the served status, so it never
  trusts the device clock at a window boundary.

All the rules live in one pure module, `packages/api/src/transfer-windows.ts`, shared by the
routes, the registration core, the CLI and the tests.

### 2. Windows govern transfers only

The gate sits where a clearance is **about to be opened**, nowhere else. A plain first
registration (no previous club declared, not registered anywhere else) is never window-blocked.
With the `clearances` module off there are no clearances and therefore no windows.

On the registration paths the gate runs **after** the pending-elsewhere check: a player already
mid-transfer still gets the usual "already registered or a transfer is already in progress"
409, not a window answer. The gate also checks the destination roster first, so an identity
already at the destination is a duplicate, not a new auto-reject.

### 3. The enforcement asymmetry: anonymous paths record, authenticated paths refuse

| Path                                             | Outside every window                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Public link `POST /register/:clubId` (anonymous) | clearance **created already rejected**; `201` with `transferWindow` info |
| Rep request `POST /clubs/:id/clearances`         | `409 transfers are closed — next window: <label> (<start> – <end>)`      |
| Chair portal registration (single and bulk rows) | the same 409 (bulk: a per-row error)                                     |
| `open-clearance.ts` CLI                          | warns and refuses unless `--ignore-window`                               |

The rep and the chair are authenticated and present: they can read a 409 and come back when the
window opens. Recording a rejected clearance for them would also mean flipping a real source
player to `clearance-pending` only to unwind it. The auto-rejected record exists on the anonymous
path for one reason, so the submission does not disappear: the union office gets an email, the
clearance shows in the console with an "Auto-rejected — window closed" badge, and an admin can
reopen it.

### 4. Auto-reject is a creation mode, not create-then-reject

`repo.createAutoRejectedClearance` writes **only** the canonical `CLEARANCE#` item (with `gsi1`)
and the destination mirror, in one transaction with a destination-club existence check and
`attribute_not_exists` on the canonical (dynalite: pre-read, canonical, then mirror). It writes
**no player rows, flips no statuses and changes no counts.** The clearance carries:

- `status: 'rejected'`, `rejectedBy: 'system:transfer-window'` (`TRANSFER_WINDOW_REJECTOR`);
- `rejectReason: 'Outside transfer window — next window: <label> (<start> – <end>)'`, or
  `'Outside transfer window — no upcoming window configured'`;
- `rejectOutcome: 'not-registered'`, a new `RejectOutcome` member;
- `rejectSnapshot: { case: 'window-closed', pendingPlayer }` on the canonical only, where
  `pendingPlayer` is the full destination row the registration would have written (status
  `clearance-pending`, ID-document metadata included).

`'window-closed'` is a new `RejectCase` that only this creation path produces. `detectRejectCase`
never yields it and `rejectClearance` throws if handed it.

Create-then-reject was rejected because of the case-D trap described in Context: rejecting a
directory-source clearance activates the destination row. A creation mode that never writes the
row is the only shape that blocks the transfer for every kind of source.

### 5. No player rows, and the duplicate short-circuit

Because the auto-reject writes no player rows, the duplicate-pending guards (which key on player
rows) never see it. Re-registering once a window opens is therefore unblocked by construction.

The same property would let an anonymous resubmission mint a fresh rejected clearance, a fresh
PII snapshot and a fresh round of emails every time. So before creating, the registration core
looks for an existing window-rejected clearance for the same identity into the same destination
(`findWindowRejectedClearances`, read from the destination's own mirror partition) whose reject
falls in the **current closed stretch** (from the day after the most recent window that ended;
`closedPeriodStart`). If one exists it returns that record with `repeat: true`: nothing is
written, nobody is notified, and the caller gets the identical 201.

A per-destination-club daily cap on the auto-reject notices is the backstop against many distinct
fabricated identities (see Consequences).

### 6. Reopen is the union's discretion to admit mid-closure

The existing `POST /admin/clearances/:cid/reopen` route handles the new case unchanged, and it is
**not** window-gated: reopening an auto-reject is how the union office admits a transfer while
the window is shut. Reopen of `'window-closed'`:

- puts `pendingPlayer` at the destination as `clearance-pending` (`attribute_not_exists` guard,
  dest count +1);
- if the source club holds an **active** row for the player, flips it to `clearance-pending`,
  exactly the shape a normal registration-origin clearance has; if it holds none, a
  `ConditionCheck` requires it still absent;
- **blocks** (409 `the player has registered or transferred since this was auto-rejected`) when
  the player has **any** row anywhere other than an active row at the source club. This mirrors
  case B′'s "check, never skip": registration-origin approve activates the destination even with
  no source row, so a player who re-registered after the window opened would otherwise end up
  active at two clubs.

Reopen clears `rejectedBy`, so a reopened clearance no longer counts for the duplicate
short-circuit. From there the clearance is an ordinary pending one; the source issues or the admin
overrides as usual.

## Consequences

- **Rejected clearances can now exist with no player row behind them.** Admin-list derivations
  (`sourceRostered`, `predictedRejectCase`) are computed for pending clearances only, so they are
  unaffected. The console renders `'not-registered'` as its own outcome, and the resolved email
  says "The registration with {to} was not completed; the player remains unregistered there and
  stays at their current club, if any."
- **Notices from an anonymous route.** An auto-reject emails both chairs through
  `notifyClearanceResolved(…, 'rejected')` (an off-system source is skipped as usual; comm-log
  kind `clearance-rejected`, `by: 'system:transfer-window'`) and every tenant admin by email. That
  call is normally uncapped because resolutions are authenticated admin actions, so the
  auto-reject wrapper adds a cap: at most 3 per destination club per day, counting that club's
  window auto-reject email rows. Past the cap, the chair and admin notices are dropped with a log
  line; the clearance is still recorded.
- **Retention (POPIA).** The snapshot's `pendingPlayer` is the only pointer to the registrant's
  uploaded ID document, since no row was written. `clearanceDocObjectKeys` collects
  `pendingPlayer.idDocMeta` / `previousIdDocMeta`, so the existing erasure paths (which already
  include `rejected` clearances) purge it. A never-reopened auto-reject keeps that snapshot
  indefinitely, the same open retention question ADR 0012 records.
- **The rep route checks the window first.** Unlike the registration core, the rep request
  route (`POST /clubs/:id/clearances`) checks the window before loading the clubs or the player,
  so a rep asking for a player who is already mid-transfer gets the window 409 while transfers
  are closed.
- **Operator CLIs.** `open-clearance.ts` is a deliberate operator action, so it warns and accepts
  `--ignore-window` rather than refusing outright.
- **Numbering.** 0015 was taken on the then-unmerged club-ops-suite branch and 0016 is the
  Medicoach sync, hence 0017.

## Rejected alternatives

- **Create the clearance normally, then reject it.** Case D leaves a directory-source registrant
  active at the destination, admitting the very transfers the window blocks (see §4).
- **Refuse anonymous registrations with a 4xx.** The submission (and its ID document) would vanish,
  and the union office would never learn it was attempted. Recording it rejected costs one
  clearance item pair and keeps the decision with a person.
- **Auto-reject rep requests too.** The rep is present to read a 409, and a recorded request would
  have to flip, then unflip, a real source row for nothing.
- **Let tenant admins edit windows.** Decided against with the user: windows are
  operator-configured, like districts and season calendars, so the admin console shows the status
  but has no editor.
