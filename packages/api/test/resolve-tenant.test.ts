/**
 * Unit tests for resolveTenant()'s prod host→tenant resolution.
 *
 * Runs in its own process (node --test isolates files), so env set here doesn't leak
 * into the integration suite. STAGE='prod' exercises the host path (x-tenant ignored);
 * TENANT_HOST_MAP must be set BEFORE importing auth — the map is parsed at module load.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'hono';

process.env.STAGE = 'prod';
process.env.TENANT_HOST_MAP = JSON.stringify({
  'dolphinspipeline.medicoach.co.za': 'dolphins',
  'www.dolphinspipeline.medicoach.co.za': 'dolphins',
  'api.dolphinspipeline.medicoach.co.za': 'dolphins',
});

const { resolveTenant } = await import('../src/auth.js');

/** Minimal Context stub: resolveTenant only reads the `host` / `x-tenant` headers. */
const ctx = (headers: Record<string, string>) =>
  ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
  }) as unknown as Context;

describe('resolveTenant (prod, host→tenant map)', () => {
  test('maps the API custom host to its tenant', () => {
    assert.equal(resolveTenant(ctx({ host: 'api.dolphinspipeline.medicoach.co.za' })), 'dolphins');
  });

  test('maps the vanity web host (label != slug) to its tenant', () => {
    assert.equal(resolveTenant(ctx({ host: 'dolphinspipeline.medicoach.co.za' })), 'dolphins');
  });

  test('maps the www alias to its tenant', () => {
    assert.equal(resolveTenant(ctx({ host: 'www.dolphinspipeline.medicoach.co.za' })), 'dolphins');
  });

  test('lowercases and strips the port before lookup', () => {
    assert.equal(
      resolveTenant(ctx({ host: 'API.DolphinsPipeline.medicoach.co.za:443' })),
      'dolphins',
    );
  });

  test('ignores x-tenant in prod (host is the authorization boundary)', () => {
    assert.equal(
      resolveTenant(ctx({ host: 'dolphinspipeline.medicoach.co.za', 'x-tenant': 'lions' })),
      'dolphins',
    );
  });

  test('falls back to the leftmost label for clean per-union subdomains', () => {
    assert.equal(resolveTenant(ctx({ host: 'lions.example.com' })), 'lions');
  });

  test('returns null for raw execute-api hosts (no bypass)', () => {
    assert.equal(resolveTenant(ctx({ host: 'abc123.execute-api.af-south-1.amazonaws.com' })), null);
  });

  test('returns null for localhost and a missing host', () => {
    assert.equal(resolveTenant(ctx({ host: 'localhost' })), null);
    assert.equal(resolveTenant(ctx({})), null);
  });
});
