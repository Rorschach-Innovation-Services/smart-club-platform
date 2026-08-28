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

| Route                     | Auth  | Notes                                                                                                                                                                                                                                                          |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /season-runs`        | admin | `200 → SeasonRun[]`. Admin-only: the frozen `structureSnapshot` embeds each stage's `schedule.slots` (kick-off times a series may withhold, ADR 0011), and the only caller is the admin-gated console. Reps read fixtures through the projected `GET /series`. |
| `POST /season-runs`       | admin | Requires `id`, `leagueKey`, `seasonLabel` and both snapshots. Sets `version: 1`, stamps `createdAt`/`createdBy`. `409` on a duplicate id — never silently overwrite a live season.                                                                             |
| `GET /season-runs/:id`    | admin | `200 → SeasonRun` · `404`. Admin-only for the same reason as the list: the frozen `structureSnapshot` embeds each stage's `schedule.slots`. Reps read fixtures through the projected `GET /series`.                                                            |
| `PATCH /season-runs/:id`  | admin | Partial update — stage status, group entrants, `carriedPoints`, audit entries. Send the current `version`; mismatch → `409 "season run changed; refetch"`. Two admins resolving the same stage is a real scenario.                                             |
| `DELETE /season-runs/:id` | admin | `200 → { ok: true }`. **Does not delete the series its stages produced** — those are real, possibly-released fixtures clubs have seen. Orphaning a back-pointer is recoverable; deleting a published schedule is not.                                          |

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

## Progressive release (ADR 0011)

An admin may **withhold** venues and/or start times when releasing a series — dates and
opponents are known before grounds and kick-offs are. Two optional server-owned fields
carry this:

| Field        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withheld`   | `{ venue?: true, time?: true }` — which fields are hidden from clubs. Set **only** on the false→true release transition; only `true` keys are stored (empty ⇒ absent). Absent ⇒ nothing withheld, so every series released before this feature reads as fully visible. The store keeps the REAL venue/time data — withholding is a read-side projection, so the release clash gate still sees real venues. |
| `revealedAt` | `{ venue?: string, time?: string }` — audit stamp of when each field was revealed. Cleared by recall. `releasedAt` is **never** bumped by a reveal — the schedule went out at release.                                                                                                                                                                                                                     |

`POST /series` and `POST /series/:id/duplicate` drop both fields: withholding belongs to a
release, never a draft.

## `GET /series` — list (rep + admin, role-projected)

`200 → Series[]` for the tenant.

- **admin** — the raw list: drafts, unreleased venues/times, approval state.
- **rep (any non-admin)** — the club-facing projection (ADR 0011):
  - unreleased series and released-but-not-yet-`activateFrom` series are **omitted**
    (server now mirrors the portal/send-fixtures read gate; release filtering used to be
    client-only, leaking every draft and all fields to reps);
  - `approved`/`approvedAt` stripped;
  - `withheld.time` ⇒ each fixture loses `time`/`slot`, the series loses `schedule.slots`;
  - `withheld.venue` ⇒ each fixture loses all venue keys (`venueId`, `venueName`,
    `venueLat`, `venueLon`, `venueStatus`, `venueReason`, `venueLocked`, `venueOverride`);
  - `withheld`/`revealedAt` are **kept** so the client renders "to be confirmed"
    explicitly. Participants' home-ground `venue`/`lat`/`lon` are **not** stripped (reps
    already have them from `GET /clubs`), so clients must check `withheld.venue` rather
    than infer from missing fields.

## `POST /series` — create (admin)

Body: a full series object including client-generated `fixtures[]`. The server sets
`version: 1`, defaults `released: false`, `releasedAt: null`, and drops any
`withheld`/`revealedAt`.

```
201 → Series
```

## `PATCH /series/:id` — update / release / recall / reveal (admin)

Partial update — covers fixture edits, regeneration (send the whole new `fixtures[]`),
release/recall, and per-field reveal. When `released` is set, the server stamps
`releasedAt` (release → now, recall → null) for trustworthy timestamps.

| Patch                                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ released: true, withheld: {venue?, time?}, version }` | Only on the false→true transition (`!current.released`) and only when the patch carries a `withheld` key. Shape-validated (`400 "withheld must be { venue?: boolean, time?: boolean }"`); only `true` keys stored. Approval + clash gates unchanged — the clash gate runs on the real (unwithheld) venues.                                                                                                                                                                                                                            |
| `{ reveal: ['venue' \| 'time', …], version }`            | Action key, not a stored field — computed from `current` and stripped before the write. `400` on a bad entry or if the patch also carries `released`; `409 "series is not released"`; `409 "nothing withheld for <field>"`. Deletes the key from `withheld`, stamps `revealedAt[field] = now()`; never re-approves, never re-runs the clash gate, never bumps `releasedAt`. The write is narrowed to `withheld`/`revealedAt`/`version` — any other keys riding along on a reveal patch (`fixtures`, `approved`, `name`…) are ignored. |
| `{ released: false, … }`                                 | Recall — clears both `withheld` and `revealedAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| any other patch carrying `withheld`/`revealedAt`         | Both dropped ⇒ the stored values are kept. This includes the whole-object PATCH of an already-released series (which carries `released: true`): withholding is chosen only at release, so an in-season fixture edit never silently reveals a field. To change withholding, recall and re-release.                                                                                                                                                                                                                                     |

Send the current `version`; mismatch → `409 "series changed; refetch"`. This is the path
most exposed to concurrent edits (two admins, or one in two tabs), so always refetch on 409.

```
200 → Series   404   409 version conflict
```

## `DELETE /series/:id` — delete (admin)

`200 → { ok: true }`.

## `POST /series/:id/duplicate` — duplicate (admin)

Clones the series with a fresh id, `name + " · Copy"`, `released: false`, `version: 1`, and
no `withheld`/`revealedAt`.

```
201 → Series
```
