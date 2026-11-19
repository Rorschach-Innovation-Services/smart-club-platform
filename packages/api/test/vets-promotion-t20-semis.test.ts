/**
 * vets-promotion-t20-semis: the 21 Nov 2026 Veterans Promotion T20 play-offs — two semis added
 * to the recipe knockout series and the final re-pointed at their winners. The stored state is
 * the prod series as read on 18 Nov 2026 (no personal data: team ids, refs, venue registry).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Series, StoredFixtureResult, Venue } from '../src/types.js';
import {
  planVetsSemis,
  parseArgs,
  SERIES_ID,
  TEAMS,
  VENUE_REASON,
  type PlanInput,
} from '../src/vets-promotion-t20-semis.js';

const FINAL_REF = 'smartclub:dolphins:fixture:recipe:veterans-promotion:t20:final';

const VENUES: Venue[] = [
  { id: 'v-toti-1', name: 'Toti 1', lat: -30.054447438466386, lon: 30.875508785247806 },
  { id: 'v-toti-2', name: 'Toti 2' },
];

const PARTICIPANTS = [
  { teamId: TEAMS.chatsworthB, clubId: 'hollywoodbets-chatsworth-sporting', name: 'Chatsworth B' },
  { teamId: TEAMS.saintsB, clubId: 'saints-cricket-club', name: 'Saints B' },
  { teamId: TEAMS.tongaat, clubId: 'tongaat-cricket-association', name: 'Tongaat' },
  { teamId: TEAMS.hillaryMalvern, clubId: 'hillary-malvern-cricket-club', name: 'Hillary/Malvern' },
];

/** The knockout series exactly as stored on prod (18 Nov 2026). */
function storedKnockout(): Series {
  return {
    id: SERIES_ID,
    name: 'Veterans Promotion · T20 · Knockout',
    kind: 'series',
    leagueKey: 'veterans-promotion',
    startDate: '2026-11-14',
    endDate: '2026-11-14',
    teams: PARTICIPANTS.map((p) => p.teamId),
    participants: PARTICIPANTS,
    approved: true,
    approvedAt: '2026-10-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-10-01T00:00:00.000Z',
    withheld: { venue: true },
    maxFixtureIdEver: 1,
    version: 3,
    fixtures: [
      {
        id: 'f1',
        round: 1,
        stage: 'Final',
        date: '2026-11-14',
        dateTbc: true,
        home: TEAMS.chatsworthB,
        away: TEAMS.saintsB,
        slots: {
          home: 'pos:s-planb-veterans-promotion-t20-1:1',
          away: 'pos:s-planb-veterans-promotion-t20-2:2',
        },
        syncRef: FINAL_REF,
      },
    ],
  } as Series;
}

/** A released series with one fixture at a ground/date/time. */
function otherSeries(
  id: string,
  name: string,
  fx: { venueName: string; time: string; home?: string; away?: string },
): Series {
  return {
    id,
    name,
    leagueKey: id,
    startDate: '2026-11-21',
    teams: [],
    released: true,
    releasedAt: '2026-10-01T00:00:00.000Z',
    version: 1,
    fixtures: [
      {
        id: 'f20',
        round: 5,
        date: '2026-11-21',
        time: fx.time,
        home: fx.home ?? `${id}-home`,
        away: fx.away ?? `${id}-away`,
        venueName: fx.venueName,
      },
    ],
  } as Series;
}

const EMCU = otherSeries('s-emcu-d5-s1-t20', 'EMCU Division 5 · Stream 1 · T20', {
  venueName: 'Toti 2',
  time: '13:00',
});

function input(over: Partial<PlanInput> = {}): PlanInput {
  const series = over.series ?? storedKnockout();
  return {
    series,
    allSeries: [series, EMCU],
    clubs: [],
    venues: VENUES,
    results: {},
    overruleSeries: 'EMCU',
    now: '2026-11-19T10:00:00.000Z',
    ...over,
  };
}

type Fx = Record<string, unknown>;
const fixturesOf = (s: { fixtures?: unknown[] }) => (s.fixtures ?? []) as Fx[];

