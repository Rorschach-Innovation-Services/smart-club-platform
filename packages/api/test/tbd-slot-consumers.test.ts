/**
 * Consumer audit for `tbd:` placeholder sides (ADR 0018): every server path that reads a
 * fixture side must treat `tbd:<label>` like the other placeholders — never a team, never a
 * club, never booked, never crashing — and show its words where a name is shown. Plus the pure
 * Set-team helpers (set-side.ts).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tbdOf } from '../../engine/src/formats.js';
import { mapFixture, type FixtureContext } from '../src/medicoach-export-build.js';
import { resolveTeam, teamIdsForClub } from '../src/teams.js';
import { findTeamBusy } from '../src/team-busy.js';
import { sameMatch } from '../src/medicoach-sync/schedule.js';
import { findClashes } from '../src/venue-clash.js';
import { fixtureClubIds } from '../src/umpires.js';
import { applySetSide, orphanSides, parseSetSide, tenantParticipant } from '../src/set-side.js';
import type { Club, Series } from '../src/types.js';

const BEST3 = tbdOf('Best 3rd place');
const CUP = tbdOf('Community Cup winner');

const club = (id: string, venue: string, over: Partial<Club> = {}) =>
  ({ id, name: id.toUpperCase(), leagues: ['mens-t20'], ground: { venue }, ...over }) as Club;
const clubs = [club('irene', 'Irene Oval'), club('pretoria', 'Pretoria Oval')];
const clubsById = new Map(clubs.map((c) => [c.id, c]));

const ko = (fixtures: unknown[], over: Partial<Series> = {}): Series =>
  ({
    id: 's-ko',
    name: 'KO',
    startDate: '2027-02-14',
    teams: ['irene', 'pretoria'],
    participants: [
      { teamId: 'irene', clubId: 'irene', name: 'Irene' },
      { teamId: 'pretoria', clubId: 'pretoria', name: 'Pretoria' },
    ],
    fixtures,
    released: false,
    releasedAt: null,
    version: 1,
    ...over,
  }) as Series;

describe('tbd: consumers', () => {
  test('medicoach export: a tbd: (or pos:) side skips the fixture as unresolved-side', () => {
    const ctx: FixtureContext = {
      tenant: 'titans',
      utcOffset: '+02:00',
      seriesId: 's-ko',
      resolveTeam: (id) => (id === 'irene' ? { ref: 'team:irene' } : null),
      phase: 2,
      stage: 'Final',
    };
    const base = { id: 'f1', round: 1, date: '2027-03-20', time: '09:00', home: 'irene' };
    assert.deepEqual(mapFixture({ ...base, away: CUP }, ctx), {
      kind: 'skip',
      reason: 'unresolved-side',
    });
    assert.deepEqual(mapFixture({ ...base, away: 'pos:s-g-e:1' }, ctx), {
      kind: 'skip',
      reason: 'unresolved-side',
    });
    // a win: side is still exported as a slot
    const ok = mapFixture({ ...base, away: 'win:f7' }, ctx);
    assert.equal(ok.kind, 'ok');
  });

  test('broadcast resolveTeam renders the words, with no club behind them', () => {
    const r = resolveTeam(ko([]), BEST3, clubsById);
    assert.equal(r.name, 'Best 3rd place');
    assert.equal(r.clubId, undefined);
    assert.deepEqual(teamIdsForClub(ko([]), 'irene'), ['irene']);
  });

  test('team-busy: a tbd: side is never busy and never books', () => {
    const s = ko([{ id: 'f1', date: '2027-02-14', time: '09:00', home: 'irene', away: BEST3 }]);
    const hit = findTeamBusy(
      [s, ko([{ id: 'f9', date: '2027-02-14', time: '09:00', home: 'pretoria', away: BEST3 }])],
      { seriesId: 'x', fixtureId: 'y', home: BEST3, away: 'pretoria' },
      '2027-02-14',
      '09:00',
    );
    assert.equal(hit.home, undefined, 'the shared label is not a team');
    assert.ok(hit.away, 'a real team is still checked');
  });

  test('medicoach schedule: filling a tbd: side is the same match', () => {
    const a = { id: 'f1', home: 'irene', away: BEST3 } as never;
    const b = { id: 'f1', home: 'irene', away: 'pretoria' } as never;
    assert.equal(sameMatch(a, b), true);
  });

  test('clash gate: a fixture with a tbd: home has no ground; the words show in a clash line', () => {
    const subject = ko([
      { id: 'f1', date: '2027-02-14', time: '09:00', home: BEST3, away: 'irene' },
      {
        id: 'f2',
        date: '2027-02-14',
        time: '09:00',
        home: 'pretoria',
        away: BEST3,
        venueName: 'Irene Oval',
      },
    ]);
    const other = ko(
      [{ id: 'f1', date: '2027-02-14', time: '09:00', home: 'irene', away: 'pretoria' }],
      { id: 's-other', name: 'Other' },
    );
    const clashes = findClashes(subject, [other], clubs, []);
    assert.equal(clashes.length, 1, 'only the fixture with a real ground can clash');
    assert.equal(clashes[0].fixtureId, 'f2');
    assert.equal(clashes[0].away, 'Best 3rd place');
  });

  test('umpire visibility: a tbd: side maps to no real club', () => {
    const ids = fixtureClubIds(ko([]), { home: 'irene', away: BEST3 });
    assert.deepEqual(
      ids.filter((id) => clubsById.has(id)),
      ['irene'],
    );
  });
});

describe('set-side helpers', () => {
  const fixtures = [{ id: 'f1', home: 'pos:s-g-a:1', away: BEST3 }];

  test('parseSetSide validates the wire shape', () => {
    assert.deepEqual(parseSetSide({ fixtureId: 'f1', side: 'home', teamId: ' irene ' }), {
      fixtureId: 'f1',
      side: 'home',
      teamId: 'irene',
    });
    assert.equal(parseSetSide({ fixtureId: 'f1', side: 'away', teamId: null }).teamId, null);
    for (const bad of [
      null,
      [],
      {},
      { fixtureId: 'f1', side: 'x', teamId: 'a' },
      { fixtureId: 'f1', side: 'home', teamId: '' },
    ])
      assert.throws(() => parseSetSide(bad), /setSide/);
  });

  test('tenantParticipant finds a roster side in any league, with its own venue', () => {
    const cent = club('centurion', 'Centurion Park', {
      leagues: ['mens-t20', 'premier-league'],
      leagueTeams: { 'premier-league': 2 },
      teamRosters: {
        'premier-league': [
          { id: 'tm_c1', name: 'Centurion 1' },
          { id: 'tm_c2', name: 'Centurion 2', venue: 'B Field' },
        ],
      },
    } as Partial<Club>);
    assert.deepEqual(tenantParticipant([cent], 'tm_c2'), {
      teamId: 'tm_c2',
      clubId: 'centurion',
      name: 'Centurion 2',
      venue: 'B Field',
    });
    assert.equal(tenantParticipant([cent], 'centurion')?.name, 'CENTURION');
    assert.equal(tenantParticipant([cent], 'nope'), null);
  });

  test('a legacy series (no participants) only takes a club, and gains no snapshot', () => {
    const legacy = ko(fixtures, { participants: undefined });
    const next = applySetSide(legacy, { fixtureId: 'f1', side: 'away', teamId: 'pretoria' }, clubs);
    assert.equal(next.participants, undefined);
    assert.deepEqual(next.teams, ['irene', 'pretoria']);
    assert.throws(
      () => applySetSide(legacy, { fixtureId: 'f1', side: 'away', teamId: 'tm_x' }, clubs),
      /unknown club/,
    );
  });

  test('orphanSides: participants, teams, placeholders and slotted sides are fine', () => {
    const s = ko([
      { id: 'f1', home: 'irene', away: BEST3 },
      { id: 'f2', home: 'tm_puller', away: 'pretoria', slots: { home: 'win:f1' } },
      { id: 'f3', home: 'ghost', away: 'irene' },
      { id: 'f4', home: '', away: undefined },
    ]);
    assert.deepEqual(orphanSides(s), ['f3 home ghost']);
    assert.deepEqual(orphanSides({ fixtures: [{ id: 'f1', home: 'x' }], teams: [] } as never), []);
  });
});
