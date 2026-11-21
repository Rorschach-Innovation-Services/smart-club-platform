# ADR 0024 — Public web address separate from the tenant slug

**Status:** Proposed (November 2026). API and SPA built on `feat/public-address`, not yet
deployed. Contract: `docs/api/tenant.md` (address route and resolution).

## Context

Clients rebrand. `westernprovincecricket` is now "Cobras", but its web address is still
`westernprovincecricket.club.medicoach.co.za` and the operator console shows the old slug.
Name, title, logo and colours were already editable; the address was not.

The slug cannot be edited in place. It is the tenant's only ID and is embedded in every
DynamoDB key (`TENANT#<slug>…`, roughly 45–50 row families), S3 object keys, user memberships
(and so JWTs), signed link tokens, signed certificates and every Medicoach external ref
(`smartclub:<slug>:…`). Renaming it would be a migration of the whole tenant.

The owner's decisions (21 November 2026):

- Keep the slug as a fixed internal ID. Add an operator-editable **public address label**
  (`cobras` → `cobras.club.medicoach.co.za`).
- When the address changes, the **old address is retired**: it stops resolving and shows
  "This club isn't available". Retired labels are never reissued to another client.

No data migration (a tenant with no address record behaves exactly as before: label = slug)
and no infra change (`*.club.medicoach.co.za` is already wildcard-served in prod).

## Decision

### Two item families, never on CONFIG

`putTenantConfig` is an unconditional whole-item Put, used read-spread-write by the API and
about 15 CLIs. A field on the CONFIG row would be wiped by any stale write, reviving the retired
address. So the address lives in its own items (keys in `src/keys.ts`, see `data-model.md`):

- **Tenant address record** — pk `TENANT#<slug>`, sk `PUBLICADDR`:
  `{ publicSlug, history, updatedAt }`. `history` lists the labels the tenant has retired,
  oldest first, never the current one. Absent = the tenant is on its own slug.
- **Label record** — pk `PUBLICADDR#<label>`, sk `PUBLICADDR`:
  `{ label, tenant, status: 'active' | 'retired', claimedAt, retiredAt? }`, one per label ever
  claimed or retired. The first move off the slug writes a retired record for the slug itself.
  Retired records are permanent tombstones.

### Changing the address

`repo.setTenantPublicSlug(tenant, next, expectedCurrent)` reads the address record, refuses a
stale `expectedCurrent` and a no-op (`next === current`) before writing, then runs one
`TransactWriteItems`:

