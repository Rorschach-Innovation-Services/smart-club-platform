# ADR 0015 — Fixture postponement by negotiation between clubs

**Status:** Accepted (October 2026). Backend; portal and console UI follow.

## Context

Fixtures move. Rain, a clash with a school event, a ground that is suddenly unplayable — the
two clubs of a match usually agree a new date between themselves and then ask the union office
to update the fixture list. Until now the platform had no part in that conversation: fixtures
were admin-edit-only (`PATCH /series/:id`), chairs had no fixture actions at all, and nothing
recorded that a match had been postponed, from when, or who agreed it.

Fixtures are not first-class items. They are an untyped array embedded in each `Series` row,
written whole under the series' optimistic `version`, behind three gates in `applySeriesPatch`
(version pre-check, release clash gate, in-season "no introduced clash" gate — see
[ADR 0011](0011-progressive-fixture-release.md) and its addendum). Released series may withhold
the venue and/or kick-off time from clubs (ADR 0011), so anything a chair sees must go through
the same club-facing projection.

The nearest existing shape is the veterans squad-selection request
([ADR 0013](0013-veterans-squad-selection.md)): one club asks, another confirms, the admin may
override, and the request lives in both clubs' partitions.

## Decision

**A chair requests a new date; the clubs negotiate by counter-proposal; agreement applies the
new date to the fixture automatically. The union admin can override with a final
date/time/venue at any point, and the chairs acknowledge the ruling.**

### 1. Storage — canonical + mirror, transitions in one transaction

A `PostponementRequest` is stored twice, mirroring the veterans-request layout:

- **Canonical** `POSTPONE#<id>` under the **opposing** club — the club asked to agree. It carries
  the only gsi1 entry (`TENANT#<t>#TYPE#POSTPONE` / `requestedAt`) so the admin console lists
  each request once.
- **Mirror** `OUTBOUND_POSTPONE#<id>` under the **requesting** club, no gsi1.

Both are a club's own partition, so a rep only ever queries its own pk. Unlike veterans
requests — whose mirror is updated best-effort — **every transition (counter, accept, decline,
withdraw, admin ruling, acknowledge) rewrites both rows in one `TransactWriteItems`**,
conditioned on the canonical's `version`, `status` and (for a turn-based move) `awaiting` side.
A negotiation is read by both sides turn after turn; a stale mirror would show the requesting
chair the wrong proposal or the wrong "your turn" state, so drift is a correctness problem
here, not a cosmetic one. Both puts require the row to exist (no phantom resurrection after an
erasure). Dynalite (offline/tests) has no transactions, so the same sequential fallback as
`createVeteransRequest` applies there.

The request carries the whole negotiation: `proposals[]` (last = on the table, each tagged
`requesting` / `opposing` / `admin`), `awaiting`, `status`
(`open` → `applied` | `admin-final` | `declined` | `withdrawn`), a snapshot of the fixture's
`originalDate` (and `originalTime` when it was visible), and per-club `acknowledgements` of an
admin ruling. Terminal rows get the 90-day `expiresAt` TTL. Erasure (tenant, cohort, club)
enumerates both prefixes like every other mirrored request.

