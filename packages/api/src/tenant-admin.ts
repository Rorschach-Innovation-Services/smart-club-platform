/**
 * Grant a user the admin role for a tenant — the shared core of the
 * bootstrap-admin CLI and POST /platform/tenants/:slug/admins. Creates (or
 * reuses) the passwordless Cognito account, upserts the USER# record with an
 * admin membership for the tenant (replacing any prior membership there), and
 * recounts CONFIG.adminCount so the transactional last-admin guard stays
 * consistent. Idempotent: re-running for the same email converges to the same
 * state. Callers verify the tenant CONFIG row exists first.
 */
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import * as repo from './repo.js';
import type { Membership } from './types.js';
import { ensurePasswordlessUser } from './cognito-users.js';

/**
 * Write the admin membership for a user whose `sub` is ALREADY known, and recount.
 *
 * Split out from `grantTenantAdmin` because the tenant-creation auto-grant iterates
 * operators it just read from the operator index — it holds their real subs, so making it
 * re-resolve each one through Cognito by email would be a pointless round-trip per
 * operator per tenant, and would silently write to the WRONG record anywhere the
 * email→sub mapping differs from the stored one (exactly what happens offline, where
 * `ensurePasswordlessUser` derives a deterministic hash sub rather than the real one).
 *
 * Callers that only have an email should use `grantTenantAdmin`, which resolves the sub
 * (creating the Cognito account if needed) and then delegates here.
 */
export async function addAdminMembership(
  sub: string,
  email: string,
  tenant: string,
): Promise<{ sub: string; adminCount: number }> {
  const existing = await repo.getUser(sub);
  const memberships = (existing?.memberships ?? []).filter((m) => m.tenantId !== tenant);
  memberships.push({ tenantId: tenant, role: 'admin', clubIds: [] });
  await repo.putUser({
    sub,
    // Prefer the stored email — it is what Cognito and the markers already agree on.
    email: existing?.email ?? email,
    memberships,
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  });
  // Keep the transactional last-admin counter on CONFIG consistent. Recount (rather
  // than +1) so re-running is idempotent and repairs a drifted/absent count.
  const adminCount = await repo.recountAdmins(tenant);
  return { sub, adminCount };
}

export async function grantTenantAdmin(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  tenant: string,
  email: string,
): Promise<{ sub: string; adminCount: number }> {
  const sub = await ensurePasswordlessUser(cognito, userPoolId, email);
  return addAdminMembership(sub, email, tenant);
}

/**
 * Grant a user the rep role for a tenant, scoped to `clubIds` — the seeding
 * counterpart of `grantTenantAdmin`, and the same core as the rep branch of
 * POST /admin/users. Used out-of-band by the seed CLI, where there is no admin
 * session to invite through.
 *
 * Same filter-then-reattach discipline: memberships in OTHER tenants are preserved,
 * and the membership for THIS tenant is replaced wholesale. Idempotent — re-running
 * with the same clubIds converges.
 *
 * Note the recount: memberships are one-per-tenant, so granting rep to someone who
 * was an admin here REMOVES an admin. Recounting keeps CONFIG.adminCount honest, which
 * the transactional last-admin guard depends on. Callers verify the tenant exists.
 */
export async function grantClubRep(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  tenant: string,
  email: string,
  clubIds: string[],
  /** When set, stamps invite provenance on the membership, matching the HTTP invite path
   * (POST /admin/users → index.ts). Existing callers omit it and behave exactly as before. */
  opts?: { invitedBy?: string },
): Promise<{ sub: string; clubIds: string[] }> {
  // Matches the API's rule (POST /admin/users): an unscoped rep would be a user who
  // can reach nothing, which reads as a silent failure rather than a refusal.
  if (clubIds.length === 0) throw new Error('a rep must be scoped to at least one club');

  const sub = await ensurePasswordlessUser(cognito, userPoolId, email);

  const existing = await repo.getUser(sub);
  // Preserve an existing pending invite's original stamp (never reset invitedAt on a
  // re-grant of a still-pending user), mirroring `prior?.invitedAt ?? now()` in the route.
  const prior = existing?.memberships.find((m) => m.tenantId === tenant);
  const memberships = (existing?.memberships ?? []).filter((m) => m.tenantId !== tenant);
  const membership: Membership = {
    tenantId: tenant,
    role: 'rep',
    clubIds,
    ...(opts?.invitedBy
      ? {
          invitedAt: prior?.invitedAt ?? new Date().toISOString(),
          invitedBy: prior?.invitedBy ?? opts.invitedBy,
        }
      : {}),
  };
  memberships.push(membership);
  await repo.putUser({
    sub,
    email,
    memberships,
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  });
  await repo.recountAdmins(tenant);
  return { sub, clubIds };
}

