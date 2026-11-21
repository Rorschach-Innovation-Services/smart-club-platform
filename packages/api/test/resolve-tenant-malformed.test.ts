/**
 * resolveTenant() must degrade safely when TENANT_HOST_MAP is malformed: empty map,
 * leftmost-label fallback still works, no throw. Separate file because the map is parsed
 * once at module load — this process gets the bad value before importing auth. The
 * leftmost label goes through the public-address lookup (ADR 0024), so the file runs its
 * own dynalite with the `lions` tenant seeded.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Context } from 'hono';
import type { TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4903;
const TABLE = 'ResolveTenantMalformedTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.STAGE = 'prod';
process.env.TENANT_HOST_MAP = '{ not valid json';

let ddbServer: Server;
let resolveTenant: (typeof import('../src/auth.js'))['resolveTenant'];

before(async () => {
  ddbServer = await startDynalite(DDB_PORT, TABLE);
  ({ resolveTenant } = await import('../src/auth.js'));
  const repo = await import('../src/repo.js');
  await repo.createTenantConfig({
    tenant: 'lions',
    branding: { name: 'lions', title: 'lions', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-01-01',
  } as unknown as TenantConfig);
});

after(async () => {
  if (ddbServer) await stopDynalite(ddbServer);
});

const ctx = (host: string) =>
  ({
    req: { header: (n: string) => (n.toLowerCase() === 'host' ? host : undefined) },
  }) as unknown as Context;

describe('resolveTenant (malformed TENANT_HOST_MAP)', () => {
  test('does not throw and falls back to the leftmost label', async () => {
    assert.deepEqual(await resolveTenant(ctx('lions.example.com')), { tenant: 'lions' });
  });

  test('still rejects execute-api/localhost (no bypass)', async () => {
    assert.equal(await resolveTenant(ctx('abc.execute-api.af-south-1.amazonaws.com')), null);
    assert.equal(await resolveTenant(ctx('localhost')), null);
  });
});
