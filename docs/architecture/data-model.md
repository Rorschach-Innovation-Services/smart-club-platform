# Data model — DynamoDB single-table design

All persistent state lives in one DynamoDB table in `af-south-1`. Items are partitioned by
tenant: every tenant-owned entity has a partition key prefixed `TENANT#<t>#`, which is the
backbone of tenant isolation. One global secondary index (`gsi1`) serves the list and
by-tenant lookups.

## Why single-table

The domain is small and id-keyed: a union has tens of clubs, a handful of series, and a few
hundred fixtures. The access patterns are known and narrow (get/list a tenant's clubs and
series; look up a registration token; read a user). At this scale, one table with a clear
key convention is simpler to operate than several tables with cross-table joins, and it makes
tenant-prefix erasure straightforward. See [ADR 0001](0001-aws-native-dynamodb.md) and
[ADR 0004](0004-thin-crud-client-side-compute.md).

## Keys

| Entity                | pk                         | sk                       | gsi1pk / gsi1sk                               | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------- | ------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant config         | `TENANT#<t>`               | `CONFIG`                 | —                                             | Branding, colors, copy, `submissionDeadline`, `knownClubs`, `requiredDocs` override. Written with `attribute_not_exists(pk)` to guard against slug collisions.                                                                                                                                                                                                             |
| Club                  | `TENANT#<t>#CLUB#<id>`     | `META`                   | `TENANT#<t>#TYPE#CLUB` / `<name>`             | Embeds `exco`, `coaches`, `ground` (incl. `lat`/`lon`), `docs`, `cqi`, `cqiAnswers`, `version`, `changedBy`/`changedAt`, and a denormalized `playerCount` (bumped atomically on each registration). Listed per tenant via gsi1.                                                                                                                                            |
| Series                | `TENANT#<t>#SERIES#<id>`   | `META`                   | `TENANT#<t>#TYPE#SERIES` / `<startDate>`      | Embeds config + `fixtures[]` + `version`.                                                                                                                                                                                                                                                                                                                                  |
| Player registration   | `TENANT#<t>#CLUB#<id>`     | `PLAYER#<naturalKey>`    | —                                             | Queried by club pk; count drives `club.players` (denormalized onto the club as `playerCount`). `<naturalKey>` (e.g. ID/cell) gives dedup. The portal + public registration paths share one `naturalKey` so a person can't be registered twice.                                                                                                                             |
| Clearance (canonical) | `TENANT#<t>#CLUB#<fromId>` | `CLEARANCE#<id>`         | `TENANT#<t>#TYPE#CLEARANCE` / `<requestedAt>` | Inter-club transfer, stored under the **source** club (the one that must action it). **Carries the only gsi1 entry** so the admin lists every request once. `version` for OCC. The destination initiates; the source confirms fees/misconduct in 14 days, then the player atomically moves.                                                                                |
| Clearance (mirror)    | `TENANT#<t>#CLUB#<toId>`   | `INBOUND_CLEARANCE#<id>` | **none**                                      | A pointer under the **destination** club so its "moving to your club" view reads its own pk — never a tenant-wide scan. **Must NOT carry a gsi1** or the admin list double-counts. Kept in sync with the canonical inside the same transaction.                                                                                                                            |
| Reg-link token        | `TOKEN#<token>`            | `META`                   | —                                             | **Global** (not tenant-prefixed): maps token → `{ tenant, clubId }`. The token self-describes its tenant so the public `/register` route never trusts the host for authorization. Deleted on regeneration so old links stop working.                                                                                                                                       |
| Club-signup token     | `TOKEN#<token>`            | `META`                   | —                                             | Same keyspace, discriminated by `kind: "club-signup"` and **no `clubId`** (each route checks the discriminator, so the two link types can't be swapped). Carries the hourly rate-cap window (`signupWindowStart`, `signupCount`). Pointed to by `TenantConfig.clubSignupLink`, so — unlike reg-link tokens — it **is** tenant-enumerable and is revoked by tenant erasure. |
| User profile          | `USER#<sub>`               | `META`                   | —                                             | `memberships: [{ tenantId, role, clubIds[] }]` (source of truth for PreTokenGen), `onboardingSeen`. No gsi1 — the markers below index it.                                                                                                                                                                                                                                  |
| User-tenant marker    | `USER#<sub>`               | `TENANT#<t>`             | `TENANT#<t>#TYPE#USER` / `<email>`            | One per (user, tenant), so a multi-union user is enumerable under **every** tenant. Carries `sub`/`email`/`role`. gsi1 lists a tenant's users for offboarding/erasure.                                                                                                                                                                                                     |

`<t>` is the tenant slug (e.g. `dolphins`, `lions`). Timestamps are UTC ISO-8601.

## Access patterns → keys

| #   | Access pattern                                      | Operation                                                                                                                                         |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Get tenant branding/config                          | `GetItem pk=TENANT#<t>, sk=CONFIG`                                                                                                                |
| 2   | List all clubs in a tenant (admin dashboard)        | `Query gsi1 where gsi1pk=TENANT#<t>#TYPE#CLUB`                                                                                                    |
| 3   | Get one club                                        | `GetItem pk=TENANT#<t>#CLUB#<id>, sk=META`                                                                                                        |
| 4   | Update a club (affiliation, CQI, exco, docs)        | `UpdateItem … ConditionExpression version = :v`                                                                                                   |
| 5   | List/get series                                     | `Query gsi1 gsi1pk=TENANT#<t>#TYPE#SERIES` / `GetItem`                                                                                            |
| 6   | Update/release a series (fixtures embedded)         | `UpdateItem … ConditionExpression version = :v`                                                                                                   |
| 7   | List a club's player registrations                  | `Query pk=TENANT#<t>#CLUB#<id>, sk begins_with PLAYER#`                                                                                           |
| 8   | Resolve a registration token → tenant + club        | `GetItem pk=TOKEN#<token>, sk=META`                                                                                                               |
| 9   | Read a user's memberships (PreTokenGen + /me)       | `GetItem pk=USER#<sub>, sk=META`                                                                                                                  |
| 10  | List a tenant's users (offboarding)                 | `Query gsi1 gsi1pk=TENANT#<t>#TYPE#USER` (marker items)                                                                                           |
| 11  | Clearances a club must action (it is the source)    | `Query pk=TENANT#<t>#CLUB#<id>, sk begins_with CLEARANCE#`                                                                                        |
| 12  | Clearances moving to a club (it is the destination) | `Query pk=TENANT#<t>#CLUB#<id>, sk begins_with INBOUND_CLEARANCE#`                                                                                |
| 13  | List every clearance in a tenant (admin console)    | `Query gsi1 gsi1pk=TENANT#<t>#TYPE#CLEARANCE` (canonical items only)                                                                              |
| 14  | Issue/override a clearance (atomic player move)     | `TransactWriteItems`: dest player put `attribute_not_exists` + source delete + ±1 `playerCount` ×2 + canonical (OCC `version=:v`) + mirror status |
| 15  | Erase a tenant                                      | Patterns 2/5/7/10/11/12 + the config item — query each partition, then batch-delete (+ S3 ID-doc/doc objects)                                     |

No pattern requires a `Scan` — erasure (pattern 15) enumerates each known partition/index and
batch-deletes rather than scanning the whole table. Listing is bounded by one tenant's cohort,
assumed to stay "fetch-all is cheap" (tens of clubs); revisit with pagination only if a union
grows into the thousands. The admin dashboard's player counts come from the denormalized
`playerCount` on each club (no per-club COUNT query).

## Concurrency & integrity

- **Optimistic concurrency:** every club/series carries a `version` integer. Mutations use a
  `ConditionExpression` on the expected version and bump it; a mismatch returns HTTP 409 and
  the client refetches. This prevents silent last-write-wins when two admins (or one in two
  tabs) edit overlapping fields or regenerate fixtures.
- **Audit:** `changedBy`/`changedAt` on the club record track affiliation changes; a
  self-registered club additionally records `onboardedVia: "self-signup"` and
  `signupConsentAt` (compliance requirement).
- **Server validation (enforced):** club-name **and slug** uniqueness per tenant (the public
  signup route checks both, and the conditional create catches the concurrent race), league
  keys valid against the frozen catalogue (`catalogue.ts`), representation percentages summing
  to 100, and a doc size/PDF check on the mark-uploaded step. (The presigned PUT signs the PDF
  content-type; a hard pre-upload size cap would need a presigned POST policy — a follow-up.)

## Embedding fixtures

Fixtures live inside the series item (they are already a nested array in the prototype).
A round-robin of N teams is N·(N−1)/2 fixtures — 8 teams = 28, a 20-team league ≈ 190 — well
under the 400 KB item limit. Seed and regeneration paths sanity-check item size for very large
leagues.