export interface RestoreMembershipResult {
  /** True when the user had no other memberships left and was fully deleted (META + markers). */
  offboarded: boolean;
  /** The admin-tier delta applied to the tenant (for the caller's summary). */
  adminDelta: -1 | 0 | 1;
}

/**
 * Set a user's membership for ONE tenant back to an exact pre-image, or remove it — the
 * shared, guarded core the contact-import CLI's `--revert` uses so it NEVER hand-writes a
 * USER# item. Filter-then-reattach (memberships in other tenants are untouched), through
 * `repo.writeUserWithAdminDelta` so the last-admin transaction guard still applies.
 *
 * `prior === null` removes this tenant's membership: if it was the user's only one, the
 * user is fully deleted; otherwise the remaining memberships are written. A removal (or a
 * restore) that would drop the tenant below one admin throws {@link repo.LastAdminError}
 * via the guarded write / decrement — reps never trip it, but the guard is applied anyway
 * rather than assumed away. Cognito accounts are NOT touched here (the CLI leaves dormant
 * OTP users in place — see its usage header); callers that need Cognito teardown layer it on.
 *
 * DELIBERATE DIVERGENCE from `DELETE /admin/users/:sub` (do NOT refactor the route onto this):
 * this helper is the shared, guarded MEMBERSHIP core, and both paths share it — that shared
 * repo primitive (the last-admin transaction guard) is the invariant that matters. The route
 * does strictly MORE, and those extras are exactly what an offline CLI must not do: it
 * reconciles phantom Cognito admins, deletes the Cognito user outright, and forces a global
 * sign-out. Folding the route onto this helper would either drag that live-session teardown
 * into the CLI's `--revert` (which intentionally leaves harmless dormant OTP users in place)
 * or strip it from the route. Keeping them separate over the same guarded primitive is the
 * point, not an accident.
 */
export async function restoreMembership(
  sub: string,
  tenant: string,
  prior: Membership | null,
): Promise<RestoreMembershipResult> {
  const existing = await repo.getUser(sub);
  if (!existing) return { offboarded: false, adminDelta: 0 }; // nothing on record — no-op

  const current = existing.memberships.find((m) => m.tenantId === tenant);
  const others = existing.memberships.filter((m) => m.tenantId !== tenant);
  const wasAdmin = current?.role === 'admin';

  if (prior === null) {
    if (others.length === 0) {
      // Full offboard. Guard the count first (backfill via recount, then the guarded
      // decrement) so the last admin can never be removed — same invariant the DELETE
      // route enforces, via the guarded repo primitive.
      if (wasAdmin) {
        await repo.recountAdmins(tenant);
        await repo.decrementAdminCount(tenant);
      }
      await repo.deleteUser(sub);
      return { offboarded: true, adminDelta: wasAdmin ? -1 : 0 };
    }
    const delta: -1 | 0 = wasAdmin ? -1 : 0;
    if (delta !== 0) await repo.recountAdmins(tenant);
    await repo.writeUserWithAdminDelta({ ...existing, memberships: others }, tenant, delta);
    return { offboarded: false, adminDelta: delta };
  }

  const willBeAdmin = prior.role === 'admin';
  const delta: -1 | 0 | 1 = willBeAdmin && !wasAdmin ? 1 : !willBeAdmin && wasAdmin ? -1 : 0;
  if (delta !== 0) await repo.recountAdmins(tenant);
  await repo.writeUserWithAdminDelta(
    { ...existing, memberships: [...others, prior] },
    tenant,
    delta,
  );
  return { offboarded: false, adminDelta: delta };
}
