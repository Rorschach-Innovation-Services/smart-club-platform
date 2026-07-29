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
): Promise<{ sub: string; clubIds: string[] }> {
  // Matches the API's rule (POST /admin/users): an unscoped rep would be a user who
  // can reach nothing, which reads as a silent failure rather than a refusal.
  if (clubIds.length === 0) throw new Error('a rep must be scoped to at least one club');

  const sub = await ensurePasswordlessUser(cognito, userPoolId, email);

  const existing = await repo.getUser(sub);
  const memberships = (existing?.memberships ?? []).filter((m) => m.tenantId !== tenant);
  memberships.push({ tenantId: tenant, role: 'rep', clubIds });
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