The opposing club is **derived server-side** from the fixture's sides (participants snapshot,
or the clubId itself on a legacy series) — never taken from the request body. Only one open
request per fixture is allowed, checked across both clubs' partitions (`409
postponement_exists`).

### 2. Auto-apply on agreement

When the awaited side accepts the proposal on the table, the server moves the fixture
immediately — there is no "pending admin approval" step. The product decision is that two clubs
agreeing a date is the normal, legitimate case, and the union office's job is to intervene in
the exceptions (§4), not rubber-stamp the rule.

The move is written **through `applySeriesPatch`**, not around it, so it passes the identical
version and in-season clash gates an admin edit does. The fixture gets the new `date` (and
`time` when the proposal names one; otherwise its kick-off stands), `status: 'postponed'`,
`postponementId`, and `originalDate` — written **only if absent**, so a fixture moved twice still
points at its first schedule. Downstream readers already treat `postponed` as "the date is the
rescheduled date" (the medicoach export, the clash engines); the club projection passes
`status` / `originalDate` through untouched because dates are never withheld.

### 3. Clash refusal at accept, and the atomicity rules

Accept re-reads the series and runs, in order:

1. the series is still released and visible to clubs, and the fixture still exists;
2. **idempotency** — if the fixture already carries exactly this request's move (a previous
   accept's series patch landed but its terminalize did not), skip the patch and only
   terminalize;
3. **baseline** — the fixture's date (and time, when snapshotted) still equal the request's
   snapshot; otherwise an admin edit or re-import superseded it → `409 fixture_changed` and the
   chair withdraws or opens a new request;
4. **conflicts** — an _introduced_ ground clash (the in-season gate's subset rule and clash
   identity, restricted to the moved fixture) **or team-busy**: either side already plays that
   day/slot in any released series. Team-busy is new server-side: it ports the allocator
   ledger's `teamBusy` semantics (`packages/engine/src/venues.ts`) into
   `packages/api/src/team-busy.ts`, because no ground gate can see a side double-booked at two
   different grounds. Either finding → `409 venue_clash` with the findings, and **the request
   stays open** so the chairs can counter or escalate;
5. patch via `applySeriesPatch` pinned to the version read in (1).

A version 409 from the patch loops back to **(1)** — re-read, re-check everything, re-patch
(bounded at three attempts). The retry never resends a stale patch: team-busy lives only in
step 4, so a retry that skipped it could write a double-booking a concurrent edit created.

Only after the fixture is moved does the request become `applied` (one transaction, both
rows), and both chairs are emailed.

### 4. Admin override and chair acknowledgement

`POST /admin/postponements/:id/override` sets a final `date` (+ optional `time`, registry
`venueId` or free-text `venueName`) on an **open, applied, previously-ruled or declined**
request (a withdrawn one is closed). It goes through `applySeriesPatch` with the standard gate —
the admin sees the full clash list on a 409 — and appends a `by: 'admin'` proposal. The request
becomes `admin-final` with `acknowledgements` reset; both chairs are emailed and asked to
acknowledge in the portal, which records `{ at, byUser }` per club. The override still honours
`originalDate` only-if-absent, so the audit always shows the original schedule.

### 5. What clubs may see (ADR 0011 still holds)

- Requests returned to clubs are projected: while a series withholds times, the time snapshot
  and proposal times are dropped (and a chair cannot propose a time); while it withholds
  venues, admin venue fields are dropped. Emails follow the same rule — the builders are never
  given a withheld time or ground.
- A chair-facing `venue_clash` 409 names the other fixture only when its series is visible to
  clubs, the ground only when neither side's venue is withheld, and never a time the series
  hides. The refusal itself still happens against drafts and withheld bookings — the gate must
  hold — so a refusal necessarily tells the chair "that date is taken", but nothing more.
- `POST /clubs/:id/clash-hints` (rep-safe, for the date picker) answers per candidate with three
  **coarse booleans only** — `groundBusy`, `homeTeamBusy`, `awayTeamBusy` — computed over the
  club-facing projection of released and active series. `groundBusy` is computed **only from
  fixtures whose venue is revealed**: a busy signal from a withheld-venue fixture would leak
  pre-reveal ground occupancy, including withheld-within-released series. Team-busy may use every
  visible fixture (dates are never withheld); withheld kick-off times are already stripped, so
  such a booking owns its whole day rather than leaking its slot.

### 6. Revision of ADR 0011's "in-season edits are silent" rule

ADR 0011's addendum made in-season fixture edits deliberately silent: an admin changing a live
fixture sends no notification. **That remains true for admin edits through the fixture
editor.** A postponement is different in kind: it is a negotiation the two chairs are party to,
so every step notifies the counterpart (email only, link-free, logged to each club's comm log
with a version-suffixed idempotency key): request opened → opposing chair; counter → the other
chair; agreed and admin ruling → both chairs; declined / withdrawn → the counterpart. This is a
deliberate, scoped revision — the fixture-editor path stays silent.

## Rejected alternatives

- **Admin approval of every agreed date.** Adds a queue the union office would rubber-stamp and
  delays the common case; the override covers the exceptions.
- **A per-fixture item or a fixture index.** Would make postponements cheaper to query but forks
  the single write path every gate lives on. Writing through `applySeriesPatch` keeps one set of
  rules for every fixture write.
- **Best-effort mirror updates (as veterans requests do).** Fine for a one-shot accept/decline;
  wrong for a turn-based negotiation both sides read repeatedly.
- **Refusing a request at open time on a clash.** The fixture list keeps moving while a
  negotiation runs; only the accept-time check against the live series is meaningful. The hints
  endpoint covers the "is this date likely to work" question up front.

## Consequences

- Chairs get fixture actions for the first time; postponed fixtures carry `status`,
  `originalDate` and `postponementId` for the portal badge and the struck-through original date.
- A Plan B re-import treats a `postponed` fixture as an informational date difference (it
  never gates `--discard-edits`) and resets it to the sheet date; the bookkeeping fields are
  ignored. Operators re-importing mid-season should read that note.
- The one-open-request-per-fixture check is read-then-write; two chairs opening requests for
  the same fixture in the same instant could both succeed. Accept's baseline check makes the
  second one harmless (`fixture_changed` once the first applies).
- Erasure enumerates `POSTPONE#` and `OUTBOUND_POSTPONE#` per club; club erasure deletes each
  request's counterpart row in both directions.
