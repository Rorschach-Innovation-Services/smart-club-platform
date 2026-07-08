import { describe, it, expect } from 'vitest';
import { resolveCopy } from './branding';

describe('resolveCopy', () => {
  it('falls back to neutral Smart Club copy with no branding at all', () => {
    const c = resolveCopy(undefined);
    expect(c.orgName).toBe('Smart Club');
    expect(c.orgShort).toBe('Smart Club');
    expect(c.office).toBe('Smart Club office');
    expect(c.admin).toBe('Smart Club administrators');
    expect(c.cohortName).toBe('Smart Club cohort');
    expect(c.heroTitle).toBe('From your club to the Smart Club.');
    expect(c.crumbRoot).toBe('Smart Club');
    expect(c.eyebrow).toBe('Smart Club');
    expect(c.welcome).toBe('Sign in');
    expect(c.footer).toBe('Powered by Medicoach');
    expect(c.support).toBe('');
  });

  it('derives everything from branding.name when copy is empty', () => {
    const c = resolveCopy({ name: 'Hollywoodbets Dolphins', copy: {} });
    expect(c.orgName).toBe('Hollywoodbets Dolphins');
    expect(c.orgShort).toBe('Hollywoodbets Dolphins');
    expect(c.office).toBe('Hollywoodbets Dolphins office');
    expect(c.cohortName).toBe('Hollywoodbets Dolphins cohort');
    expect(c.heroTitle).toBe('From your club to the Hollywoodbets Dolphins.');
    expect(c.crumbRoot).toBe('Hollywoodbets Dolphins');
    expect(c.heroBlurb).toContain('Hollywoodbets Dolphins ecosystem');
  });

  it('uses branding.title when name is missing', () => {
    const c = resolveCopy({ title: 'Lions Pipeline' });
    expect(c.orgName).toBe('Lions Pipeline');
    expect(c.office).toBe('Lions Pipeline office');
  });

  it('cascades an orgShort override into the derived slots', () => {
    const c = resolveCopy({ name: 'Hollywoodbets Dolphins', copy: { orgShort: 'Dolphins' } });
    expect(c.orgName).toBe('Hollywoodbets Dolphins');
    expect(c.orgShort).toBe('Dolphins');
    expect(c.office).toBe('Dolphins office');
    expect(c.admin).toBe('Dolphins administrators');
    expect(c.cohortName).toBe('Dolphins cohort');
    expect(c.heroTitle).toBe('From your club to the Dolphins.');
    expect(c.crumbRoot).toBe('Dolphins');
  });

  it('lets explicit copy slots win over every derived default', () => {
    const c = resolveCopy({
      name: 'Lions Cricket',
      copy: {
        orgShort: 'Lions',
        office: 'Lions HQ',
        admin: 'Lions admin team',
        cohortName: 'Pride cohort',
        heroTitle: 'Roar with the Lions.',
        heroBlurb: 'Custom blurb.',
        crumbRoot: 'Lions Cricket',
        welcome: 'Welcome back',
        eyebrow: 'Lions · DP World',
        footer: 'Powered by Lions',
        support: 'Lions Office · office@lions.co.za',
      },
    });
    expect(c.office).toBe('Lions HQ');
    expect(c.admin).toBe('Lions admin team');
    expect(c.cohortName).toBe('Pride cohort');
    expect(c.heroTitle).toBe('Roar with the Lions.');
    expect(c.heroBlurb).toBe('Custom blurb.');
    expect(c.crumbRoot).toBe('Lions Cricket');
    expect(c.welcome).toBe('Welcome back');
    expect(c.eyebrow).toBe('Lions · DP World');
    expect(c.footer).toBe('Powered by Lions');
    expect(c.support).toBe('Lions Office · office@lions.co.za');
  });

  it('treats empty-string slots as unset (fallback chain uses ||)', () => {
    const c = resolveCopy({ name: 'Dolphins', copy: { office: '', orgShort: '' } });
    expect(c.orgShort).toBe('Dolphins');
    expect(c.office).toBe('Dolphins office');
  });
});