0. claim `PUBLICADDR#<next>`: absent, or already this tenant's (reclaiming an own old label);
1. ConditionCheck that no `TENANT#<next>` CONFIG row exists (another client's internal ID),
   skipped when `next` is the tenant's own slug;
2. put the address record, conditional on it still holding `expectedCurrent`;
3. retire `PUBLICADDR#<current>` (creating the tombstone when `current` is the slug).

The no-op check is what keeps every item distinct (DynamoDB refuses two operations on one
item in a transaction): 0 and 3 differ because `next ≠ current`, 1 and 2 have different sort
keys, and 1 is dropped in the own-slug reclaim. `CancellationReasons` map to a typed
`PublicAddressConflictError` (`label-active`, `label-retired`, `label-is-tenant`, `stale`,
`unchanged`). A failed condition wins over a race: the claim, then the CONFIG check, then the
address record. A `TransactionConflict` on any item (another operator changing the same
client's address, or a tenant create checking the same label, at the same moment) writes
nothing and maps to `stale` (409, "reload and try again"). A failed retire is an integrity
fault (the tombstone belongs to another tenant) and surfaces as a 500. dynalite has no
`TransactWriteItems`, so the offline path reads and then writes in sequence, throwing the same
errors.

`repo.createTenantConfig` became a transaction too: the CONFIG Put plus a ConditionCheck that
no `PUBLICADDR#<slug>` record exists. That blocks a new client taking a label in use or retired,
and reusing an erased renamed tenant's slug. It still throws an error named
`ConditionalCheckFailedException` (a `TenantSlugUnavailableError` with a `reason`), the name
its callers in `index.ts` and `seed-core.ts` already match, with `exists` taking precedence
over `address-in-use`. When neither condition failed but an item hit `TransactionConflict` (a
concurrent create of the same slug, or an address change claiming it), it throws
`TenantCreateConflictError` instead; `POST /platform/tenants` answers 409 "try again". That
error is deliberately not named `ConditionalCheckFailedException`, so `seed-core` never reads a
race as "already exists".

The operator route is `PUT /platform/tenants/:slug/address` (`{ publicSlug, expectedCurrent }`,
validated with `validateTenantSlug`). It is refused (409) for a tenant with a vanity host in
`WEB_ORIGIN_MAP`, whose address is set in `infra/tenants.ts`. It is audited (ADR 0023) as
`tenant.address.update` with the old and new label.

### Resolving a label

One rule for every label a client presents (Host, Origin, the dev `x-tenant` header, the
`GET /tenant?tenant=` fallback), in `src/public-address.ts`:

1. a `PUBLICADDR#<label>` record exists: `active` → its tenant; `retired` → unknown;
2. else a `TENANT#<label>` CONFIG row exists → that tenant;
3. else unknown.

`resolveTenant` is async and returns `{ tenant }`, `{ unknownLabel }` or `null` (nothing
presented). `GET /tenant` answers 404 for an unknown label (the SPA shows `UnknownClub`) and 400
only when nothing was presented; `requireTenantMembership` answers 404 for an unknown label.
`HOST_TENANT_MAP` (vanity hosts) stays static and skips the lookup.

`resolvePublicLabel` does two parallel GetItems and caches **hits only** (60 s TTL, bounded).
Misses are never cached: the key is caller-supplied, so caching misses would let anyone fill the
cache. A DynamoDB error is never cached and fails closed (500). The address-change, tenant-create
and tenant-erase paths clear this container's cache.

### Outbound links

`canonicalWebOrigin(slug, publicLabel)` and `originAllowedForTenant(origin, slug, publicLabel)`
take the label as a **required** argument, so the compiler finds every caller; an optional one
would let a missed caller keep emitting the retired address. `tenantWebOrigin(tenant)` looks the
label up for the common case. A vanity `WEB_ORIGIN_MAP[slug]` entry still wins. The retired
origin is no longer one of the tenant's allowed link origins.

### Erasure

`eraseTenantData` reads the address record first, retires every label in it (never deletes a
label record), and only then deletes the address record with the rest of the tenant. Retiring is
idempotent, so a retry after a partial erase finds the address record again and re-retires.

## Consequences

Accepted by the owner, and stated in the operator's confirm dialog:

- Everyone signs in again on the new address: sessions and local drafts are per-origin.
- Links already sent to the old address stop working. This includes the widely shared
  player-registration and club-signup links, which the SPA builds from the page's own origin,
  plus invites and clearance notices.
- Unaffected: captain's-report, squad, doc-request and certificate `/verify` links (they live on
  `platform.club.medicoach.co.za` and carry the internal ID), the Medicoach sync, and S3.

Also:

- **Cache limit.** Other warm Lambda containers keep honouring the old label, and may build
  links to it, for up to 60 seconds after a change. Only the container that served the change
  clears its cache at once.
- Each request presenting a label costs up to two GetItems on a cache miss; hits are free for
  60 seconds.
- A tenant that was never renamed has no label records, so erasing it does not tombstone its
  slug: the slug can be created again after an erase, as before. Once a tenant has moved off its
  slug, the slug is tombstoned and is never reusable.
- Tests and fixtures: a label now resolves only to a tenant with a CONFIG row or an active label
  record, so integration suites that call the API under `x-tenant` seed a minimal CONFIG row
  (`minimalTenantConfig` in `test/dynalite-harness.ts`).

### Not covered

- The local stack and the test harness never run a real `TransactWriteItems` (dynalite takes
  the sequential fallback). `test/public-address-tx.test.ts` pins the cancellation-code mapping
  of both transactions with the DynamoDB client stubbed, but the transactional branch still
  needs a scripted pass on the deployed dev stage before the first prod rename: claim, change,
  own-reclaim, each collision, duplicate create.
- Whether the Medicoach repo builds any link to `<slug>.club.medicoach.co.za` from the
  `smartclub:<slug>` ref cannot be checked from this repo; confirm before the first prod rename.
- The UnknownClub screen does not name or link the new address, by design (retire, not redirect).
