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
 * Read-only resolve of an email to its Cognito sub — returns `null` when no account
 * exists. UNLIKE {@link ensurePasswordlessUser} this NEVER creates or confirms a user, so
 * it is safe on a read-only path (the contact-import CLI's dry-run resolves each contact's
 * existing membership without provisioning anyone). Offline (LOCAL_AUTH=1) mirrors
 * ensurePasswordlessUser's deterministic sub so the two agree on which USER# record an
 * email maps to. A UserNotFoundException is the definitive "no account"; other errors
 * propagate (a dry-run must not silently under-report existing users on a transient fault).
 */
export async function getUserSubByEmail(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<string | null> {
  const username = email.trim().toLowerCase();
  if (LOCAL) return localSub(username);
  try {
    const got = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
    );
    return got.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'UserNotFoundException') return null;
    throw err;
  }
}

/**
 * Relocate a user's sign-in email (the typo-correction flow). The pool uses
 * `usernames: ['email']` (UsernameAttributes), so the email is a RELOCATABLE alias —
 * updating the `email` attribute moves the alias without changing the sub, so every
 * USER#{sub} record stays valid and the user signs in (EMAIL_OTP) under the new address.
 * `email_verified=true` keeps the new value usable as a sign-in alias immediately.
 *
 * Robust to the pool's Username semantics (we have NOT verified which it uses here): on a
 * UsernameAttributes pool the immutable username normally equals the sub, so `Username: sub`
 * works AND is idempotent on retry (re-setting the same email is a no-op). But some pools
 * resolve admin ops only by the email alias — so on InvalidParameterException ("Username
 * should be an email") or UserNotFoundException we retry once with the CURRENT email, which
 * every other helper here already uses successfully. The sub path is preferred (idempotent);
 * the alias path is the guaranteed-working fallback.
 *
 * Throws `AliasExistsException` if the new email is already an alias for another pool user
 * (caller → 409). If neither sub nor the current email resolves, UserNotFoundException
 * propagates (caller → 404). No-op offline (LOCAL_AUTH=1) — offline never exercises this.
 */
export async function adminUpdateCognitoUserEmail(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  sub: string,
  currentEmail: string,
  newEmail: string,
): Promise<void> {
  if (LOCAL) return;
  const UserAttributes = [
    { Name: 'email', Value: newEmail.trim().toLowerCase() },
    { Name: 'email_verified', Value: 'true' },
  ];
  try {
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: sub,
        UserAttributes,
      }),
    );
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    // This pool resolves admin ops by the email alias, not the sub — retry with the
    // user's current sign-in email (the alias). AliasExists/other errors propagate.
    if (name !== 'InvalidParameterException' && name !== 'UserNotFoundException') throw err;
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: currentEmail.trim().toLowerCase(),
        UserAttributes,
      }),
    );
  }
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
