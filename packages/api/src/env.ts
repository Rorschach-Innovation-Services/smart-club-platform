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
