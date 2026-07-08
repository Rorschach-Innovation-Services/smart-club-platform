/**
 * Unit tests for the per-tenant feature-flag reader in features.ts. Pure
 * function, no DynamoDB/Hono needed.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasFeature } from '../src/features.js';
import type { TenantConfig } from '../src/types.js';

const cfg = (features?: Record<string, boolean>): TenantConfig =>
  ({ tenant: 't', features }) as TenantConfig;

describe('hasFeature', () => {
  test('null/undefined config → the per-flag default', () => {
    assert.equal(hasFeature(null, 'whatsappInvites', true), true);
    assert.equal(hasFeature(undefined, 'whatsappInvites', true), true);
    assert.equal(hasFeature(null, 'selfServeBranding'), false);
  });

  test('missing features map / missing key → the default (false when omitted)', () => {
    assert.equal(hasFeature(cfg(), 'whatsappInvites', true), true);
    assert.equal(hasFeature(cfg({}), 'whatsappInvites', true), true);
    assert.equal(hasFeature(cfg({}), 'selfServeBranding'), false);
  });

  test('an explicit stored boolean beats the default in both directions', () => {
    assert.equal(hasFeature(cfg({ whatsappInvites: false }), 'whatsappInvites', true), false);
    assert.equal(hasFeature(cfg({ selfServeBranding: true }), 'selfServeBranding'), true);
  });

  test('non-boolean junk on the row falls back to the default, not truthiness', () => {
    const junk = cfg({ whatsappInvites: 'yes' as unknown as boolean });
    assert.equal(hasFeature(junk, 'whatsappInvites', false), false);
  });
});
