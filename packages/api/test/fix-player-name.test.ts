/**
 * Tests for scripts/fix-player-name.ts — the player-name correction CLI. Flag parsing is pure;
 * the lookup, dry run and confirm path run against dynalite with the REAL repo. Writes are
 * observed both in the table and through spies wrapped around the two repo write functions.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, PlayerClearance, PlayerRegistration } from '../src/types.js';
import { playerNaturalKey } from '../src/player-identity.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4726;
const TABLE = 'SmartClubFixPlayerName';
dynaliteEnv(DDB_PORT, TABLE);

type Script = typeof import('../scripts/fix-player-name.js');
let script: Script;
let ddb: Server;
let repo: typeof import('../src/repo.js');

const ID = '9507215332086';
const NK = playerNaturalKey({ idType: 'sa-id', idNumber: ID });
let n = 0;
let tenant: string;

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  script = await import('../scripts/fix-player-name.js');
});
after(async () => {
  await stopDynalite(ddb);
});
beforeEach(() => {
  n++;
  tenant = `fixname${n}`;
});

async function seedClub(id: string) {
  await repo.putClub(tenant, { id, name: `Club ${id}` } as unknown as Club);
}
async function seedPlayer(clubId: string, over: Partial<PlayerRegistration> = {}) {
  const row = {
    naturalKey: NK,
    clubId,
    firstName: 'Saihal',
    lastName: '9507215332086',
    dob: '1995-07-21',
    isMinor: false,
    consentAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    idType: 'sa-id',
    idNumber: ID,
    status: 'active',
    ...over,
  } as PlayerRegistration;
  await repo.createPlayer(tenant, row);
  return row;
}
async function seedClearance(nk: string, playerName: string) {
  const c = {
    id: `clr-${n}`,
    playerNaturalKey: nk,
    playerName,
    fromClubId: 'a',
    toClubId: 'b',
    fromClubName: 'Club a',
    toClubName: 'Club b',
    requestedAt: '2026-10-01T00:00:00Z',
    feesCleared: false,
    misconductCleared: false,
    status: 'pending',
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
  } as PlayerClearance;
  await repo.createClearance(tenant, c);
  return c;
}

/** The real repo with the two writes spied (calls recorded, then delegated). */
function deps() {
  const lines: string[] = [];
  const playerCalls: unknown[][] = [];
  const clrCalls: unknown[][] = [];
  const spied = {
    ...repo,
    updatePlayer: ((...a: Parameters<typeof repo.updatePlayer>) => {
      playerCalls.push(a);
      return repo.updatePlayer(...a);
    }) as typeof repo.updatePlayer,
    updateClearancePlayerName: ((...a: Parameters<typeof repo.updateClearancePlayerName>) => {
      clrCalls.push(a);
      return repo.updateClearancePlayerName(...a);
    }) as typeof repo.updateClearancePlayerName,
  };
  return { lines, playerCalls, clrCalls, d: { repo: spied, log: (l: string) => lines.push(l) } };
}
const args = (extra: string[] = [], id = `--id-number=${ID}`) =>
  script.parseFixPlayerNameArgs([
    `--tenant=${tenant}`,
    id,
    '--first=Saihial',
    '--last=Shrinath',
    ...extra,
  ]);

describe('parseFixPlayerNameArgs', () => {
  test('parses every flag, trimming names', () => {
    assert.deepEqual(
      script.parseFixPlayerNameArgs([
        '--tenant=d',
        '--nk=abc',
        '--first= Ann ',
        '--last=Lee ',
        '--confirm',
      ]),
      { tenant: 'd', nk: 'abc', first: 'Ann', last: 'Lee', confirm: true },
    );
  });
  test('rejects missing, conflicting, unknown and all-digit flags', () => {
    const p = script.parseFixPlayerNameArgs;
    assert.throws(() => p(['--id-number=1', '--first=A', '--last=B']), /--tenant/);
    assert.throws(() => p(['--tenant=d', '--first=A', '--last=B']), /exactly one/);
    assert.throws(
      () => p(['--tenant=d', '--nk=x', '--id-number=1', '--first=A', '--last=B']),
      /exactly one/,
    );
    assert.throws(() => p(['--tenant=d', '--nk=x', '--last=B']), /--first/);
    assert.throws(() => p(['--tenant=d', '--nk=x', '--first=A']), /--last/);
    assert.throws(() => p(['--tenant=d', '--nk=x', '--first=A', '--last= ']), /empty flag/);
    assert.throws(() => p(['--tenant=d', '--nk=x', '--first=A', '--last=950721']), /all digits/);
    assert.throws(() => p(['--tenant=d', '--nk=x', '--first=A', '--last=B', '--x']), /unknown/);
  });
});

