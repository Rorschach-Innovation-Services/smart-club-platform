# ADR 0008 — Configurable league structures: stage pipelines over per-union special cases

**Status:** Accepted

## Context

A league in the current model is a name: `League { key, label, group, district, note? }`
in `TenantConfig.leagues` ([ADR 0005](0005-frozen-catalogues-v1.md) addendum). Fixtures come
from `CreateSeriesForm` (`src/admin.tsx`), which picks a league, bulk-selects every registered
side via `clubTeamsForLeague`, and emits **one** flat round robin from `generateRoundRobin`
(`src/data.ts`) across a single start/end window.

The KZNCU and EMCU structure documents for the 2026/27 season describe roughly twenty
competitions. Almost none of them is a flat round robin:

- **Premier Men** runs **two competitions in parallel** with different structures _and_
  different groupings of the same twelve clubs — T20 Pink Ball (two seeded pools of six →
  cross-pool semis → final) and 50 Over Red Ball (Top Six / Bottom Six, double round robin, a
  mid-season swap, then a single final round).
- The **mid-season swap** is not a plain regrade: the team dropping out of the Top Six
  _relinquishes its points and takes on the incoming team's_, and vice versa. Points move by
  **league position**, not with the team.
- **Promotion Men** layers a 9-team knockout (one preliminary → QF → SF → final) onto the
  bottom stream, running concurrently with the top stream's final group phase.
- **EMCU** divisions are structurally identical and differ only in **cadence** — weekly,
  every two weeks, Saturdays-only.
- The season is **two blocks with a mid-season break** (13 Sep – 13 Dec, break, third week of
  January – March), and **juniors generate fixtures that must not become visible** until the
  second block.

So today's output is wrong for two independent reasons. **Structurally**, Premier Men gets a
single 55-match pool instead of two six-team groups. **Temporally**, every league is scheduled
straight through the December break at a hardcoded weekly cadence.

The tempting fix — a `structure` enum on `League` with a branch per union — does not survive
contact with the second client. The requirement is that _how a league works_ becomes something
an operator configures per tenant, and that the model absorbs structures nobody has described
yet.

