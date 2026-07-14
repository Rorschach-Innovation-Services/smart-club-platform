/**
 * validateTenantSlug — the slug becomes a LIVE hostname `<slug>.club.medicoach.co.za`,
 * so it must be a valid DNS label (no trailing hyphen) and never a reserved name.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateTenantSlug } from '../src/tenant-validation.js';

describe('validateTenantSlug', () => {
  test('accepts valid LDH slugs', () => {
    for (const slug of ['dolphins', 'sharks', 'club-one', 'a1', 'x-9-y']) {
      assert.equal(validateTenantSlug(slug), null, slug);
    }
  });

  test('rejects a trailing hyphen (not a resolvable DNS label)', () => {
    assert.notEqual(validateTenantSlug('demo-'), null);
  });

  test('rejects a leading hyphen or digit', () => {
    assert.notEqual(validateTenantSlug('-demo'), null);
    assert.notEqual(validateTenantSlug('9demo'), null);
  });

  test('rejects a single character (min 2) and over 32 chars', () => {
    assert.notEqual(validateTenantSlug('a'), null);
    assert.notEqual(validateTenantSlug('a'.repeat(33)), null);
  });

  test('rejects uppercase and other non-LDH characters', () => {
    assert.notEqual(validateTenantSlug('Demo'), null);
    assert.notEqual(validateTenantSlug('de_mo'), null);
    assert.notEqual(validateTenantSlug('de.mo'), null);
  });

  test('rejects reserved names', () => {
    for (const slug of ['www', 'api', 'platform', 'admin']) {
      assert.notEqual(validateTenantSlug(slug), null, slug);
    }
  });
});
