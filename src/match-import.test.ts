import { describe, it, expect } from 'vitest';
import {
  baseKey,
  detectKind,
  formatFromCompetition,
  howOutFrom,
  isoDate,
  parseBallByBall,
  planImport,
  readFile,
  readOutcome,
} from './match-import';
import { ballByBall, bat, card, type Ball } from './pro-csv-fixtures';

// An invented two-over game. Hawks: 20/2 — Bea caught; Ann run out at the non-striker's end
// (the scorer logged it against Cara, who then faces again). Kestrels: 11/1 in four balls.
const BALLS: Ball[] = [
  [1, '0.1', '1', 'Ann Hawk (WK)', 'Ben Kestrel'],
  [1, '0.2', '4', 'Bea Hawk', 'Ben Kestrel'],
  [1, '0.3', '●', 'Bea Hawk', 'Ben Kestrel'],
  [1, '0.4', '1wd', 'Bea Hawk', 'Ben Kestrel'],
  [1, '0.4', 'W', 'Bea Hawk', 'Ben Kestrel', 'OUT! Caught, Cal Kestrel (C) (4 - 3b, 1x4, 0x6)'],
  [1, '0.5', 'nb+2', 'Cara Hawk', 'Ben Kestrel'],
  [1, '0.5', '1lb', 'Cara Hawk', 'Ben Kestrel'],
  [1, '0.6', '●', 'Ann Hawk (WK)', 'Ben Kestrel'],
  [1, '1.1', '6', 'Ann Hawk (WK)', 'Cal Kestrel (C)'],
  [1, '1.2', '1', 'Ann Hawk (WK)', 'Cal Kestrel (C)'],
  [1, '1.3', 'W', 'Cara Hawk', 'Cal Kestrel (C)', 'OUT! Run Out, Ben Kestrel'],
  [1, '1.4', '2', 'Cara Hawk', 'Cal Kestrel (C)'],
  [1, '1.5', '1', 'Cara Hawk', 'Cal Kestrel (C)'],
  [1, '1.6', '●', 'Dee Hawk', 'Cal Kestrel (C)'],
  [2, '0.1', '4', 'Ben Kestrel', 'Ann Hawk (WK)'],
  [2, '0.2', '6', 'Ben Kestrel', 'Ann Hawk (WK)'],
  [2, '0.3', 'W', 'Ben Kestrel', 'Ann Hawk (WK)', 'OUT! Bowled (10 - 3b, 1x4, 1x6)'],
  [2, '0.4', '1', 'Cal Kestrel (C)', 'Ann Hawk (WK)'],
];

const BBB = ballByBall({
  id: '900/1',
  competition: 'Invented Pro20 2025/26',
  date: '12 Oct 2025',
  teams: ['Highveld Hawks', 'Coastal Kestrels'],
  balls: BALLS,
});
const BBB_NAME = 'Ball by Ball (Highveld Hawks vs Coastal Kestrels) 12 Oct 2025.csv';

const scorecard = (date: string, hawks: number, kestrels: number) =>
  card({
    date,
    home: 'Highveld Hawks',
    away: 'Coastal Kestrels',
    innings: [
      {
        bat: 'Highveld Hawks',
        label: '1st innings',
        total: hawks,
        extras: ['1w, 1nb, 0b, 1lb, 0p', 3],
        batting: bat([
          ['Ann Hawk', '(run out) Ben Kestrel', 8, 4, 0, 1, 1],
          ['Bea Hawk', '(c) Cal Kestrel, (b) Ben Kestrel', 4, 3, 1, 0, 2],
          ['Cara Hawk', 'not out', 5, 5, 0, 0, 2],
          ['Dee Hawk', 'not out', 0, 1, 0, 0, 1],
        ]),
        bowling: `"Ben Kestrel","1","0","9","1","9.0","2","1","1"\n"Cal Kestrel","1","0","10","0","10.0","1","0","0"`,
        overs: '2',
        fow: `"Bea Hawk","6/1","0.4"\n"Ann Hawk","17/2","1.3"`,
      },
      {
        bat: 'Coastal Kestrels',
        label: '2nd innings',
        total: kestrels,
        extras: ['0w, 0nb, 0b, 0lb, 0p', 0],
        batting: bat([
          ['Ben Kestrel', '(b) Ann Hawk', 10, 3, 1, 1, 1],
          ['Cal Kestrel', 'not out', 1, 1, 0, 0, 0],
        ]),
        bowling: `"Ann Hawk","0.4","0","11","1","16.5","1","0","0"`,
        overs: '0.4',
        fow: `"Ben Kestrel","10/1","0.3"`,
      },
    ],
  });
const CARD = scorecard('2025-10-12', 20, 11);
const CARD_NAME = 'Scorecard CSV (Highveld Hawks vs Coastal Kestrels) 2025-10-12.csv';

