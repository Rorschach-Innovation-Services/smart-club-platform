/**
 * origins.ts — the two separated origin duties (CORS vs link/anti-phishing). Env is set
 * before import (the module parses ALLOWED_ORIGINS / WEB_ORIGIN_MAP at load); node --test
 * isolates this file's process.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.WILDCARD_ENABLED = '1';
process.env.WILDCARD_WEB_SUFFIX = '.club.medicoach.co.za';
process.env.ALLOWED_ORIGINS =
  'https://dolphinspipeline.medicoach.co.za,https://www.dolphinspipeline.medicoach.co.za';
process.env.WEB_ORIGIN_MAP = JSON.stringify({
  dolphins: 'https://dolphinspipeline.medicoach.co.za',
});

const {
  originAllowed,
  canonicalWebOrigin,
  originAllowedForTenant,
  tenantWebOrigin,
  hasVanityWebOrigin,
} = await import('../src/origins.js');

describe('originAllowed (CORS — broad)', () => {
  test('accepts an enumerated vanity origin', () => {
    assert.equal(originAllowed('https://dolphinspipeline.medicoach.co.za'), true);
  });
  test('accepts a single-label wildcard club origin', () => {
    assert.equal(originAllowed('https://demo.club.medicoach.co.za'), true);
  });
  test('accepts localhost and *.cloudfront.net (bare distribution)', () => {
    assert.equal(originAllowed('http://localhost:5173'), true);
    assert.equal(originAllowed('https://d123.cloudfront.net'), true);
  });
  test('rejects a multi-label wildcard origin and a foreign host', () => {
    assert.equal(originAllowed('https://a.b.club.medicoach.co.za'), false);
    assert.equal(originAllowed('https://evil.example.com'), false);
  });
  test('rejects a non-https wildcard origin', () => {
    assert.equal(originAllowed('http://demo.club.medicoach.co.za'), false);
  });
});

describe('canonicalWebOrigin', () => {
  test('returns the vanity origin for a tenant that has one', () => {
    assert.equal(
      canonicalWebOrigin('dolphins', 'dolphins'),
      'https://dolphinspipeline.medicoach.co.za',
    );
  });
  test('falls back to the wildcard host for a wildcard-only tenant', () => {
    assert.equal(canonicalWebOrigin('demo', 'demo'), 'https://demo.club.medicoach.co.za');
  });
  test('builds the wildcard host from the public label, not the slug, once renamed', () => {
    assert.equal(
      canonicalWebOrigin('westernprovincecricket', 'cobras'),
      'https://cobras.club.medicoach.co.za',
    );
  });
  test('a vanity entry (keyed by slug) wins over any label', () => {
    assert.equal(
      canonicalWebOrigin('dolphins', 'elsewhere'),
      'https://dolphinspipeline.medicoach.co.za',
    );
  });
});

describe('tenantWebOrigin / hasVanityWebOrigin', () => {
  test('a vanity tenant resolves without a label lookup (no table in this process)', async () => {
    assert.equal(await tenantWebOrigin('dolphins'), 'https://dolphinspipeline.medicoach.co.za');
  });
  test('hasVanityWebOrigin is true only for WEB_ORIGIN_MAP tenants', () => {
    assert.equal(hasVanityWebOrigin('dolphins'), true);
    assert.equal(hasVanityWebOrigin('demo'), false);
  });
});

describe('originAllowedForTenant (link/anti-phishing — strict)', () => {
  test("accepts the tenant's own vanity origin + www variant", () => {
    assert.equal(
      originAllowedForTenant('https://dolphinspipeline.medicoach.co.za', 'dolphins', 'dolphins'),
      true,
    );
    assert.equal(
      originAllowedForTenant(
        'https://www.dolphinspipeline.medicoach.co.za',
        'dolphins',
        'dolphins',
      ),
      true,
    );
  });
  test("accepts the tenant's wildcard origin", () => {
    assert.equal(originAllowedForTenant('https://demo.club.medicoach.co.za', 'demo', 'demo'), true);
    assert.equal(
      originAllowedForTenant('https://dolphins.club.medicoach.co.za', 'dolphins', 'dolphins'),
      true,
    );
  });
  test("a renamed tenant: accepts its new label's host, REJECTS its retired slug host", () => {
    assert.equal(
      originAllowedForTenant('https://cobras.club.medicoach.co.za', 'wpc', 'cobras'),
      true,
    );
    assert.equal(
      originAllowedForTenant('https://wpc.club.medicoach.co.za', 'wpc', 'cobras'),
      false,
    );
  });
  test('REJECTS a foreign *.cloudfront.net (the phishing hole CORS would allow)', () => {
    assert.equal(
      originAllowedForTenant('https://d123.cloudfront.net', 'dolphins', 'dolphins'),
      false,
    );
  });
  test('REJECTS another tenant’s origin', () => {
    assert.equal(
      originAllowedForTenant('https://dolphinspipeline.medicoach.co.za', 'demo', 'demo'),
      false,
    );
    assert.equal(
      originAllowedForTenant('https://demo.club.medicoach.co.za', 'dolphins', 'dolphins'),
      false,
    );
  });
  test('rejects localhost', () => {
    assert.equal(originAllowedForTenant('http://localhost:5173', 'dolphins', 'dolphins'), false);
  });
});
