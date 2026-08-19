# ADR 0010 — Self-serve client onboarding suite (operator portal)

**Status:** Accepted (August 2026).

## Context

Titans was onboarded with three engineer-only CLIs (a catalogue script, a
compliance/structure import, a roster import) plus one operator wizard (bulk document
intake, ADR 0009). Every following client repeated that same CLI-and-a-Slack-thread
process — an engineer's time on the critical path of every new client, and no way for
an operator to onboard one alone.

This suite productizes the remaining engineer-only steps — league structure/teams,
player rosters, rep invites — as operator-console wizards, following the doc-intake
wizard's proven shape: parse server-side, review in a table, commit in reviewable
batches. Per-client variance (different workbook layouts, different age-band spellings,
different committee-doc formats) is absorbed by **review tables and interactive
mapping**, never by per-client config files or code — the same choice ADR 0009 made for
the doc catalogue itself.

Hard constraints that shaped the design: all workbook parsing must be server-side (the
SPA cannot import `packages/api`, and the uploads bucket has no CORS for a
browser-side read); roster and committee data is PII and must never round-trip through
the browser as a file; `exceljs` is already a `packages/api` dependency, not a frontend
one; operators hold no invite capability today (`/admin/*` resolves its tenant from the
`Host` header in production, so a cross-tenant operator console needs its own
slug-addressed routes).

## Decision

### 1. Doc roles, not literal keys