describe('reading a delivery', () => {
  it.each([
    ['●', 0, '', 0, false],
    ['4', 4, '', 0, false],
    ['2wd', 0, 'wd', 2, false],
    ['1lb', 0, 'lb', 1, false],
    ['4b', 0, 'b', 4, false],
    ['nb+4', 4, 'nb', 1, false],
    ['1W', 1, '', 0, true],
    ['wd+W', 0, 'wd', 1, true],
    ['2?', 2, '', 0, false],
  ])('%s', (code, batRuns, extra, extraRuns, wicket) => {
    const r = readOutcome(code, '0', '', wicket ? '1' : '0', '');
    expect([r.bat, r.extra, r.extraRuns, r.wicket]).toEqual([batRuns, extra, extraRuns, wicket]);
    expect(r.legal).toBe(extra !== 'wd' && extra !== 'nb');
  });

  it('reads the dismissal from the commentary', () => {
    expect(howOutFrom('OUT! Caught, Cal Kestrel (C) (4 - 3b, 1x4, 0x6)', 'Ben Kestrel')).toEqual({
      out: 'c Cal Kestrel b Ben Kestrel',
      runs: 4,
      balls: 3,
    });
    expect(howOutFrom('OUT! Caught, Ben Kestrel (0 - 1b, 0x4, 0x6)', 'Ben Kestrel').out).toBe(
      'c & b Ben Kestrel',
    );
    expect(howOutFrom('OUT! Stumped, Ann Hawk (WK) (9 - 7b, 1x4, 0x6)', 'Bo').out).toBe(
      'st Ann Hawk b Bo',
    );
    expect(howOutFrom('OUT! Leg Before (1 - 2b, 0x4, 0x6)', 'Bo').out).toBe('lbw b Bo');
    expect(howOutFrom('Retired Injured', 'Bo').out).toBe('retired not out');
    // A "W" with nothing written isn't a wicket (a concussion swap, say).
    expect(howOutFrom('', 'Bo').out).toBe('retired out');
  });

  it('reads the dates, formats and file kinds', () => {
    expect(isoDate('27 Sept 2024')).toBe('2024-09-27');
    expect(isoDate('2024-09-27')).toBe('2024-09-27');
    expect(formatFromCompetition('Invented Pro20 2025/26')).toBe('T20');
    expect(formatFromCompetition('Invented One-Day Cup')).toBe('One-Day');
    expect(formatFromCompetition('Invented 4-Day Series')).toBe('Multi-day');
    expect(detectKind(BBB)).toBe('ball-by-ball');
    expect(detectKind(CARD)).toBe('scorecard');
    expect(detectKind('[]')).toBe('standard');
    expect(detectKind('name,club\nA,B')).toBe('unknown');
  });
});

describe('a ball-by-ball file', () => {
  const r = parseBallByBall(BBB, BBB_NAME)!;
  const [hawks, kestrels] = r.match.innings!;

  it('builds the cards from the deliveries', () => {
    expect(r.match.date).toBe('2025-10-12');
    expect(r.match.format).toBe('T20');
    expect(r.match.gender).toBe('men');
    expect(r.competition).toBe('Invented Pro20 2025/26');
    expect([hawks.bat, hawks.total, hawks.wkts, hawks.overs]).toEqual([
      'Highveld Hawks',
      20,
      2,
      '2',
    ]);
    expect(hawks.exb).toEqual({ w: 1, nb: 1, b: 0, lb: 1 });
    expect(hawks.batting.map((b) => [b.n, b.r, b.b])).toEqual([
      ['Ann Hawk', 8, 4],
      ['Bea Hawk', 4, 3],
      ['Cara Hawk', 5, 5],
      ['Dee Hawk', 0, 1],
    ]);
    expect(hawks.bowling.map((b) => [b.n, b.o, b.r, b.w, b.wd, b.nb])).toEqual([
      ['Ben Kestrel', '1', 9, 1, 1, 1],
      ['Cal Kestrel', '1', 10, 0, 0, 0],
    ]);
    expect(hawks.perOver).toEqual([
      [1, 10, 1],
      [2, 10, 1],
    ]);
    expect(hawks.balls).toHaveLength(14);
    expect([kestrels.total, kestrels.wkts, kestrels.overs]).toEqual([11, 1, '0.4']);
    expect(kestrels.batting[0].out).toBe('b Ann Hawk');
  });

  it('moves a run-out to the batter who went when the "dismissed" one faces again', () => {
    const out = Object.fromEntries(hawks.batting.map((b) => [b.n, b.out]));
    expect(out['Ann Hawk']).toBe('run out (Ben Kestrel)');
    expect(out['Cara Hawk']).toBe('not out');
    expect(out['Bea Hawk']).toBe('c Cal Kestrel b Ben Kestrel');
    expect(hawks.fow.map((f) => f.batter)).toEqual(['Bea Hawk', 'Ann Hawk']);
  });
});

