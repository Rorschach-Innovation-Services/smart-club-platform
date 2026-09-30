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
The snapshots are **server-fetched** at start (the same rule as rebase): `POST /season-runs`
resolves the run's league setup in live tenant config and freezes that structure and
calendar, so an admin tab holding a config cached before an operator edit can never freeze
outdated dates into a new season.

**Setup vocabulary.** A league has at most one operator-authored **setup**,
`League.setup = { structureId, calendarId }` — the structure its seasons run and the
calendar they play on. Match format lives on the structure: `CompetitionStructure.overs`
(a whole number 1-200; absent ⇒ 50). Two formats in one season are two league entries. A
run resolves everything through `run.leagueKey → league.setup`; the deprecated
`SeasonRun.competitionId` is inert (ignored on POST, never read, left alone on stored runs),
and a league's deprecated `competitions[]` is inert stored data until a later cleanup
script removes it.
Both are **stripped from PATCH** rather than rejected, so a client round-tripping a whole
run object doesn't get a confusing 400.

**The calendar follows the live tenant calendar until the first generate.** Freezing at
start protected nothing (no fixtures existed yet), so a run's calendar is frozen at its
**first generate** instead:

- While the run is unfrozen (no stored `calendarFrozenAt`) and no stage has a series (no
  `stages[].groups[].seriesId`), `GET /season-runs` and
  `GET /season-runs/:id` return the run with `calendarSnapshot` replaced by a deep copy of the
  calendar its league's setup resolves to **now** (league → `setup.calendarId`), plus the
  response-only flag `calendarLive: true`. An operator's date fix, or re-pointing the
  setup at another calendar, shows up at once. Nothing is written by the read, and
  `version` is unchanged, so a generate sends back the version it read as before.
- If that setup no longer resolves (the league lost its setup, or its calendar was deleted),
  the stored snapshot is returned with `calendarLive: false` and
  `warnings: ["This season's league setup or calendar was removed; showing the dates it started with."]`.
- The first `POST /season-runs/:id/stages/:specId/generate` materialises against the live
  calendar (the `does_not_fit` / `no_block` checks included) and stores it as
  `calendarSnapshot` in the same run write that records the stage's series, stamping the
  server-owned `calendarFrozenAt`. From then on the run is returned exactly as stored, with
  no `calendarLive`, and calendar edits no longer reach it.
- **The freeze is one-way.** `calendarFrozenAt` is never cleared, so a rebase that clears a
  stage's groups (and their `seriesId`s) cannot put the season back on live dates. A rebase
  of a run that has series but no stamp (generated before this rule) stamps it, keeping the
  stored calendar; such a run already counts as frozen because it has series.
- `calendarFrozenAt` is ignored on `POST` and stripped from PATCH. `calendarLive` and
  `warnings` are response-only and never stored; PATCH strips them like the snapshots.
- The structure snapshot is unchanged by this: a structure change still reaches a running
  season only through rebase (Review changes).
- The operator calendar delete guard counts a run by its stored `calendarSnapshot.id`
  **and**, for a run that has not generated, by the calendar its league's setup names
  after the save. Deleting a calendar an ungenerated run follows is a `409` even when its
  stored snapshot names another calendar. The message counts the two separately:
  `N season run(s) started on "X"` and `N season run(s) follow "X" until their fixtures are
generated`, joined with `;` when both apply.

