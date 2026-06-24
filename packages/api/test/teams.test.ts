/**
 * Unit tests for the team↔club resolvers in teams.ts — the backend twin of the
 * frontend resolvers in src/data.ts, used by the player-fixtures broadcast. These
 * assert the parity contract: legacy series fall back to club-id semantics, and a
 * participant series resolves names/coords from its self-contained snapshot.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { teamIdsForClub, resolveTeam } from '../src/teams.js';
import type { Club, Series } from '../src/types.js';

const clubs = new Map<string, Club>([
  [
    'glenwood',
    {
      id: 'glenwood',
      name: 'Glenwood',
      ground: { venue: 'Oval', lat: -29.85, lon: 31.02 },
    } as Club,
  ],
  [
    'pirates',
    { id: 'pirates', name: 'Pirates', ground: { venue: 'Bay', lat: -29.9, lon: 31.0 } } as Club,
  ],
]);

describe('teamIdsForClub', () => {
  test('legacy series (no participants): the clubId is its own teamId', () => {
    const s = { teams: ['glenwood', 'pirates'] } as unknown as Series;
    assert.deepEqual(teamIdsForClub(s, 'glenwood'), ['glenwood']);
  });

  test('participant series: returns all of the club’s sides', () => {
    const s = {
      teams: ['tm_a', 'tm_b', 'pirates'],
      participants: [
        { teamId: 'tm_a', clubId: 'glenwood', name: 'Glenwood A' },
        { teamId: 'tm_b', clubId: 'glenwood', name: 'Glenwood B' },
        { teamId: 'pirates', clubId: 'pirates', name: 'Pirates' },
      ],
    } as unknown as Series;
    assert.deepEqual(teamIdsForClub(s, 'glenwood').sort(), ['tm_a', 'tm_b']);
    assert.deepEqual(teamIdsForClub(s, 'pirates'), ['pirates']);
  });
});

describe('resolveTeam', () => {
  test('legacy series: resolves a teamId as a clubId', () => {
    const s = { teams: ['glenwood', 'pirates'] } as unknown as Series;
    const r = resolveTeam(s, 'pirates', clubs);
    assert.equal(r.clubId, 'pirates');
    assert.equal(r.name, 'Pirates');
    assert.equal(r.venue, 'Bay');
    assert.equal(r.lat, -29.9);
  });

  test('legacy series: an unknown clubId degrades to TBA, no throw', () => {
    const s = { teams: ['ghost'] } as unknown as Series;
    const r = resolveTeam(s, 'ghost', clubs);
    assert.equal(r.name, 'TBA');
    assert.equal(r.clubId, 'ghost');
  });

  test('participant series: resolves name + venue from the snapshot', () => {
    const s = {
      teams: ['tm_a'],
      participants: [
        {
          teamId: 'tm_a',
          clubId: 'glenwood',
          name: 'Glenwood A',
          venue: 'Oval',
          lat: -29.85,
          lon: 31.02,
        },
      ],
    } as unknown as Series;
    const r = resolveTeam(s, 'tm_a', clubs);
    assert.equal(r.clubId, 'glenwood');
    assert.equal(r.name, 'Glenwood A');
    assert.equal(r.venue, 'Oval');
    assert.equal(r.club?.name, 'Glenwood');
  });

  test('participant with no own pin falls back to the club ground coords', () => {
    const s = {
      teams: ['tm_b'],
      participants: [{ teamId: 'tm_b', clubId: 'glenwood', name: 'Glenwood B' }],
    } as unknown as Series;
    const r = resolveTeam(s, 'tm_b', clubs);
    assert.equal(r.lat, -29.85);
    assert.equal(r.lon, 31.02);
    assert.equal(r.venue, 'Oval');
  });

  test('orphaned participant id (in teams but not participants) degrades to TBA', () => {
    const s = {
      teams: ['tm_x'],
      participants: [{ teamId: 'tm_y', clubId: 'glenwood', name: 'Y' }],
    } as unknown as Series;
    const r = resolveTeam(s, 'tm_x', clubs);
    assert.equal(r.name, 'TBA');
    assert.equal(r.clubId, undefined);
  });

  test('an intra-club derby resolves both sides to the same club, distinct names', () => {
    const s = {
      teams: ['tm_a', 'tm_b'],
      participants: [
        { teamId: 'tm_a', clubId: 'glenwood', name: 'Glenwood A' },
        { teamId: 'tm_b', clubId: 'glenwood', name: 'Glenwood B' },
      ],
    } as unknown as Series;
    const a = resolveTeam(s, 'tm_a', clubs);
    const b = resolveTeam(s, 'tm_b', clubs);
    assert.equal(a.clubId, b.clubId); // same club
    assert.notEqual(a.name, b.name); // distinct sides
  });
});
