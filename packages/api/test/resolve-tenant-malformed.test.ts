/**
 * resolveTenant() must degrade safely when TENANT_HOST_MAP is malformed: empty map,
 * leftmost-label fallback still works, no throw. Separate file because the map is parsed
 * once at module load — this process gets the bad value before importing auth.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'hono';

process.env.STAGE = 'prod';
process.env.TENANT_HOST_MAP = '{ not valid json';

const { resolveTenant } = await import('../src/auth.js');

const ctx = (host: string) =>
  ({
    req: { header: (n: string) => (n.toLowerCase() === 'host' ? host : undefined) },
  }) as unknown as Context;

describe('resolveTenant (malformed TENANT_HOST_MAP)', () => {
  test('does not throw and falls back to the leftmost label', () => {
    assert.equal(resolveTenant(ctx('lions.example.com')), 'lions');
  });

  test('still rejects execute-api/localhost (no bypass)', () => {
    assert.equal(resolveTenant(ctx('abc.execute-api.af-south-1.amazonaws.com')), null);
    assert.equal(resolveTenant(ctx('localhost')), null);
  });
});
