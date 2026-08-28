# ADR 0011 — Progressive fixture release (withhold venues / times)

**Status:** Accepted (August 2026).

## Context

A union fixes its dates and matchups long before it fixes grounds and kick-off times.
Venue allocation waits on ground availability and the union's own directives; start times
follow. Until this change a series was all-or-nothing: releasing it published every field
to every club at once, so an admin either sat on a schedule the clubs needed (the dates,
who plays whom) or published grounds and times that weren't settled yet and then edited
them under the clubs' feet.

The release model also leaked. Release filtering was **client-side only**: `GET /series`
returned every series in the tenant — drafts included, all fields — to club reps, and the
portal decided what to hide. A rep reading the network response saw unreleased drafts,
unapproved venues, and approval state that is an admin concern. `activateFrom` (ADR 0008)
was gated the same client-trusting way.

We wanted admins to release the settled part of a schedule while holding back the parts
that aren't, per series, without a second publish model and without teaching every read
path a new endpoint.

## Decision

### 1. Withholding is a release-time choice on the series, not a per-fixture flag

Two optional server-owned fields carry it (`packages/api/src/types.ts`):

```ts
export type WithheldField = 'venue' | 'time';
withheld?: { venue?: true; time?: true };
revealedAt?: { venue?: string; time?: string };
```

An admin ticks "withhold venues" and/or "withhold start times" in the release dialog.
Withholding is **whole-series, per field** — either every fixture's ground is hidden or
none is. Per-fixture or per-round withholding was rejected: the union settles a
competition's grounds as a batch, the UI for a 40-fixture partial mask would be its own
project, and none of the real cases asked for it.

`withheld` is written **only on the false→true release transition**, and only when the
release PATCH actually carries a `withheld` key. The gate is deliberately narrow
(`patch.released === true && !current.released && 'withheld' in patch`): gating on the
flag value alone would rewrite the mask on the first in-season fixture edit, because
`updateSeries` PATCHes the whole series object with `released: true` still set, silently
revealing everything. To change what a released series withholds, recall it and release
again.

### 2. Reveal is a per-field action, computed from the current series

Un-hiding a field is a dedicated action key on `PATCH /series/:id`:
`{ reveal: ['venue' | 'time', …], version }`. `reveal` is not a stored field — it is
computed from `current.withheld`, deletes the named key(s), stamps
`revealedAt[field] = now()`, and is stripped before the write. It 400s if combined with
`released` (one intent per patch), 409s on an unreleased series or a field that isn't
withheld, and never re-approves or re-runs the clash gate — it changes no real data.

`revealedAt` is an audit stamp, not a re-publish. `releasedAt` is **never** bumped by a
reveal: the schedule went out at release; revealing a field only removes a mask over data
clubs were always going to see.

The reveal branch **returns early** in the PATCH handler — it runs its own `updateSeries`
and returns before reaching the transition-gated `withheld`/`revealedAt` block below it.
This is deliberate: the reveal branch has already computed the exact new mask from
`current`, and the generic withheld gate (which fires on `!current.released`, false for a
released series, so it would `delete patch.withheld`) must not run afterwards and clobber
it. Every other PATCH — including the whole-object edit of an already-released series —
drops `withheld`/`revealedAt`, so the stored values are kept and an in-season fixture edit
never reveals a field by accident.

As a consequence of tightening read access, **`GET /season-runs` became admin-only**. Its
frozen `structureSnapshot` embeds each stage's `schedule.slots` — the kick-off times a
series may now withhold — and its only caller is the admin-gated console; leaving it
rep-readable would have been a side channel around the time mask. Reps read fixtures
through the projected `GET /series` instead.

### 3. One shared `GET /series`, role-projected — no second endpoint

`GET /series` stays the single list route. Admins get the raw list unchanged; any
non-admin gets `projectSeriesForClub(series, tenantToday())` per series, dropping the ones
that project to `null`. A separate `/series/for-club` endpoint was rejected: it would
fork every future series read into "which one am I calling?", and the projection is a pure
function that belongs beside the data, not behind its own route.

The projection (`packages/api/src/series-projection.ts`, pure — no repo, no clock, caller
passes `today`) applies, in order:

