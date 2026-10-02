import { describe, it, expect } from 'vitest';

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
