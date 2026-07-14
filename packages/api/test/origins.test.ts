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

const { originAllowed, canonicalWebOrigin, originAllowedForTenant } =
  await import('../src/origins.js');

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
    assert.equal(canonicalWebOrigin('dolphins'), 'https://dolphinspipeline.medicoach.co.za');
  });
  test('falls back to the wildcard host for a wildcard-only tenant', () => {
    assert.equal(canonicalWebOrigin('demo'), 'https://demo.club.medicoach.co.za');
  });
});

describe('originAllowedForTenant (link/anti-phishing — strict)', () => {
  test("accepts the tenant's own vanity origin + www variant", () => {
    assert.equal(
      originAllowedForTenant('https://dolphinspipeline.medicoach.co.za', 'dolphins'),
      true,
    );
    assert.equal(
      originAllowedForTenant('https://www.dolphinspipeline.medicoach.co.za', 'dolphins'),
      true,
    );
  });
  test("accepts the tenant's wildcard origin", () => {
    assert.equal(originAllowedForTenant('https://demo.club.medicoach.co.za', 'demo'), true);
    assert.equal(originAllowedForTenant('https://dolphins.club.medicoach.co.za', 'dolphins'), true);
  });
  test('REJECTS a foreign *.cloudfront.net (the phishing hole CORS would allow)', () => {
    assert.equal(originAllowedForTenant('https://d123.cloudfront.net', 'dolphins'), false);
  });
  test('REJECTS another tenant’s origin', () => {
    assert.equal(originAllowedForTenant('https://dolphinspipeline.medicoach.co.za', 'demo'), false);
    assert.equal(originAllowedForTenant('https://demo.club.medicoach.co.za', 'dolphins'), false);
  });
  test('rejects localhost', () => {
    assert.equal(originAllowedForTenant('http://localhost:5173', 'dolphins'), false);
  });
});
