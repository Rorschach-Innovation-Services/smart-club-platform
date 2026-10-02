import { describe, it, expect } from 'vitest';
import {
  releasedFixtures,
  clubFixtures,
  seasonStarted,
  seasonProgress,
  weekWindow,
  seriesProgress,
  addDays,
  daysBetween,
} from './season';

const clubs = [
  { id: 'ukzn', name: 'UKZN CC', ground: { venue: 'Howard College Oval' } },
  { id: 'clares', name: 'Clares CC', ground: { venue: 'Clares Park' } },
  { id: 'umlazi', name: 'Umlazi CC', ground: { venue: 'Umlazi Comtech' } },
];
const clubBy = (id: string) => clubs.find((c) => c.id === id);

const legacy = {
  id: 's1',
  name: 'Division 1',
  released: true,
  teams: ['ukzn', 'clares', 'umlazi'],
  fixtures: [
    { id: 'f1', date: '2026-10-03', home: 'ukzn', away: 'clares' },
    { id: 'f2', date: '2026-10-10', home: 'umlazi', away: 'ukzn' },
    { id: 'f3', date: '2026-09-26', home: 'clares', away: 'umlazi', venueOverride: 'Kingsmead' },
  ],
};
const unreleased = { ...legacy, id: 's2', released: false };
// Multi-team club: UKZN plays as tm_ukzn_2 in this series.
const multi = {
  id: 's3',
  name: 'Women',
  released: true,
  teams: ['tm_ukzn_2', 'clares'],
  participants: [
    { teamId: 'tm_ukzn_2', clubId: 'ukzn', name: 'UKZN Women' },
    { teamId: 'clares', clubId: 'clares', name: 'Clares Women' },
  ],
  fixtures: [{ id: 'w1', date: '2026-10-04', home: 'clares', away: 'tm_ukzn_2' }],
  withheld: { venue: true },
};

describe('season fixtures', () => {
  it('collects released fixtures only, sorted by date, with resolved names and venues', () => {
    const all = releasedFixtures([legacy, unreleased, multi], clubBy);
    expect(all.map((f) => f.key)).toEqual(['s1:f3', 's1:f1', 's3:w1', 's1:f2']);
    expect(all[0].venue).toBe('Kingsmead'); // allocated ground wins
    expect(all[1].venue).toBe('Howard College Oval'); // home ground
    expect(all[2].venue).toBe('Venue to be confirmed'); // withheld
    expect(all[2].awayName).toBe('UKZN Women');
  });

  it("gives one club's fixtures newest first, including multi-team appearances", () => {
    const mine = clubFixtures([legacy, multi], 'ukzn', clubBy);
    expect(mine.map((f) => [f.key, f.isHome, f.oppName])).toEqual([
      ['s1:f2', false, 'Umlazi CC'],
      ['s3:w1', false, 'Clares Women'],
      ['s1:f1', true, 'Clares CC'],
    ]);
  });
});

describe('season state', () => {
  const fx = releasedFixtures([legacy], clubBy);
  it('starts once the first fixture date arrives', () => {
    expect(seasonStarted(fx, '2026-09-25')).toBe(false);
    expect(seasonStarted(fx, '2026-09-26')).toBe(true);
  });
  it('tracks progress', () => {
    const p = seasonProgress(fx, '2026-10-03');
    expect(p).toMatchObject({ total: 3, played: 1, today: 1, remaining: 1, next: '2026-10-03' });
    expect(p.pct).toBe(33);
  });
  it('splits the week either side of today', () => {
    const w = weekWindow(fx, '2026-10-02', 7);
    expect(w.upcoming.map((f) => f.date)).toEqual(['2026-10-03']);
    expect(w.recent.map((f) => f.date)).toEqual(['2026-09-26']);
  });
  it('reports per-series progress', () => {
    expect(seriesProgress(fx, '2026-10-04')[0]).toMatchObject({ played: 2, total: 3 });
  });
  it('does local date maths', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(daysBetween('2026-10-02', '2026-10-04')).toBe(2);
  });
});
