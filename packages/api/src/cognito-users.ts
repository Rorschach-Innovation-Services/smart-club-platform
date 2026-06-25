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
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createHash, randomUUID } from 'node:crypto';

// LOCAL-DEV ONLY: when LOCAL_AUTH=1 (offline stack / tests, never set in AWS) there is
// no Cognito to call, so every admin Cognito operation is stubbed — exactly the same
// gate auth.ts uses for the dev identity bypass. Mirrors the notify/ dry-run toggle.
const LOCAL = process.env.LOCAL_AUTH === '1';

/** A random password meeting the pool policy (upper/lower/number/symbol, ≥8). */
function randomPassword(): string {
  return `Aa1!${randomUUID()}${randomUUID()}`;
}

/**
 * Deterministic offline sub for an email. Real Cognito returns the SAME sub for a
 * repeated AdminCreateUser/Get of one email (idempotent provisioning); mirror that
 * offline so a re-invite resolves to the same USER# record instead of a new one.
 */
function localSub(email: string): string {
  return `local-${createHash('sha1').update(email.trim().toLowerCase()).digest('hex')}`;
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
  // Offline: no Cognito — return a stable, email-derived sub (idempotent like the real
  // pool) so the offline invite/bootstrap flows and tests work without AWS.
  if (LOCAL) return localSub(email);

  // Normalize the Cognito username so it matches what cognitoUserExists later looks up
  // (and what the invite path stores) — a casing drift would make the orphan reconciler
  // see a real account as missing if the pool were ever set to case-sensitive usernames.
  const username = email.trim().toLowerCase();
  let sub: string | undefined;
  try {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
        ],
        MessageAction: 'SUPPRESS', // no invite email; the user signs in via OTP
      }),
    );
    sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'UsernameExistsException') throw err;
    const got = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
    );
    sub = got.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  }
  if (!sub) throw new Error('could not resolve user sub');

  // Confirm the account so EMAIL_OTP is offered (password is unused/random).
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: randomPassword(),
      Permanent: true,
    }),
  );
  return sub;
}

/**
 * Relocate a user's sign-in email (the typo-correction flow). The pool uses
 * `usernames: ['email']` (UsernameAttributes), so the immutable `Username` is the
 * sub (a UUID) and the email is a RELOCATABLE alias — updating the `email` attribute
 * moves the alias without changing the sub, so every USER#{sub} record stays valid and
 * the user signs in (EMAIL_OTP) under the new address. `email_verified=true` keeps the
 * new value usable as a sign-in alias immediately.
 *
 * Resolve by `sub` (NOT the old email): re-setting the email to the same value is then a
 * harmless no-op, so a retry after a later DB-write failure re-converges. Resolving by the
 * old email would break on retry — once the first attempt moves the alias, the old email no
 * longer resolves (UserNotFoundException) and the correction is stuck.
 *
 * Throws `AliasExistsException` if the new email is already an alias for another pool user
 * (caller → 409) and `UserNotFoundException` for an orphaned account (caller → 404). No-op
 * offline (LOCAL_AUTH=1) — note that offline never exercises the real alias relocation.
 */
export async function adminUpdateCognitoUserEmail(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  sub: string,
  newEmail: string,
): Promise<void> {
  if (LOCAL) return;
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: sub, // immutable username == sub on a usernames:['email'] pool
      UserAttributes: [
        { Name: 'email', Value: newEmail.trim().toLowerCase() },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
}

/**
 * Whether a Cognito user exists for `email`. Drives orphan reconciliation: a DynamoDB
 * membership whose Cognito account is gone is a phantom that must not count toward the
 * last-admin guard. The lookup is normalized (`trim().toLowerCase()`) to match how the
 * invite path writes both the DB email and the Cognito username, so casing can't make a
 * real user look missing.
 *
 * FAIL-SAFE: returns `false` ONLY on `UserNotFoundException` (a definitive "gone"); ANY
 * other error (throttle, outage, transient) returns `true` so reconcile never prunes a
 * real user — and never blocks an admin operation — on an ambiguous Cognito failure. A
 * genuine orphan is simply caught on a later reconcile. Always `true` offline (LOCAL).
 */
export async function cognitoUserExists(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<boolean> {
  if (LOCAL) return true;
  try {
    await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email.trim().toLowerCase() }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'UserNotFoundException') return false;
    // Ambiguous failure — assume the user exists so we neither prune a real account nor
    // block the operation; the next reconcile re-checks.
    console.warn(`cognitoUserExists check failed for ${email}:`, (err as Error).message);
    return true;
  }
}

/**
 * Revoke a user's refresh tokens (Cognito AdminUserGlobalSignOut). Used after a
 * demote or removal so no NEW elevated token can be minted — note this kills refresh
 * tokens only; an already-issued ID/access token stays valid until it expires
 * (≤ pool TTL). Best-effort: a failure here must not fail the role change, so the
 * caller's authorization state has already been written by the time we sign out.
 * No-op offline (LOCAL_AUTH=1).
 */
export async function adminGlobalSignOut(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<void> {
  if (LOCAL) return;
  try {
    await cognito.send(
      new AdminUserGlobalSignOutCommand({
        UserPoolId: userPoolId,
        Username: email.trim().toLowerCase(),
      }),
    );
  } catch (err) {
    // The DynamoDB authorization write already succeeded; a failed token revoke only
    // shrinks (doesn't remove) the bounded ≤TTL window. Log once; don't fail the request.
    console.warn(`global sign-out failed for ${email}:`, (err as Error).message);
  }
}

/**
 * Delete a user's Cognito account (full offboard — they have no memberships left).
 * No-op offline (LOCAL_AUTH=1). Best-effort: a failed delete is logged, not thrown —
 * the DynamoDB record is already gone and the orphaned Cognito user is harmless
 * (no membership ⇒ no tenant access) and re-reconciled on a future invite.
 */
export async function adminDeleteCognitoUser(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<void> {
  if (LOCAL) return;
  try {
    await cognito.send(
      new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email.trim().toLowerCase() }),
    );
  } catch (err) {
    console.warn(`could not delete Cognito user ${email}:`, (err as Error).message);
  }
}
