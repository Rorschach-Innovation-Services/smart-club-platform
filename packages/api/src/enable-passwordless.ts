/**
 * Post-deploy step — enable Cognito passwordless email OTP.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/enable-passwordless.ts
 *
 * WHY this isn't in sst.config.ts: the sign-in policy that turns on EMAIL_OTP as a
 * first auth factor (`Policies.SignInPolicy.AllowedFirstAuthFactors`) only exists
 * in pulumi-aws 7.x, but SST 3.19 bundles 6.66.2 — so the IaC can't set it yet.
 * This script flips it via the AWS API instead. Re-run it after any deploy that
 * recreates the user pool. See docs/architecture/0003 and docs/guides/auth-and-roles.md.
 *
 * It reads the current pool and re-applies its config (UpdateUserPool resets
 * omitted fields), adding EMAIL_OTP alongside PASSWORD — so it's idempotent and
 * preserves the PreTokenGeneration trigger, tier, auto-verify, and admin-create-only.
 */
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { userPoolId } from './env.js';

async function main(): Promise<void> {
  const poolId = userPoolId();
  const cognito = new CognitoIdentityProviderClient({});
  const { UserPool: p } = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
  if (!p) throw new Error('user pool not found');

  const factors = p.Policies?.SignInPolicy?.AllowedFirstAuthFactors ?? ['PASSWORD'];
  if (factors.includes('EMAIL_OTP')) {
    console.log('EMAIL_OTP already enabled — nothing to do.');
    return;
  }

  await cognito.send(
    new UpdateUserPoolCommand({
      UserPoolId: poolId,
      // Re-apply existing config (UpdateUserPool resets omitted fields).
      UserPoolTier: p.UserPoolTier,
      AutoVerifiedAttributes: p.AutoVerifiedAttributes,
      AdminCreateUserConfig: p.AdminCreateUserConfig,
      EmailConfiguration: p.EmailConfiguration,
      LambdaConfig: p.LambdaConfig,
      MfaConfiguration: p.MfaConfiguration,
      UserAttributeUpdateSettings: p.UserAttributeUpdateSettings,
      DeletionProtection: p.DeletionProtection,
      AccountRecoverySetting: p.AccountRecoverySetting,
      Policies: {
        ...p.Policies,
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] },
      },
    }),
  );
  console.log(`enabled passwordless EMAIL_OTP on ${poolId} (factors: PASSWORD, EMAIL_OTP).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