The named risk in doing that is the
[inner-platform effect](https://en.wikipedia.org/wiki/Inner-platform_effect): building a
configuration language so general it becomes a poor reimplementation of the programming
language underneath it. Everything below is shaped by keeping that from happening.

## Decision

### A competition is an ordered pipeline of stages

We adopt the vocabulary the sports-data industry has already settled on (Sportradar, Score7,
Open Bracket Format): **competition → season → stage → group → round → match**. Inventing our
own terms here buys nothing and costs every future integration a translation layer.

```
CompetitionStructure (versioned blueprint, no teams in it)
   └─ StageSpec[] ── format · entrants · schedule · ladder · outcome
                   ↓ bound to a league
League.competitions[] ── one per format stream (T20 Pink Ball, 50 Over Red Ball)
                   ↓ run for a season (snapshots the structure)
SeasonRun → StageRun[] → group → Series
```

A `League` gains an optional `competitions[]`. This is the structural gap in today's model: a
league is currently one flat thing, and Premier Men needs to be two, over the same club roster
with different groupings.

### One stage-group materialises into one `Series`

This is the load-bearing choice. The season run is an orchestration layer **above** `Series`,
not a replacement for it. A series keeps its exact shape — `participants`, `fixtures[]`,
`approved`, `released`, `version` — and gains only optional back-pointers (`seasonRunId`,
`stageSpecId`, `groupId`).

That preserves, untouched: the approve→release gate (`packages/api/src/index.ts`), the player
broadcast and `buildClubSchedule`, travel cost via `fixtureCost`, and the
`resolveTeam`/`teamIdsForClub` parity pair (`src/data.ts` ↔ `packages/api/src/teams.ts`).

It is **not** free, and the plan should not pretend otherwise: a Top Six club would see three
separate series cards for what it thinks of as one league season. The club portal
(`src/club.tsx`) and the broadcast text need a grouping-by-`SeasonRun` layer so a season reads
as one thing. That is a display concern, deliberately paid in exchange for leaving the entire
fixture-persistence and release path alone.

### Closed registries, no expression language

Structure configuration is **selection from fixed sets with parameters** — never user-authored
logic. No conditionals, no arithmetic, no expression evaluator. This is the structural defence
against the inner-platform effect, and it is a constraint we intend to defend: if a future
requirement wants an `if` in configuration, that is the signal to hardcode it instead.

`FormatSpec` — how fixtures are made within one group:

| kind           | Parameters                                           | Covers                              |
| -------------- | ---------------------------------------------------- | ----------------------------------- |
| `round-robin`  | `legs: 1\|2\|3`, `legOrder`                          | Every league phase in both unions   |
| `knockout`     | `entrants`, `preliminaries`, `pairing`, `thirdPlace` | Kingsmead Cup, all cross-pool semis |
| `single-match` | —                                                    | Finals, playoffs                    |
| `manual`       | —                                                    | The escape hatch                    |

`round-robin legs:1` **is** the existing `generateRoundRobin`, absorbed behaviour-identically.
It carries real test coverage in `src/data.test.ts`, including a create/regenerate parity test
that must keep passing untouched.

`manual` generates no fixtures **by design** — it is the escape hatch for a stage nobody can
express, and the admin enters the fixtures by hand afterwards. Readiness is therefore judged
on ENTRANTS (a group needs two sides), never on fixture count, or the escape hatch would be
permanently unreachable. Because such a stage plans no rounds, it also has no first date, and
`startDate` is the Series gsi1 SORT KEY — so generation falls back to the stage's block start,
and `POST /series` rejects a blank one outright. An empty string there is accepted by dynalite
and rejected by DynamoDB, which is the worst combination: green tests, a 500 in production
half-way through writing a multi-group stage.

A `cross-pool` knockout needs two different things from two different places:

- **Who qualified** comes from the knockout stage's own confirmed entrants.
- **Which pool, and in what order** comes from the stage before it.

Both halves are load-bearing. Sourcing the whole thing from the previous stage's rosters
builds a bracket over the first two clubs in each pool — sides the knockout series does not
contain — so the clubs that actually qualified open the portal to a series with none of their
fixtures in it.

There are therefore **two refusals**, and both fall back to a seeded bracket over the full
field — wrong in pairing, never wrong in personnel, and never empty:

- The qualifiers must name **exactly** this stage's entrants.
- The draw itself must not lose anyone. `crossPoolRounds` takes a fixed shape — one per pool,
  or exactly two per pool — so "winners plus the best runner-up" would silently drop the
  runner-up. It returns nothing rather than a lossy bracket.

A fallback is reported on the stage card (`crossPoolFallback`), because silently degrading
leaves the console still saying "cross-pool" over a draw that isn't — undiagnosable from the
operator's side.

Pool ORDER is finishing order, and the confirm form asks for it explicitly — a Position column
that appears only when the next stage draws cross-pool from this one. There is no results
model, so a human supplies the ranking, exactly as `swap` and `from-standings` do. Inferring
it from registration order would have been a ranking of nothing.

Swiss format is **deliberately omitted**. No documented league needs it, and adding a primitive
"for flexibility" is precisely how the anti-pattern starts.

### Standings are admin-confirmed; the resolver registry stays honest

There is no results or ladder model in the platform — fixtures carry a `status` and nothing
else. A resolver that reads standings therefore cannot resolve anything, today or after any
amount of engineering that stops short of building results capture.

Rather than ship seven resolvers of which five permanently answer "ask a human", the registry
is three:

```ts
type EntrantSpec =
  | { kind: 'all-registered' } // today's behaviour
  | { kind: 'manual'; derivedFrom?: DerivationNote } // everything standings-dependent
  | { kind: 'seeded-split'; groups: GroupSizes; method: 'snake' | 'blocks' | 'manual' };

interface DerivationNote {
  // records the RULE — for prefill, display and audit
  rule: 'from-standings' | 'swap' | 'winners-of' | 'carry-forward';
  fromStage: string;
  detail: string; // "Top Six 6th ↔ Bottom Six 1st, points carried"
  carryPoints?: boolean;
}
```

Everything standings-dependent is `manual` carrying a `DerivationNote`. The note states the
rule in the operator's own language, drives what prefill we can offer (prior entrant order,
last season's confirmed order), and is recorded in the stage audit trail. When results capture
lands, each `rule` is promoted to a real resolver — stored specs need no migration, only the
resolution path changes.

This also handles the case that has no prior data at all: a **newly created client** has no
previous log, so the admin types the starting groups. `manual` is the normal path there, not a
degraded one.

`swap` is kept as a `DerivationNote.rule` rather than a resolver because it is how operators
think, but it is a label over general machinery: two positional reads plus set arithmetic. Only
`carryPoints` is genuinely novel — [PlayHQ's regrading](https://support.playhq.com/hc/en-au/articles/900003188503-Understanding-the-impact-of-regrading-on-a-grade-s-fixture)
moves teams and can include or exclude prior results, but has no notion of inheriting the
outgoing _position's_ points. `carriedPoints` is therefore an admin-entered handover value,
stored on the `StageRun`, displayed as "carried", and never recomputed — explicitly marked so a
future ladder cannot double-count it.

### The season calendar is a first-class tenant object

```ts
interface SeasonCalendar {
  id: string;
  label: string;
  timezone: string;
  blocks: { id: string; label: string; start: string; end: string }[];
  breaks?: { start: string; end: string; label: string }[];
  excludeDates?: string[];
}
```

A stage's `ScheduleSpec` names a block and a cadence (`weekly` · `every-n-weeks` ·
`weekdays[]` · `spread`), plus optional time slots, doubleheader allowance and minimum rest.
`resolveSpread` (`src/data.ts`) — currently a special case pairing `dateMode` with `kind` —
becomes one cadence kind among four.

This is the cheapest and most broadly useful part of the whole change: it fixes the temporal
defect for **every** league, including the flat EMCU divisions that need no stage model at all.

**Junior delayed activation reuses `released`/`releasedAt`** rather than inventing a parallel
visibility flag. `activateFrom` is a scheduled release on a generated, approved series — the
existing gate already does exactly this job, and a second visibility mechanism would be one
more thing to get out of sync.

**Times are stored as local wall-clock `date` + `time` strings and never converted to UTC.**
Today, date-only ISO strings round-trip cleanly through `new Date(…).toISOString().slice(0,10)`
because both ends treat them as UTC midnight. Introducing times breaks that symmetry, and the
region has no DST to justify the complexity. One tenant timezone on the calendar, used for
display.

### Structures are versioned; a `SeasonRun` snapshots the one it started with

Editing a structure must never mutate a season already in flight. Structures carry a version;
edits mint a new one; a `SeasonRun` stores `structureSnapshot` and `calendarSnapshot` taken at
start.

This is the same defensive pattern the codebase already applies to `series.participants`
(`src/leagues.ts`), where a snapshot keeps a released series resolving correctly after a club
edits its roster. [Score7](https://kb.score7.io/docs/getting-started/multi-stage-tournament/)
solves the same problem by forbidding format changes after creation; a tenant-configured
platform cannot take that option, so it pays for it with snapshots.

### A structure records the calendar its blocks were authored against, and never guesses

A `StageSpec` names a `blockId` and nothing else, so "which calendar does this structure
belong to" is a question the model cannot answer from the stage alone. `CompetitionStructure`
therefore carries `calendarId` — provenance, not a binding, since a competition still names
its own calendar and one structure can be reused across seasons.

Where it is absent (structures written before the field, imported JSON, or the seed CLI),
the editor resolves it in a fixed order: **recorded `calendarId` → the calendar named by the
competitions that bind this structure → the one calendar whose blocks cover every stage →
nothing.**

The bound competition beats block coverage because it is what the _server_ enforces:
`validateCompetitions` rejects a save whose blocks aren't on the bound calendar, so editing
against any other calendar is editing against one with no authority over the outcome.

The last step is the load-bearing one. It returns **nothing** rather than falling back to
the first calendar. Block ids are not globally unique — tenants seeded before ids were
namespaced carry identical ids _and_ labels on every calendar — and choosing between them by
array order renders a correct-_looking_ block picker over the wrong season's dates. That is
invisibly wrong, where an unanswered picker is visibly unanswered. The console renders the
refusal as a question naming each stage's block and its candidate calendars, because
"nothing" is only a safe answer if the operator can see it was asked.

The corollary is that the editor must never treat "no calendar selected" as "no blocks to
show": a stage's stored block stays visible and named in that state. Hiding it reproduces the
original defect — a scheduled stage rendering an empty picker, inviting an operator to
"fix" it by writing a blockId from a calendar the structure isn't bound to, which
`validateCompetitions` then rejects for the whole tenant.

### Storage: config for setup data, own items for operational data

| Entity                        | Location                                         | Reason                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `structures[]`, `calendars[]` | `TenantConfig`, beside `leagues[]`               | Low-cardinality setup data, a few KB. Operator-only, stripped from `PUT /tenant/config` exactly as `districts`/`knownClubs` are ([ADR 0006](0006-platform-operator-and-tenant-registry.md)).                                                           |
| `venues[]`                    | Own items — `pk TENANT#<t>`, `sk VENUE#<id>`     | Unbounded (a region has hundreds) and operational — availability windows change constantly. Follows the existing `EXPORT#` precedent in `keys.ts`. In the config item they would threaten the 400 KB ceiling _and_ widen the read-modify-write window. |
| `SeasonRun`                   | `pk TENANT#<t>#SEASONRUN#<id>`, gsi1 for listing | Mirrors the `Series` pattern, including `version` for optimistic concurrency.                                                                                                                                                                          |

Every new operator card follows `LeaguesCard`'s refetch-rebuild-PUT (`src/platform.tsx`), so a
stale operator tab cannot erase a concurrent tenant-admin edit.

### All date handling goes through dayjs, parsed strictly and anchored to UTC

`dayjs` (+ the `utc` and `customParseFormat` plugins) is a direct dependency of both the web
app and the API, and is the only way scheduling code touches dates. Three properties earn it:

- **Strict parsing rejects impossible dates.** `dayjs.utc(v, 'YYYY-MM-DD', true)` refuses
  `2026-02-31` and `13/09/2026`. Lenient parsing — including plain `new Date()` — rolls 31
  February into March and stores a fixture date nobody entered. This applies to the calendar
  engine and to every server-side date guard, i.e. every path that decides a real fixture
  date. The one deliberate exception is `legacyRoundDates`, the pre-calendar stepping kept so
  a series created before season calendars regenerates the dates it already has: it parses
  leniently, because tightening it would reject inputs the old path accepted and silently
  change existing series. It still throws on a genuinely unparseable start date rather than
  emitting `Invalid Date`.
- **UTC anchoring removes host-offset drift.** Every date-only string is parsed at UTC
  midnight and arithmetic is in whole days, so a fixture cannot slide by a day depending on
  where the code runs. The single deliberate local-time read is `todayIso()`, because "what
  day is it here" is exactly a wall-clock question.
- **Month names are stable across runtimes.** `Intl`/`toLocaleString` short months are
  ICU-version dependent — current ICU renders September as "Sept", older builds "Sep" — so
  the same summary string would differ between browser, Node and Lambda. dayjs formats from
  its own bundled locale. These strings are read against union documents that write "13 Sep".

Times are wall-clock `HH:MM` and are never converted; the region has no DST, so a timezone on
the calendar is display metadata, not a conversion input.

### Venue allocation is a separate pass over a tenant-wide booking ledger

Allocation consumes finished fixtures and assigns venue and slot. It does not shape fixtures,
so it is modelled and built separately from structure.

The one non-obvious correctness requirement: **allocation must run against a tenant-wide
booking ledger across all season runs**, not per series. Premier Men 50 Over and Premier Men
T20 compete for the same grounds on the same Saturday, and a team must not be scheduled twice
in one day across two competitions.

The algorithm is **greedy, most-constrained-first, with ordered scoring and a fallback chain**
(home ground → club secondary → nearest available neutral) — not constraint programming.
Constraint programming is the right tool for professional leagues with broadcast windows and
hundreds of teams; at roughly 600 fixtures per tenant it is over-engineering. Decisively, the
greedy pass is **explainable**: every fixture carries `venueStatus`
(`home | alternative | neutral | unresolved`) and a reason string an operator can argue with.
When the problem is over-constrained we emit `unresolved` with the reason rather than a
confident wrong placement.

Measured cost at that scale (600 fixtures, 40 grounds, 60 sides, distance ranking on):
**~95 ms** for `buildLedger` + `allocateVenues`. It scales with candidates rather than
outcomes — a tighter registry is faster, not slower, because each fixture has fewer grounds
to score. Comfortably inside a click-to-allocate action, but "milliseconds" would be
flattering it.

One data caveat is load-bearing: there is **no geocoder** in the platform —
`src/geocode.ts` only formats addresses and bounds-checks South Africa, and coordinates are
hand-pinned. `ground.secondaryVenue` has no `lat`/`lon` at all. Distance ranking over
half-missing coordinates produces confident garbage, so the venue registry surfaces geocode
coverage and the allocator falls back to home-preference-only below a threshold.

Two consequences of sharing the ledger with the rest of the platform are easy to get wrong:

- **A knockout placeholder is not a side.** `win:f1` is series-scoped — every bracket numbers
  from `f1` — so two competitions' finals both read `win:f1 v win:f2`. Booked into the team
  ledger they collide, and the second competition's final comes back `unresolved` over sides
  that don't exist yet. `isSlotRef` guards the ledger and both fairness reports.
  Those placeholders are also what a club reads on its fixture list, so they are labelled
  ("Winner of Semi-final 1") from the bracket **graph** — the final is the fixture nothing
  else references, the third-place playoff is the one pairing two `lose:` refs. Counting
  rounds does not work: the playoff is appended after the final, and a bye produces two
  consecutive single-fixture rounds (a 3-team knockout, an odd pool count).
- **A hand-placed fixture is whatever an admin can actually set.** The fixture editor writes
  `venueOverride` (a ground NAME, predating the registry), not `venueLocked` — so allocation
  honours both, matching an override back to the registry by name where it can so the ledger
  still knows that ground is taken. Honouring only the flag would have made "hand-picked
  venues are kept" a promise nothing in the app could satisfy.

### [ADR 0004](0004-thin-crud-client-side-compute.md) is re-affirmed, not amended

Generation and allocation stay client-side. At tens of clubs and a few hundred fixtures the
greedy allocator costs a fraction of a second (measured above), and the client already fetches
every series — which is exactly the tenant-wide view the booking ledger needs. Moving this
server-side would duplicate logic across the client/server boundary for no user-visible
benefit, which is the argument 0004 already made.

## Why

- **Stage pipeline over a structure enum.** An enum with a branch per union is a per-client
  code change — the thing [ADR 0002](0002-single-tenant-saas-vs-isolated-stacks.md) and
  [ADR 0006](0006-platform-operator-and-tenant-registry.md) have each already moved away from.
  Every one of the thirteen documented structures decomposes into the primitives above with no
  special cases, which is the evidence the decomposition is at the right altitude.
- **Series as the fixture unit, not a new one.** Fixture persistence, the approval gate,
  release, the player broadcast and travel cost are all working, tested code paths built around
  `Series`. Re-homing fixtures under a new entity would put all of them in scope for a change
  whose actual subject is _which teams play whom_.
- **Three resolvers over seven.** Architecture that describes capability it does not have is
  worse than architecture that admits the gap: it invites callers to depend on resolution that
  never happens, and it hides how much manual work remains. `DerivationNote` keeps the rule
  recorded — for prefill, display and audit — without claiming to execute it.
- **Calendar separated from structure.** The temporal defect affects every league, including
  the ones that need no stage model. Coupling the cheap fix to the expensive one would delay it
  for no reason.
- **Closed registries.** The alternative — JSONLogic, a rules engine, or a small DSL — buys
  marginal expressiveness over parameterised selection and costs a UI that cannot render it, a
  debugging surface nobody wants, and the anti-pattern by name.
- **Greedy allocation over CP.** Explainability beats optimality when the output is a schedule
  a club secretary will phone about.

## Consequences

- **The club portal must group series by `SeasonRun`.** Without it, one league season presents
  as three unrelated series cards. This is new display work created by the series-per-group
  choice, and it is the price of leaving the persistence path alone.
- **`generateRoundRobin` becomes engine-internal but must stay behaviour-identical.** Its
  existing tests, including create/regenerate parity, are the regression gate.
- **Stage transitions remain manual until results exist.** The platform's value here is correct
  generation, calendar correctness, venue allocation and auditability — not stage automation.
  Whether results should ever live here depends on the scoring-platform integration below.
- **Structure edits are versioned, so live seasons diverge from their template.** Operators
  will need to see which version a running season is on, and that a template edit did not
  reach it.
- **`TenantConfig` grows.** Structures and calendars are small, but the 400 KB item ceiling is
  now a documented constraint rather than a distant one. Venues were moved out for this reason.
- **Referrer guards multiply.** Deleting a structure, calendar or venue that a league or season
  run references must 409 and name the referrers — the pattern already used for districts and
  leagues.
- **Withdrawals and late entries need an explicit operation.** PlayHQ's model applies: choose
  the effective round, void the remainder, regenerate future rounds only. The existing
  `stripClubFromDraftSeries` (`packages/api/src/repo.ts`) covers only draft series, and
  released series must stay deliberately out of scope for silent mutation.
- **Scoring-platform export cannot be built.** The source document ranks it P0, but the target
  platform is unnamed and there is no API, auth model, or team-identity mapping. This is the
  highest-priority question to put back to the client; nothing else in this ADR is blocked on
  it.

## Alternatives considered

- **A `structure` enum on `League` with a branch per union.** Fastest to the current
  requirement and wrong at the second client; every new structure becomes a deploy.
- **A rules engine or DSL for stage transitions** (JSONLogic, a small expression language).
  Maximum expressiveness, and the textbook inner-platform effect. The twenty documented
  structures decompose cleanly into a closed set, so the generality would be paid for and
  unused.
- **A node-canvas structure editor.** League structures are strictly sequential with fan-out
  into groups; a canvas adds spatial-arrangement work without adding comprehension. A linear
  vertical stage list with progressive disclosure and a live preview fits the shape of the
  data.
- **Building results capture and a ladder now**, so stage transitions resolve automatically.
  A whole subsystem, and it likely duplicates the scoring platform that the same document says
  fixtures must export to. Deferred behind that integration decision.
- **Constraint programming for venue allocation.** Justified at professional-league scale and
  constraint density; here it trades explainability for optimality we do not need.
- **A new entity for fixtures under `SeasonRun`.** Cleaner on paper; puts every working
  release, broadcast and travel-cost path into scope for a change about team composition.
