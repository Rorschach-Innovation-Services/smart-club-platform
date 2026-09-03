/**
 * Unit tests for venue-clash.ts's ground-name keying (groundKey / VENUE_ALIASES).
 * Pure — no repo, no DynamoDB.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groundKey, findClashes, formatClash, clashKey } from '../src/venue-clash.js';
import type { Series, Club, Venue } from '../src/types.js';

const mkSeries = (over: Partial<Series>): Series =>
  ({
    id: 'x',
    name: 'X',
    startDate: '2026-09-27',
    teams: [],
    fixtures: [],
    released: false,
    releasedAt: null,
    version: 1,
    ...over,
  }) as Series;

describe('groundKey — Gledhow shared-ground alias (union, 31 Aug 2026)', () => {
  test('Ilembe\'s "Gledhow Cricket Grounds" (trailing space) keys onto Dawnheights\' "Gledhow Cricket Ground"', () => {
    assert.equal(groundKey('Gledhow Cricket Grounds '), groundKey('Gledhow Cricket Ground'));
  });

  test('an unrelated ground name is unaffected by the alias', () => {
    assert.notEqual(groundKey('Kingsmead Oval'), groundKey('Gledhow Cricket Ground'));
  });
});

describe('groundKey — Penguin shared-ground alias (union, 31 Aug 2026)', () => {
  test('Saints\' "Chatsworth, Penguin Grounds" keys onto the registry\'s "PENGUIN STREET GROUND"', () => {
    assert.equal(groundKey('Chatsworth, Penguin Grounds'), groundKey('PENGUIN STREET GROUND'));
  });
});

describe('groundKey — exact field numbering (union, 31 Aug 2026)', () => {
  test('old venue spellings key onto the new numbered field names', () => {
    assert.equal(groundKey('Siripat Road Grounds'), groundKey('Siripat 1'));
    assert.equal(groundKey('Siripat Grounds'), groundKey('Siripat 2'));
    assert.equal(groundKey('Crusaders Sports Club'), groundKey('Crusaders 1'));
    assert.equal(groundKey('Crusaders 2 Field'), groundKey('Crusaders 2'));
    assert.equal(groundKey('Danville'), groundKey('Danville 1'));
    assert.equal(groundKey('Van Riebek Park (Harlequins 1)'), groundKey('Harlequins 1'));
    assert.equal(groundKey('Van Riebek Park (Harlequins 2)'), groundKey('Harlequins 2'));
  });

  test('generic complex names key onto their lowest numbered field', () => {
    assert.equal(groundKey('Cato Manor'), groundKey('Cato Manor 1'));
    assert.equal(groundKey('Cator Manor'), groundKey('Cato Manor 1')); // typo spelling
    assert.equal(groundKey('Harlequins'), groundKey('Harlequins 1'));
    assert.equal(groundKey('Highbury grounds'), groundKey('Highbury 1'));
  });

  test('distinct numbered fields still key apart', () => {
    assert.notEqual(groundKey('Siripat 1'), groundKey('Siripat 2'));
    assert.notEqual(groundKey('Harlequins 1'), groundKey('Harlequins 2'));
    assert.notEqual(groundKey('Cato Manor 1'), groundKey('Cato Manor 2'));
  });
});

describe('findClashes — resolved sides, rounds and series name', () => {
  const kingsmead = { id: 'v-k', name: 'Kingsmead', surfaces: 1 } as Venue;

  test('a participants-snapshot partner resolves with.home/away/round and seriesName', () => {
    const b = mkSeries({
      id: 'B',
      name: 'Series B',
      participants: [
        { teamId: 't-bh', clubId: 'cbh', name: 'Bravo Home' },
        { teamId: 't-ba', clubId: 'cba', name: 'Bravo Away' },
      ],
      fixtures: [
        {
          id: 'bf1',
          round: 3,
          date: '2026-09-27',
          time: '09:00',
          home: 't-bh',
          away: 't-ba',
          venueName: 'Kingsmead',
        },
      ],
    });
    const a = mkSeries({
      id: 'A',
      name: 'Series A',
      participants: [
        { teamId: 't-ah', clubId: 'cah', name: 'Alpha Home' },
        { teamId: 't-aa', clubId: 'caa', name: 'Alpha Away' },
      ],
      fixtures: [
        {
          id: 'af1',
          round: 1,
          date: '2026-09-27',
          time: '09:00',
          home: 't-ah',
          away: 't-aa',
          venueName: 'Kingsmead',
        },
      ],
    });
    const clashes = findClashes(a, [a, b], [], [kingsmead]);
    assert.equal(clashes.length, 1);
    const c = clashes[0];
    assert.equal(c.fixtureId, 'af1');
    assert.equal(c.round, 1);
    assert.equal(c.home, 'Alpha Home');
    assert.equal(c.away, 'Alpha Away');
    assert.equal(c.ground, 'Kingsmead');
    assert.equal(c.with.seriesId, 'B');
    assert.equal(c.with.seriesName, 'Series B');
    assert.equal(c.with.fixtureId, 'bf1');
    assert.equal(c.with.round, 3);
    assert.equal(c.with.home, 'Bravo Home');
    assert.equal(c.with.away, 'Bravo Away');
  });

  test('a legacy clubId series resolves side names from the clubs list', () => {
    const clubs: Club[] = [
      { id: 'legacy-home', name: 'Legacy Home CC' } as Club,
      { id: 'legacy-away', name: 'Legacy Away CC' } as Club,
    ];
    const legacy = mkSeries({
      id: 'L',
      name: 'Legacy',
      fixtures: [
        {
          id: 'lf1',
          round: 2,
          date: '2026-09-27',
          time: '09:00',
          home: 'legacy-home',
          away: 'legacy-away',
          venueName: 'Kingsmead',
        },
      ],
    });
    const other = mkSeries({
      id: 'O',
      name: 'Other',
      participants: [{ teamId: 't-o', clubId: 'co', name: 'Oscar' }],
      fixtures: [{ id: 'of1', round: 5, date: '2026-09-27', home: 't-o', venueName: 'Kingsmead' }],
    });
    const clashes = findClashes(legacy, [legacy, other], clubs, [kingsmead]);
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].home, 'Legacy Home CC');
    assert.equal(clashes[0].away, 'Legacy Away CC');
  });

  test('a win: slot ref falls back to the raw string', () => {
    const bracket = mkSeries({
      id: 'K',
      name: 'Knockout',
      fixtures: [
        {
          id: 'kf1',
          round: 9,
          date: '2026-09-27',
          time: '09:00',
          home: 'win:f1',
          away: 'win:f2',
          venueName: 'Kingsmead',
        },
      ],
    });
    const other = mkSeries({
      id: 'O2',
      name: 'Other',
      participants: [{ teamId: 't-o', clubId: 'co', name: 'Oscar' }],
      fixtures: [{ id: 'of1', round: 5, date: '2026-09-27', home: 't-o', venueName: 'Kingsmead' }],
    });
    const clashes = findClashes(bracket, [bracket, other], [], [kingsmead]);
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].home, 'win:f1');
    assert.equal(clashes[0].away, 'win:f2');
  });
});

describe('formatClash / clashKey', () => {
  const kingsmead = { id: 'v-k', name: 'Kingsmead', surfaces: 1 } as Venue;
  const a = mkSeries({
    id: 'A',
    name: 'Series A',
    participants: [
      { teamId: 't-ah', clubId: 'cah', name: 'Alpha Home' },
      { teamId: 't-aa', clubId: 'caa', name: 'Alpha Away' },
    ],
    fixtures: [
      {
        id: 'af1',
        round: 1,
        date: '2026-09-27',
        time: '09:00',
        home: 't-ah',
        away: 't-aa',
        venueName: 'Kingsmead',
      },
    ],
  });
  const b = mkSeries({
    id: 'B',
    name: 'Series B',
    fixtures: [
      { id: 'bf1', round: 1, date: '2026-09-27', time: '09:00', home: 'x', venueName: 'Kingsmead' },
    ],
  });

  test('formatClash reproduces the legacy release-gate line', () => {
    const c = findClashes(a, [a, b], [], [kingsmead])[0];
    assert.equal(formatClash(c), 'af1: Kingsmead on 2026-09-27 09:00 (also B/bf1)');
  });

  test('clashKey ignores date/time — same pair on the same ground is one key', () => {
    const c = findClashes(a, [a, b], [], [kingsmead])[0];
    const moved = { ...c, time: '13:00', date: '2026-12-31' };
    assert.equal(clashKey(moved), clashKey(c));
  });
});
