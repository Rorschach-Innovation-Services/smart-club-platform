/**
 * Resolve resource names in two contexts:
 * - Lambda: explicit env vars set in sst.config.ts (TABLE_NAME, USER_POOL_ID).
 * - CLI under `sst shell`: SST injects `SST_RESOURCE_<Name>` as JSON.
 */

export function fromSstResource(
  name: string,
  prop: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[`SST_RESOURCE_${name}`];
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

/**
 * Medicoach fixture-sync endpoint + shared HMAC secret (ADR 0016). Lambda: env vars set in
 * sst.config.ts from the `MedicoachSyncUrl` / `MedicoachSyncSecret` secrets; CLI under
 * `sst shell`: the linked secret resources. Both default to '' — and an empty value is the
 * DRY-RUN switch (the puller logs what it would request and makes no HTTP call), so the
 * stack deploys and the cron runs harmlessly before the secrets are set.
 */
export function medicoachSyncUrl(): string {
  return (
    process.env.MEDICOACH_SYNC_URL ??
    fromSstResource('MedicoachSyncUrl', 'value') ??
    ''
  ).replace(/\/+$/, '');
}

/**
 * The per-request timeout of the review-decision push (ADR 0019), default 10 s. Overridable
 * via MEDICOACH_RESOLVE_TIMEOUT_MS (tests, and ops tuning without a code change).
 */
export function medicoachResolveTimeoutMs(fallback: number): number {
  const v = Number(process.env.MEDICOACH_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function medicoachSyncSecret(): string {
  return process.env.MEDICOACH_SYNC_SECRET ?? fromSstResource('MedicoachSyncSecret', 'value') ?? '';
}

/** True while the sync URL or secret is empty: every medicoach call is a logged no-op. */
export function medicoachSyncDryRun(): boolean {
  return !medicoachSyncUrl() || !medicoachSyncSecret();
}

/**
 * The union-admin cell that receives the captain's-report ops digest after a sync run with
 * report activity. Lambda: OPS_DIGEST_CELL from the `OpsDigestCell` secret; CLI under
 * `sst shell`: the linked secret. Empty/unset ⇒ null ⇒ the digest is off (never throws).
 */
export function opsDigestCell(): string | null {
  const v = (process.env.OPS_DIGEST_CELL ?? fromSstResource('OpsDigestCell', 'value') ?? '').trim();
  return v || null;
}

/**
 * The HMAC key for captain's-report submit-once links (ADR 0016, Slice 2). A link token is
 * `payload.HMAC(secret, payload)`, so an empty key would make every link forgeable: FAIL
 * CLOSED exactly like `candidateHandleSecret` — only the offline/local stack (LOCAL_AUTH=1,
 * never set in AWS) gets a fixed dev constant. Set before deploy:
 *   sst secret set CaptainsReportLinkSecret $(openssl rand -hex 32) --stage <stage>
 */
export function captainsReportLinkSecret(): string {
  const v =
    process.env.CAPTAINS_REPORT_LINK_SECRET ?? fromSstResource('CaptainsReportLinkSecret', 'value');
  if (v) return v;
  if (process.env.LOCAL_AUTH === '1') return 'local-dev-captains-report-link-secret';
  throw new Error(
    'CAPTAINS_REPORT_LINK_SECRET not set (run: sst secret set CaptainsReportLinkSecret <hex> --stage <stage>)',
  );
}

/**
 * Where a captain's-report link points: `${base}/r/<token>`. The page is tenant-independent
 * (the token names the tenant), so prod uses the PLATFORM host — the same one the WhatsApp
 * template's URL button is registered with — and other stages their own web URL.
 */
export function captainsReportLinkBase(): string {
  return (process.env.CAPTAINS_REPORT_LINK_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
}
