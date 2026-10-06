import { describe, it, expect } from 'vitest';
import type { ScoutInnings } from './scouting-matches';
import type { ProMatch } from './pro-scorecards';
import { detectSquads } from './pro-team';
import { exitReport, normName, statusOf } from './pro-exits';

// Invented teams and players.
const inn = (bat: string, fld: string, batters: string[], bowlers: string[]): ScoutInnings => ({
  bat,
  fld,
  total: 100,
  wkts: 5,
  overs: '20',
  extras: 0,
  exb: { w: 0, nb: 0, b: 0, lb: 0 },
  batting: batters.map((n, i) => ({ n, pos: i + 1, r: 20, b: 15, f4: 1, f6: 0, out: 'b X' })),
  bowling: bowlers.map((n) => ({ n, o: '4', m: 0, r: 30, w: 1, wd: 0, nb: 0, dots: 8 })),
  fow: [],
  perOver: [],
});
const match = (date: string, us: string[], opp: string, them: string[]): ProMatch => ({
  id: `${date}-${opp}`,
  date,
  event: 'T20',
  stage: '',
  overs: 20,
  venue: '',
  home: 'Acme Hawks',
  away: opp,
  winner: null,
  result: '',
  innings: [inn('Acme Hawks', opp, us, them), inn(opp, 'Acme Hawks', them, us)],
  format: 'T20',
  gender: 'men',
  season: `${Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 8 ? 1 : 0)}/${String((Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 8 ? 1 : 0) + 1) % 100).padStart(2, '0')}`,
  resultKind: 'unknown',
});

const ms = [
  match('2024-10-01', ['Ann Old', 'Ben Stay', 'Cal Gone'], 'Bay Gulls', ['Gus One']),
  match('2025-02-01', ['Ann Old', 'Ben Stay', 'Cal Gone'], 'Bay Gulls', ['Gus One']),
  match('2025-08-20', ['Ben Stay', 'Dee New', 'Cal Gone'], 'Bay Gulls', ['Gus One']),
  // Ann turns up for the Gulls after leaving.
  match('2026-01-10', ['Ben Stay', 'Dee New'], 'Bay Gulls', ['Ann Old']),
  match('2026-03-01', ['Ben Stay', 'Dee New'], 'Bay Gulls', ['Gus One']),
];
const [squad] = detectSquads(ms);
// Three more games without Ann or Cal, so both are out of the squad.
const more = [
  ...ms,
  ...['2026-03-05', '2026-03-08', '2026-03-12'].map((d) =>
    match(d, ['Ben Stay', 'Dee New'], 'Bay Gulls', ['Gus One']),
  ),
];
const [sqMore] = detectSquads(more);

describe('exits', () => {
  it('counts games missed in the player’s formats, and time from the newest game in the files', () => {
    expect(statusOf(2, 400)).toBe('active');
    expect(statusOf(5, 200)).toBe('fading');
    expect(statusOf(5, 400)).toBe('exited');
    const r = exitReport(squad, ms);
    expect(r.asOf).toBe('2026-03-01');
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
    expect(by['Ben Stay']).toMatchObject({ status: 'active', missed: 0 });
    expect(by['Cal Gone']).toMatchObject({ missed: 2, status: 'active' }); // only 2 games since
    // Three more games without them: Cal drops out, Ann (a year gone) has exited.
    const later = Object.fromEntries(exitReport(sqMore, more).rows.map((x) => [x.name, x]));
    expect(later['Cal Gone']).toMatchObject({ missed: 5, status: 'fading' });
    expect(later['Ann Old']).toMatchObject({ missed: 6, status: 'exited' });
    expect(later['Ann Old'].seasons).toEqual({ '2024/25': 2 });
  });

  it('finds a player at another franchise after they left, and nowhere else', () => {
    const r = exitReport(sqMore, more);
    const ann = r.rows.find((x) => x.name === 'Ann Old')!;
    expect(ann.whereNow).toBe('still-playing');
    expect(ann.sightings[0]).toMatchObject({
      kind: 'franchise',
      where: 'Gulls',
      date: '2026-01-10',
    });
    const cal = r.rows.find((x) => x.name === 'Cal Gone')!;
    expect(cal.whereNow).toBe('no-trace');
  });

  it('matches names across sources ignoring case and accents, and counts a registration as playing', () => {
    expect(normName('Cál  GONE')).toBe('cal gone');
    const r = exitReport(sqMore, more, {
      register: [{ name: 'CAL gone', club: 'Ridgeview CC', since: '2024-01-01' }],
      clearances: [
        {
          name: 'Cal Gone',
          from: 'Ridgeview CC',
          to: 'Hilltop CC',
          date: '2026-02-01',
          status: 'approved',
        },
      ],
      pools: [
        {
          id: 'p',
          name: 'Invented pool',
          gender: 'men',
          format: 'T20',
          source: '',
          date: '2026-02-20',
          players: [
            {
              name: 'Cal Gone',
              club: 'Hilltop CC',
              union: 'Highveld',
              role: 'Batter',
              games: 2,
              lists: [],
            },
          ],
        },
      ],
    });
    const cal = r.rows.find((x) => x.name === 'Cal Gone')!;
    expect(cal.whereNow).toBe('still-playing');
    expect(cal.sightings.map((s) => s.kind)).toEqual(['club', 'clearance', 'register']);
  });

  it('counts who was kept, who arrived and who left each season', () => {
    const r = exitReport(squad, ms);
    expect(r.flow).toEqual([
      { season: '2024/25', games: 2, partial: false, retained: 0, arrived: 3, left: 0 },
      // The newest season, with fewer than 6 games, is flagged as still under way.
      { season: '2025/26', games: 3, partial: true, retained: 2, arrived: 1, left: 1 },
    ]);
  });
});
