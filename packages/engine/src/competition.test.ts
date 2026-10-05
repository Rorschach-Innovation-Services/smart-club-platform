import { describe, it, expect } from 'vitest';
import {
  advanceKnockout,
  type AdvanceFixture,
  competitionProblems,
  planCompetition,
  shuffleWithSeed,
  type CompetitionSpec,
} from './competition';

const team = (i: number) => ({
  teamId: `t${i}`,
  clubId: `c${i}`,
  name: `Team ${i}`,
  venue: `Ground ${i}`,
});
const teams = (n: number) => Array.from({ length: n }, (_, i) => team(i + 1));
const spec = (over: Partial<CompetitionSpec> = {}): CompetitionSpec => ({
  id: 'c-premier-t20',
  type: 'league',
  name: 'Premier T20',
  leagueKey: 'premier',
  overs: 20,
  teams: teams(6),
  format: { kind: 'round-robin', legs: 1 },
  schedule: { startDate: '2026-10-10', everyDays: 7, times: ['10:00', '13:30'] },
  ...over,
});
const fixturesOf = (s: { fixtures: unknown[] }) =>
  s.fixtures as Array<{
    id: string;
    round: number;
    date: string;
    time?: string;
    home: string;
    away: string;
    status: string;
  }>;

describe('planCompetition — league', () => {
  it('a single round robin: everyone meets once, one game each per round, weekly, times cycling', () => {
    const plan = planCompetition(spec());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [s] = plan.series;
    const fx = fixturesOf(s);
    expect(fx).toHaveLength(15);
    expect(plan.summary).toEqual({
      rounds: 5,
      fixtures: 15,
      firstDate: '2026-10-10',
      lastDate: '2026-11-07',
    });
    const pairs = new Set(fx.map((f) => [f.home, f.away].sort().join('|')));
    expect(pairs.size).toBe(15);
    for (let r = 1; r <= 5; r++) {
      const round = fx.filter((f) => f.round === r);
      expect(new Set(round.flatMap((f) => [f.home, f.away])).size).toBe(6);
      expect(new Set(round.map((f) => f.date)).size).toBe(1);
    }
    expect(fx.slice(0, 3).map((f) => f.time)).toEqual(['10:00', '13:30', '10:00']);
    expect(s).toMatchObject({
      id: 'c-premier-t20',
      name: 'Premier T20',
      leagueKey: 'premier',
      maxOvers: 20,
      seriesType: 'League · 20 overs',
      released: false,
      approved: false,
      version: 1,
      competition: {
        id: 'c-premier-t20',
        type: 'league',
        role: 'league',
        points: { win: 4, tie: 2, noResult: 2, loss: 0 },
      },
    });
    expect(s.participants?.map((p) => p.venue)).toContain('Ground 1');
    expect(fx.every((f) => f.status === 'scheduled' && /^f\d+$/.test(f.id))).toBe(true);
  });

  it('two legs reverse home and away; an odd roster gets a bye; excluded dates push a round on', () => {
    const plan = planCompetition(
      spec({
        teams: teams(5),
        format: { kind: 'round-robin', legs: 2 },
        schedule: {
          startDate: '2026-10-10',
          everyDays: 7,
          times: [],
          excludeDates: ['2026-10-17'],
        },
      }),
    );
    if (!plan.ok) throw new Error(plan.problems.join());
    const fx = fixturesOf(plan.series[0]);
    expect(fx).toHaveLength(20); // 10 pairs × 2 legs
    const legs = new Map<string, number>();
    for (const f of fx) legs.set(`${f.home}>${f.away}`, (legs.get(`${f.home}>${f.away}`) ?? 0) + 1);
    expect([...legs.values()].every((n) => n === 1)).toBe(true); // each way once
    expect([...new Set(fx.map((f) => f.date))].slice(0, 3)).toEqual([
      '2026-10-10',
      '2026-10-24',
      '2026-10-31',
    ]);
    expect(fx.every((f) => f.time === undefined)).toBe(true);
  });

  it('randomise is a seeded shuffle: same seed, same draw; another seed, another draw', () => {
    const a = planCompetition(spec({ seed: 42 }));
    const b = planCompetition(spec({ seed: 42 }));
    const c = planCompetition(spec({ seed: 7 }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('refused');
    expect(fixturesOf(a.series[0])).toEqual(fixturesOf(b.series[0]));
    expect(fixturesOf(a.series[0])).not.toEqual(fixturesOf(c.series[0]));
    expect(a.series[0].competition.seed).toBe(42);
    expect(shuffleWithSeed([1, 2, 3, 4, 5], 3).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('planCompetition — tournaments', () => {
  it('a knockout cup: seeded bracket with winner slots, warns about a preliminary round', () => {
    const plan = planCompetition(
      spec({ type: 'tournament', teams: teams(6), format: { kind: 'knockout', thirdPlace: true } }),
    );
    if (!plan.ok) throw new Error(plan.problems.join());
    const fx = fixturesOf(plan.series[0]);
    expect(plan.series[0].competition.role).toBe('knockout');
    expect(fx.some((f) => f.home.startsWith('win:') || f.away.startsWith('win:'))).toBe(true);
    expect(fx.some((f) => f.home.startsWith('lose:'))).toBe(true); // third place
    expect(plan.warnings[0]).toMatch(/preliminary round/);
  });

  it('groups then knockout: snake-split groups, cross-group semis from the tables, after the groups', () => {
    const plan = planCompetition(
      spec({
        type: 'tournament',
        teams: teams(8),
        format: { kind: 'groups-knockout', groups: 2, qualifiers: 2, legs: 1 },
      }),
    );
    if (!plan.ok) throw new Error(plan.problems.join());
    expect(
      plan.series.map((s) => [s.id, s.name, s.competition.role, s.competition.groupLabel ?? null]),
    ).toEqual([
      ['c-premier-t20-g1', 'Premier T20 · Group A', 'group', 'Group A'],
      ['c-premier-t20-g2', 'Premier T20 · Group B', 'group', 'Group B'],
      ['c-premier-t20-ko', 'Premier T20 · Knockout', 'knockout', null],
    ]);
    // Snake: 1,4,5,8 / 2,3,6,7
    expect(plan.series[0].teams).toEqual(['t1', 't4', 't5', 't8']);
    const ko = fixturesOf(plan.series[2]);
    expect(ko[0]).toMatchObject({ home: 'pos:c-premier-t20-g1:1', away: 'pos:c-premier-t20-g2:2' });
    expect(ko[1]).toMatchObject({ home: 'pos:c-premier-t20-g2:1', away: 'pos:c-premier-t20-g1:2' });
    expect(ko[2]).toMatchObject({ home: 'win:f1', away: 'win:f2' });
    const lastGroup = fixturesOf(plan.series[0]).at(-1)!.date;
    expect(ko[0].date > lastGroup).toBe(true);
    expect(plan.summary.fixtures).toBe(6 + 6 + 3);
  });
});

describe('refusals, in the office’s words', () => {
  it('lists every problem at once', () => {
    expect(
      competitionProblems(
        spec({
          name: ' ',
          overs: 0,
          teams: [team(1), team(1)],
          schedule: { startDate: '10/10/2026', everyDays: 0, times: ['9am'] },
        }),
      ),
    ).toEqual([
      'Give it a name.',
      'Overs must be a whole number from 1 to 200.',
      'A team is in the list twice.',
      'Pick a start date.',
      'Rounds must be 1 to 28 days apart.',
      'Start times must be HH:MM (up to four).',
    ]);
    expect(competitionProblems(spec({ teams: [team(1)] }))).toContain('Pick at least two teams.');
    expect(
      competitionProblems(
        spec({
          teams: teams(5),
          format: { kind: 'groups-knockout', groups: 3, qualifiers: 2, legs: 1 },
        }),
      ),
    ).toEqual([
      '3 groups need at least 6 teams (two per group).',
      'Each group needs more teams than it sends through.',
    ]);
    expect(
      competitionProblems(spec({ points: { win: -1, tie: 2, noResult: 2, loss: 0 } })),
    ).toEqual(['Points must be whole numbers from 0 to 20.']);
    expect(planCompetition(spec({ id: 'Bad Id!' }))).toEqual({
      ok: false,
      problems: ['The competition id is invalid.'],
    });
  });
});

describe('advanceKnockout', () => {
  const ko: AdvanceFixture[] = [
    { id: 'f1', home: 'pos:g1:1', away: 'pos:g2:2' },
    { id: 'f2', home: 'pos:g2:1', away: 'pos:g1:2' },
    { id: 'f3', home: 'win:f1', away: 'win:f2' },
  ];
  const groups = new Map([
    ['g1', { complete: true, order: ['A', 'B', 'C'] }],
    ['g2', { complete: false, order: ['D', 'E', 'F'] }],
  ]);

  it('fills group places only from finished groups, keeping the placeholder', () => {
    const r = advanceKnockout(ko, groups);
    expect(r.fixtures.map((f) => [f.home, f.away])).toEqual([
      ['A', 'pos:g2:2'],
      ['pos:g2:1', 'B'],
      ['win:f1', 'win:f2'],
    ]);
    expect(r.fixtures[0].slots).toEqual({ home: 'pos:g1:1' });
    expect(r.filled).toBe(2);
    expect(r.waiting).toEqual([
      "g2 isn't finished",
      'f1 has no winner yet',
      'f2 has no winner yet',
    ]);
    expect(advanceKnockout(ko, groups, { allowIncomplete: true }).filled).toBe(4);
  });

  it('fills the final from the semis’ results; a tie waits for the union', () => {
    const semis = [
      { id: 'f1', home: 'A', away: 'E', result: { winner: 'away' as const } },
      { id: 'f2', home: 'D', away: 'B', result: { winner: 'tie' as const } },
      { id: 'f3', home: 'win:f1', away: 'win:f2' },
    ];
    const r = advanceKnockout(semis, groups);
    expect([r.fixtures[2].home, r.fixtures[2].away]).toEqual(['E', 'win:f2']);
    expect(r.waiting).toEqual(['f2 has no winner yet']);
  });
});
