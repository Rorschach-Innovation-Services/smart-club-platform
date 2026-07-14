/**
 * DynamoDB key builders — the single source of truth for the tenant-scoped
 * single-table layout. Every tenant-owned item is partitioned under
 * `TENANT#<t>#…`; this prefix IS the tenant-isolation boundary, so all reads and
 * writes must go through these helpers and never hand-build a key.
 *
 * See docs/architecture/data-model.md for the full access-pattern → key mapping.
 */

export type EntityType = 'CLUB' | 'SERIES' | 'USER' | 'CLEARANCE' | 'REGREVIEW';

const tenantPrefix = (tenant: string) => `TENANT#${tenant}`;

/** Tenant config item (branding, deadline, knownClubs, requiredDocs override). */
export const tenantConfigKey = (tenant: string) => ({
  pk: tenantPrefix(tenant),
  sk: 'CONFIG',
});

/**
 * gsi1 attributes that make a tenant CONFIG row enumerable platform-wide (the
 * operator portal's registry listing). Derived INSIDE createTenantConfig /
 * putTenantConfig from `config.tenant` — never supplied by callers — because
 * stripKeys removes gsi attrs on read and putTenantConfig whole-item-Puts, so a
 * read-modify-write would otherwise silently delist the tenant.
 */
export const tenantConfigGsi1 = (slug: string) => ({
  gsi1pk: 'PLATFORM#TENANTS',
  gsi1sk: slug,
});

/** gsi1pk used to enumerate every tenant CONFIG row (platform registry). */
export const tenantsListGsi1pk = () => 'PLATFORM#TENANTS';

/**
 * Player-register export audit item. Co-located with the tenant CONFIG row
 * (pk `TENANT#<t>`, distinct EXPORT# sk) so it is tenant-isolated and queryable by
 * `begins_with(sk,'EXPORT#')` without a gsi1 entry. It carries no player PII (just
 * actor + counts), but sits ABOVE the `tenantErasurePrefix` sweep (which only matches
 * `TENANT#<t>#…`), so tenant erasure must enumerate it explicitly (see listExportLogKeys).
 */
export const exportLogKey = (tenant: string, iso: string, id: string) => ({
  pk: tenantPrefix(tenant),
  sk: `EXPORT#${iso}#${id}`,
});

/** pk + sk-prefix to query a tenant's export history (and to enumerate for erasure). */
export const exportLogsListKey = (tenant: string) => ({
  pk: tenantPrefix(tenant),
  skPrefix: 'EXPORT#',
});

/** A single club. */
export const clubKey = (tenant: string, clubId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${clubId}`,
  sk: 'META',
});

/**
 * Idempotency marker for an admin "send invite" click. Lives in the club's item
 * collection (same pk as the club META, distinct sk) so it's tenant-isolated, but it
 * has no gsi1 entry, so it never surfaces in getClub/listClubs (sk='META' / gsi1).
 * Because the marker stores recipient contact in its results, tenant/cohort erasure
 * must enumerate it explicitly via `listClubInviteKeys` (a `begins_with(sk,'INVITE#')`
 * query) — the gsi1-based erase set would otherwise miss it. The `attribute_not_exists`
 * claim on this key is the server-side double-send guard.
 */
export const clubInviteKey = (tenant: string, clubId: string, idempotencyKey: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${clubId}`,
  sk: `INVITE#${idempotencyKey}`,
});

/** gsi1 attributes that make a club listable within its tenant. */
export const clubGsi1 = (tenant: string, name: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#CLUB`,
  gsi1sk: name,
});

/** gsi1pk used to query every club in a tenant. */
export const clubsListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#CLUB`;

/** A single series (fixtures embedded). */
export const seriesKey = (tenant: string, seriesId: string) => ({
  pk: `${tenantPrefix(tenant)}#SERIES#${seriesId}`,
  sk: 'META',
});

export const seriesGsi1 = (tenant: string, startDate: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#SERIES`,
  gsi1sk: startDate ?? '',
});

export const seriesListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#SERIES`;

/** A player registration, partitioned under its club; naturalKey gives dedup. */
export const playerKey = (tenant: string, clubId: string, naturalKey: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${clubId}`,
  sk: `PLAYER#${naturalKey}`,
});