- unreleased ⇒ `null` (this closes the draft leak);
- released but `activateFrom` in the future ⇒ `null` (the server now enforces the gate the
  client used to be trusted with);
- always strip `approved` / `approvedAt` (admin sign-off state, not a club concern);
- `withheld.time` ⇒ each fixture loses `time` / `slot`, the series loses
  `schedule.slots`;
- `withheld.venue` ⇒ each fixture loses all eight venue keys (`venueId`, `venueName`,
  `venueLat`, `venueLon`, `venueStatus`, `venueReason`, `venueLocked`, `venueOverride`);
- always keep `withheld` / `revealedAt`, so the client renders "to be confirmed"
  explicitly rather than inferring it from missing fields.

The projection never mutates its input — every stripped object is cloned first — so the
same in-memory series can be projected for a club and still read in full by the clash gate.

### 4. The store always holds the real data; the clash gate reads it

Withholding is a read-side projection, never a mutation. The DynamoDB item keeps the real
venue and time on every fixture; only the club-facing read strips them. This is what lets
the release clash gate (the server-side gate in
[the Plan B runbook](../runbooks/planb-fixtures-import.md)) keep seeing real grounds and
times while clubs see "to be confirmed" — releasing a withheld series still refuses a
known double-booking, because the gate never looks at the projection.

### 5. Participants' home grounds are not stripped

`projectSeriesForClub` strips venue fields off `fixtures[]` but leaves each participant's
home-ground `venue`/`lat`/`lon` snapshot alone. Reps already have those from
`GET /clubs`; stripping them would be theatre that also breaks the club list. The client
and `buildClubSchedule` therefore **must check `withheld.venue` explicitly** rather than
infer a withheld venue from missing fixture fields — the participant snapshot is still
there to infer from, and would give the game away.

## Rejected alternatives

- **Per-fixture or per-round withholding.** More granular than any real request, a large
  UI surface, and it fits neither how the union settles grounds (in batches) nor how the
  projection works (whole-series field strip).
- **A separate `/series/for-club` endpoint.** Forks every series read and duplicates the
  activate/approve gating. A role branch over one pure projection keeps the two views
  provably consistent.
- **Stripping participants' home grounds too.** Breaks the club list reps already hold,
  for no gain — the ground is available from `GET /clubs` regardless.

## Consequences

- **Reps no longer receive drafts.** The rep `GET /series` now omits unreleased and
  not-yet-active series entirely; any UI that leaned on receiving drafts would break, so
  merging this needs a release note and a check that no rep view depended on the leak.
- **Recall clears withholding.** A `released: false` patch (and the direct
  `recall-fixture-release` repo path) sets both `withheld` and `revealedAt` to undefined —
  a series pulled back to draft carries no mask to silently re-apply when it is next
  released.
- **`POST /series` and `POST /series/:id/duplicate` never carry either field.**
  Withholding belongs to a release, not a draft or a copy; both routes drop them.
- **`activateFrom` composes cleanly.** The projection returns `null` until a series is
  active, then applies the withheld mask — the two gates stack rather than conflict.
- **Re-import preserves the mask.** The Plan B importer's lifecycle-preserve block carries
  `withheld`/`revealedAt` from the existing series, so a re-import of a released-but-
  withheld series never silently un-withholds it (see the runbook's post-import section).
- **No backfill.** Every series released before this feature has `withheld` undefined, so
  it reads as fully visible — the absence of the field is the correct legacy behaviour.
- **Legacy `participants` are synthesised on the rep read path.** §5 assumed reps hold the
  club list, but `GET /clubs` is admin-only, so a rep opening a **legacy** series (one with
  no `participants` snapshot, where every `teams[]` id is a clubId) saw "Removed club" for
  every opponent. The rep `GET /series` now back-fills `participants` from the tenant's
  clubs after projection — `{ teamId, clubId, name }` plus the home-ground `venue`/`lat`/
  `lon` from `club.ground`, skipping any id with no club record — using a separate pure
  helper (`withLegacyParticipants`) so `projectSeriesForClub` stays a pure field-strip. A
  series that already carries `participants` is untouched. Consistent with §5, the
  synthesised home grounds are included even when `venue` is withheld (public identity,
  distinct from the fixture's hidden allocated venue); the client still shows "Venue to be
  confirmed" by checking `withheld.venue` explicitly.
