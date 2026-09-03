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
    explicitly. Participants' home-ground `venue`/`lat`/`lon` are **not** stripped, so
    clients must check `withheld.venue` rather than infer from missing fields;
  - **legacy participants back-fill** — a series with no `participants` snapshot (created
    before the snapshot existed, where every `teams[]` id is a clubId) has `participants`
    synthesised from the tenant's clubs: `{ teamId, clubId, name }` plus home-ground
    `venue`/`lat`/`lon` from `club.ground`, skipping any id with no club record. Without
    this a rep's client — which can't call the admin-only `GET /clubs` — renders opponents
    as "Removed club". Home-ground identity is public even when `venue` is withheld (ADR
    0011 §5): the fixture's allocated venue is still hidden and the client shows "Venue to
    be confirmed". A series that already carries `participants` is left untouched.

## `POST /series` — create (admin)

Body: a full series object including client-generated `fixtures[]`. A brand-new series is
always a **draft**: the server sets `version: 1` and **forces** `released: false`,
`releasedAt: null`, `approved: false`, `approvedAt: null` regardless of what the client
sent — release and approval are earned via `PATCH`, never asserted at create — and drops
any `withheld`/`revealedAt`.

```
201 → Series
```

## `PATCH /series/:id` — update / release / recall / reveal (admin)

Partial update — covers fixture edits, regeneration (send the whole new `fixtures[]`),
release/recall, and per-field reveal. `releasedAt` is server-owned: stamped **only** on the
false→true release transition (→ now) and cleared on recall (→ null). A whole-object edit of
an already-released series carries `released: true` but does **not** re-stamp `releasedAt` —
the key is dropped so the stored value (the date clubs already saw) is kept, the same
keep-on-edit rule as `withheld`.

| Patch                                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ released: true, withheld: {venue?, time?}, version }` | Only on the false→true transition (`!current.released`) and only when the patch carries a `withheld` key. Shape-validated (`400 "withheld must be { venue?: boolean, time?: boolean }"`); only `true` keys stored. Approval + clash gates unchanged — the clash gate runs on the real (unwithheld) venues.                                                                                                                                                                                                                            |
| `{ reveal: ['venue' \| 'time', …], version }`            | Action key, not a stored field — computed from `current` and stripped before the write. `400` on a bad entry or if the patch also carries `released`; `409 "series is not released"`; `409 "nothing withheld for <field>"`. Deletes the key from `withheld`, stamps `revealedAt[field] = now()`; never re-approves, never re-runs the clash gate, never bumps `releasedAt`. The write is narrowed to `withheld`/`revealedAt`/`version` — any other keys riding along on a reveal patch (`fixtures`, `approved`, `name`…) are ignored. |
| `{ released: false, … }`                                 | Recall — clears both `withheld` and `revealedAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| any other patch carrying `withheld`/`revealedAt`         | Both dropped ⇒ the stored values are kept. This includes the whole-object PATCH of an already-released series (which carries `released: true`): withholding is chosen only at release, so an in-season fixture edit never silently reveals a field. To change withholding, recall and re-release.                                                                                                                                                                                                                                     |

Send the current `version`; mismatch → `409 "series changed; refetch"`. This is the path
most exposed to concurrent edits (two admins, or one in two tabs), so always refetch on 409.
The **version check runs before the clash gate**, so a stale write always gets the plain
concurrency 409, never a venue-clash one.

```
200 → Series   404   409 version conflict / venue clash
```

### Venue clash gate

A fixtures write must not publish a ground/date/time double-booking:

- **At release** (false→true): the series is checked against every other series in the
  tenant (drafts included). Any clash blocks release.
- **In-season** (a `fixtures` write to an already-**released** series — regenerate and
  allocation write-back included): the edit is refused only if it **introduces** a clash,
  i.e. the resulting clash set is not a subset of the pre-edit set. A series already
  carrying residual clashes stays fixable one fixture at a time, and moving a residual-
  clashing fixture's kick-off against the same untimed partner is not counted as new (the
  clash identity is the fixture pair on a ground, without date/time). Recall
  (`released: false`) is never gated. The gate reads the **real** venues even when
  `withheld.venue` hides them from clubs. See the
  [ADR 0011 in-season addendum](../architecture/0011-progressive-fixture-release.md#addendum-2026-09-in-season-edits-are-clash-gated).

Both gates return `409` with a **structured body** (details spread before `error`, which
every client still reads):

```jsonc
{
  "error": "Change blocked — 1 venue clash(es): …", // release: "Release blocked — …"
  "code": "venue_clash",
  "clashes": [
    {
      "fixtureId": "f2", // the subject fixture
      "round": 3,
      "ground": "Kingsmead",
      "date": "2026-09-27",
      "time": "09:00", // omitted for an untimed fixture
      "home": "Home Club", // subject-side display names
      "away": "Away Club",
      "with": {
        "seriesId": "s-other",
        "seriesName": "Premier T20",
        "fixtureId": "f7",
        "round": 3,
        "home": "Other Home",
        "away": "Other Away",
      },
    },
  ],
}
```

At release, `clashes` lists every clash; in-season it lists only the **introduced** ones.

## `POST /series/:id/clash-check` — clash pre-check (admin)

A read-only pre-check for the fixture editor: which candidate fixtures would clash, and
which the in-season save gate would **refuse**. No write, no version check; works on drafts
and released series alike.

Body: `{ candidates: Fixture[] }` — 1–20 entries, each an object with a string `id`
(otherwise `400`). Every field the clash ledger reads is type-checked too: `date`, `time`,
`venueOverride`, `venueName`, `home`, `away` and `status` must each be a string when present
(`400 "candidate <field> must be a string"`), and `round` a number when present
(`400 "candidate round must be a number"`) — `null`/omitted is always accepted. Unknown
series → `404`; a rep → `403`.

```jsonc
{
  "results": [
    // aligned by index to `candidates`
    {
      "clashes": [
        /* Clash */
      ],
      "introduced": [
        /* Clash */
      ],
    },
  ],
}
```

For each candidate the subject is `current` with the same-id fixture replaced (or the
candidate appended if new). `clashes` is every clash the candidate is party to; `introduced`
is the subset absent from the series' pre-edit clash set — exactly what the in-season gate
would refuse on a released series, so the editor's "will be refused on save" hint can never
disagree with the server. A server round-trip (not a client ledger) is deliberate:
ground-name normalisation and `VENUE_ALIASES` live server-side.

## `DELETE /series/:id` — delete (admin)

`200 → { ok: true }`.

## `POST /series/:id/duplicate` — duplicate (admin)

Clones the series with a fresh id, `name + " · Copy"`, `version: 1`, and no
`withheld`/`revealedAt`. A copy is a fresh **draft**: `released: false`, `releasedAt: null`,
`approved: false`, `approvedAt: null` — release and approval belong to the original, so a
copy never starts approved or released.

```
201 → Series
```
