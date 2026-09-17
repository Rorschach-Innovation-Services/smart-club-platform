/**
 * Resolve resource names in two contexts:
 * - Lambda: explicit env vars set in sst.config.ts (TABLE_NAME, USER_POOL_ID).
 * - CLI under `sst shell`: SST injects `SST_RESOURCE_<Name>` as JSON.
 */

function fromSstResource(name: string, prop: string): string | undefined {
  const raw = process.env[`SST_RESOURCE_${name}`];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw)[prop];
  } catch {
    return undefined;
  }
}

export function tableName(): string {
  const v = process.env.TABLE_NAME ?? fromSstResource('Data', 'name');
  if (!v) throw new Error('TABLE_NAME not set (run under sst shell or set TABLE_NAME)');
  return v;
}

export function userPoolId(): string {
  const v = process.env.USER_POOL_ID ?? fromSstResource('Auth', 'id');
  if (!v) throw new Error('USER_POOL_ID not set (run under sst shell or set USER_POOL_ID)');
  return v;
}

export function uploadsBucket(): string {
  const v = process.env.UPLOADS_BUCKET ?? fromSstResource('Uploads', 'name');
  if (!v) throw new Error('UPLOADS_BUCKET not set (run under sst shell or set UPLOADS_BUCKET)');
  return v;
}

/**
 * The HMAC key for veterans-candidate handles (ADR 0013). The finder never returns a player's
 * natural key; it returns `HMAC(secret, tenant|clubId|naturalKey)`, so this secret must be a real
 * value in any real stage or the handle is guessable.
 *
 * `sst.Secret('CandidateHandleSecret', '')` defaults to '' (exactly like FromEmail), so an unset
 * secret arrives here as the EMPTY STRING, not `undefined` — an `if (!v)` check alone wouldn't
 * distinguish "unset" from a legitimately-set value, but empty is never legitimate for an HMAC
 * key, so we FAIL CLOSED on empty. The only exception is the offline/local stack (LOCAL_AUTH=1,
 * never set in AWS), which falls back to a fixed dev constant so tests and `dev:local` work
 * without a secret. Any real stage with the secret unset throws (→ 500) rather than minting
 * brute-forceable handles.
 */
export function candidateHandleSecret(): string {
  const v = process.env.CANDIDATE_HANDLE_SECRET;
  if (v) return v; // a non-empty value is always trusted
  if (process.env.LOCAL_AUTH === '1') return 'local-dev-candidate-handle-secret';
  throw new Error(
    'CANDIDATE_HANDLE_SECRET not set (run: sst secret set CandidateHandleSecret <hex> --stage <stage>)',
  );
}