The wizards cannot gate on the literal doc keys `memberDatabase`/`committee` — those
exist on Titans only because the engineer catalogue script wrote them; a self-serve
tenant's operator-authored catalogue slugifies free-text names ("Member Database" →
`member-database`) and can never reproduce a hardcoded literal. `RequiredDoc` (ADR 0009)
gains an optional `role?: 'memberDatabase' | 'committee'`; `docKeyForRole(requiredDocs,
role)` in `catalogue.ts` resolves the active doc that carries a role, and
`validateRequiredDocs` enforces at most one active doc per role. Every route that reads
a structural document — roster-intake parse, committee-extract — resolves through this
role and 409s with actionable guidance ("No document in the catalogue is marked as the
member database — assign the role in Required documents.") when it's unassigned, rather
than silently finding nothing. The onboarding checklist (frontend) enforces the same
rule ahead of the API: the roster and reps steps show as blocked, with the same
guidance, until both roles are assigned.

### 2. Server-side parsing, tenant-neutral modules

`roster-parse.ts`, `structure-parse.ts`, `team-plan.ts` and `committee-parse.ts` are new
`packages/api` modules with no Titans-specific knowledge — `parseRosterSheet`,
`parseStructureWorkbookAllSheets`, `deriveTeamPlanCounts`, and the committee field-set
matcher all take their tenant's own leagues/keys as parameters rather than assuming a
fixed manifest. The Titans CLIs (`import-titans-roster.ts`, `titans-import-map.ts`)
import these same modules instead of duplicating parsing logic — the CLI keeps only its
Titans-specific shell (file walking, `SECTION_LEAGUE_MAP`, `REGISTERED_BY`, revert). One
implementation, two callers; `import-titans.test.ts` staying green through the
extraction is the regression gate that proves the CLI survived the refactor.

The structure parser's hardest constraint: today, distinguishing a real section header
from a sub-header (Titans' "50 - OVERS | VENUE" row under a SENIORS section) relies
entirely on the Titans `SECTION_LEAGUE_MAP` — the two are indistinguishable by shape
alone. The tenant-neutral parser can't have a manifest, so it uses a **manifest-free
rule** instead: every header-shaped row is provisionally a section, but a header whose
section collects zero data rows never displaces the live column-state — data rows after
a barren sub-header keep attaching to the enclosing section. A sub-header that _does_
collect real rows surfaces to the operator as its own section, handled by the sections
screen's Ignore action rather than silently merged. Pinned by a fixture test that runs
an overs sub-header through the manifest-free path — `import-titans.test.ts` cannot
catch this class of bug, since the CLI path still has its manifest.

A local-file read seam (`readUploadObject`, mirroring the existing `local/` sentinel +
`LOCAL_UPLOADS_DIR` convention) lets the roster and committee-extract routes read a
club's stored document — from S3 in production, from disk in offline tests — without
ever asking the browser to re-upload a file that document intake already stored.

### 3. Review-tables-over-config: the variance model

Every source of per-client variance is resolved by a human looking at a table, not by
writing per-tenant configuration:

- **Age-band spelling** ("U/10" vs "u9" vs "Colts") is confirmed in the roster wizard's
  junior confirm table, built from `ageGroupRaws` (every distinct raw band string paired
  with its mapped league key, or `null` if unmapped). A junior row whose band maps to
  nothing is an **exception** (`unmapped-age-group`), never silently committed
  team-less — the one behavior gap the old CLI's `ageGroupToLeagueKey` (hardcoded to
  u9–u15) would have hit on any client with different band names.
- **Workbook section → league** mapping is an operator choice on the structure wizard's
  sections screen, with heuristic suggestions as prefill only (a gold "Check" pill until
  confirmed) — never applied unconfirmed.
- **Club matching** (workbook row → club record) runs client-side via the existing
  `matchClub` confidence scorer, with an "unmatched → create the club" escape hatch
  through the shared `CreateClubModal`.
- **Committee-extract confidence** (high for a chair, medium for vice/deputy, low for
  any other officer with an email) is a hint, never an oracle — every candidate still
  passes through the same review-and-confirm invite modal a manual entry would.

None of this becomes tenant config. A client that never needs the escape hatches looks
identical to one that uses all of them; the review tables are how the suite absorbs a
client whose workbook doesn't match anyone else's.

### 4. Provenance is the revert contract — there is no portal undo

The user's explicit choice: **no in-portal undo**. Commits are preview-then-write,
idempotent (re-running a commit never double-writes — a
`ConditionalCheckFailedException` on `createPlayer` reports `alreadyPresent`, and
structure commits are keyed by clubId with an explicit `overwrite` flag), and
provenance-stamped so a revert stays an engineer operation, exactly like reverting a
Titans import today.

- Roster commits stamp `registeredBy = "intake:roster:<slug>:<yyyymmdd>:<operatorEmail>"`
  on every created player, echoed back as the response's `batchId`.
- Structure commits append a club note reading
  `"intake:structure:<slug>:<yyyymmdd>:<operatorEmail> — team plan applied|overwritten"`
  via `repo.appendClubNote` (best-effort — a note-append failure never fails the commit).
  This is deliberately a club note, not a `commLog` field in the patch body:
  `applyClubPatch`/`updateClub` does a shallow merge, so writing `commLog` in the same
  patch as the team plan would _replace_ the club's whole comm log instead of appending
  to it. `appendClubNote` is the same proven path the original Titans import already
  used for exactly this reason.

Both prefixes are disjoint from the Titans CLI's own `import:titans-*` provenance and
are prefix-greppable — `--revert intake:roster:<slug>:<date>` is the natural shape for
a future CLI revert mode (out of scope here; recorded as the natural next step). Until
that CLI mode exists, "undo an operator commit" is an engineer running the same class of
manual fix a bad Titans import already required.

### 5. Full ID numbers in the parse response — the POPIA decision

Roster-intake parse returns unmasked `idNumber` values (server-side masking still
applies to _exception_ rows, whose bad IDs are never committed). The bulk delta this
decision accepts is real: a parse response can carry a whole club's — potentially a
whole tenant's, one club at a time — worth of minors' ID numbers in one payload, not
the single-record access a chair or admin already has.

Reasoning accepted despite that:

1. Operators already hold explicit tenant-admin on every tenant they operate (the POPIA
   widening documented for the operator-auto-admin change) — this suite exposes no new
   _class_ of access, only a new _shape_ of it (bulk vs. one-record-at-a-time).
2. Commit needs the real ID number anyway, to rebuild the natural key
   (`playerNaturalKey`) server-side — a masked-plus-reveal-token design would need
   server-side draft storage to let the commit call resolve a token back to a real ID,
   for a reduction in actual access that a widened-access operator doesn't need.
3. Mitigations that don't require draft storage are applied regardless: every parse and
   committee-extract response carries `Cache-Control: no-store`; the UI masks IDs by
   default with an explicit per-row reveal; invalid IDs are masked even in the response
   (they're exceptions, never committed).

**Documented fallback**, to slot in without a route-shape change if a future POPIA
review overturns this: short-lived DynamoDB draft items keyed by a batch token, with the
parse response carrying masked IDs plus a token and the commit body accepting the token
instead of raw IDs. The response and request shapes were kept flat enough (`items:
[...]`, one `idNumber` field per row) that swapping the field for a token is additive,
not a breaking reshape.

### 6. Immediate club creation is not draft-able

Leagues created inline during the structure wizard are drafts (`newLeagues`) until
commit — nothing writes tenant config mid-wizard. Clubs are different: there is no
operator club-delete route, so a club created via `CreateClubModal` mid-wizard is
**permanent** the moment it's created, even if the rest of the wizard session is
abandoned. Accepted for v1 — `CreateClubModal`'s copy says so explicitly ("This creates
the club immediately") — with operator deletion of empty shell clubs recorded as a
follow-up rather than blocking this release on it.

### 7. Committee-extract degrades to manual, by design

The committee-doc extractor is the most speculative parser in the suite — it's reading
free-form exco tables in whatever shape a club's secretary produced them, scored by
regex (`/chair/i` vs `/vice|deputy/i` vs "any officer with an email"). Rather than treat
a low-confidence or failed extraction as an error, the reps page treats "view the
document, type what you read" as a **first-class equal path**, not a degraded one — a
PDF or scanned committee doc opens the same invite modal with a "View document" link
(the platform doc view-url twin of the tenant route) beside a blank manual form. If the
extractor's real-world hit rate turns out too low to be worth keeping, this is the
sanctioned first thing to cut; the manual path already carries the feature on its own.

### 8. Leagues are append-only inside the structure commit, with a fixture-reference guard

Structure-intake commit orders itself deliberately: **leagues append first,
fail-fast-whole-request** (a duplicate league key 409s before any club write happens),
then each club's plan validates and commits independently against the post-append
league set. Appending leagues inside the same commit — rather than requiring a separate
`PUT /tenant/config` first — is a coupled write, but the alternative (a second round
trip an operator has to remember to do first) is worse UX for no safety gain, since the
append is itself fail-fast and blocks everything after it.

`overwrite: true` on a club that already has a team plan regenerates every `tm_<clubId>_
<key>_<n>` team id — and a live season's fixtures may reference the old ones. Since
`validateClubPatch` has no referrer guard on `teamRosters`, the commit route checks the
tenant's fixture/series data for references to the club's _current_ team ids before
applying an overwrite, and 409s ("teams are referenced by existing fixtures") instead of
dangling them. Harmless during onboarding, where no fixtures exist yet; protective on a
mature tenant like Titans running this wizard for a structure correction after a season
has already started.

## Consequences

- Two new tenant-neutral parsing modules (`roster-parse.ts`, `structure-parse.ts`) plus
  `team-plan.ts` and `committee-parse.ts` are now shared surface area between the
  operator routes and the Titans CLIs — a bug fixed in one is fixed in both, but a
  behavior change to either needs both call sites checked.
- `RequiredDoc.role` is additive (no schema break); the Titans catalogue needs one
  operator PUT (or a script bump) to backfill the roles onto its existing
  member-database/committee entries before the roster/reps wizards work on it.
- No portal undo exists yet. The `intake:roster:*` / `intake:structure:*` provenance
  prefixes are the contract a future CLI revert mode reads — building that mode is
  recorded as a follow-up, not shipped here.
- Full ID numbers ride in the parse response; the no-store + mask-by-default mitigations
  are the accepted posture pending any POPIA-review reversal, at which point the
  documented draft-token fallback slots into the same route shapes without a breaking
  change to callers.
- A club created mid-structure-wizard cannot be deleted through the operator console —
  an abandoned session can leave shell clubs behind. Operator club-delete is a follow-up.
- The committee extractor is accepted as speculative; its manual fallback path is not an
  afterthought but is exercised by every unparseable-document case, so cutting the
  extractor later is a subtraction, not a redesign.