describe('runFixPlayerName', () => {
  test('not found → exit 1, nothing written', async () => {
    await seedClub('a');
    const { d, playerCalls, lines } = deps();
    assert.equal(await script.runFixPlayerName(args(['--confirm']), d), 1);
    assert.equal(playerCalls.length, 0);
    assert.ok(lines.some((l) => /NOT FOUND/.test(l)));
  });

  test('dry run lists the hash-key row and clearance but writes nothing', async () => {
    await seedClub('a');
    await seedClub('b');
    await seedPlayer('a');
    await seedClearance(NK, 'Saihal 9507215332086');
    const { d, playerCalls, clrCalls, lines } = deps();
    assert.equal(await script.runFixPlayerName(args(), d), 0);
    assert.equal(playerCalls.length + clrCalls.length, 0);
    assert.ok(lines.some((l) => /"Saihal 9507215332086" → "Saihial Shrinath"/.test(l)));
    assert.ok(lines.some((l) => /clr-\d+ a→b status=pending/.test(l)));
    assert.ok(lines.some((l) => /DRY RUN done/.test(l)));
    assert.ok(!lines.some((l) => l.includes(NK)), 'full natural key never logged');
    assert.equal((await repo.getPlayer(tenant, 'a', NK))!.firstName, 'Saihal');
  });

  test('confirm patches the player row and the clearance', async () => {
    await seedClub('a');
    await seedClub('b');
    await seedPlayer('a');
    const c = await seedClearance(NK, 'Saihal 9507215332086');
    const { d, playerCalls, clrCalls, lines } = deps();
    assert.equal(await script.runFixPlayerName(args(['--confirm']), d), 0);
    assert.deepEqual(playerCalls, [
      [tenant, 'a', NK, { firstName: 'Saihial', lastName: 'Shrinath' }],
    ]);
    assert.deepEqual(clrCalls, [[tenant, 'a', c.id, 'Saihial Shrinath']]);
    const row = (await repo.getPlayer(tenant, 'a', NK))!;
    assert.equal(`${row.firstName} ${row.lastName}`, 'Saihial Shrinath');
    const clr = (await repo.getClearance(tenant, 'a', c.id))!;
    assert.equal(clr.playerName, 'Saihial Shrinath');
    assert.equal(clr.version, 1);
    assert.ok(lines.some((l) => /player sync off for tenant/.test(l)));
  });

  test('already-correct rows and clearances are skipped', async () => {
    await seedClub('a');
    await seedClub('b');
    await seedPlayer('a', { firstName: 'Saihial', lastName: 'Shrinath' });
    await seedClearance(NK, 'Saihial Shrinath');
    const { d, playerCalls, clrCalls, lines } = deps();
    assert.equal(await script.runFixPlayerName(args(['--confirm']), d), 0);
    assert.equal(playerCalls.length + clrCalls.length, 0);
    assert.equal(lines.filter((l) => /already correct \(skipped\)/.test(l)).length, 2);
  });

  test('legacy slug-keyed row is found via the idNumber fallback', async () => {
    const SLUG = 'saihal-9507215332086-1995-07-21';
    await seedClub('a');
    await seedClub('b');
    await seedPlayer('a', { naturalKey: SLUG });
    const c = await seedClearance(SLUG, 'Saihal 9507215332086');
    const { d, playerCalls, clrCalls, lines } = deps();
    assert.equal(await script.runFixPlayerName(args(['--confirm']), d), 0);
    assert.deepEqual(playerCalls, [
      [tenant, 'a', SLUG, { firstName: 'Saihial', lastName: 'Shrinath' }],
    ]);
    assert.deepEqual(clrCalls, [[tenant, 'a', c.id, 'Saihial Shrinath']]);
    assert.ok(lines.some((l) => /legacy key/.test(l)));
  });

  test('--nk finds the row without the idNumber fallback', async () => {
    await seedClub('a');
    await seedPlayer('a');
    const { d, playerCalls } = deps();
    assert.equal(await script.runFixPlayerName(args(['--confirm'], `--nk=${NK}`), d), 0);
    assert.equal(playerCalls.length, 1);
  });
});
