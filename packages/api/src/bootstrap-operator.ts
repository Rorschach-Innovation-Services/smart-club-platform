/**
 * Platform bootstrap — create a PLATFORM OPERATOR (the /platform/* portal role).
 *
 * Operators are provisioned out-of-band (there is no tenant admin above them):
 *   sst shell --stage <stage> -- npx tsx packages/api/src/bootstrap-operator.ts <email>
 *
 * Creates a suppressed-invite Cognito user (they sign in via OTP) and writes the
 * USER# record with the platform membership {tenantId: '*', role: 'operator'}.
 * Unlike bootstrap-admin there is NO tenant-config existence check (the platform
 * is not a tenant) and NO recountAdmins (operators don't count toward any
 * tenant's admin floor); the repo layer skips TENANT# markers for '*', so the
 * operator never appears in a tenant roster. See docs/architecture/0006.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import * as repo from './repo.js';
import { ensurePasswordlessUser } from './cognito-users.js';
import { userPoolId } from './env.js';
import { PLATFORM_TENANT } from './types.js';

async function main(): Promise<void> {
  const [email] = process.argv.slice(2);
  if (!email) {
    console.error('usage: bootstrap-operator <email>');
    process.exit(1);
  }

  const cognito = new CognitoIdentityProviderClient({});
  const sub = await ensurePasswordlessUser(cognito, userPoolId(), email);

  const existing = await repo.getUser(sub);
  const memberships = (existing?.memberships ?? []).filter((m) => m.tenantId !== PLATFORM_TENANT);
  memberships.push({ tenantId: PLATFORM_TENANT, role: 'operator', clubIds: [] });
  await repo.putUser({
    sub,
    email,
    memberships,
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  });

  console.log(`bootstrapped platform operator ${email} (sub ${sub})`);
  console.log('they can now sign in via email OTP and open /platform.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
