/**
 * Unit tests for the sport-vertical resolver (vertical.ts), hasModule (features.ts), the
 * operator sport/seasonLabel validators, the football tenant builder defaults and the
 * pitchCount check in validateClubPatch. Pure functions, no DynamoDB/Hono needed.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVertical, seasonLabel, VERTICALS } from '../src/vertical.js';
import { hasModule } from '../src/features.js';
import { validateSport, validateSeasonLabel } from '../src/tenant-validation.js';
import { validateClubPatch } from '../src/catalogue.js';
import type { TenantConfig } from '../src/types.js';

const cfg = (over: Partial<TenantConfig> = {}): TenantConfig =>
  ({ tenant: 't', ...over }) as TenantConfig;

describe('resolveVertical', () => {
  test('absent / null / unknown sport → the cricket profile', () => {
    for (const c of [null, undefined, cfg(), cfg({ sport: 'rugby' as never })]) {
      assert.equal(resolveVertical(c).sport, 'cricket');
    }
  });

  test('cricket profile reproduces the existing literals', () => {
    const v = resolveVertical(cfg({ sport: 'cricket' }));
    assert.deepEqual(
      v.leadershipRoles.map((r) => [r.key, r.label, r.required]),
      [
        ['chair', 'Chairperson', true],
        ['sec', 'Secretary', true],
        ['tre', 'Treasurer', true],
        ['vc', 'Vice-Chair', false],
      ],
    );
    assert.deepEqual(v.coachingBodies, ['None', 'CSA', 'Gary Kirsten']);
    assert.deepEqual(v.coachingLevels, ['None', 'Level 1', 'Level 2', 'Level 3', 'Level 4']);
    assert.equal(v.playerProfile, 'cricket');
    assert.deepEqual(v.affiliationSteps, [
      'Club Details',
      'Executive Committee',
      'Leagues & Coaches',
    ]);
    assert.equal(v.terms.Club, 'Club');
    assert.equal(v.terms.sport, 'cricket');
  });

  test('football profile: school terms, leadership roles on the frozen keys, positions', () => {
    const v = resolveVertical(cfg({ sport: 'football' }));
    assert.equal(v, VERTICALS.football);
    assert.equal(v.terms.Club, 'School');
    assert.equal(v.terms.clubs, 'schools');
    assert.equal(v.terms.Chair, 'Principal');
    assert.equal(v.terms.Exco, 'School Leadership');
    assert.equal(v.terms.sport, 'football');
    assert.deepEqual(
      v.leadershipRoles.map((r) => [r.key, r.label, r.required]),
      [
        ['chair', 'Principal', true],
        ['sec', 'Director of Sport', true],
        ['tre', 'Director of Football', true],
        ['vc', 'Director of Academics', false],
      ],
    );
    assert.equal(v.playerProfile, 'positions');
    assert.ok(v.positions.includes('Goalkeeper'));
    assert.ok(!v.positions.includes('Fullback'));
    assert.deepEqual(v.coachingBodies, ['None', 'CAF', 'UEFA', 'SAFA']);
    assert.deepEqual(v.coachingLevels, ['None', 'A', 'B', 'C', 'D']);
    assert.deepEqual(v.affiliationSteps, [
      'School Details',
      'School Leadership',
      'Leagues & Coaches',
    ]);
  });
});

describe('hasModule', () => {
  const MODULES = ['veterans', 'cqi', 'compliance', 'clearances'] as const;

  test('cricket (and absent sport) defaults every module on', () => {
    for (const c of [null, cfg(), cfg({ sport: 'cricket' })]) {
      for (const m of MODULES) assert.equal(hasModule(c, m), true, m);
    }
  });

  test('football defaults every module off', () => {
    for (const m of MODULES) assert.equal(hasModule(cfg({ sport: 'football' }), m), false, m);
  });

  test('a stored module.* flag overrides the default in both directions', () => {
    const football = cfg({ sport: 'football', features: { 'module.cqi': true } });
    assert.equal(hasModule(football, 'cqi'), true);
    assert.equal(hasModule(football, 'veterans'), false);
    const cricket = cfg({ features: { 'module.clearances': false } });
    assert.equal(hasModule(cricket, 'clearances'), false);
    assert.equal(hasModule(cricket, 'compliance'), true);
  });
});

describe('operator vertical validators', () => {
  test('validateSport accepts the known sports only', () => {
    assert.equal(validateSport('cricket'), null);
    assert.equal(validateSport('football'), null);
    assert.match(validateSport('rugby') ?? '', /sport must be one of/);
    assert.match(validateSport(3) ?? '', /sport must be one of/);
  });

  test('validateSeasonLabel wants a short non-empty string', () => {
    assert.equal(validateSeasonLabel('2027'), null);
    assert.match(validateSeasonLabel('  ') ?? '', /non-empty/);
    assert.match(validateSeasonLabel(2027) ?? '', /non-empty/);
    assert.match(validateSeasonLabel('x'.repeat(21)) ?? '', /20 characters/);
  });
});

describe('buildTenantConfig · sport', async () => {
  // seed-core imports the repo, which reads TABLE_NAME at load (never touched here).
  process.env.TABLE_NAME ??= 'VerticalUnitTest';
  const { buildTenantConfig } = await import('../src/seed-core.js');

  test('cricket / omitted sport leaves the new fields absent (legacy shape)', () => {
    const c = buildTenantConfig('t', { name: 'T' }, '2026-10-01', undefined, [], []);
    assert.equal('sport' in c, false);
    assert.equal('requiredDocs' in c, false);
    assert.equal('tutorialsNoFallback' in c, false);
    assert.equal('features' in c, false);
  });

  test('football seeds requiredDocs [] explicitly, WhatsApp off and no tutorial fallback', () => {
    const c = buildTenantConfig('t', { name: 'T' }, '2026-10-01', undefined, [], [], 'football');
    assert.equal(c.sport, 'football');
    assert.deepEqual(c.requiredDocs, []);
    assert.deepEqual(c.features, { whatsappInvites: false });
    assert.equal(c.tutorialsNoFallback, true);
  });

  test('operator-supplied features still win over the football defaults', () => {
    const c = buildTenantConfig(
      't',
      { name: 'T' },
      '2026-10-01',
      { whatsappInvites: true, 'module.cqi': true },
      [],
      [],
      'football',
    );
    assert.deepEqual(c.features, { whatsappInvites: true, 'module.cqi': true });
  });
});

describe('validateClubPatch · ground.pitchCount', () => {
  const check = (pitchCount: unknown) =>
    validateClubPatch({ ground: { pitchCount } }, new Set(), new Set(), new Set());

  test('whole numbers 0–99 (and absent/null) pass', () => {
    for (const n of [undefined, null, 0, 1, 4, 99]) assert.equal(check(n), null, String(n));
  });

  test('fractions, negatives, >99 and non-numbers are rejected', () => {
    for (const n of [1.5, -1, 100, '3', true]) {
      assert.match(check(n) ?? '', /whole number between 0 and 99/, String(n));
    }
  });
});

describe('seasonLabel (display only)', () => {
  const sept2026 = new Date(2026, 8, 28);

  test('absent / blank configured label → the built-in current season label', () => {
    for (const c of [null, undefined, cfg(), cfg({ seasonLabel: '   ' })]) {
      assert.equal(seasonLabel(c, sept2026), '2026/27');
    }
  });

  test('a configured label wins, trimmed', () => {
    assert.equal(seasonLabel(cfg({ seasonLabel: ' 2027 ' }), sept2026), '2027');
  });
});
