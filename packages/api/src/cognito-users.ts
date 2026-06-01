/**
 * Shared Cognito user provisioning for the invite + bootstrap flows.
 *
 * Creates (or reuses) a user and moves them to CONFIRMED so passwordless email
 * OTP works: AdminCreateUser leaves a user in FORCE_CHANGE_PASSWORD, which
 * restricts sign-in to password challenges and hides EMAIL_OTP. Setting a random
 * PERMANENT password confirms the account; the password is never surfaced —
 * users sign in via OTP. See docs/architecture/0003.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';

/** A random password meeting the pool policy (upper/lower/number/symbol, ≥8). */
function randomPassword(): string {
  return `Aa1!${randomUUID()}${randomUUID()}`;
}

/**
 * Ensure a CONFIRMED Cognito user exists for `email`; returns their sub.
 * Idempotent: reuses an existing account (multi-union invite) and re-confirms.
 */
export async function ensurePasswordlessUser(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<string> {
  let sub: string | undefined;
  try {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        MessageAction: 'SUPPRESS', // no invite email; the user signs in via OTP
      }),
    );
    sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'UsernameExistsException') throw err;
    const got = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
    );
    sub = got.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  }
  if (!sub) throw new Error('could not resolve user sub');

  // Confirm the account so EMAIL_OTP is offered (password is unused/random).
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: randomPassword(),
      Permanent: true,
    }),
  );
  return sub;
}
