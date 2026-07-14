/**
 * resolveTenant() on the SHARED API host (wildcard platform, scheme 1). When the API is
 * hit at SHARED_API_HOST the Host can't identify the tenant (it's api.club.* for
 * everyone), so the tenant comes from the request's Origin. Env is set before importing
 * auth (the map + shared-host consts are read at module load); node --test isolates this
 * file's process so it doesn't leak into the other suites.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'hono';

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

const { resolveTenant } = await import('../src/auth.js');

const SHARED = 'api.club.medicoach.co.za';
const ctx = (headers: Record<string, string>) =>
  ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
  }) as unknown as Context;

describe('resolveTenant (shared API host, Origin-derived)', () => {
  test('resolves a wildcard web Origin to its leftmost label', () => {
    assert.equal(
      resolveTenant(ctx({ host: SHARED, origin: 'https://demo.club.medicoach.co.za' })),
      'demo',
    );
  });

  test('resolves a vanity web Origin via the host→tenant map', () => {
    assert.equal(
      resolveTenant(ctx({ host: SHARED, origin: 'https://clubs.sharks.co.za' })),
      'sharks',
    );
  });

  test('returns null (never the reserved "api") when the Origin is missing', () => {
    assert.equal(resolveTenant(ctx({ host: SHARED })), null);
  });

  test('returns null for a garbage Origin', () => {
    assert.equal(resolveTenant(ctx({ host: SHARED, origin: 'not a url' })), null);
  });

  test('returns null for a multi-label wildcard Origin (a.b.club.…)', () => {
    assert.equal(
      resolveTenant(ctx({ host: SHARED, origin: 'https://a.b.club.medicoach.co.za' })),
      null,
    );
  });

  test('returns null for a foreign Origin not under the suffix or in the map', () => {
    assert.equal(resolveTenant(ctx({ host: SHARED, origin: 'https://evil.example.com' })), null);
  });

  test('a per-tenant API host still resolves by Host, ignoring Origin', () => {
    assert.equal(
      resolveTenant(
        ctx({
          host: 'api.dolphinspipeline.medicoach.co.za',
          origin: 'https://demo.club.medicoach.co.za',
        }),
      ),
      'dolphins',
    );
  });
});
