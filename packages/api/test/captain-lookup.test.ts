/** Tests for src/captain-lookup.ts — pure: report choice, roster matching, playedBefore. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptainsReport, PlayerRegistration, StoredFixtureScorecard } from '../src/types.js';
import { normalizeName, pickSourceReport, resolveClubCaptain } from '../src/captain-lookup.js';

const report = (o: Partial<CaptainsReport>): CaptainsReport =>
  ({
    id: `s~f~${o.clubId ?? 'c1'}`,
    seriesId: 's1',
    fixtureId: 'f1',
    clubId: 'c1',
    status: 'submitted',
    source: 'auto',
    matchDate: '2026-10-11',
    side: 'home',
    clubName: 'Westville',
    opponentName: 'Crusaders',
    competition: 'Premier League',
    umpiresSnapshot: [],
    recipient: { kind: 'chair' },
    captainName: 'Sbusiso Phewa',
    umpires: [],
    general: '',
    submittedAt: '2026-10-12T10:00:00Z',
    ...o,
  }) as CaptainsReport;

const player = (o: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    naturalKey: `k-${o.firstName ?? 'Sbusiso'}-${Math.random()}`,
    clubId: 'c1',
    firstName: 'Sbusiso',
    lastName: 'Phewa',
    dob: '1995-01-01',
    email: 'sp@example.com',
    isMinor: false,
    consentAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    ...o,
  }) as PlayerRegistration;

const card = (
  innings: Array<{ team: string; batters?: string[]; bowlers?: string[]; fow?: string[] }>,
) =>
  ({
    seriesId: 's1',
    fixtureId: 'f1',
    medicoachMatchId: 'm',
    medicoachTournamentId: 't',
    schemaVersion: 1,
    fetchedAt: '2026-10-12T00:00:00Z',
    available: true,
    innings: innings.map((i) => ({
      battingTeamName: i.team,
      totalRuns: 0,
      wickets: 0,
      overs: '0',
      extras: {},
      batters: (i.batters ?? []).map((name) => ({ name })),
      bowlers: (i.bowlers ?? []).map((name) => ({ name })),
      fallOfWickets: (i.fow ?? []).map((batterName) => ({ batterName })),
    })),
  }) as unknown as StoredFixtureScorecard;

describe('normalizeName', () => {
  test('lowercases, strips punctuation and diacritics, collapses whitespace', () => {
    assert.equal(normalizeName("  Zoë   O'Brien.  "), 'zoe obrien');
  });
});

describe('pickSourceReport', () => {
  test('newest submitted wins', () => {
    const r = pickSourceReport(
      [
        report({ id: 'old', captainName: 'A', submittedAt: '2026-10-01T00:00:00Z' }),
        report({ id: 'new', captainName: 'B', submittedAt: '2026-10-10T00:00:00Z' }),
        report({ id: 'pending', status: 'pending', submittedAt: '2026-10-15T00:00:00Z' }),
        report({ id: 'other', clubId: 'c2', submittedAt: '2026-10-16T00:00:00Z' }),
      ],
      'c1',
    );
    assert.equal(r?.id, 'new');
  });

  test('same series preferred over a newer other-series report', () => {
    const r = pickSourceReport(
      [
        report({ id: 'same', seriesId: 's1', submittedAt: '2026-10-01T00:00:00Z' }),
        report({ id: 'newer', seriesId: 's2', submittedAt: '2026-10-10T00:00:00Z' }),
      ],
      'c1',
      { seriesId: 's1' },
    );
    assert.equal(r?.id, 'same');
  });

  test('same competition preferred over any when no series match', () => {
    const r = pickSourceReport(
      [
        report({
          id: 't20',
          seriesId: 's3',
          competition: 'T20',
          submittedAt: '2026-10-01T00:00:00Z',
        }),
        report({ id: 'league', seriesId: 's2', submittedAt: '2026-10-10T00:00:00Z' }),
      ],
      'c1',
      { seriesId: 's9', competition: 'T20' },
    );
    assert.equal(r?.id, 't20');
  });

  test('blank captainName skipped, older report used', () => {
    const r = pickSourceReport(
      [
        report({ id: 'old', submittedAt: '2026-10-01T00:00:00Z' }),
        report({ id: 'blank', captainName: '  ', submittedAt: '2026-10-10T00:00:00Z' }),
      ],
      'c1',
    );
    assert.equal(r?.id, 'old');
  });
});

describe('resolveClubCaptain', () => {
  test('no submitted history → no-history', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({ status: 'pending' })], roster: [] },
      't',
      'c1',
    );
    assert.equal(r.reason, 'no-history');
    assert.equal(r.match, null);
  });

  test('only blank captains → blank-captain', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({ captainName: '' })], roster: [] },
      't',
      'c1',
    );
    assert.equal(r.reason, 'blank-captain');
  });

  test('exact roster match', async () => {
    const p = player({ cell: '0821234567' });
    const r = await resolveClubCaptain(
      { reports: [report({ captainName: 'sbusiso  PHEWA' })], roster: [p] },
      't',
      'c1',
    );
    assert.equal(r.reason, undefined);
    assert.deepEqual(r.match, {
      name: 'Sbusiso Phewa',
      playerKey: p.naturalKey,
      email: 'sp@example.com',
      cell: '0821234567',
    });
    assert.equal(r.initialOnly, undefined);
  });

  test('roster via injected listPlayers', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({})], listPlayers: async () => [player({})] },
      't',
      'c1',
    );
    assert.equal(r.match?.name, 'Sbusiso Phewa');
  });

  test('initial-form match flagged initialOnly', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({ captainName: 'S. Phewa' })], roster: [player({})] },
      't',
      'c1',
    );
    assert.equal(r.match?.name, 'Sbusiso Phewa');
    assert.equal(r.initialOnly, true);
  });

  test('two same-name players (one a minor) → ambiguous-roster', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({})], roster: [player({}), player({ isMinor: true, email: undefined })] },
      't',
      'c1',
    );
    assert.equal(r.reason, 'ambiguous-roster');
    assert.equal(r.match, null);
  });

  test('not on roster', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({})], roster: [player({ firstName: 'Other' })] },
      't',
      'c1',
    );
    assert.equal(r.reason, 'not-on-roster');
  });

  test('unique minor → minor', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({})], roster: [player({ isMinor: true })] },
      't',
      'c1',
    );
    assert.equal(r.reason, 'minor');
    assert.equal(r.match, null);
  });

  test('inactive → inactive', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({})], roster: [player({ status: 'inactive' })] },
      't',
      'c1',
    );
    assert.equal(r.reason, 'inactive');
  });

  test('unique match without contact → no-contact', async () => {
    const r = await resolveClubCaptain(
      { reports: [report({})], roster: [player({ email: undefined, cell: undefined })] },
      't',
      'c1',
    );
    assert.equal(r.reason, 'no-contact');
    assert.equal(r.match, null);
  });

  describe('playedBefore', () => {
    const deps = (scorecards?: StoredFixtureScorecard[]) => ({
      reports: [report({})],
      roster: [player({})],
      scorecards,
    });

    test('undefined when no scorecards supplied', async () => {
      assert.equal((await resolveClubCaptain(deps(), 't', 'c1')).playedBefore, undefined);
    });

    test('true when batting for the club', async () => {
      const sc = [card([{ team: 'Westville CC 1st XI', batters: ['Sbusiso Phewa'] }])];
      assert.equal((await resolveClubCaptain(deps(sc), 't', 'c1')).playedBefore, true);
    });

    test('true when bowling for the club (opponent batting)', async () => {
      const sc = [card([{ team: 'Westville' }, { team: 'Crusaders', bowlers: ['Sbusiso Phewa'] }])];
      assert.equal((await resolveClubCaptain(deps(sc), 't', 'c1')).playedBefore, true);
    });

    test('true via an alias passed in opts', async () => {
      const sc = [card([{ team: 'WCC', fow: ['Sbusiso Phewa'] }])];
      const r = await resolveClubCaptain(deps(sc), 't', 'c1', { clubNames: ['Westville', 'WCC'] });
      assert.equal(r.playedBefore, true);
    });

    test('false when the name only appears for another club', async () => {
      const sc = [card([{ team: 'Crusaders', batters: ['Sbusiso Phewa'] }])];
      assert.equal((await resolveClubCaptain(deps(sc), 't', 'c1')).playedBefore, false);
    });
  });
});