describe('the import plan', () => {
  const files = [readFile(BBB_NAME, BBB), readFile(CARD_NAME, CARD)];

  it('pairs a game’s scorecard and ball by ball into one match, whatever the order', () => {
    const plan = planImport([], files);
    expect(plan.items.map((i) => i.outcome)).toEqual(['new', 'adds-balls']);
    expect(plan.save).toHaveLength(1);
    const m = plan.save[0];
    expect(m.key).toBe('2025-10-12_hawks-v-kestrels_men');
    expect(m.key).toBe(baseKey(m));
    expect(m.hasBalls).toBe(true);
    expect(m.sources.map((s) => s.kind)).toEqual(['scorecard', 'ball-by-ball']);
    expect(m.competition).toBe('Invented Pro20 2025/26');
    expect(m.externalId).toBe('900/1');
    // The scorecard's cards are kept; the deliveries come from the ball by ball.
    expect(m.innings![0].balls).toHaveLength(14);
    expect(m.innings![0].perOver).toHaveLength(2);
    expect(plan.items[1].warnings).toEqual([]);
    expect(planImport([], [...files].reverse()).save).toEqual(plan.save);
  });

  it('catches duplicates, in one drop and against the library', () => {
    const once = planImport([], files).save;
    const again = planImport(once, files);
    expect(again.items.map((i) => i.outcome)).toEqual(['duplicate', 'duplicate']);
    expect(again.save).toEqual([]);
    const twice = planImport([], [...files, readFile(`copy of ${CARD_NAME}`, CARD)]);
    expect(twice.items.filter((i) => i.outcome === 'duplicate')).toHaveLength(1);
    expect(twice.save).toHaveLength(1);
  });

  it('a library export reads back as the same matches', () => {
    const lib = planImport([], files).save;
    const exported = readFile('library.json', JSON.stringify(lib));
    expect(exported.kind).toBe('standard');
    expect(planImport(lib, [exported]).items.map((i) => i.outcome)).toEqual(['duplicate']);
    const fresh = planImport([], [exported]);
    expect(fresh.save[0].key).toBe(lib[0].key);
    expect(fresh.save[0].hasBalls).toBe(true);
  });

  it('reports a ball by ball that doesn’t add up to its scorecard instead of attaching it', () => {
    const lib = planImport([], [readFile(CARD_NAME, scorecard('2025-10-12', 160, 11))]).save;
    const plan = planImport(lib, [files[0]]);
    expect(plan.items[0].outcome).toBe('conflict');
    expect(plan.items[0].warnings[0]).toMatch(/doesn.t add up/);
    expect(plan.save).toEqual([]);
  });

  it('a scorecard that disagrees with the library keeps the library copy', () => {
    const lib = planImport([], [files[1]]).save;
    const plan = planImport(lib, [readFile('other.csv', scorecard('2025-10-12', 23, 11))]);
    expect(plan.items[0].outcome).toBe('conflict');
    expect(plan.save).toEqual([]);
  });

  it('a second game the same day gets its own key', () => {
    const plan = planImport(
      [],
      [files[1], readFile('evening.csv', scorecard('2025-10-12', 140, 141))],
    );
    expect(plan.save.map((m) => m.key)).toEqual([
      '2025-10-12_hawks-v-kestrels_men',
      '2025-10-12_hawks-v-kestrels_men_2',
    ]);
  });

  it('flags files it can’t use', () => {
    const plan = planImport(
      [],
      [readFile('notes.csv', 'name,club\nA,B'), readFile('broken.json', '{"x":1}')],
    );
    expect(plan.items.map((i) => i.outcome)).toEqual(['error', 'unrecognised']);
    expect(plan.save).toEqual([]);
  });
});

describe('scoring by phase, from the deliveries', () => {
  it('counts run rate, dots, boundaries and wickets in each phase for each side', async () => {
    const { scoringByPhase } = await import('./pro-team');
    const m = parseBallByBall(BBB, BBB_NAME)!.match;
    const squad = {
      id: 'hawks-men',
      gender: 'men' as const,
      key: 'hawks',
      name: 'Highveld Hawks',
      matches: [m],
    };
    const r = scoringByPhase(squad, [m], 'T20');
    expect(r.innings).toEqual({ ours: 1, theirs: 1 });
    const [pp, mid] = r.rows;
    expect(pp.phase).toBe('Powerplay 1–6');
    // Hawks: 20 runs off 12 legal balls; five dots (the two wicket balls among them); a 4
    // and a 6; two wickets.
    expect(pp.ours).toMatchObject({ rate: 10, balls: 12, wkts: 2 });
    expect(pp.ours.dot).toBeCloseTo((5 / 12) * 100);
    expect(pp.ours.boundary).toBeCloseTo((2 / 12) * 100);
    // Kestrels: 11 off 4 balls.
    expect(pp.theirs).toMatchObject({ rate: 16.5, balls: 4, wkts: 1 });
    expect(mid.ours.balls).toBe(0);
  });
});