describe('plan from the stored prod state', () => {
  const plan = planVetsSemis(input());

  test('applies, with the EMCU final clash overruled', () => {
    assert.equal(plan.status, 'apply');
    assert.equal(plan.writable, true, plan.reasons.join('; '));
    assert.equal(plan.introduced.length, 1);
    const [c] = plan.introduced;
    assert.equal(c.verdict, 'overruled');
    assert.equal(c.clash.date, '2026-11-21');
    const sides = [
      `${c.subjectSeriesId}/${c.clash.fixtureId}`,
      `${c.clash.with.seriesId}/${c.clash.with.fixtureId}`,
    ].sort();
    assert.deepEqual(sides, ['s-emcu-d5-s1-t20/f20', `${SERIES_ID}/f1`]);
    assert.equal(c.pairKey, `s-emcu-d5-s1-t20/f20~${SERIES_ID}/f1|toti2`);
    assert.deepEqual(plan.teamBusy, []);
  });

  test('semis f2/f3 and the final re-pointed at their winners, slots and dateTbc gone', () => {
    const [f1, f2, f3] = fixturesOf(plan.patch!);
    const venueBits = { venueLocked: true, venueStatus: 'neutral', venueReason: VENUE_REASON };
    assert.deepEqual(f2, {
      id: 'f2',
      round: 1,
      stage: 'Semi-final 1',
      date: '2026-11-21',
      time: '09:00',
      home: TEAMS.chatsworthB,
      away: TEAMS.saintsB,
      venueId: 'v-toti-1',
      venueName: 'Toti 1',
      venueLat: -30.054447438466386,
      venueLon: 30.875508785247806,
      ...venueBits,
      syncRef: 'smartclub:dolphins:fixture:recipe:veterans-promotion:t20:sf1',
    });
    assert.deepEqual(f3, {
      id: 'f3',
      round: 1,
      stage: 'Semi-final 2',
      date: '2026-11-21',
      time: '09:00',
      home: TEAMS.tongaat,
      away: TEAMS.hillaryMalvern,
      venueId: 'v-toti-2',
      venueName: 'Toti 2',
      ...venueBits,
      syncRef: 'smartclub:dolphins:fixture:recipe:veterans-promotion:t20:sf2',
    });
    assert.deepEqual(f1, {
      id: 'f1',
      round: 2,
      stage: 'Final',
      date: '2026-11-21',
      time: '13:00',
      home: 'win:f2',
      away: 'win:f3',
      venueId: 'v-toti-2',
      venueName: 'Toti 2',
      ...venueBits,
      syncRef: FINAL_REF,
    });
  });

  test('series dates, id high-water and the venue reveal', () => {
    const p = plan.patch!;
    assert.equal(p.startDate, '2026-11-21');
    assert.equal(p.endDate, '2026-11-21');
    assert.equal(p.maxFixtureIdEver, 3);
    assert.equal(p.withheld, undefined);
    assert.deepEqual(p.revealedAt, { venue: '2026-11-19T10:00:00.000Z' });
    assert.deepEqual(plan.revealed, ['venue']);
  });

  test('a time withheld too is revealed and stamped; nothing withheld still stamps venue', () => {
    const both = planVetsSemis(
      input({ series: { ...storedKnockout(), withheld: { venue: true, time: true } } as Series }),
    );
    assert.deepEqual(both.revealed, ['venue', 'time']);
    assert.deepEqual(both.patch!.revealedAt, {
      venue: '2026-11-19T10:00:00.000Z',
      time: '2026-11-19T10:00:00.000Z',
    });
    const s = storedKnockout();
    delete s.withheld;
    const none = planVetsSemis(input({ series: s }));
    assert.deepEqual(none.revealed, []);
    assert.deepEqual(none.patch!.revealedAt, { venue: '2026-11-19T10:00:00.000Z' });
  });
});

describe('clash rule', () => {
  test('without --overrule-series the EMCU clash blocks', () => {
    const plan = planVetsSemis(input({ overruleSeries: undefined }));
    assert.equal(plan.status, 'apply');
    assert.equal(plan.writable, false);
    assert.deepEqual(
      plan.introduced.map((t) => t.verdict),
      ['blocking'],
    );
  });

  test('a non-EMCU clash still refuses under --overrule-series EMCU', () => {
    const premier = otherSeries('s-planb-premier-men-t20-1', 'Premier League · T20 · Group 1', {
      venueName: 'Toti 1',
      time: '09:00',
    });
    const series = storedKnockout();
    const plan = planVetsSemis(input({ series, allSeries: [series, EMCU, premier] }));
    assert.equal(plan.writable, false);
    const byVerdict = Object.fromEntries(
      plan.introduced.map((t) => [
        t.verdict,
        [t.subjectSeriesId, t.clash.with.seriesId].sort().join(' & '),
      ]),
    );
    assert.deepEqual(byVerdict, {
      overruled: `s-emcu-d5-s1-t20 & ${SERIES_ID}`,
      blocking: `${SERIES_ID} & s-planb-premier-men-t20-1`,
    });
  });

  test('a clash that already existed (not involving this change) does not block', () => {
    const a = otherSeries('s-a', 'Series A', { venueName: 'Kings Park', time: '10:00' });
    const b = otherSeries('s-b', 'Series B', { venueName: 'Kings Park', time: '10:00' });
    const series = storedKnockout();
    const plan = planVetsSemis(input({ series, allSeries: [series, EMCU, a, b] }));
    assert.equal(plan.writable, true);
    assert.equal(plan.preExisting.length, 1);
  });

  test('a semi team already playing that slot elsewhere is a team double-booking', () => {
    const other = otherSeries('s-vets-30', 'Veterans Promotion · 30 Over', {
      venueName: 'Tongaat Oval',
      time: '09:00',
      home: TEAMS.tongaat,
    });
    const series = storedKnockout();
    const plan = planVetsSemis(input({ series, allSeries: [series, EMCU, other] }));
    assert.equal(plan.writable, false);
    assert.deepEqual(
      plan.teamBusy.map((b) => [b.fixtureId, b.side, b.teamId, b.with.seriesId]),
      [['f3', 'home', TEAMS.tongaat, 's-vets-30']],
    );
  });
});

