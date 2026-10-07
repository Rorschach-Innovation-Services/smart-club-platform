/**
 * Medicoach player sync placement + intent (ADR 0019), pure:
 *  - regression: the shared `desiredTeamRefs` (used by BOTH the bundle exporter and the sync)
 *    reproduces the exporter's teamRefs on the existing placement fixture, and the sync's own
 *    placement context (`buildPlacementContext`) agrees with the bundle player by player;
 *  - the per-person `syncIntent` table (active, clearance-pending source/destination,
 *    rejected-and-reactivated, inactive/placeholder-only → remove, veterans union);
 *  - the name+dob key the possible-duplicate guard matches on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refs } from '../src/medicoach-bundle.js';
import { buildBundle } from '../src/medicoach-export-build.js';
import {
  buildPlacementContext,
  distinctPair,
  nameDobKey,
  playerSyncEnabled,
  syncIntent,
} from '../src/medicoach-sync/player-placement.js';
import type { PlayerClearance, PlayerRegistration, TenantConfig } from '../src/types.js';
import { placementInputs, T } from './data/medicoach/placement-fixture.js';

const input = placementInputs();
const ctx = buildPlacementContext({
  tenant: T,
  config: input.config,
  clubs: input.clubs,
  series: input.series,
  seasonRuns: input.seasonRuns,
  recipes: input.recipes,
});
const allRows = [...input.playersByClub.values()].flat();
const rowsOf = (nk: string) => allRows.filter((r) => r.naturalKey === nk);
const row = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    firstName: 'Sipho',
    lastName: 'Dlamini',
    dob: '2001-02-03',
    isMinor: false,
    consentAt: 'x',
    createdAt: '2026-01-01',
    naturalKey: 'nk-x',
    clubId: 'solo',
    team: 'premier',
    ...p,
  }) as PlayerRegistration;
const clearance = (c: Partial<PlayerClearance>) =>
  ({ fromClubId: 'solo', toClubId: 'multi', status: 'pending', ...c }) as PlayerClearance;

describe('desiredTeamRefs — regression against the bundle exporter', () => {
  const { bundle } = buildBundle(input);

  test('every bundled player gets exactly the teamRefs the sync would push', () => {
    assert.ok(bundle.people.players.length >= 10);
    for (const p of bundle.people.players) {
      const nk = p.externalRef.slice(refs.player(T, '').length);
      const intent = syncIntent(rowsOf(nk), [], ctx);
      assert.equal(intent.op, 'upsert', nk);
      if (intent.op === 'upsert') assert.deepEqual(intent.teamRefs, p.teamRefs, nk);
    }
  });

  test('every team ref the sync places a fixture player on exists in the bundle', () => {
    const teams = new Set(bundle.teams.map((t) => t.externalRef));
    for (const nk of new Set(allRows.map((r) => r.naturalKey))) {
      const intent = syncIntent(rowsOf(nk), [], ctx);
      if (intent.op === 'upsert') for (const t of intent.teamRefs) assert.ok(teams.has(t), t);
    }
  });
});

describe('syncIntent — per person, never per row', () => {
  test('one active row → upsert with its desired teams', () => {
    const i = syncIntent([row({})], [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
      assert.equal(i.primary.clubId, 'solo');
    }
  });

  test('a status-absent legacy row counts as active', () => {
    const i = syncIntent([row({ status: undefined })], [], ctx);
    assert.equal(i.op, 'upsert');
  });

  test('main + veterans: the union of both clubs’ teams, main side first', () => {
    const i = syncIntent([row({ veteransClubId: 'vets-club' })], [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.deepEqual(i.teamRefs, [
        refs.team(T, 'premier', 'solo'),
        refs.team(T, 'veterans-premier', 'vets-club'),
      ]);
      assert.equal(i.veteransClubId, 'vets-club');
    }
  });

  test('pending clearance: source still counts, destination waits for approval', () => {
    const rows = [
      row({ clubId: 'solo', status: 'clearance-pending' }),
      row({ clubId: 'multi', status: 'clearance-pending', team: 'promotion' }),
    ];
    const i = syncIntent(rows, [clearance({ fromClubId: 'solo', toClubId: 'multi' })], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
      assert.equal(i.primary.clubId, 'solo');
    }
  });

  test('approved clearance: destination active, source inactive → the new club’s team only', () => {
    const rows = [
      row({ clubId: 'solo', status: 'inactive' }),
      row({ clubId: 'multi', status: 'active', team: 'promotion' }),
    ];
    const i = syncIntent(rows, [clearance({ status: 'approved' })], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') assert.deepEqual(i.teamRefs, [refs.team(T, 'promotion', 'multi')]);
  });

  test('rejected clearance (source reactivated, destination gone) → upsert with source teams', () => {
    const i = syncIntent([row({ clubId: 'solo' })], [clearance({ status: 'rejected' })], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
  });

  test('a clearance-pending row with no pending clearance naming it is not eligible', () => {
    const i = syncIntent([row({ status: 'clearance-pending' })], [], ctx);
    assert.deepEqual(i, { op: 'remove', reason: 'no-eligible-row' });
  });

  test('all inactive / legacy clearance-rejected / placeholder-only → remove', () => {
    for (const rows of [
      [row({ status: 'inactive' })],
      [row({ status: 'clearance-rejected' })],
      [row({ placeholder: true })],
      [row({ status: 'inactive' }), row({ clubId: 'multi', placeholder: true })],
    ])
      assert.deepEqual(syncIntent(rows, [], ctx), { op: 'remove', reason: 'no-eligible-row' });
  });

  test('no rows at all (club cleanup removed the last one) → remove, never erase', () => {
    assert.deepEqual(syncIntent([], [], ctx), { op: 'remove', reason: 'no-rows' });
  });

  test('veterans club erased (pointer scrubbed) → upsert with reduced teams, not remove', () => {
    const i = syncIntent([row({ veteransClubId: undefined })], [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
  });

  test('primary row: active beats pending source, then the newest registration', () => {
    const rows = [
      row({ clubId: 'solo', createdAt: '2026-03-01' }),
      row({ clubId: 'multi', team: 'promotion', createdAt: '2026-05-01' }),
    ];
    const i = syncIntent(rows, [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.equal(i.primary.clubId, 'multi');
      assert.deepEqual(i.teamRefs, [
        refs.team(T, 'promotion', 'multi'),
        refs.team(T, 'premier', 'solo'),
      ]);
    }
  });
});

describe('guards and flags', () => {
  test('name+dob key: case, accents, punctuation and spacing tolerant; blank never matches', () => {
    assert.equal(
      nameDobKey({ firstName: ' Zoë ', lastName: "O'Neil", dob: '2001-02-03' }),
      nameDobKey({ firstName: 'zoe', lastName: 'o neil', dob: '2001-02-03' }),
    );
    assert.notEqual(
      nameDobKey({ firstName: 'Zoe', lastName: 'Oneil', dob: '2001-02-03' }),
      nameDobKey({ firstName: 'Zoe', lastName: 'Oneil', dob: '2001-02-04' }),
    );
    assert.equal(nameDobKey({ firstName: 'Zoe', lastName: 'Oneil' }), '');
  });

  test('distinct pairs are order-independent', () => {
    assert.deepEqual(distinctPair('b', 'a'), ['a', 'b']);
    assert.deepEqual(distinctPair('a', 'b'), ['a', 'b']);
  });

  test('player sync needs BOTH medicoachSync and integrations.medicoach.playerSync', () => {
    const cfg = (features: object, playerSync?: boolean) =>
      ({ features, integrations: { medicoach: { playerSync } } }) as unknown as TenantConfig;
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: true }, true)), true);
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: false }, true)), false);
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: true }, false)), false);
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: true })), false);
    assert.equal(playerSyncEnabled(null), false);
  });
});