/** pk + sk-prefix to query all registrations for a club. */
export const playersListKey = (tenant: string, clubId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${clubId}`,
  skPrefix: 'PLAYER#',
});

/**
 * Player clearance (inter-club transfer). Stored as two items:
 *  - canonical, under the SOURCE club, carries the gsi1 entry (admin-wide listing);
 *  - mirror, under the DESTINATION club, has NO gsi1 (so admin lists each once).
 * Keeping the clearance in each club's own partition means a rep only ever queries
 * their own pk — no tenant-wide scan/filter, no cross-club read.
 */
export const clearanceKey = (tenant: string, fromClubId: string, clearanceId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${fromClubId}`,
  sk: `CLEARANCE#${clearanceId}`,
});

export const inboundClearanceKey = (tenant: string, toClubId: string, clearanceId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${toClubId}`,
  sk: `INBOUND_CLEARANCE#${clearanceId}`,
});

/** pk + sk-prefix to query the clearances a club must action (it is the source). */
export const clearancesListKey = (tenant: string, fromClubId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${fromClubId}`,
  skPrefix: 'CLEARANCE#',
});

/** pk + sk-prefix to query the inbound clearances for a club (it is the destination). */
export const inboundClearancesListKey = (tenant: string, toClubId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${toClubId}`,
  skPrefix: 'INBOUND_CLEARANCE#',
});

/** gsi1 attributes that make the canonical clearance listable tenant-wide (admin). */
export const clearanceGsi1 = (tenant: string, requestedAt: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#CLEARANCE`,
  gsi1sk: requestedAt ?? '',
});

/** gsi1pk used to query every clearance in a tenant (admin console). */
export const clearancesListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#CLEARANCE`;

/**
 * A registration review (off-system alert or cross-club hold). ONE canonical item
 * under the DESTINATION club (the club that must action a hold), carrying the gsi1
 * entry so admins list every review cohort-wide in one query — same own-partition
 * read model as clearances, but without a mirror (a review has a single owner).
 * Like clearances/invites it has no META/gsi1-CLUB listing, so tenant/club erasure
 * must enumerate `REGREVIEW#` items explicitly (see listReviewsForClub).
 */
export const registrationReviewKey = (tenant: string, destClubId: string, id: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${destClubId}`,
  sk: `REGREVIEW#${id}`,
});

/** pk + sk-prefix to query a club's own registration reviews (it is the destination). */
export const registrationReviewsListKey = (tenant: string, destClubId: string) => ({
  pk: `${tenantPrefix(tenant)}#CLUB#${destClubId}`,
  skPrefix: 'REGREVIEW#',
});

/** gsi1 attributes that make a registration review listable tenant-wide (admin). */
export const registrationReviewGsi1 = (tenant: string, createdAt: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#REGREVIEW`,
  gsi1sk: createdAt ?? '',
});

/** gsi1pk used to query every registration review in a tenant (admin console). */
export const registrationReviewsListGsi1pk = (tenant: string) =>
  `${tenantPrefix(tenant)}#TYPE#REGREVIEW`;

/**
 * Registration-link token. GLOBAL (not tenant-prefixed) and self-describing:
 * the item carries { tenant, clubId } so the public /register route resolves the
 * tenant from the token, never from the request host.
 */
export const tokenKey = (token: string) => ({
  pk: `TOKEN#${token}`,
  sk: 'META',
});

/** A user profile (memberships live here — source of truth for PreTokenGen). */
export const userKey = (sub: string) => ({
  pk: `USER#${sub}`,
  sk: 'META',
});

/**
 * Per-membership marker item: one per (user, tenant) so a user with multiple
 * memberships is enumerable under EVERY tenant they belong to (a single GSI on
 * the META item could only index one tenant). Listed via gsi1 for offboarding.
 */
export const userTenantMarkerKey = (sub: string, tenant: string) => ({
  pk: `USER#${sub}`,
  sk: `TENANT#${tenant}`,
});

/** gsi1 attributes that make a user-tenant marker listable within a tenant. */
export const userGsi1 = (tenant: string, email: string) => ({
  gsi1pk: `${tenantPrefix(tenant)}#TYPE#USER`,
  gsi1sk: email,
});

export const usersListGsi1pk = (tenant: string) => `${tenantPrefix(tenant)}#TYPE#USER`;

/** Prefix used to erase an entire tenant's non-user items. */
export const tenantErasurePrefix = (tenant: string) => `${tenantPrefix(tenant)}#`;
