/**
 * The dolphins player audit CLI (read-only), pure: per-person export with the sync's own
 * intent, multi-club split (suspicious vs legitimate), no-ID / passport / unauditable
 * buckets, the SYNC backlog, and a report that never prints a full name, ID number or full
 * natural key. The snapshot is loaded through an in-memory repo (medicoach-player-cli's
 * pattern).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Club,
  PendingPlayerSync,
  PlayerClearance,
  PlayerRegistration,
  PlayerSyncReview,
  TenantConfig,
} from '../src/types.js';
import { loadPlayerSyncSnapshot } from '../src/medicoach-sync/players.js';
import {
  buildAudit,
  initials,
  parseArgs,
  renderReport,
  resolveStage,
} from '../src/medicoach-sync/audit-dolphins-players.js';

const T = 'acme';
const NK = (c: string) => c.repeat(64);
const clubs = [
  { id: 'a', name: 'A CC', leagues: ['premier'] },
  { id: 'b', name: 'B CC', leagues: ['premier'] },
] as unknown as Club[];
const row = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    firstName: 'Sipho',
    lastName: 'Dlamini',
    dob: '2001-02-03',
    isMinor: false,
    consentAt: 'x',
    createdAt: '2026-01-01',
    clubId: 'a',
    team: 'premier',
    idType: 'sa-id',
    idNumber: '0102035000081',
    ...p,
  }) as PlayerRegistration;

const rosters: Record<string, PlayerRegistration[]> = {
  a: [
    // active at both clubs: suspicious
    row({ naturalKey: NK('1') }),
    // clearance-pending source at a, active at b: legitimate
    row({
      naturalKey: NK('2'),
      firstName: 'Thabo',
      lastName: 'Nkosi',
      status: 'clearance-pending',
    }),
    // no ID (name+dob key)
    row({ naturalKey: NK('3'), firstName: 'Ayanda', idNumber: undefined }),
    // passport, blank dob → unauditable
    row({
      naturalKey: NK('4'),
      firstName: 'Kudzai',
      idType: 'passport',
      idNumber: 'FN123',
      dob: '',
    }),
  ],
  b: [
    row({ naturalKey: NK('1'), clubId: 'b' }),
    row({ naturalKey: NK('2'), clubId: 'b', firstName: 'Thabo', lastName: 'Nkosi' }),
    row({ naturalKey: NK('5'), clubId: 'b', firstName: 'Lwazi', status: 'inactive' }),
  ],
};
const clearances = [
  { playerNaturalKey: NK('2'), fromClubId: 'a', toClubId: 'b', status: 'pending' },
] as unknown as PlayerClearance[];

const flags = { medicoachSync: true, whatsappInvites: true };
const fakeRepo = {
  getTenantConfig: async () =>
    ({
      tenant: T,
      leagues: [{ key: 'premier', label: 'Premier' }],
      features: flags,
      integrations: { medicoach: { playerSync: true, goLiveDate: '2026-09-01' } },
    }) as unknown as TenantConfig,
  listClubs: async () => clubs,
  listSeries: async () => [],
  listSeasonRuns: async () => [],
  listPlayers: async (_t: string, clubId: string) => rosters[clubId] ?? [],
  listAllClearances: async () => clearances,
  listPlayerDistinctPairs: async () => new Set<string>(),
};

const reviews = [
  {
    naturalKey: NK('3'),
    reason: 'smartclub-possible-duplicate',
    detectedAt: '2026-10-01T00:00:00Z',
    playerName: 'Ayanda Dlamini',
    dob: '2001-02-03',
    clubName: 'A CC',
    candidates: [],
  },
] as PlayerSyncReview[];
const pending = [
  { naturalKey: NK('4'), changedAt: 'x', enqueuedAt: '2026-10-02T00:00:00Z', attempts: 2 },
  { naturalKey: NK('9'), changedAt: 'x', enqueuedAt: 'y', attempts: 0, op: 'erase' },
] as PendingPlayerSync[];

async function audit() {
  const snap = await loadPlayerSyncSnapshot(fakeRepo, T);
  return buildAudit({ tenant: T, stage: 'test', generatedAt: 'now', snap, reviews, pending });
}

describe('audit-dolphins-players', () => {
  test('args + stage + initials', () => {
    assert.deepEqual(parseArgs(['--tenant', 'acme', '--out', '/x']), { tenant: 'acme', out: '/x' });
    assert.throws(() => parseArgs(['--tenant', 'acme']), /--out is required/);
    assert.throws(() => parseArgs(['--tenant']), /needs a value/);
    assert.throws(() => parseArgs(['--tenant', 'a', '--out', 'x', '--confirm']), /unknown/);
    assert.equal(resolveStage({ SST_RESOURCE_App: '{"name":"x","stage":"prod"}' }), 'prod');
    assert.equal(resolveStage({}), 'unknown');
    assert.equal(initials('thabo', 'van der Merwe'), 'T.V.D.M.');
  });

  test('export: one entry per person, intent from the sync, flags verbatim, backlog', async () => {
    const { export: e } = await audit();
    assert.deepEqual(e.syncFeatureFlags.features, flags);
    assert.equal(e.syncFeatureFlags.playerSyncEnabled, true);
    assert.equal(e.players.length, 5);
    const p1 = e.players.find((p) => p.naturalKey === NK('1'))!;
    assert.equal(p1.ref, `smartclub:${T}:player:${NK('1')}`);
    assert.equal(p1.maskedName, 'S.D.');
    assert.equal(p1.birthYear, 2001);
    assert.equal(p1.clubs.length, 2);
    assert.equal(p1.intent?.op, 'upsert');
    assert.equal(p1.intent?.teamRefs.length, 2);
    assert.ok(p1.intent?.teamRefs.every((r) => r.startsWith(`smartclub:${T}:team:`)));
    // Pending clearance: upsert with the SOURCE's teams only.
    const p2 = e.players.find((p) => p.naturalKey === NK('2'))!;
    assert.equal(p2.intent?.op, 'upsert');
    assert.equal(p2.intent?.primaryClubId, 'b');
    const p5 = e.players.find((p) => p.naturalKey === NK('5'))!;
    assert.deepEqual(p5.intent, { op: 'remove', teamRefs: [], reason: 'no-eligible-row' });
    assert.equal(e.players.find((p) => p.naturalKey === NK('3'))!.backlog, 'review');
    const p4 = e.players.find((p) => p.naturalKey === NK('4'))!;
    assert.equal(p4.backlog, 'pending');
    assert.equal(p4.dobMissing, true);
    assert.equal(p4.birthYear, null);
    assert.equal(p4.idKind, 'passport');
  });

  test('buckets: multi-club split, no-ID, passport, unauditable, backlog', async () => {
    const a = await audit();
    assert.deepEqual(
      a.multiClub.suspicious.map((g) => g.nk),
      [NK('1')],
    );
    assert.deepEqual(
      a.multiClub.legitimate.map((g) => [g.nk, g.why]),
      [[NK('2'), 'clearance-pending']],
    );
    assert.deepEqual(
      a.noIdRows.map((r) => r.nk),
      [NK('3')],
    );
    assert.deepEqual(
      a.passportRows.map((r) => r.nk),
      [NK('4')],
    );
    assert.deepEqual(
      a.unauditableRows.map((r) => [r.nk, r.missing]),
      [[NK('4'), 'dob']],
    );
    assert.equal(a.reviews.length, 1);
    assert.deepEqual(
      a.pending.map((p) => [p.op, p.hasRows]),
      [
        ['sync', true],
        ['erase', false],
      ],
    );
  });

  test('report is masked: no full names, ID numbers or full natural keys', async () => {
    const md = renderReport(await audit());
    for (const leak of ['Sipho', 'Thabo', 'Ayanda', 'Dlamini', '0102035000081', 'FN123', NK('1')])
      assert.ok(!md.includes(leak), `report leaks ${leak}`);
    assert.ok(md.includes('11111111'), 'truncated key present');
    assert.ok(md.includes('"medicoachSync": true'), 'flags printed verbatim');
  });
});
