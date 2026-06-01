/**
 * Platform offboarding / POPIA erasure — delete a tenant and its users.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/erase-tenant.ts <tenant> --confirm
 *
 * Removes the tenant's config, clubs, series, player registrations, and user
 * markers (no table Scan — see repo.eraseTenantData). For each member: if the
 * tenant was their ONLY membership, their USER# record and Cognito account are
 * deleted too; multi-union users keep their other memberships. Reg-link TOKEN#
 * items are global and harmlessly resolve to a deleted club afterwards.
 */
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import * as repo from './repo.js';
import { userPoolId } from './env.js';

async function main(): Promise<void> {
  const [tenant, flag] = process.argv.slice(2);
  if (!tenant) {
    console.error('usage: erase-tenant <tenant> --confirm');
    process.exit(1);
  }
  if (flag !== '--confirm') {
    console.error(`Refusing to erase "${tenant}" without --confirm. This is irreversible.`);
    process.exit(1);
  }

  // Reconcile users first (before their markers are deleted by eraseTenantData).
  const users = await repo.listTenantUsers(tenant);
  const cognito = new CognitoIdentityProviderClient({});
  for (const u of users) {
    const profile = await repo.getUser(u.sub);
    const remaining = (profile?.memberships ?? []).filter((m) => m.tenantId !== tenant);
    if (remaining.length === 0) {
      await repo.deleteUser(u.sub);
      try {
        await cognito.send(
          new AdminDeleteUserCommand({ UserPoolId: userPoolId(), Username: u.email }),
        );
      } catch (err) {
        console.warn(`could not delete Cognito user ${u.email}:`, (err as Error).message);
      }
    } else if (profile) {
      // Drop just this tenant's membership; putUser reconciles their markers.
      await repo.putUser({ ...profile, memberships: remaining });
    }
  }

  const deleted = await repo.eraseTenantData(tenant);
  console.log(
    `erased tenant "${tenant}": ${deleted} items + ${users.length} user link(s) removed.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