| Route                                           | Auth  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /season-runs`                              | admin | `200 → SeasonRun[]`. Admin-only: the frozen `structureSnapshot` embeds each stage's `schedule.slots` (kick-off times a series may withhold, ADR 0011), and the only caller is the admin-gated console. Reps read fixtures through the projected `GET /series`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /season-runs`                             | admin | Requires `id`, `leagueKey` and `seasonLabel`. The server resolves `leagueKey` → `league.setup` in tenant config and deep-copies that setup's live structure and calendar into `structureSnapshot` / `calendarSnapshot`; **any snapshots in the body are ignored**, and so is a `competitionId` (never stored on a new run). `stages` is optional: absent, every stage of the resolved structure starts `awaiting-entrants`; present, every `specId` must be on the resolved structure. A client-sent `formatChanged` is dropped. Sets `version: 1`, stamps `createdAt`/`createdBy`. `400 "unknown league"`; `400 "this league has no season setup yet — ask your operator"` (`code: "setup_missing"`) — the **only** place a setup is required; `400` with `code: "structure_missing"` / `"calendar_missing"` when the setup points at a structure or calendar config no longer has; `400 "stage <id> is not on the bound structure"`; `400` when the resolved structure or calendar fails the operator validators. `409` on a duplicate id — never silently overwrite a live season; `409` with `code: "season_exists"` when the league already has a run with the same `seasonLabel` (one setup, one season per label). |
| `GET /season-runs/:id`                          | admin | `200 → SeasonRun` · `404`. Admin-only for the same reason as the list: the frozen `structureSnapshot` embeds each stage's `schedule.slots`. Reps read fixtures through the projected `GET /series`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PATCH /season-runs/:id`                        | admin | Partial update — stage status, group entrants, `carriedPoints`, audit entries. Send the current `version`; mismatch → `409 "season run changed; refetch"`. Two admins resolving the same stage is a real scenario. A stage's `formatChanged` is server-owned: the stored value is replayed whatever the body says.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /season-runs/:id/stages/:specId/generate` | admin | Materialise one stage on the server and write its group series through the `POST`/`PATCH /series` gates. See [Generate a stage](#generate-a-stage) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /season-runs/:id/rebase`                  | admin | Adopt the live structure version. Body `{ structureVersion, version }` (both required, `400` otherwise). `409 "season run changed; refetch"` on a stale run `version`; `409` with `code: "structure_changed"` when the live structure is no longer the `structureVersion` the admin reviewed; `404` when the structure is gone. When the adopted structure's **root** `name` or `overs` differs from the old snapshot's, every surviving StageRun is stamped `formatChanged: true` (stored, server-owned) — see [Generate a stage](#generate-a-stage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DELETE /season-runs/:id`                       | admin | `200 → { ok: true }`. **Does not delete the series its stages produced** — those are real, possibly-released fixtures clubs have seen. Orphaning a back-pointer is recoverable; deleting a published schedule is not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Season runs are swept by tenant erasure and by cohort clearing, like series.

The `POST /season-runs/quick-start` route is **removed**. Seasons start only on a league the
operator set up; a one-off cup is an operator-created structure like any other.

**`CompetitionStructure.source`** records who authored a structure: `operator`,
`quick-start` (structures minted by the retired quick start keep it) or `migration` (the
flat-run migration). Absent means `operator`, as before. It is provenance only, like
`templateId`. The operator PUT validates it against that enum and never strips it.

### Generate a stage

`POST /season-runs/:id/stages/:specId/generate` writes one stage's fixtures. The server
materialises the stage with the shared engine (ADR 0014) and writes one series per group. It
works out the stage the same way the Seasons panel previews it: `leagueParticipants` over the
tenant's clubs for the run's league (no exclusion list — the stage-level Edit entrants flow
covers a side sitting a stage out), then `materialiseRun`, which applies pairing overrides, confirmed groups, pool qualifiers and
chained start dates. Each group becomes a series through `buildStageSeries`, with the id
`s-<runId>-<specId>-<groupId>`.

There is **no setup check** here: every run carries its own snapshots, so a league that lost
its setup can still generate and regenerate its season. The format is **snapshot-first**:
a new series gets `seriesType` = the structure snapshot's `name` and `maxOvers` = its
`overs`, falling back to the live setup structure's `overs` for a snapshot taken before
overs existed, and to 50 when neither has one.

```jsonc
{
  "version": 3, // the run version you read
  "confirmReleasedOverwrite": true, // optional; only `true` is accepted
}
```

Writes go through the existing routes' own code:

1. **Released check.** Every group is checked before anything is written. If any series the
   generate would replace is released and `confirmReleasedOverwrite` isn't `true`, the
   response is `409 { code: "released_overwrite", seriesIds }`, listing every such series,
   and nothing is written.
2. **Series.** A new group series is created exactly as `POST /series` creates one, so it is
   always a draft. An existing one is overwritten through the `PATCH /series/:id` handler
   with its stored version, so the approval recall on drafts and the in-season clash gate on
   released series run unchanged. `released`, `releasedAt` and `name` are left out of that
   patch: regenerating changes the fixtures, not whether they are published, and it never
   reverts a name the admin chose. **`seriesType` and `maxOvers` are left out too**: a
   regenerate keeps the existing series' stored format, so a released "T20" series can never
   be republished as a 50-over under a structure-shaped name. The one exception is a stage
   marked `formatChanged` by a rebase (the rebase's version review is the consent): then
   the new snapshot's name/overs are written, and the marker is cleared in step 3.
3. **Run.** The run is updated through the `PATCH /season-runs/:id` handler with the version
   you sent. The stage is marked `generated`, each group records its `seriesId`, and
   `staleSchedule` and `formatChanged` are cleared. A stage generated with no stored groups gets them from what
   was generated. On the run's **first** generate this write also stores the live calendar
   the stage was materialised against as `calendarSnapshot` (the freeze point, see
   [Season runs](#season-runs)); the new series' schedules are validated against that
   calendar.

| Status | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | `{ run: SeasonRun, series: Series[] }`: the updated run and the series written, in group order (admin shape).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `400`  | `version` is not an integer, or `confirmReleasedOverwrite` is present but not `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `403`  | The caller is not an admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `404`  | Unknown run, or `specId` names no stage on the run's structure snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `409`  | `"season run changed; refetch"`: `version` doesn't match (checked before anything is written). `"stage is awaiting entrants"` (`code: "awaiting_entrants"`, plus `reason`): no confirmed or derivable entrants yet. `code: "does_not_fit"`: a group's rounds overrun its block. `code: "no_block"`: the stage's block no longer exists on the run's calendar. `code: "released_overwrite"`: see step 1. `code: "venue_clash"`: the in-season clash gate refused a released series, with the same body `PATCH /series/:id` returns. `"series changed; refetch"`: a series moved under the write. |

**Idempotent.** Generation is deterministic, so repeating a call with the same inputs writes
the same ids and the same content. Each call still bumps the run's and the series' versions,
so a repeat must send the new run version.

**Not transactional across groups.** Once the released check passes, groups are written one
after another. A clash-gate `409` on a later group leaves the earlier groups written, as the
client-side loop this route replaced did. Fix the clash and generate again.

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
| `{ released: true, withheld: {venue?, time?}, version }` | Only on the false→true transition (`!current.released`) and only when the patch carries a `withheld` key. Shape-validated (`400 "withheld must be { venue?: boolean, time?: boolean }"`); only `true` keys stored. Approval + clash gates unchanged — an unapproved series is `400 "fixtures must be approved before release"` with `code: "not_approved"`, and the clash gate runs on the real (unwithheld) venues.                                                                                                                  |
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
