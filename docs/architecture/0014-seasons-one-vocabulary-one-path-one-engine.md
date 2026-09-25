# ADR 0014 — Seasons: one vocabulary, one path, one engine

**Status:** Accepted (September 2026). Amends [ADR 0004](0004-thin-crud-client-side-compute.md)
(engine placement) and extends [ADR 0008](0008-configurable-league-structures.md).

## Context

ADR 0008 gave the platform a sound model — competition → season → stage → group → series,
a closed registry of formats, one stage-group materialising into one `Series`. What grew up
around it over the following months made the model hard to _use_:

- **Three forms behind one button.** "Generate fixtures" in the admin console opened one of
  three forms depending on whether an operator had bound a competition to the league —
  something the admin could neither see nor change. The unbound case produced a "flat season":
  a `SeasonRun` with a synthetic structure (`st-flat-default`), a synthetic calendar
  (`cal-flat-<league>`) that existed only inside the run's snapshot, a sentinel competition id
  `__flat__`, and the match format stored on the run as `flatFormat` because there was no
  competition to hold it. A flat season with custom dates could not generate fixtures at all:
  `POST /series` validated the series' calendar against tenant config and the synthetic
  calendar was never there.
- **A legacy create-series form** kept alive beside the season path, with its own id scheme,
  its own date model (`startDate`/`endDate` weekly stepping) and a 350-line "Advanced
  match & scoring settings" section of which two fields were read anywhere.
- **Five writers of `Series.fixtures[]`** (season generate, flat season, legacy form,
  `seed-cohort`, the Plan B importer) assembling the series object by hand, with different
  field sets. `seed-cohort` had drifted: it omitted `roundsPerDay` and `activateFrom` and
  carried its own copy of the template block-placement rule.
- **Twins kept in sync by comment.** Knockout labels (`formats.ts` ↔ `slot-refs.ts`),
  structure validation (client ↔ `config-validation.ts`), the rebase diff, the domain types
  themselves (`src/types.ts` "hand-ported" from `packages/api/src/types.ts`), two info
  popovers, six modal shells.
- **Vocabulary that collided.** "Block" meant a calendar window but read as a phase because
  templates placed stage 0 in block 0 and every later stage in block 1, so on a two-block
  calendar stage _n_ and Block _n_ lined up one to one. "Season" meant a calendar label, a
  `SeasonRun`, an operator wizard that created no run, and an admin action that did.
  "Structure" also named a workbook import of club team entries. Entrants "entered by an
  administrator" sat beside a format "entered by hand".
- **Hard-coded values in shared code**: cricket-only series types and overs, KZNCU league
  names as template examples for every tenant, dolphins venue aliases inside the server
  clash gate, T20 kick-off slots in a template and two admin forms, a Saturday default, a
  `2026/27` literal.

The question was not whether the ADR 0008 model was right. It was how to remove the parallel
paths and give operators and administrators one way to do each thing, with the platform
explaining itself as they go.

## Decision

### One vocabulary

- A **season calendar** holds dates. Its ranges are **blocks** — the unions' own word, kept.
- A **competition** is a league's format stream. A **structure** is its reusable shape: an
  ordered list of **stages**. A stage is never called a block; every stage is titled by its
  kind (Round-robin stage, Knockout stage, Final, Hand-entered stage) and the platform always
  says _which block_ a stage plays in, so the two ideas are shown side by side rather than
  confused.
- A **season** is one competition being played this year (`SeasonRun`). The operator wizard
  is "Set up the season calendar & competitions"; the admin action is "Start a season".
- **Group** everywhere in labels. Entrants are "every registered side", "seeded into groups"
  or "chosen by the admin"; the manual format is "fixtures entered by hand". The workbook
  import of club team entries is "Team entries import".

The fix for the block/stage confusion is **explicit placement, not renaming**: instantiating
a template asks which block each stage plays in (prefilled by the old rule), and a
plain-English **season narrative** — one sentence per stage with its block and dates — is
rendered wherever a structure is shown.

### Every season is a real run on a real structure

The `__flat__` sentinel, `flatFormat`, `buildFlatSeasonRun` and the synthetic calendar are
removed. A league with no competition is started through **quick start**: the admin picks a
template, a calendar (an existing one, or new single-block dates) and a match format, and
`POST /season-runs/quick-start` instantiates the template **server-side from the closed
registry** with server-minted ids, writes the calendar, structure and binding into tenant
config through the same validators and referrer guards the operator route uses, and creates
the run. Admins never send a structure body, so ADR 0006's "structures are operator-authored"
still holds — an admin can only _select_ from the registry. Quick-start structures are marked
`source: 'quick-start'`, are minted fresh per league, and never become the operator wizard's
reuse prefill.

Match format lives on `Competition.matchFormat` only; series copy it.

Existing flat runs are migrated **per run** (`scripts/migrate-flat-runs.ts`), each keeping its
exact snapshot content and stage id `stage-1`, so `stageSpecId`, `run.stages[].specId` and
series ids survive a later rebase. Sharing one Flat structure across runs was rejected: the
rebase route drops any `StageRun` whose spec id is not in the live structure, which would
have stranded migrated seasons on the first operator edit.

