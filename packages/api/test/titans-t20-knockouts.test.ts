/**
 * Titans T20 knockouts (PR B, ADR 0018): the bracket build from parsed KO rows (`pos:`/`win:`/
 * `tbd:` sides, stages, no ground, participants = the groups' union), the past-date cutoff
 * (risk R10: skip + report, never an empty bracket for a played date; union-confirmed teams
 * kept with their placeholder in `slots`), KO identity across a re-import after Set team
 * (risk R8) and the --include-t20-ko / --ko-cutoff flag guards. Pure — no workbook, no repo.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tbdOf } from '../../engine/src/formats.js';
import type { Series } from '../src/types.js';

const { buildT20Knockouts, koSideNeeds, koStage, parseArgs, runScope } =
  await import('../src/import-titans-fixtures.js');
const { TITANS_FIXTURE_SHEETS } = await import('../src/titans-fixture-map.js');
type Sheet = Parameters<typeof buildT20Knockouts>[0][number];
type Built = Parameters<typeof buildT20Knockouts>[1][number];
type KoRow = Sheet['ko'][number];

const KO = 's-titans-mens-t20-ko';
const spec = TITANS_FIXTURE_SHEETS.find((s) => s.koSeriesId === KO)!;
const IRENE = 'irene-villagers-cricket-club';
const TUKS = 'tuks-cricket-club';
const PTA = 'pretoria-cricket-club';

const part = (teamId: string, clubId: string, name: string) => ({ teamId, clubId, name });
const groups: Built[] = spec.series.map(
  (x, i) =>
    ({
      series: {
        id: x.seriesId,
        participants:
          i === 0
            ? [part(IRENE, IRENE, 'IRENE VILLAGERS 1'), part(TUKS, TUKS, 'TUKS 1')]
            : i === 1
              ? [part(PTA, PTA, 'PRETORIA 1'), part(TUKS, TUKS, 'TUKS 1')]
              : [],
      },
    }) as unknown as Built,
);

const slot = (kind: 'pos' | 'win' | 'tbd' | 'team', ref: string, raw = ref) => ({ raw, kind, ref });
const row = (
  fixtureId: string,
  tag: string | null,
  date: string,
  time: string,
  home: ReturnType<typeof slot>,
  away: ReturnType<typeof slot>,
): KoRow => ({
  sheet: spec.sheet,
  row: 1,
  koSeriesId: KO,
  fixtureId,
  tag,
  date,
  time,
  timeSource: 't20-marker',
  rawHome: home.raw,
  rawAway: away.raw,
  rawVenue: tag ? `WINNER (${tag})` : 'TBC',
  home,
  away,
});
const GA = `pos:${spec.series[0].seriesId}:1`;
const GB = `pos:${spec.series[1].seriesId}:1`;
const GE = `pos:${spec.series[4].seriesId}:1`;
const rows: KoRow[] = [
  row('f1', 'Q1', '2026-10-10', '09:00', slot('pos', GA), slot('team', 'team:IRENE VILLAGERS 1')),
  row('f2', 'Q2', '2026-10-10', '09:00', slot('pos', GB), slot('tbd', tbdOf('Runner-up 1'))),
  row('f3', 'S1', '2026-10-10', '13:30', slot('win', 'win:f1'), slot('win', 'win:f2')),
  row('f4', null, '2026-10-17', '09:00', slot('win', 'win:f3'), slot('pos', GB)),
  row(
    'f5',
    null,
    '2027-03-20',
    '09:00',
    slot('tbd', tbdOf('Community Cup winner')),
    slot('pos', GE),
  ),
];
const sheet = { spec, ko: rows } as unknown as Sheet;
// The live side plan (titans-sides.ts) for the names these rows use.
const LIVE: Record<string, string> = {
  'IRENE VILLAGERS 1': IRENE,
  'TUKS 1': TUKS,
  'PRETORIA 1': PTA,
};
const sideOf = (_k: string, n: string) =>
  LIVE[n] ? { teamId: LIVE[n], clubId: LIVE[n], name: n, how: 'bare' as const } : undefined;
type Fx = Record<string, unknown> & { id: string; slots?: Record<string, string> };
const fxOf = (s: Series) => s.fixtures as Fx[];

describe('T20 knockout build', () => {
  test('stages, sides, sheet dates and times, no ground; participants = the groups', () => {
    const r = buildT20Knockouts([sheet], groups, { cutoff: '2026-10-01', resolved: {}, sideOf });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.skipped, []);
    const s = r.series[0];
    assert.equal(s.id, KO);
    assert.equal(s.name, "Men's T20 · Knockouts");
    assert.equal(s.seriesType, 'T20');
    assert.equal(s.maxOvers, 20);
    assert.equal(s.released, false);
    assert.deepEqual(
      fxOf(s).map((f) => [f.id, f.stage, f.round, f.date, f.time, f.home, f.away, f.venueStatus]),
      [
        ['f1', 'Quarter-final', 1, '2026-10-10', '09:00', GA, IRENE, 'unresolved'],
        ['f2', 'Quarter-final', 1, '2026-10-10', '09:00', GB, 'tbd:Runner-up%201', 'unresolved'],
        ['f3', 'Semi-final', 2, '2026-10-10', '13:30', 'win:f1', 'win:f2', 'unresolved'],
        ['f4', 'Play-off', 4, '2026-10-17', '09:00', 'win:f3', GB, 'unresolved'],
        [
          'f5',
          'Play-off',
          4,
          '2027-03-20',
          '09:00',
          'tbd:Community%20Cup%20winner',
          GE,
          'unresolved',
        ],
      ],
    );
    assert.ok(fxOf(s).every((f) => !f.venueName && !f.venueId && !f.slots));
    assert.deepEqual(s.teams, [IRENE, TUKS, PTA], 'union, deduped');
  });

  test('koStage: winners of two fixtures are a final; tagged rows follow the tag', () => {
    assert.equal(
      koStage({ tag: null, home: slot('win', 'win:f5'), away: slot('win', 'win:f6') } as never)
        .stage,
      'Final',
    );
    assert.equal(
      koStage({ tag: 'Q3', home: slot('pos', GA), away: slot('pos', GB) } as never).stage,
      'Quarter-final',
    );
  });

  test('past fixtures with an unknown side are skipped and reported; a named team alone is not enough', () => {
    const r = buildT20Knockouts([sheet], groups, { cutoff: '2026-10-18', resolved: {}, sideOf });
    assert.deepEqual(
      r.skipped.map((x) => [x.fixtureId, x.stage, x.date]),
      [
        ['f1', 'Quarter-final', '2026-10-10'],
        ['f2', 'Quarter-final', '2026-10-10'],
        ['f3', 'Semi-final', '2026-10-10'],
        ['f4', 'Play-off', '2026-10-17'],
      ],
    );
    assert.deepEqual(
      fxOf(r.series[0]).map((f) => f.id),
      ['f5'],
      'the future fixture stays',
    );
    assert.equal(r.series[0].startDate, '2027-03-20');
    assert.deepEqual(r.errors, []);
  });

  test('a kept fixture fed by a skipped one is an error, never an empty bracket', () => {
    const r = buildT20Knockouts([sheet], groups, { cutoff: '2026-10-11', resolved: {}, sideOf });
    assert.match(
      r.errors.join('\n'),
      /f4 \(2026-10-17\): its home side is the winner of f3, which is skipped/,
    );
  });

  test('union-confirmed teams (KO_RESOLVED) keep a past fixture, placeholder kept in slots', () => {
    const r = buildT20Knockouts([sheet], groups, {
      cutoff: '2026-10-11',
      sideOf,
      resolved: {
        [KO]: {
          f1: { home: 'TUKS 1' },
          f2: { home: 'PRETORIA 1', away: 'IRENE VILLAGERS 1' },
          f3: { home: 'TUKS 1', away: 'PRETORIA 1' },
        },
      },
    });
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.errors, []);
    const [f1, f2, f3] = fxOf(r.series[0]);
    assert.deepEqual([f1.home, f1.away, f1.slots], [TUKS, IRENE, { home: GA }]);
    assert.deepEqual(
      [f2.home, f2.away, f2.slots],
      [PTA, IRENE, { home: GB, away: 'tbd:Runner-up%201' }],
    );
    assert.deepEqual([f3.home, f3.away, f3.slots], [TUKS, PTA, { home: 'win:f1', away: 'win:f2' }]);
    assert.equal(r.resolvedSides.length, 5, 'the sheet-named team is not a union resolution');
  });

  test('a union-confirmed name with no live side is an error (live run)', () => {
    const r = buildT20Knockouts([sheet], groups, {
      cutoff: '2026-10-01',
      resolved: { [KO]: { f2: { away: 'PRETORIA 3' } } },
      sideOf: () => undefined,
    });
    assert.match(r.errors.join('\n'), /PRETORIA 3.*has no side on the live club/);
  });
});

describe('T20 knockout re-import after Set team (R8)', () => {
  // Stored: f2's away was set to TUKS in the console; the stored ids differ from row order.
  const stored = {
    id: KO,
    participants: [part(TUKS, TUKS, 'TUKS 1'), part('tm_outsider', PTA, 'PRETORIA 2')],
    fixtures: [
      { id: 'f7', date: '2026-10-10', time: '09:00', home: GA, away: IRENE },
      {
        id: 'f9',
        date: '2026-10-10',
        time: '09:00',
        home: GB,
        away: TUKS,
        slots: { away: 'tbd:Runner-up%201' },
      },
      {
        id: 'f10',
        date: '2027-03-20',
        time: '09:00',
        home: 'tm_outsider',
        away: GE,
        slots: { home: tbdOf('Community Cup winner') },
      },
    ],
  } as unknown as Series;

  test('ids match by placeholder; console teams and their participants are carried', () => {
    const r = buildT20Knockouts([sheet], groups, {
      cutoff: '2026-10-01',
      resolved: {},
      sideOf,
      stored: new Map([[KO, stored]]),
    });
    const fx = fxOf(r.series[0]);
    const byPair = (h: string) => fx.find((f) => f.home === h || f.slots?.home === h)!;
    assert.equal(byPair(GA).id, 'f7');
    const f2 = byPair(GB);
    assert.equal(f2.id, 'f9');
    assert.equal(f2.away, TUKS);
    assert.deepEqual(f2.slots, { away: 'tbd:Runner-up%201' });
    const cup = fx.find((f) => f.slots?.home === tbdOf('Community Cup winner'))!;
    assert.equal(cup.id, 'f10');
    assert.equal(cup.home, 'tm_outsider');
    assert.ok(r.series[0].participants!.some((p) => p.teamId === 'tm_outsider'));
    assert.ok(r.series[0].teams.includes('tm_outsider'));
    assert.equal(r.carried.length, 2);
  });

  test('a stored past fixture is kept (never silently dropped) even with a placeholder left', () => {
    const r = buildT20Knockouts([sheet], groups, {
      cutoff: '2026-10-18',
      resolved: {},
      sideOf,
      stored: new Map([[KO, stored]]),
    });
    const ids = fxOf(r.series[0]).map((f) => f.id);
    assert.ok(ids.includes('f7') && ids.includes('f9'), 'stored QFs stay');
    assert.ok(
      r.skipped.some((x) => x.stage === 'Semi-final'),
      'the never-stored SF is skipped',
    );
  });
});

describe('T20 knockout flags and scope', () => {
  test('--only on a T20 knockout needs --include-t20-ko; --ko-cutoff needs it too', () => {
    assert.throws(() => parseArgs(['--only', KO]), /--include-t20-ko/);
    const a = parseArgs(['--only', KO, '--include-t20-ko', '--today', '2026-10-12']);
    assert.equal(a.includeT20Ko, true);
    assert.equal(a.koCutoff, '2026-10-12', 'the cutoff defaults to --today');
    assert.equal(
      parseArgs(['--include-t20-ko', '--ko-cutoff', '2026-10-18']).koCutoff,
      '2026-10-18',
    );
    assert.throws(() => parseArgs(['--ko-cutoff', '2026-10-18']), /--include-t20-ko/);
    assert.throws(() => parseArgs(['--include-t20-ko', '--ko-cutoff', '18 Oct']), /YYYY-MM-DD/);
    assert.throws(() => parseArgs(['--revert', '--include-t20-ko']), /import flag/);
  });

  test('a T20 knockout id brings every group of its sheet into scope; KO side needs', () => {
    const sc = runScope([KO])!;
    for (const x of spec.series) assert.ok(sc.has(x.seriesId));
    const needs = koSideNeeds([sheet], sc, { [KO]: { f3: { home: 'tuks 1' } } });
    assert.deepEqual(
      needs.map((n) => n.name),
      ['IRENE VILLAGERS 1', 'TUKS 1'],
    );
    assert.deepEqual(koSideNeeds([sheet], new Set(['s-other']), {}), []);
  });
});
