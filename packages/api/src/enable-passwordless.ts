/**
 * Post-deploy step — apply Cognito pool settings that the IaC can't (or that
 * deploys reset):
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/enable-passwordless.ts
 *
 * 1. EMAIL_OTP as a first auth factor (`Policies.SignInPolicy.AllowedFirstAuthFactors`)
 *    only exists in pulumi-aws 7.x, but SST 3.19 bundles 6.66.2 — so the IaC can't set
 *    it, and any deploy that issues UpdateUserPool wipes it back to [PASSWORD].
 * 2. SES DEVELOPER email sending (info@medicoach.co.za). COGNITO_DEFAULT caps at
 *    50 emails/day and sends from no-reply@verificationemail.com, which Gmail
 *    spam-bins — OTP codes never arrive. Cognito requires the SES identity to be in
 *    the POOL'S OWN region (af-south-1; an eu-west-1 ARN is rejected with
 *    InvalidParameterException), and this account's af-south-1 SES starts sandboxed —
 *    so this setting is gated: it's only applied once the af-south-1 identity is
 *    verified AND production access is granted (a sandboxed DEVELOPER config would
 *    reject OTP mail to unverified recipients, which is worse than the default
 *    sender). Until then the script leaves the existing email config in place and
 *    says what's missing. Owned here, not in sst.config.ts, for the same gating
 *    reason — which also means EVERY pool-updating deploy must re-run this script.
 *
 * Re-run after ANY deploy that updates or recreates the user pool. See
 * docs/architecture/0003 and docs/guides/auth-and-roles.md.
 *
 * It reads the current pool and re-applies its config (UpdateUserPool resets
 * omitted fields) — so it's idempotent and preserves the PreTokenGeneration
 * trigger, tier, auto-verify, and admin-create-only.
 */
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { userPoolId } from './env.js';

// Cognito only accepts SES identities in the pool's own region.
const SES_REGION = 'af-south-1';
const SES_IDENTITY = 'info@medicoach.co.za';
const FROM_ADDRESS = `Smart Club Platform <${SES_IDENTITY}>`;

/** SES af-south-1 is usable for OTP mail only when the identity is verified and the
 * account is out of the sandbox (sandbox rejects unverified recipients). Failures
 * keep their error names — an AccessDenied must not read as "not created". */
async function sesReadiness(): Promise<{ ready: boolean; missing: string[] }> {
  const ses = new SESv2Client({ region: SES_REGION });
  const missing: string[] = [];
  try {
    const account = await ses.send(new GetAccountCommand({}));
    if (!account.ProductionAccessEnabled) missing.push('production access (account in sandbox)');
  } catch (err) {
    missing.push(`production access (GetAccount failed: ${err instanceof Error ? err.name : err})`);
  }
  try {
    const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: SES_IDENTITY }));
    if (!identity.VerifiedForSendingStatus) missing.push(`verified identity ${SES_IDENTITY}`);
  } catch (err) {
    const reason = err instanceof Error && err.name === 'NotFoundException' ? 'not created' : err;
    missing.push(`identity ${SES_IDENTITY} (${reason})`);
  }
  return { ready: missing.length === 0, missing };
}

async function main(): Promise<void> {
  const poolId = userPoolId();
  const cognito = new CognitoIdentityProviderClient({});
  const { UserPool: p } = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
  if (!p) throw new Error('user pool not found');

  // Account id from the pool's own ARN (arn:aws:cognito-idp:region:ACCOUNT:userpool/id)
  // — avoids an STS dependency for one lookup.
  const accountId = p.Arn?.split(':')[4];
  if (!accountId) throw new Error(`cannot parse account id from pool ARN: ${p.Arn}`);
  const sourceArn = `arn:aws:ses:${SES_REGION}:${accountId}:identity/${SES_IDENTITY}`;

  const { ready: sesReady, missing } = await sesReadiness();
  if (!sesReady) {
    console.warn(
      `⚠ SES ${SES_REGION} not ready for Cognito sending — missing: ${missing.join(', ')}.\n` +
        `  Keeping the pool's current email config (${p.EmailConfiguration?.EmailSendingAccount ?? 'COGNITO_DEFAULT'}); ` +
        `OTP codes stay on Cognito's default sender (often lands in Gmail spam).\n` +
        `  Fix: verify ${SES_IDENTITY} in SES ${SES_REGION} + request production access, then re-run this script.`,
    );
  }

  const factors = p.Policies?.SignInPolicy?.AllowedFirstAuthFactors ?? ['PASSWORD'];
  const hasOtp = factors.includes('EMAIL_OTP');
  const emailUpToDate =
    !sesReady ||
    (p.EmailConfiguration?.EmailSendingAccount === 'DEVELOPER' &&
      p.EmailConfiguration?.SourceArn === sourceArn &&
      p.EmailConfiguration?.From === FROM_ADDRESS);
  if (hasOtp && emailUpToDate) {
    console.log('Pool already configured — nothing to do.');
    return;
  }

  await cognito.send(
    new UpdateUserPoolCommand({
      UserPoolId: poolId,
      // Re-apply existing config (UpdateUserPool resets omitted fields). Every
      // updatable field DescribeUserPool returns is passed through — including ones
      // the IaC doesn't set yet (undefined pass-through is a no-op), so a future
      // sst.config.ts addition isn't silently wiped by the next post-deploy run.
      UserPoolTier: p.UserPoolTier,
      AutoVerifiedAttributes: p.AutoVerifiedAttributes,
      AdminCreateUserConfig: p.AdminCreateUserConfig,
      LambdaConfig: p.LambdaConfig,
      MfaConfiguration: p.MfaConfiguration,
      UserAttributeUpdateSettings: p.UserAttributeUpdateSettings,
      DeletionProtection: p.DeletionProtection,
      AccountRecoverySetting: p.AccountRecoverySetting,
      VerificationMessageTemplate: p.VerificationMessageTemplate,
      DeviceConfiguration: p.DeviceConfiguration,
      SmsConfiguration: p.SmsConfiguration,
      SmsAuthenticationMessage: p.SmsAuthenticationMessage,
      UserPoolTags: p.UserPoolTags,
      UserPoolAddOns: p.UserPoolAddOns,
      EmailConfiguration: sesReady
        ? { EmailSendingAccount: 'DEVELOPER', SourceArn: sourceArn, From: FROM_ADDRESS }
        : p.EmailConfiguration,
      Policies: {
        ...p.Policies,
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] },
      },
    }),
  );
  console.log(
    `updated ${poolId}: factors PASSWORD+EMAIL_OTP, email via ` +
      (sesReady
        ? `SES DEVELOPER (${sourceArn}).`
        : `${p.EmailConfiguration?.EmailSendingAccount ?? 'COGNITO_DEFAULT'} (unchanged — SES not ready).`),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
