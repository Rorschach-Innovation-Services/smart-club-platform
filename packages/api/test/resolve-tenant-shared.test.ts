/**
 * resolveTenant() on the SHARED API host (wildcard platform, scheme 1). When the API is
 * hit at SHARED_API_HOST the Host can't identify the tenant (it's api.club.* for
 * everyone), so the tenant comes from the request's Origin. A wildcard Origin's label goes
 * through the public-address lookup (ADR 0024) — this is the prod path a renamed tenant's
 * browser takes — so the file runs its own dynalite. Env is set before importing auth (the
 * map + shared-host consts are read at module load); node --test isolates this file's
 * process so it doesn't leak into the other suites.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Context } from 'hono';
import type { TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4905;
const TABLE = 'ResolveTenantSharedTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.STAGE = 'prod';
process.env.WILDCARD_ENABLED = '1';
process.env.SHARED_API_HOST = 'api.club.medicoach.co.za';
process.env.WILDCARD_WEB_SUFFIX = '.club.medicoach.co.za';
process.env.TENANT_HOST_MAP = JSON.stringify({
  'dolphinspipeline.medicoach.co.za': 'dolphins',
  'api.dolphinspipeline.medicoach.co.za': 'dolphins',
  // A vanity tenant that shares the platform API host (no apiHost of its own).
  'clubs.sharks.co.za': 'sharks',
});

let ddbServer: Server;
let resolveTenant: (typeof import('../src/auth.js'))['resolveTenant'];

before(async () => {
  ddbServer = await startDynalite(DDB_PORT, TABLE);
  ({ resolveTenant } = await import('../src/auth.js'));
  const repo = await import('../src/repo.js');
  for (const tenant of ['demo', 'westernprovincecricket'])
    await repo.createTenantConfig({
      tenant,
      branding: { name: tenant, title: tenant, logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-01-01',
    } as unknown as TenantConfig);
  await repo.setTenantPublicSlug('westernprovincecricket', 'cobras', 'westernprovincecricket');
});

after(async () => {
  if (ddbServer) await stopDynalite(ddbServer);
});

const SHARED = 'api.club.medicoach.co.za';
const ctx = (headers: Record<string, string>) =>
  ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
  }) as unknown as Context;

describe('resolveTenant (shared API host, Origin-derived)', () => {
  test('resolves a wildcard web Origin to its leftmost label', async () => {
    assert.deepEqual(
      await resolveTenant(ctx({ host: SHARED, origin: 'https://demo.club.medicoach.co.za' })),
      { tenant: 'demo' },
    );
  });

  test('resolves a vanity web Origin via the host→tenant map', async () => {
    assert.deepEqual(
      await resolveTenant(ctx({ host: SHARED, origin: 'https://clubs.sharks.co.za' })),
      { tenant: 'sharks' },
    );
  });

  test('returns null (never the reserved "api") when the Origin is missing', async () => {
    assert.equal(await resolveTenant(ctx({ host: SHARED })), null);
  });

  test('returns null for a garbage Origin', async () => {
    assert.equal(await resolveTenant(ctx({ host: SHARED, origin: 'not a url' })), null);
  });

  test('returns null for a multi-label wildcard Origin (a.b.club.…)', async () => {
    assert.equal(
      await resolveTenant(ctx({ host: SHARED, origin: 'https://a.b.club.medicoach.co.za' })),
      null,
    );
  });

  test('returns null for a foreign Origin not under the suffix or in the map', async () => {
    assert.equal(
      await resolveTenant(ctx({ host: SHARED, origin: 'https://evil.example.com' })),
      null,
    );
  });

  test('a per-tenant API host still resolves by Host, ignoring Origin', async () => {
    assert.deepEqual(
      await resolveTenant(
        ctx({
          host: 'api.dolphinspipeline.medicoach.co.za',
          origin: 'https://demo.club.medicoach.co.za',
        }),
      ),
      { tenant: 'dolphins' },
    );
  });
});

describe('resolveTenant (shared API host, renamed tenant — ADR 0024)', () => {
  test("an active label's Origin resolves to the tenant's internal ID", async () => {
    assert.deepEqual(
      await resolveTenant(ctx({ host: SHARED, origin: 'https://cobras.club.medicoach.co.za' })),
      { tenant: 'westernprovincecricket' },
    );
  });

  test("the retired label's Origin is an unknown label", async () => {
    assert.deepEqual(
      await resolveTenant(
        ctx({ host: SHARED, origin: 'https://westernprovincecricket.club.medicoach.co.za' }),
      ),
      { unknownLabel: 'westernprovincecricket' },
    );
  });
});