The legacy create-series form and the series-level Regenerate are retired. What only the form
did is re-homed first: dropping a side becomes an Edit-entrants affordance on every stage
(including `all-registered`), the affiliation gate moves into `leagueParticipants`, and travel
cost moves to tenant `competitionDefaults`. Series without a `seasonRunId` are labelled
"Imported schedule" (the union's Plan B fixtures) or "Stand-alone series" and cannot be
regenerated.

### One engine, in one place

The pure engine — formats, entrants, calendar planning, structure materialisation, venue
allocation, templates, the season narrative, `leagueParticipants`, the pure season-run
functions and the competition domain types — lives in **`packages/engine`**, a strict
TypeScript package imported by the web app, the API and the CLIs by relative path. The
hand-ported type twin is gone: both `types.ts` files re-export the engine's. The knockout
label twin in the API is gone. `buildStageSeries` is the **only** place a stage-group series
object is assembled; the web client and `seed-cohort` both call it, which is what closed the
drift the analysis found.

**ADR 0004 is amended, not reversed.** Generation and preview stay pure functions; preview
still runs in the browser over data it already fetches. What changes is _where the write
side of season generation runs_: `POST /season-runs/:id/stages/:specId/generate` materialises
on the server via the same engine and writes the group series through the same gates as
`PATCH /series`, carrying `confirmReleasedOverwrite` so the console's "overwrite a released
schedule?" prompt survives as a 409-then-confirm. This consolidates the two browser callers.
It is scoped honestly: the Plan B importer cannot use it (its fixtures are not generated),
and `seed-cohort` intentionally bypasses release gates (pre-released seeds would 409 on
home-ground collisions), so it keeps `repo.putSeries` but uses the shared builder.

### Tenant-configured defaults instead of constants

`TenantConfig.competitionDefaults` carries match formats (replacing the cricket-only series
types and the two ball-type lists), match days, kick-off slots, travel cost and venue aliases
(replacing the dolphins aliases in the server clash gate). Templates lose union-specific
example text. Every-N-weeks exposes N everywhere. Within-group semi-final validation widens to
the engine's real rule. Fields that stored a capability the platform does not have
(`LadderSpec`, `OutcomeSpec`, `knockout.preliminaries`, the Advanced scoring block) leave the
UI and are marked deprecated; stored data stays valid.

### The platform explains itself

Three plain-TypeScript registries hold the copy, so it is greppable and testable: stage kinds
(what a stage does, what the admin will be asked, what it produces, an example, how to
choose), help topics ("how the platform does it": dates, home/away, seeding, pairing, why
standings are typed by a human, allocation, approve/release/withhold, activate-from, what
regenerate destroys, versions and rebase) and per-field guides (meaning, how it is used, an
example, the convention). They feed option cards for every behaviour-changing choice, a help
drawer reachable from any control, the season narrative, status timelines on stage cards, a
"what happens next" strip after starting a season, and a "how a season works" overview on the
empty states. The printed tutorial is served from the app and every topic links to its
section.

## Why

- **Remove the parallel path rather than add a fourth.** Each extra form, sentinel or twin
  was locally reasonable and globally the cause of the confusion. The evidence is the flat
  custom-dates bug: a synthetic calendar that only one side of the system knew about.
- **Server-side quick start over client-written config.** Opening `PUT /tenant/config` to
  structures would have ended ADR 0006's operator/admin split. A route that instantiates from
  a closed registry gives admins self-service without authoring.
- **Shared engine first, server write second.** The drift found was object-assembly drift,
  which a shared builder fixes on its own. The server route was kept because the user chose
  one gated writer; it is the piece with the weakest evidence and is separable.
- **Explicit placement over renaming "block".** Docs, runbooks and union documents all say
  Block 1 / Block 2. The confusion came from a placement rule, so the rule became a question.
- **Per-run migration.** N small structures cost nothing; a stranded season costs a union.

## Consequences

- `packages/engine` must stay pure (no React, no DOM, no AWS SDK) and strict. `tsconfig.seed.json`
  remains only for `export-cohort.ts`, which imports CQI code, not engine code.
- The operator wizard's template reuse considers operator-authored structures only.
- Calendar delete now also refuses when a season run was started on that calendar.
- A quick start writes two items (config, then run) without a transaction; a failure between
  them is reported with the created competition id so the admin can start it normally.
- Series without `seasonRunId` cannot be regenerated from the UI. Plan B re-imports remain the
  way to reshape the union's imported schedule.
- Preview (client) and generate (server) now run the same engine from the same package; a
  stale browser tab could preview with an older build than the API generates with. This is a
  new, rare failure class accepted in exchange for one gated writer.
- The known clash-gate bypasses recorded in ADR 0011 (venue CLIs, `PATCH /clubs/:id` ground
  changes) are unchanged by this ADR.
- Tenant-configured defaults, as built (Phase 4). `competitionDefaults` is admin-level setup
  data: both `PUT /tenant/config` and the operator route write it, and the anonymous
  `GET /tenant` serves only formats, days and slots. The dolphins venue aliases stay in code
  as `DEFAULT_VENUE_ALIASES` (moved into the engine so the console can import them), merged
  under each tenant's own aliases; a backfill copies them into the dolphins config, and
  emptying the code default is a later change. Alias keys and values are stored normalised.
  The "Every 2 weeks" choice was already gone (the structure editor asks for N), so there was
  no remaining two-week-only control to replace. Template and stage-kind copy describe a shape,
  not a union; the optional "use the tenant's own league names as examples" idea was not built.
  `ladder`, `outcome`, `knockout.preliminaries` and `StageRun.status: 'complete'` are marked
  deprecated and no new template sets `outcome`; stored values still validate.

## Alternatives considered

- **Keep the flat path and fix only the calendar validation.** Ten lines, and it ships first
  (Phase 1a). It leaves the sentinel, the hidden three-way branch and `flatFormat` in place,
  which is the confusion this ADR exists to remove.
- **Let admins author structures.** Simplest quick start; ends the operator/admin split.
- **Rename "block".** Rejected: every external document uses it, and the collision was caused
  by placement, not the word.
- **Shared engine with the client still writing.** Removes the twins and the drift with less
  change; leaves five writers and their gate gaps. Kept as the fallback if the generate route
  proves troublesome.
