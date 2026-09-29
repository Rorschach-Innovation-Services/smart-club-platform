import { describe, it, expect } from 'vitest';
import { VERTICALS, resolveVertical, pitchCountLabel } from './vertical';
import { VERTICALS as API_VERTICALS } from '../packages/api/src/vertical';
import { COACHING_BODIES, COACHING_LEVELS } from './data';
import { resolveCopy } from './branding';

describe('vertical profiles', () => {
  it('match the API twin exactly', () => {
    expect(VERTICALS).toEqual(API_VERTICALS);
  });

  it('resolve cricket when sport is absent or unknown', () => {
    expect(resolveVertical(undefined).sport).toBe('cricket');
    expect(resolveVertical({}).sport).toBe('cricket');
    expect(resolveVertical({ sport: 'netball' as never }).sport).toBe('cricket');
    expect(resolveVertical({ sport: 'football' }).sport).toBe('football');
  });

  it('keep the cricket coaching vocabulary identical to data.ts', () => {
    expect(VERTICALS.cricket.coachingBodies).toEqual(COACHING_BODIES);
    expect(VERTICALS.cricket.coachingLevels).toEqual(COACHING_LEVELS);
  });
});

describe('resolveCopy · vertical terms', () => {
  it('cricket terms reproduce the existing club defaults', () => {
    const c = resolveCopy({ name: 'Dolphins' }, VERTICALS.cricket.terms);
    expect(c).toEqual(resolveCopy({ name: 'Dolphins' }));
    expect(c.heroTitle).toBe('From your club to the Dolphins.');
  });

  it('football terms say "school" in the derived hero copy', () => {
    const c = resolveCopy({ name: 'Cape Schools' }, VERTICALS.football.terms);
    expect(c.heroTitle).toBe('From your school to the Cape Schools.');
    expect(c.heroBlurb).toMatch(/^Affiliated schools join the Cape Schools ecosystem/);
  });

  it('explicit branding copy still wins over the vertical default', () => {
    const c = resolveCopy(
      { name: 'Cape Schools', copy: { heroTitle: 'Play for your school.' } },
      VERTICALS.football.terms,
    );
    expect(c.heroTitle).toBe('Play for your school.');
  });
});

describe('pitchCountLabel', () => {
  it('says fields for football and fields / ovals for cricket', () => {
    expect(pitchCountLabel('football')).toBe('Number of fields');
    expect(pitchCountLabel('cricket')).toBe('Number of fields / ovals');
  });
});
