/**
 * The player-sync CLIs (ADR 0018), pure: `enqueue-players` plans the backfill (eligible
 * upserts queued, inactive people skipped, possible duplicates counted — the flush holds
 * them), and `audit-player-duplicates` groups same name + dob under different IDs, masking
 * names and leaving out natural keys. The snapshot is loaded through an in-memory repo.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Club, PlayerClearance, PlayerRegistration, TenantConfig } from '../src/types.js';
import { loadPlayerSyncSnapshot } from '../src/medicoach-sync/players.js';
import { parseArgs as parseEnqueue, planBackfill } from '../src/medicoach-sync/enqueue-players.js';
import {
  duplicateGroups,
  parseArgs as parseAudit,
} from '../src/medicoach-sync/audit-player-duplicates.js';

const T = 'acme';
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
    ...p,
  }) as PlayerRegistration;

const rosters: Record<string, PlayerRegistration[]> = {
  a: [
    row({ naturalKey: 'k1' }),
    row({ naturalKey: 'k2', firstName: 'Ayanda', status: 'inactive' }),
    row({ naturalKey: 'k3', firstName: 'Thabo', lastName: 'Nkosi', dob: '2004-04-04' }),
  ],
  b: [
    row({
      naturalKey: 'k4',
      clubId: 'b',
      firstName: 'THABO',
      lastName: 'nkosi',
      dob: '2004-04-04',
    }),
  ],
};

const fakeRepo = (distinct: string[] = []) => ({
  getTenantConfig: async () =>
    ({ tenant: T, leagues: [{ key: 'premier', label: 'Premier' }] }) as unknown as TenantConfig,
  listClubs: async () => clubs,
  listSeries: async () => [],
  listSeasonRuns: async () => [],
  listPlayers: async (_t: string, clubId: string) => rosters[clubId] ?? [],
  listAllClearances: async () => [] as PlayerClearance[],
  listPlayerDistinctPairs: async () => new Set(distinct),
});

describe('enqueue-players', () => {
  test('args: --tenant required, --confirm optional, anything else refused', () => {
    assert.deepEqual(parseEnqueue(['--tenant', 'acme']), { tenant: 'acme', confirm: false });
    assert.deepEqual(parseEnqueue(['--tenant', 'acme', '--confirm']), {
      tenant: 'acme',
      confirm: true,
    });
    assert.throws(() => parseEnqueue([]), /--tenant is required/);
    assert.throws(() => parseEnqueue(['--tenant', 'acme', '--force']), /unknown argument/);
  });

  test('plan: eligible upserts queued, inactive skipped, possible duplicates counted', async () => {
    const snap = await loadPlayerSyncSnapshot(fakeRepo(), T);
    const plan = planBackfill(snap);
    assert.deepEqual(plan.eligible, ['k1', 'k3', 'k4']);
    assert.deepEqual(plan.counts, {
      persons: 4,
      upsert: 3,
      notEligible: 1,
      possibleDuplicates: 2,
    });
  });
});

describe('audit-player-duplicates', () => {
  test('args', () => {
    assert.deepEqual(parseAudit(['--tenant', 'acme']), { tenant: 'acme' });
    assert.throws(() => parseAudit(['--tenant']), /needs a value/);
  });

  test('groups same name + dob under different IDs; names masked, no keys', async () => {
    const groups = duplicateGroups(await loadPlayerSyncSnapshot(fakeRepo(), T));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].persons.length, 2);
    assert.equal(groups[0].allConfirmedDistinct, false);
    const printed = JSON.stringify(groups);
    assert.ok(!printed.includes('k3') && !printed.includes('k4'), 'no natural keys');
    assert.ok(!printed.includes('Thabo') && !printed.includes('2004-04-04'), 'masked');
    assert.deepEqual(groups[0].persons.map((p) => p.rows[0].club).sort(), ['A CC', 'B CC']);
  });

  test('a pair an admin confirmed distinct is reported as settled', async () => {
    const groups = duplicateGroups(await loadPlayerSyncSnapshot(fakeRepo(['k3#k4']), T));
    assert.equal(groups[0].allConfirmedDistinct, true);
  });
});
