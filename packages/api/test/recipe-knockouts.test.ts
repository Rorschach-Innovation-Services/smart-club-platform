/**
 * create-recipe-knockouts: the 13 dolphins T20 semis/finals medicoach built from the recipe
 * are planned in smart club with the SAME refs, placeholder sides and a TBC date — and a
 * TBC fixture never takes part in a clash gate.
 *
 * The group series are synthetic but shaped like prod's (ids, names, leagueKeys from the
 * Plan-B import); no prod data is read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Series } from '../src/types.js';
import { planRecipeKnockouts, parseArgs } from '../src/create-recipe-knockouts.js';
import { DOLPHINS_RECIPES } from '../src/medicoach-recipes/dolphins.js';
import { findClashes, isClashExempt } from '../src/venue-clash.js';

/** The 13 `:fixture:recipe:` keys of medicoach's league-map.prod.json (checked by hand). */
const EXPECTED_REFS = [
  'smartclub:dolphins:fixture:recipe:premier:t20:final',
  'smartclub:dolphins:fixture:recipe:premier:t20:sf1',
  'smartclub:dolphins:fixture:recipe:premier:t20:sf2',
  'smartclub:dolphins:fixture:recipe:premierWomen:t20:final',
  'smartclub:dolphins:fixture:recipe:premierWomen:t20:sf1',
  'smartclub:dolphins:fixture:recipe:premierWomen:t20:sf2',
  'smartclub:dolphins:fixture:recipe:promotion:t20:final',
  'smartclub:dolphins:fixture:recipe:promotion:t20:sf1',
  'smartclub:dolphins:fixture:recipe:promotion:t20:sf2',
  'smartclub:dolphins:fixture:recipe:veterans-premier:t20:final',
  'smartclub:dolphins:fixture:recipe:veterans-premier:t20:sf1',
  'smartclub:dolphins:fixture:recipe:veterans-premier:t20:sf2',
  'smartclub:dolphins:fixture:recipe:veterans-promotion:t20:final',
];

const group = (id: string, name: string, leagueKey: string, lastDate: string): Series =>
  ({
    id,
    name,
    leagueKey,
    startDate: '2026-10-04',
    teams: [`${id}-a`, `${id}-b`],
    participants: [
      { teamId: `${id}-a`, clubId: `${id}-a`, name: 'A' },
      { teamId: `${id}-b`, clubId: `${id}-b`, name: 'B' },
    ],
    fixtures: [
      { id: 'f1', round: 1, date: '2026-10-04', home: `${id}-a`, away: `${id}-b` },
      { id: 'f2', round: 2, date: lastDate, home: `${id}-b`, away: `${id}-a` },
    ],
    maxOvers: 20,
    seriesType: 'Twenty20 (16-25 overs)',
    kind: 'series',
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-09-02T00:00:00.000Z',
    withheld: { venue: true },
    version: 3,
  }) as unknown as Series;

const DOLPHINS_GROUPS: Series[] = [
  group('s-planb-premier-men-t20-2', 'Premier League · T20 · Group 2', 'premier', '2026-11-15'),
  group('s-planb-premier-men-t20-1', 'Premier League · T20 · Group 1', 'premier', '2026-11-22'),
  ...[1, 2, 3, 4].map((g) =>
    group(
      `s-planb-promotion-men-t20-g${g}`,
      `Promotion League · T20 · Group ${g}`,
      'promotion',
      '2026-11-22',
    ),
  ),
  ...[1, 2].map((g) =>
    group(
      `s-planb-premier-women-t20-g${g}`,
      `Premier Women’s League · T20 · Group ${g}`,
      'premierWomen',
      '2026-11-08',
    ),
  ),
  ...[1, 2].map((g) =>
    group(
      `s-planb-veterans-premier-t20-${g}`,
      `Veterans Premier · T20 · Group ${g}`,
      'veterans-premier',
      '2026-11-29',
    ),
  ),
  ...[1, 2].map((g) =>
    group(
      `s-planb-veterans-promotion-t20-${g}`,
      `Veterans Promotion · T20 · Group ${g}`,
      'veterans-promotion',
      '2026-11-29',
    ),
  ),
  // Not a T20 stream, and a Promotion Women group: neither gets a knockout.
  group(
    's-planb-premier-men-50ov-top6',
    'Premier League · 50 Over · Top 6',
    'premier',
    '2027-03-01',
  ),
  group(
    's-planb-promotion-women-t20-ga',
    'Promotion Women’s League · T20 · Group A',
    'promotion-women-s-league',
    '2027-03-01',
  ),
];