describe('idempotent re-run', () => {
  const applied = () => {
    const plan = planVetsSemis(input());
    return { ...storedKnockout(), ...plan.patch, version: 4 } as Series;
  };

  test('an applied series is a no-op', () => {
    const plan = planVetsSemis(input({ series: applied() }));
    assert.equal(plan.status, 'noop');
    assert.equal(plan.patch, undefined);
  });

  test('still a no-op after the puller filled the final and semi results arrived', () => {
    const s = applied();
    const [f1, f2, f3] = fixturesOf(s);
    s.fixtures = [{ ...f1, home: TEAMS.chatsworthB, slots: { home: 'win:f2' } }, f2, f3];
    const result = { seriesId: SERIES_ID, fixtureId: 'f2', winner: 'home' } as StoredFixtureResult;
    const plan = planVetsSemis(input({ series: s, results: { f2: result } }));
    assert.equal(plan.status, 'noop');
  });
});

describe('refuses an unexpected stored state', () => {
  const refusal = (mutate: (s: Series) => void, extra: Partial<PlanInput> = {}) => {
    const s = storedKnockout();
    mutate(s);
    const plan = planVetsSemis(input({ series: s, ...extra }));
    assert.equal(plan.status, 'refuse');
    assert.equal(plan.writable, false);
    assert.equal(plan.patch, undefined);
    return plan.reasons.join('\n');
  };

  test('the final already has a result', () => {
    const r = { seriesId: SERIES_ID, fixtureId: 'f1', winner: 'away' } as StoredFixtureResult;
    assert.match(
      refusal(() => {}, { results: { f1: r } }),
      /stored result exists for f1/,
    );
  });

  test('a cleared result tombstone does not count', () => {
    const r = { seriesId: SERIES_ID, fixtureId: 'f1', cleared: true } as StoredFixtureResult;
    assert.equal(planVetsSemis(input({ results: { f1: r } })).status, 'apply');
  });

  test('f2/f3 ids already burned (high-water above 1)', () => {
    assert.match(
      refusal((s) => (s.maxFixtureIdEver = 3)),
      /maxFixtureIdEver is 3/,
    );
  });

  test('f2 taken by some other fixture', () => {
    assert.match(
      refusal((s) =>
        s.fixtures.push({
          id: 'f2',
          round: 1,
          stage: 'Plate',
          date: '2026-11-21',
          home: 'x',
          away: 'y',
        }),
      ),
      /expected exactly one fixture f1, found \[f1, f2\]/,
    );
  });

  test('the final no longer carries the old G1 1st v G2 2nd placeholders', () => {
    assert.match(
      refusal((s) => {
        const f1 = fixturesOf(s)[0];
        f1.slots = {
          home: 'pos:s-planb-veterans-promotion-t20-2:1',
          away: 'pos:s-planb-veterans-promotion-t20-2:2',
        };
      }),
      /f1 home placeholder/,
    );
  });

  test('a missing venue in the registry', () => {
    assert.match(
      refusal(() => {}, { venues: [VENUES[0]] }),
      /venue v-toti-2 is not in the tenant's venue registry/,
    );
  });

  test('the series is absent', () => {
    const plan = planVetsSemis({ ...input(), series: null });
    assert.equal(plan.status, 'refuse');
  });
});

describe('parseArgs', () => {
  test('dry run by default; overrule and confirm flags', () => {
    assert.deepEqual(parseArgs(['--tenant', 'dolphins']), { tenant: 'dolphins', confirm: false });
    assert.deepEqual(
      parseArgs(['--tenant', 'dolphins', '--overrule-series', 'EMCU', '--confirm']),
      {
        tenant: 'dolphins',
        confirm: true,
        overruleSeries: 'EMCU',
      },
    );
  });

  test('only the dolphins tenant; unknown flags and an empty overrule fail', () => {
    assert.throws(() => parseArgs(['--tenant', 'titans']), /must be "dolphins"/);
    assert.throws(() => parseArgs(['--tenant', 'dolphins', '--allow-clashes']), /unknown flag/);
    assert.throws(
      () => parseArgs(['--tenant', 'dolphins', '--overrule-series']),
      /needs a substring/,
    );
  });
});
