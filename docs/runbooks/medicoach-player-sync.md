# Medicoach player sync — enabling, backfill, reviews (ADR 0018)

Registrations on smart club reach medicoach team rosters on the 15-minute sync
([ADR 0018](../architecture/0018-medicoach-player-sync.md)). This runbook is the addendum to
[medicoach-migration-cutover.md](medicoach-migration-cutover.md): do it per tenant, after that
tenant's bundle import.

All commands run under `sst shell` for the stage (`--stage dev` first, then prod). Output is
counts only; nothing here prints names, ID numbers or refs.

## 0. Deploy order

1. **Medicoach first**: its `POST /integrations/smartclub/players` route must be live before
   any smart-club tenant has `playerSync` on.
2. Then smart club (`sst deploy`).

If smart club flushes against a medicoach without the route (HTTP 404), the player rows count
attempts and show as **stuck** on the admin page — nothing is lost. Once medicoach is deployed,
recover with the admin page's "Retry now" in the Players panel, or:

```
POST /integrations/medicoach/players/retry   {"scope":"stuck"}
```

(The fixture outbox's `POST /integrations/medicoach/outbox/retry` is the same recovery for
schedule rows; it takes one fixture `ref`.)

## 1. Precondition: the tenant's teams are in medicoach

Teams reach medicoach **only** through the bundle (`export-medicoach --confirm` + the medicoach
import). A player whose team medicoach lacks is parked. Before enabling:

- the tenant's last `export-medicoach` ran with `--confirm` (it records the EXPORT# entry the
  coverage probe reads) and was imported;
- any club or league added since has had a bundle top-up.

## 2. Audit duplicates first (read-only)

```
npm --prefix packages/api run audit-player-duplicates -- --tenant <t>
```

Lists groups with the same name + date of birth under different IDs (names masked). Each group
would be held for review by the sync. Fix wrong IDs on smart club first. On the medicoach side,
run its `match-players.mjs` against a fresh bundle and the duplicate-player remediation checks.

## 3. Enable

Operator: `PUT /platform/tenants/<t>` with

```json
{ "integrations": { "medicoach": { "playerSync": true } } }
```

(`features.medicoachSync` must already be on; a `goLiveDate`-only save keeps `playerSync`.)
The response's `warnings` carry the team-coverage probe: no export recorded, teams in leagues
the last export did not cover, or club squad teams that may not exist. Resolve them (bundle
top-up) before the backfill, or expect parked players.

## 4. Backfill

Dry run — counts by intent, and (with the sync secrets set) medicoach's predicted outcome per
player plus which fields an `updated` would change (`dryRun: true`, medicoach writes nothing):

```
npm --prefix packages/api run enqueue-players -- --tenant <t>
```

Go-live gate: `created` is plausible (mostly players registered since the migration), `linked`
/`unchanged` dominate for bundled players, and there is no surprise spike of `updated` field
diffs (that would overwrite corrections made in medicoach since the migration). Then:

```
npm --prefix packages/api run enqueue-players -- --tenant <t> --confirm
```

The cron sends about 500 people per run; watch the Players panel drain.

**Re-run `enqueue-players --confirm` after any import CLI that writes players** (roster or
compliance imports, the clearance backfills): the repo functions enqueue automatically, but a
CLI writing raw DynamoDB items does not.

## 5. Resolving held players (admin page → Medicoach sync → Players)

- **medicoach found a possible match** — "Link to this player" binds the registration to that
  medicoach player; "None of these — create new" creates one (medicoach refuses if a new exact
  match appeared since, and the player comes back for review).
- **Same name and date of birth under another ID here** — if they are different people, "They
  are different people" (never flagged again for that pair; both are sent). If it is one person,
  fix the ID on smart club first, then "Dismiss".
- **Waiting for a team** — ask the operator for a bundle top-up, then "Retry waiting players".
- Reviews expire after 60 days; the player is re-evaluated on their next change.

### Reviews with `out-of-tenant-identity-conflict` and no candidates

medicoach could not create the player because an identity claim **outside this tenant** (same
name/email claim held by a player smart club may not see) blocks it, and it never links across
tenants. The review shows medicoach's message and only **Dismiss** — link and create are not
offered. Dismiss it on smart club, then ask the medicoach team to resolve the claim by hand on
their side (merge, or release the claim). Once fixed, the player's next change (or
`enqueue-players --confirm`) sends them again.

## 6. Erasure

`DELETE /admin/players/:nk` (POPIA) queues an `erase`: medicoach anonymises the player and drops
the ref; match statistics stay on the anonymised record (ADR 0018, lawful basis). Club deletion
never erases: people are re-sent with fewer teams, or removed from their teams.
