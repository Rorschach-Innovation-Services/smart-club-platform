import { describe, it, expect } from 'vitest';
import { misconductDeadline, OFFENCE_LEVELS } from './CaptainsReport';

describe('misconductDeadline (Code clause 4.1 — third business day)', () => {
  it('skips the weekend after a Friday match', () => {
    expect(misconductDeadline('2026-10-02')).toBe('2026-10-07');
  });
  it('counts Mon→Thu for a Saturday or Sunday match', () => {
    expect(misconductDeadline('2026-10-03')).toBe('2026-10-07');
    expect(misconductDeadline('2026-10-04')).toBe('2026-10-07');
  });
  it('rolls over a weekend mid-count', () => {
    expect(misconductDeadline('2026-10-07')).toBe('2026-10-12');
  });
  it('returns null without a date', () => {
    expect(misconductDeadline('')).toBeNull();
  });
});

describe('OFFENCE_LEVELS', () => {
  it('covers levels 1–5 with unique offence codes', () => {
    expect(OFFENCE_LEVELS.map((l) => l.level)).toEqual([1, 2, 3, 4, 5]);
    const codes = OFFENCE_LEVELS.flatMap((l) => l.offences.map((o) => o.code));
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('captain report rosters', () => {
  it('sample roster is stable per club and has no duplicate names', async () => {
    const { sampleRoster } = await import('./captainsReportRoster');
    const a = sampleRoster('crusaders');
    expect(sampleRoster('crusaders')).toEqual(a);
    const names = [...a.players, ...a.coaches, ...a.officials].map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(sampleRoster('umlazi').players).not.toEqual(a.players);
  });
  it('own roster prefers real registrations', async () => {
    const { ownRoster } = await import('./captainsReportRoster');
    const r = ownRoster({ id: 'ukzn' }, [
      { firstName: 'Zane', lastName: 'Adams' },
      { firstName: 'Ayanda', lastName: 'Cele' },
    ]);
    expect(r.sample).toBe(false);
    expect(r.players.map((p) => p.name)).toEqual(['Ayanda Cele', 'Zane Adams']);
  });
});
