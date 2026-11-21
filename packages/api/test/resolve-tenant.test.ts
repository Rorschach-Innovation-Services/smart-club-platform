/**
 * Unit tests for resolveTenant()'s prod host→tenant resolution, including the public-address
 * label lookup (ADR 0024): an active label resolves to its tenant, a retired label (and a
 * renamed tenant's own retired slug) is an unknown label, a vanity host-map hit skips the
 * lookup entirely.
 *
 * Runs in its own process (node --test isolates files), so env set here doesn't leak
 * into the integration suite. STAGE='prod' exercises the host path (x-tenant ignored);
 * TENANT_HOST_MAP must be set BEFORE importing auth — the map is parsed at module load.
 * The label lookup reads the table, so this file runs its own dynalite.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Context } from 'hono';
import type { TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4901;
const TABLE = 'ResolveTenantTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.STAGE = 'prod';
process.env.TENANT_HOST_MAP = JSON.stringify({
  'dolphinspipeline.medicoach.co.za': 'dolphins',
  'www.dolphinspipeline.medicoach.co.za': 'dolphins',
  'api.dolphinspipeline.medicoach.co.za': 'dolphins',
});

let ddbServer: Server;
let resolveTenant: (typeof import('../src/auth.js'))['resolveTenant'];
let repo: typeof import('../src/repo.js');
let clearPublicAddressCache: () => void;

const config = (tenant: string) =>
  ({
    tenant,
    branding: { name: tenant, title: tenant, logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-01-01',
  }) as unknown as TenantConfig;

before(async () => {
  ddbServer = await startDynalite(DDB_PORT, TABLE);
  ({ resolveTenant } = await import('../src/auth.js'));
  repo = await import('../src/repo.js');
  ({ clearPublicAddressCache } = await import('../src/public-address.js'));
  for (const t of ['dolphins', 'lions', 'wpc']) await repo.createTenantConfig(config(t));
  // wpc → cobras → capes: `wpc` (own slug) and `cobras` are retired, `capes` is active.
  await repo.setTenantPublicSlug('wpc', 'cobras', 'wpc');
  await repo.setTenantPublicSlug('wpc', 'capes', 'cobras');
});

after(async () => {
  if (ddbServer?.listening) await stopDynalite(ddbServer);
});

/** Minimal Context stub: resolveTenant only reads the `host` / `x-tenant` / `origin` headers. */
const ctx = (headers: Record<string, string>) =>
  ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
  }) as unknown as Context;

describe('resolveTenant (prod, host→tenant map)', () => {
  test('maps the API custom host to its tenant', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'api.dolphinspipeline.medicoach.co.za' })), {
      tenant: 'dolphins',
    });
  });

  test('maps the vanity web host (label != slug) to its tenant', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'dolphinspipeline.medicoach.co.za' })), {
      tenant: 'dolphins',
    });
  });

  test('maps the www alias to its tenant', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'www.dolphinspipeline.medicoach.co.za' })), {
      tenant: 'dolphins',
    });
  });

  test('lowercases and strips the port before lookup', async () => {
    assert.deepEqual(
      await resolveTenant(ctx({ host: 'API.DolphinsPipeline.medicoach.co.za:443' })),
      { tenant: 'dolphins' },
    );
  });

  test('ignores x-tenant in prod (host is the authorization boundary)', async () => {
    assert.deepEqual(
      await resolveTenant(ctx({ host: 'dolphinspipeline.medicoach.co.za', 'x-tenant': 'lions' })),
      { tenant: 'dolphins' },
    );
  });

  test('falls back to the leftmost label for clean per-union subdomains', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'lions.example.com' })), { tenant: 'lions' });
  });

  test('returns null for raw execute-api hosts (no bypass)', async () => {
    assert.equal(
      await resolveTenant(ctx({ host: 'abc123.execute-api.af-south-1.amazonaws.com' })),
      null,
    );
  });

  test('returns null for localhost and a missing host', async () => {
    assert.equal(await resolveTenant(ctx({ host: 'localhost' })), null);
    assert.equal(await resolveTenant(ctx({})), null);
  });
});

describe('resolveTenant (public-address labels, ADR 0024)', () => {
  test('an active label resolves to the tenant that holds it', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'capes.example.com' })), { tenant: 'wpc' });
  });

  test('a retired label is an unknown label', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'cobras.example.com' })), {
      unknownLabel: 'cobras',
    });
  });

  test("a renamed tenant's own retired slug is an unknown label (its CONFIG row still exists)", async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'wpc.example.com' })), {
      unknownLabel: 'wpc',
    });
  });

  test('a label nobody holds is an unknown label', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'nobody.example.com' })), {
      unknownLabel: 'nobody',
    });
  });

  test('a vanity host-map hit skips the lookup, even when the slug label is retired', async () => {
    // `dolphinspipeline…` is mapped; prove the map path never consults label records by
    // retiring the mapped tenant's own slug label and resolving its vanity host.
    await repo.setTenantPublicSlug('dolphins', 'dolphinsmoved', 'dolphins');
    assert.deepEqual(await resolveTenant(ctx({ host: 'dolphinspipeline.medicoach.co.za' })), {
      tenant: 'dolphins',
    });
    assert.deepEqual(await resolveTenant(ctx({ host: 'dolphins.example.com' })), {
      unknownLabel: 'dolphins',
    });
  });

  test('a miss is never cached: a tenant created after a miss resolves at once', async () => {
    assert.deepEqual(await resolveTenant(ctx({ host: 'latecomer.example.com' })), {
      unknownLabel: 'latecomer',
    });
    // putTenantConfig does not clear the cache — only an uncached miss lets this resolve.
    await repo.putTenantConfig(config('latecomer'));
    assert.deepEqual(await resolveTenant(ctx({ host: 'latecomer.example.com' })), {
      tenant: 'latecomer',
    });
  });

  test('a hit is cached until the cache is cleared', async () => {
    await repo.putTenantConfig(config('cachedco'));
    assert.deepEqual(await resolveTenant(ctx({ host: 'cachedco.example.com' })), {
      tenant: 'cachedco',
    });
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
    const raw = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT,
        region: 'localhost',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    );
    await raw.send(
      new DeleteCommand({ TableName: TABLE, Key: { pk: 'TENANT#cachedco', sk: 'CONFIG' } }),
    );
    assert.deepEqual(await resolveTenant(ctx({ host: 'cachedco.example.com' })), {
      tenant: 'cachedco',
    });
    clearPublicAddressCache();
    assert.deepEqual(await resolveTenant(ctx({ host: 'cachedco.example.com' })), {
      unknownLabel: 'cachedco',
    });
  });

  // Last: stops the table.
  test('a DynamoDB error fails closed (throws), and is not cached', async () => {
    clearPublicAddressCache();
    await stopDynalite(ddbServer);
    await assert.rejects(resolveTenant(ctx({ host: 'lions.example.com' })));
    await assert.rejects(resolveTenant(ctx({ host: 'lions.example.com' })));
  });
});
