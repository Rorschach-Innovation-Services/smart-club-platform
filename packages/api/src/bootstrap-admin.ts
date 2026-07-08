/**
 * Platform bootstrap — create the FIRST admin for a tenant.
 *
 * Admin-create-only Cognito means a brand-new tenant has no one to invite the
 * first admin, so a platform operator runs this out-of-band:
 *   sst shell --stage dev -- npx tsx packages/api/src/bootstrap-admin.ts <tenant> <email>
 *
 * Creates a suppressed-invite Cognito user (they sign in via OTP) and writes the
 * USER# record with an admin membership. Thereafter that admin invites reps via
 * the API. See docs/architecture/0003 and docs/guides/onboarding-a-tenant.md.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import * as repo from './repo.js';
import { grantTenantAdmin } from './tenant-admin.js';
import { userPoolId } from './env.js';

async function main(): Promise<void> {
  const [tenant, email] = process.argv.slice(2);
  if (!tenant || !email) {
    console.error('usage: bootstrap-admin <tenant> <email>');
    process.exit(1);
  }
  const config = await repo.getTenantConfig(tenant);
  if (!config) {
    console.error(`tenant "${tenant}" not found — seed it first`);
    process.exit(1);
  }

  const cognito = new CognitoIdentityProviderClient({});
  // Shared core with POST /platform/tenants/:slug/admins (tenant-admin.ts).
  const { sub } = await grantTenantAdmin(cognito, userPoolId(), tenant, email);

  console.log(`bootstrapped admin ${email} (sub ${sub}) for tenant ${tenant}`);
  console.log('they can now sign in via email OTP.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
