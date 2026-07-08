/**
 * Unit tests for the org-copy fallback resolver in branding.ts — the single
 * chain every piece of interpolated org copy (emails, invites, signup) rides.
 * Pure function, no DynamoDB/Hono needed.
 *
 * The frontend ships a twin resolver (src/branding.ts resolveCopy) with the
 * same slot names and fallbacks; these tests pin the shared contract.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orgCopy } from '../src/branding.js';
import type { TenantConfig } from '../src/types.js';

const branding = (
  over: Partial<TenantConfig['branding']> = {},
): Pick<TenantConfig, 'branding' | 'tenant'> => ({
  tenant: 'sharks',
  branding: {
    name: '',
    title: '',
    logoUrl: '/logo.png',
    colors: {},
    copy: {},
    ...over,
  },
});

describe('orgCopy · fallback chain', () => {
  test('null/undefined config → neutral platform defaults', () => {
    for (const cfg of [null, undefined]) {
      assert.deepEqual(orgCopy(cfg), {
        name: 'Smart Club',
        title: 'Smart Club',
        orgShort: 'Smart Club',
        office: 'Smart Club office',
        cohort: 'Smart Club cohort',
      });
    }
  });

  test('slug-only config (no branding) → slug-derived copy', () => {
    assert.deepEqual(orgCopy({ tenant: 'sharks' }), {
      name: 'sharks',
      title: 'sharks',
      orgShort: 'sharks',
      office: 'sharks office',
      cohort: 'sharks cohort',
    });
  });

  test('empty branding strings fall through to the slug', () => {
    assert.equal(orgCopy(branding()).name, 'sharks');
  });

  test('title-only branding: name and title both resolve to the title', () => {
    const c = orgCopy(branding({ title: 'Sharks Smart Club' }));
    assert.equal(c.name, 'Sharks Smart Club');
    assert.equal(c.title, 'Sharks Smart Club');
  });

  test('name without title: title falls back to name', () => {
    const c = orgCopy(branding({ name: 'The Sharks' }));
    assert.equal(c.title, 'The Sharks');
  });

  test('partial branding, no copy slots: derived office/cohort from orgShort', () => {
    const c = orgCopy(branding({ name: 'The Sharks', title: 'Sharks Portal' }));
    assert.deepEqual(c, {
      name: 'The Sharks',
      title: 'Sharks Portal',
      orgShort: 'The Sharks',
      office: 'The Sharks office',
      cohort: 'The Sharks cohort',
    });
  });

  test('orgShort drives derived office/cohort when the explicit slots are absent', () => {
    const c = orgCopy(branding({ name: 'The Sharks', copy: { orgShort: 'Sharks' } }));
    assert.equal(c.orgShort, 'Sharks');
    assert.equal(c.office, 'Sharks office');
    assert.equal(c.cohort, 'Sharks cohort');
  });

  test('full copy slots win over every derivation (dolphins seed shape)', () => {
    const c = orgCopy(
      branding({
        name: 'Hollywoodbets Dolphins',
        title: 'Dolphins Pipeline',
        copy: {
          orgShort: 'Dolphins',
          office: 'Dolphins office',
          cohortName: 'Dolphins Pipeline cohort',
        },
      }),
    );
    assert.deepEqual(c, {
      name: 'Hollywoodbets Dolphins',
      title: 'Dolphins Pipeline',
      orgShort: 'Dolphins',
      office: 'Dolphins office',
      cohort: 'Dolphins Pipeline cohort',
    });
  });
});
