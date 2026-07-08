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

export async function grantTenantAdmin(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  tenant: string,
  email: string,
): Promise<{ sub: string; adminCount: number }> {
  const sub = await ensurePasswordlessUser(cognito, userPoolId, email);

  const existing = await repo.getUser(sub);
  const memberships = (existing?.memberships ?? []).filter((m) => m.tenantId !== tenant);
  memberships.push({ tenantId: tenant, role: 'admin', clubIds: [] });
  await repo.putUser({
    sub,
    email,
    memberships,
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  });
  // Keep the transactional last-admin counter on CONFIG consistent. Recount (rather
  // than +1) so re-running is idempotent and repairs a drifted/absent count.
  const adminCount = await repo.recountAdmins(tenant);
  return { sub, adminCount };
}