describe('planRecipeKnockouts (dolphins)', () => {
  const plan = planRecipeKnockouts('dolphins', DOLPHINS_GROUPS, DOLPHINS_RECIPES);
  const fixtures = plan.series.flatMap((s) =>
    (s.fixtures as Array<Record<string, unknown>>).map(
      (f): Record<string, unknown> => ({ ...f, seriesId: s.id }),
    ),
  );

  test('exactly 13 fixtures, refs equal to the recipe refs medicoach holds', () => {
    assert.deepEqual(plan.warnings, []);
    assert.equal(fixtures.length, 13);
    assert.deepEqual(fixtures.map((f) => f.syncRef).sort(), EXPECTED_REFS);
    for (const f of fixtures)
      assert.match(
        String(f.syncRef),
        /^smartclub:dolphins:fixture:recipe:[A-Za-z-]+:t20:(sf1|sf2|final)$/,
      );
  });

  test('one s-mc-ko-<league>-t20 series per competition, lifecycle copied from the groups', () => {
    assert.deepEqual(plan.series.map((s) => s.id).sort(), [
      's-mc-ko-premier-t20',
      's-mc-ko-premierWomen-t20',
      's-mc-ko-promotion-t20',
      's-mc-ko-veterans-premier-t20',
      's-mc-ko-veterans-promotion-t20',
    ]);
    const premier = plan.series.find((s) => s.id === 's-mc-ko-premier-t20')!;
    assert.equal(premier.name, 'Premier League · T20 · Knockout');
    assert.equal(premier.released, true);
    assert.equal(premier.approved, true);
    assert.deepEqual(premier.withheld, { venue: true });
    assert.equal(premier.participants?.length, 4, 'union of the group participants');
  });

  test('placeholder sides use exporter group order (Group 1 = the "Group 1" series)', () => {
    const premier = plan.series.find((s) => s.id === 's-mc-ko-premier-t20')!;
    const [sf1, sf2, final] = premier.fixtures as Array<Record<string, unknown>>;
    assert.deepEqual(
      [sf1.home, sf1.away],
      ['pos:s-planb-premier-men-t20-1:1', 'pos:s-planb-premier-men-t20-2:1'],
    );
    assert.deepEqual(
      [sf2.home, sf2.away],
      ['pos:s-planb-premier-men-t20-1:2', 'pos:s-planb-premier-men-t20-2:2'],
    );
    assert.deepEqual([final.home, final.away], ['win:f1', 'win:f2']);
    for (const f of [sf1, sf2, final]) {
      assert.equal(f.dateTbc, true);
      assert.equal(f.date, '2026-11-22', "the stream's last group date");
      assert.equal(f.venueName, undefined);
      assert.equal(f.venueId, undefined);
    }
    const vets = plan.series.find((s) => s.id === 's-mc-ko-veterans-promotion-t20')!;
    assert.deepEqual(
      (vets.fixtures as Array<Record<string, unknown>>).map((f) => [f.home, f.away, f.stage]),
      [
        [
          'pos:s-planb-veterans-promotion-t20-1:1',
          'pos:s-planb-veterans-promotion-t20-2:2',
          'Final',
        ],
      ],
    );
  });

  test('a missing group series is a warning and no half bracket', () => {
    const partial = planRecipeKnockouts(
      'dolphins',
      DOLPHINS_GROUPS.filter((s) => s.id !== 's-planb-promotion-men-t20-g4'),
      DOLPHINS_RECIPES,
    );
    assert.equal(
      partial.series.find((s) => s.id === 's-mc-ko-promotion-t20'),
      undefined,
    );
    assert.ok(partial.warnings.some((w) => /promotion t20 sf2 away: recipe names group 4/.test(w)));
  });

  test('parseArgs requires --tenant', () => {
    assert.throws(() => parseArgs([]), /usage/);
    assert.deepEqual(parseArgs(['--tenant', 'dolphins', '--confirm']), {
      tenant: 'dolphins',
      confirm: true,
    });
  });
});

describe('dateTbc fixtures and the clash gates', () => {
  test('isClashExempt: TBC, cancelled and undated fixtures stay out of the ledger', () => {
    assert.equal(isClashExempt({ date: '2026-11-22', dateTbc: true }), true);
    assert.equal(isClashExempt({ date: '2026-11-22', status: 'cancelled' }), true);
    assert.equal(isClashExempt({}), true);
    assert.equal(isClashExempt({ date: '2026-11-22' }), false);
  });

  test('a TBC knockout at the same ground and date as a group fixture does not clash', () => {
    const base = DOLPHINS_GROUPS[1];
    const groupSeries = {
      ...base,
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: '2026-11-22',
          time: '09:00',
          home: 'x',
          away: 'y',
          venueName: 'Kingsmead',
        },
      ],
    } as unknown as Series;
    const ko = (dateTbc: boolean) =>
      ({
        ...base,
        id: 's-mc-ko-premier-t20',
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-11-22',
            time: '09:00',
            home: 'a',
            away: 'b',
            venueName: 'Kingsmead',
            ...(dateTbc ? { dateTbc: true } : {}),
          },
        ],
      }) as unknown as Series;
    assert.equal(findClashes(ko(true), [groupSeries], [], []).length, 0);
    assert.equal(
      findClashes(ko(false), [groupSeries], [], []).length,
      1,
      'control: a real date clashes',
    );
  });
});
