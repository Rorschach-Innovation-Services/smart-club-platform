# ADR 0020 — Match Centre connection console

## Status

Accepted — Phase 1 (visibility) implemented October 2026. Phases 2–4 planned; Phase 3 gated
(see Consequences).

## Context

Connecting a tenant's fixtures to the Match Centre (medicoach) has two halves. The 15-minute
sync (ADR 0016) keeps *already-mapped* fixtures in step; the sync contract has no way to create
a match. New fixtures reach medicoach only through a one-off "bundle carry": a developer-run
export CLI on our side and a suite of import scripts (human admin token, git-committed ID map)
on medicoach's side.

In October 2026 the EMCU season import put 620 fixtures into production as drafts; they were
released, and nothing appeared on Medicoach Live. The carry had never run. Every release-time
push was answered `unmapped` and dropped, and the only trace was a log line
(`newFixturesNotice`) no operator ever sees. Operators had no way to see the gap, and no way to
act on it without a developer.

The platform has ~5 operators, one developer, and a handful of carries ever performed. Any
design must make the gap *visible* immediately, make the standard carry operator-drivable
eventually, and must not replace medicoach's battle-tested import path with something riskier.

## Decision

An operator-portal **Match Centre connection console**, built in phases, each independently
shippable.

1. **Awaiting-carry is durable, reconciled data — never inferred from silence.** Fixtures
   medicoach lacks are recorded as `MCAWAIT#<seriesId>` rows, fed by two sources: the schedule
   write path (new refs, `unmapped` push answers) and a reconciliation that walks released,
   sync-mapped series and asks medicoach directly via two new read-only, HMAC-signed endpoints
   (`GET …/import/connection-summary`, `POST …/import/check-refs`, ≤500 refs per call; import
   contract v1, versioned separately from sync v1 — the sync wire format is untouched). The
   write path alone cannot see the EMCU shape (bulk import + release, then no edits), so
   "nothing awaiting" is only ever asserted from reconciliation ground truth.
2. **Reconciliation is serialised per tenant by a lease** (`MCRECONLOCK#`, conditional put,
   5-minute expiry on the table's TTL attribute, renewed per chunk, token-identified). The cron
   runs it at most daily per tenant (hourly retry after a failure); the console's "Check now"
   bypasses the cadence but not the lease (a concurrent run answers 409). All failure paths —
   dry run, 404, bad responses, timeouts, a lost lease — stamp `MCRECON#` unreachable and leave
   existing rows untouched.
3. **Split state ownership.** Smart club owns orchestration state (`MCAWAIT#`, `MCRECON#`,
   later `MCCONN#`/`MCCARRY#`) under `TENANT#<t>`; medicoach's external-ref table remains the
   only mapping truth. Derived status shown before a real carry record exists is labelled
   *inferred* in the UI. Carried/mapped counts are never stored authoritatively on our side.
4. **Operator surface:** a read-only Match Centre card on the client settings page, a per-client
   console at `/platform/tenants/:slug/medicoach` (awaiting-carry table, health, "Check now"),
   and an awaiting-carry badge on the client list (suppressed when the sync feature is off).
   An empty sync secret — previously a *silent* dry run — is surfaced as a prominent warning.
5. **Later phases.** Phase 2 moves the smart-club half of the carry (readiness checks, bundle
   build with preview/confirm, league-scoped edit freeze with a hard TTL) into the console;
   medicoach's half stays a runbook. Phase 3 (server-side medicoach import service, SQS worker)
   is **gated** on sustained carry cadence (~monthly) and, if built, must drive medicoach's
   existing admin API routes — never a direct-write port of `importer.mjs`, whose API-mediated
   side effects (validation, publish, page regeneration) a port would silently lose. Its write
   surface gets its own secret. Prerequisites: player-sync merge and dolphins dedup remediation.

### Alternatives rejected

- **One-click full automation** — the judgment steps (recipe authoring, host binding,
  player-match overrides, POPIA calls) are real; hiding them behind a button moves risk, not
  work.
- **Per-tenant sync keys now** — touches the live dolphins contract for little gain at this
  scale; revisit with Phase 3's write surface.
- **A generic background-job framework in smart club** — one bounded step machine and
  medicoach's existing queue pattern cover the need.
- **Write-path capture alone for awaiting-carry** — cannot detect the incident class that
  motivated the feature.

## Consequences

- EMCU-class gaps surface within one cron cycle (or one button press), attributed per series,
  on the page operators already use daily.
- Two read-only endpoints and a shared-contract section are added to the medicoach integration;
  the contract doc remains byte-identical and sha-pinned in both repos.
- Stale `MCAWAIT#` rows on a sync-off tenant persist (true, but unflagged on the list); the
  console explains them. Reconciliation cannot speak for drafts or unmapped leagues and leaves
  their rows as the write path recorded them.
- The reconcile POST runs synchronously behind the 30-second gateway limit; a very large tenant
  against a slow medicoach can see a 504 while the run completes (the lease prevents a double
  run). Accepted for Phase 1.
- Until a real carry writes `MCCONN#`, the console's stage is heuristic and labelled inferred.
- The developer stays in the carry loop until Phase 2 (smart-club half) and the gated Phase 3
  (medicoach half) land.
