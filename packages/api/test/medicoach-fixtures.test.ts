/**
 * Fixture mapping: status (cancelled skipped + counted, postponed scheduled with a note,
 * everything else scheduled with sourceStatus kept), slots only for undecided sides,
 * venue precedence, times, and slot sources dropped with a cancelled source fixture.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MedicoachBundleSchema, refs } from '../src/medicoach-bundle.js';
import {
  buildBundle,
  inferRounds,
  mapFixture,
  parseSeriesName,
  compareGroupLabels,
  type FixtureContext,
  type SourceFixture,
} from '../src/medicoach-export-build.js';
import type { Club, Series, TenantConfig } from '../src/types.js';

const ctx: FixtureContext = {
  tenant: 't',
  utcOffset: '+02:00',
  seriesId: 's-ko',
  phase: 1,
  stage: 'Knockout',
  resolveTeam: (id) =>
    ({
      a: { ref: refs.team('t', 'cup', 'a'), ground: 'A Oval' },
      b: { ref: refs.team('t', 'cup', 'b'), ground: 'B Park' },
    })[id] ?? null,
};
const base: SourceFixture = {
  id: 'f1',
  round: 1,
  date: '2026-10-03',
  time: '09:30',
  home: 'a',
  away: 'b',
};
const ok = (f: SourceFixture) => {
  const out = mapFixture(f, ctx);
  assert.equal(out.kind, 'ok');
  return out.kind === 'ok' ? out : (null as never);
};

describe('mapFixture status', () => {
  test('cancelled is skipped', () => {
    assert.deepEqual(mapFixture({ ...base, status: 'cancelled' }, ctx), {
      kind: 'skip',
      reason: 'cancelled',
    });
  });

  test('postponed is scheduled at its stored (rescheduled) date, with a note', () => {
    const out = ok({ ...base, status: 'postponed', date: '2026-12-05' });
    assert.equal(out.postponed, true);
    assert.equal(out.fixture.status, 'scheduled');
    assert.equal(out.fixture.sourceStatus, 'postponed');
    assert.equal(out.fixture.scheduledTime, '2026-12-05T09:30:00+02:00');
    assert.match(out.fixture.notes![0], /Postponed/);
  });

  test('completed and null stay scheduled, with sourceStatus preserved for the results backfill', () => {
    assert.equal(ok({ ...base, status: 'completed' }).fixture.sourceStatus, 'completed');
    assert.equal(ok({ ...base, status: 'completed' }).fixture.status, 'scheduled');
    assert.equal(ok({ ...base, status: null }).fixture.sourceStatus, null);
    assert.equal(ok({ ...base, status: 'scheduled' }).fixture.sourceStatus, 'scheduled');
  });

  test('an undated fixture is skipped; a missing time is 00:00 and flagged timeTbc', () => {
    assert.deepEqual(mapFixture({ ...base, date: undefined }, ctx), {
      kind: 'skip',
      reason: 'undated',
    });
    const f = ok({ ...base, time: undefined }).fixture;
    assert.equal(f.scheduledTime, '2026-10-03T00:00:00+02:00');
    assert.equal(f.timeTbc, true);
  });
});

describe('mapFixture sides', () => {
  test('a materialised side exports its concrete teamRef', () => {
    const f = ok(base).fixture;
    assert.equal(f.homeTeamRef, refs.team('t', 'cup', 'a'));
    assert.equal(f.homeSlot, undefined);
  });

  test('an undecided win:/lose: side is a slot pointing at the source fixture in the same series', () => {
    const f = ok({ ...base, id: 'f3', home: 'win:f1', away: 'lose:f2' }).fixture;
    assert.deepEqual(f.homeSlot, { kind: 'winner', ofFixtureRef: refs.fixture('t', 's-ko', 'f1') });
    assert.deepEqual(f.awaySlot, { kind: 'loser', ofFixtureRef: refs.fixture('t', 's-ko', 'f2') });
    assert.equal(f.homeTeamRef, undefined);
  });

  test('a half-decided final keeps the decided side concrete and only the other as a slot', () => {
    const f = ok({ ...base, id: 'f3', home: 'a', away: 'win:f2' }).fixture;
    assert.equal(f.homeTeamRef, refs.team('t', 'cup', 'a'));
    assert.deepEqual(f.awaySlot, { kind: 'winner', ofFixtureRef: refs.fixture('t', 's-ko', 'f2') });
  });

  test('an unknown side id is skipped rather than guessed', () => {
    assert.deepEqual(mapFixture({ ...base, away: 'ghost' }, ctx), {
      kind: 'skip',
      reason: 'unresolved-side',
    });
  });
});

describe('mapFixture venue', () => {
  test('venueOverride beats venueName beats the home team ground', () => {
    assert.equal(
      ok({ ...base, venueOverride: 'Kingsmead', venueName: 'Chatsworth' }).fixture.venue,
      'Kingsmead',
    );
    assert.equal(ok({ ...base, venueName: 'Chatsworth' }).fixture.venue, 'Chatsworth');
    assert.equal(ok(base).fixture.venue, 'A Oval');
  });

  test('withheld venue/time from the series is carried as flags', () => {
    const f = mapFixture(base, { ...ctx, venueWithheld: true });
    assert.equal(f.kind === 'ok' && f.fixture.venueWithheld, true);
  });
});

describe('helpers', () => {
  test('series names split into stream and group', () => {
    assert.deepEqual(parseSeriesName('Premier League · 50 Over · Top 6'), {
      streamLabel: '50 Over',
      groupLabel: 'Top 6',
    });
    assert.deepEqual(parseSeriesName('Veterans Premier · 30 Over'), {
      streamLabel: '30 Over',
      groupLabel: null,
    });
    assert.deepEqual(parseSeriesName('Friendly'), { streamLabel: null, groupLabel: null });
  });

  test('group labels order Top before Bottom, then naturally', () => {
    assert.deepEqual(['Bottom 6', 'Top 6'].sort(compareGroupLabels), ['Top 6', 'Bottom 6']);
    assert.deepEqual(['Group 10', 'Group 2', 'Group 1'].sort(compareGroupLabels), [
      'Group 1',
      'Group 2',
      'Group 10',
    ]);
  });

  test('rounds are inferred from how often the most-met pair meets', () => {
    assert.deepEqual(
      inferRounds([
        { home: 'a', away: 'b' },
        { home: 'a', away: 'c' },
      ]),
      { rounds: 1, maxMeetings: 1 },
    );
    assert.deepEqual(
      inferRounds([
        { home: 'a', away: 'b' },
        { home: 'b', away: 'a' },
      ]),
      { rounds: 2, maxMeetings: 2 },
    );
  });
});

describe('buildBundle fixture bookkeeping', () => {
  const clubs = ['a', 'b', 'c', 'd'].map(
    (id) =>
      ({
        id,
        name: id.toUpperCase(),
        leagues: ['cup'],
        ground: { venue: `${id} ground` },
      }) as unknown as Club,
  );
  const config = {
    tenant: 't',
    branding: { name: 'T' },
    leagues: [
      { key: 'cup', label: 'Cup', group: 'Cups', district: 'All districts', fixturesOnly: true },
    ],
  } as unknown as TenantConfig;
  const series = {
    id: 's-ko',
    name: 'Cup · Knockout',
    leagueKey: 'cup',
    teams: ['a', 'b', 'c', 'd'],
    participants: clubs.map((c) => ({ teamId: c.id, clubId: c.id, name: c.name })),
    fixtures: [
      { id: 'f1', round: 1, date: '2026-10-03', home: 'a', away: 'b' },
      { id: 'f2', round: 1, date: '2026-10-03', home: 'c', away: 'd', status: 'cancelled' },
      { id: 'f3', round: 2, date: '2026-10-10', home: 'win:f1', away: 'win:f2' },
      { id: 'f4', round: 1, date: '2026-10-04', home: 'b', away: 'c', status: 'postponed' },
    ],
    released: true,
    releasedAt: null,
    version: 1,
    startDate: '2026-10-03',
  } as unknown as Series;
  const { bundle, summary } = buildBundle({
    tenant: 't',
    config,
    clubs,
    playersByClub: new Map(),
    series: [series],
    seasonRuns: [],
    recipes: { tenant: 't', utcOffset: '+02:00', leagues: {} },
    options: { generatedAt: 'x' },
  });

  test('cancelled is counted; a fixture fed by a cancelled one is dropped as an orphan slot', () => {
    assert.equal(summary.fixtures.cancelledSkipped, 1);
    assert.equal(summary.fixtures.orphanSlotSkipped, 1);
    assert.equal(summary.fixtures.postponed, 1);
    const ids = bundle.leagues[0].competitions[0].fixtures.map((f) =>
      f.externalRef.split(':').pop(),
    );
    assert.deepEqual(ids, ['f1', 'f4']);
  });

  test('a fixturesOnly league gets a minimal league format and still validates', () => {
    const c = bundle.leagues[0].competitions[0];
    assert.equal(c.formatSource, 'fixtures-only');
    assert.equal(c.format.type, 'league');
    assert.equal(bundle.leagues[0].fixturesOnly, true);
    assert.ok(MedicoachBundleSchema.safeParse(bundle).success);
  });
});
