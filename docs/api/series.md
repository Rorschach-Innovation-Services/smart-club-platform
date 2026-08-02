# API — Series & fixtures

A series carries match config plus an **embedded** `fixtures[]` array. Fixtures are
generated client-side (`generateRoundRobin`, or `fixturesFromPlan` when a season calendar
drives the dates) and POSTed whole. Writes use optimistic concurrency (`version`; `409` on
conflict). All series writes are admin-only; reps read.

## Scheduling fields (ADR 0008)

Both optional; absent ⇒ the pre-calendar behaviour, unchanged.

| Field          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule`     | `{ calendarId, blockId, cadence, slots? }` — the season-calendar binding. Persisted so **regenerate reproduces the dates the admin confirmed** instead of falling back to legacy weekly stepping, which would move a whole league into the mid-season break. A calendar the operator has since deleted makes regenerate refuse rather than silently reschedule. Validated on `POST`/`PATCH` against the tenant's own config when present: `calendarId` must name a real calendar, `blockId` a real block on it, `cadence` a known kind, and each `slots[]` entry a non-empty `label` and an `HH:MM` `start` — a dangling reference or malformed slot can never be written, so a series schedule stays trustworthy for `regenerate` to trust blindly. Note this is a concrete `blockId`, not the `blockIndex` position a `StageSpec` uses — a series is generated once against a specific calendar and block, so identity is the right thing here even though a structure's stages reference by position (see the [ordinal block refs addendum](../architecture/0008-configurable-league-structures.md#addendum-2026-08-02-ordinal-block-references-and-the-season-wizard)). On `PATCH` only, sending `schedule: null` **clears** the stored binding — the series reverts to legacy `startDate`/`endDate` scheduling. `POST` rejects `null` (a brand-new series has no binding yet to clear), same as any other non-object. |
| `activateFrom` | Date-only. A **released** series stays hidden from clubs and from the player broadcast until this date — junior leagues generate up front but only surface in the second half of the season. Gated on read (no scheduled job) in both the club portal and `POST /clubs/:id/send-fixtures`, so the two can never disagree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Deleting a calendar a series references is rejected (409) by
`PUT /platform/tenants/:slug` — see [tenant.md](tenant.md).

A series produced by a season run also carries `seasonRunId`, `stageSpecId` and `groupId`.
One stage-group materialises into one series, so those three say which. Absent ⇒ a
standalone series from the flat create-series flow.

## Season runs

`SeasonRun` is the orchestration layer **above** series: it holds which teams are in which
group of which stage, and each group's series id once generated. It never holds fixtures.

It carries a frozen `structureSnapshot` and `calendarSnapshot` taken when the season
started, so an operator editing a structure template can never reshape a season already in
flight — the same defensive snapshotting `Series.participants` uses for team identity.
Both are **stripped from PATCH** rather than rejected, so a client round-tripping a whole
run object doesn't get a confusing 400.

| Route                     | Auth        | Notes                                                                                                                                                                                                                 |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /season-runs`        | rep + admin | `200 → SeasonRun[]`                                                                                                                                                                                                   |
| `POST /season-runs`       | admin       | Requires `id`, `leagueKey`, `seasonLabel` and both snapshots. Sets `version: 1`, stamps `createdAt`/`createdBy`. `409` on a duplicate id — never silently overwrite a live season.                                    |
| `GET /season-runs/:id`    | rep + admin | `200 → SeasonRun` · `404`                                                                                                                                                                                             |
| `PATCH /season-runs/:id`  | admin       | Partial update — stage status, group entrants, `carriedPoints`, audit entries. Send the current `version`; mismatch → `409 "season run changed; refetch"`. Two admins resolving the same stage is a real scenario.    |
| `DELETE /season-runs/:id` | admin       | `200 → { ok: true }`. **Does not delete the series its stages produced** — those are real, possibly-released fixtures clubs have seen. Orphaning a back-pointer is recoverable; deleting a published schedule is not. |

Season runs are swept by tenant erasure and by cohort clearing, like series.

## Venues & allocation

`GET /venues` (rep + admin) · `PUT /venues/:id` · `DELETE /venues/:id` (admin).

The master ground list fixtures are allocated to. **Admin-managed, not operator-only** —
a ground going out for maintenance is a week-to-week fact the union office learns first.
Validated on write: a name, in-range coordinates (optional; there is no geocoder, they are
pinned by hand), at least one match per day, and unavailable windows with a reason and
`end >= start`. The path owns the id, so a body id is ignored.

Deleting a venue does **not** rewrite fixtures allocated to it — they keep a denormalised
`venueName`, so a released schedule still reads correctly.

Allocation runs client-side ([ADR 0004](../architecture/0004-thin-crud-client-side-compute.md))
and writes these fields onto each fixture:

| Field                   | Meaning                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `venueId` / `venueName` | The allocated ground; the name is denormalised so a published schedule survives the venue being deleted.                                                                                                                                                          |
| `venueStatus`           | `home` · `alternative` (the away side's ground) · `neutral` · `unresolved`.                                                                                                                                                                                       |
| `venueReason`           | Why this ground — "Home ground outfield relaid — moved to the away side's ground". An over-constrained fixture is `unresolved` **with a reason**, never silently placed somewhere wrong.                                                                          |
| `venueLocked`           | A hand-placed fixture. Claims its slot before allocation runs, so a manual override is never displaced by a re-run. A non-empty `venueOverride` (the ground name the fixture editor writes) counts as locked too — otherwise nothing in the app could set a lock. |

The booking ledger is **tenant-wide**: it spans every series, so two competitions can't
double-book a ground on the same Saturday and a side can't be scheduled twice in one day
across competitions. The series being re-allocated is excluded from its own ledger.

Knockout placeholders (`win:f3`) are **not** booked as sides — they are series-scoped, so
two brackets both contain `win:f1`, and treating them as teams would make one competition's
final clash with another's over sides that don't exist yet.

## `GET /series` — list (rep + admin)

`200 → Series[]` for the tenant. (The club fixtures view filters this to released series
that include the club.)

## `POST /series` — create (admin)

Body: a full series object including client-generated `fixtures[]`. The server sets
`version: 1` and defaults `released: false`, `releasedAt: null`.

```
201 → Series
```

## `PATCH /series/:id` — update / release / recall (admin)

Partial update — covers fixture edits, regeneration (send the whole new `fixtures[]`), and
release/recall. When `released` is set, the server stamps `releasedAt` (release → now,
recall → null) for trustworthy timestamps.

Send the current `version`; mismatch → `409 "series changed; refetch"`. This is the path
most exposed to concurrent edits (two admins, or one in two tabs), so always refetch on 409.

```
200 → Series   404   409 version conflict
```

## `DELETE /series/:id` — delete (admin)

`200 → { ok: true }`.

## `POST /series/:id/duplicate` — duplicate (admin)

Clones the series with a fresh id, `name + " · Copy"`, `released: false`, `version: 1`.

```
201 → Series
```
