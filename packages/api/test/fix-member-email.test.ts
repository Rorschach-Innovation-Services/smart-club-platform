/**
 * Tests for scripts/fix-member-email.ts — the no-send email correction CLI. Flag parsing is
 * pure; the guards, dry run and confirm path run against dynalite with the REAL repo. Only
 * the two Cognito calls are injected (the runFixMemberEmail deps seam).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Club, UserProfile } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4725;
const TABLE = 'SmartClubFixMemberEmail';
dynaliteEnv(DDB_PORT, TABLE);

type Script = typeof import('../scripts/fix-member-email.js');
let script: Script;
let ddb: Server;
let repo: typeof import('../src/repo.js');

const T = 'fixtenant';
const OLD = 'old@typo.com';
const NEW = 'new@right.com';
let n = 0;
let sub: string;
let clubId: string;

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  script = await import('../scripts/fix-member-email.js');
});
after(async () => {
  await stopDynalite(ddb);
});

// Fresh tenant-scoped identities per test (the table is shared across tests).
let tenant: string;
beforeEach(async () => {
  n++;
  tenant = `${T}${n}`;
  sub = `sub-${n}`;
  clubId = `club-${n}`;
});

async function seedUser(over: Partial<UserProfile> = {}, email = OLD, s = sub) {
  await repo.putUser({
    sub: s,
    email,
    memberships: [{ tenantId: tenant, role: 'rep', clubIds: [clubId] } as never],
    onboardingSeen: {},
    ...over,
  });
}
async function seedClub(excoEmail: string) {
  await repo.putClub(tenant, {
    id: clubId,
    name: `Club ${n}`,
    exco: { sec: { name: 'Sec', email: excoEmail, cell: '0821234567' }, chair: { name: 'C' } },
  } as unknown as Club);
}

function deps(cognitoEmail: string | null = OLD, updateErr?: Error) {
  const calls: Array<[string, string, string]> = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    d: {
      repo,
      getCognitoEmail: async () => cognitoEmail,
      updateCognitoEmail: async (s: string, cur: string, next: string) => {
        calls.push([s, cur, next]);
        if (updateErr) throw updateErr;
      },
      log: (l: string) => lines.push(l),
      now: () => new Date('2026-10-13T08:00:00Z'),
    },
  };
}
const args = (extra: string[] = []) =>
  script.parseFixMemberEmailArgs([`--tenant=${tenant}`, `--from=${OLD}`, `--to=${NEW}`, ...extra]);

describe('parseFixMemberEmailArgs', () => {
  test('parses every flag, lowercasing the addresses', () => {
    assert.deepEqual(
      script.parseFixMemberEmailArgs([
        '--tenant=d',
        '--from=Old@X.com',
        '--to=New@Y.com',
        '--club=c1',
        '--slot=sec',
        '--confirm',
      ]),
      { tenant: 'd', from: 'old@x.com', to: 'new@y.com', club: 'c1', slot: 'sec', confirm: true },
    );
  });
  test('rejects missing, unknown, malformed and half-paired flags', () => {
    const base = ['--tenant=d', '--from=a@b.co', '--to=c@d.co'];
    assert.throws(() => script.parseFixMemberEmailArgs(base.slice(1)), /--tenant/);
    assert.throws(() => script.parseFixMemberEmailArgs([base[0], base[2]]), /--from/);
    assert.throws(() => script.parseFixMemberEmailArgs(base.slice(0, 2)), /--to/);
    assert.throws(() => script.parseFixMemberEmailArgs([...base, '--x']), /unknown/);
    assert.throws(() => script.parseFixMemberEmailArgs([...base, '--club=c']), /both or neither/);
    assert.throws(() => script.parseFixMemberEmailArgs([...base, '--slot=sec']), /both or neither/);
    assert.throws(
      () => script.parseFixMemberEmailArgs(['--tenant=d', '--from=a@b.co', '--to=nope']),
      /valid email/,
    );
  });
});

describe('guards', () => {
  test('member not found → exit 1', async () => {
    const { d, calls } = deps();
    assert.equal(await script.runFixMemberEmail(args(['--confirm']), d), 1);
    assert.equal(calls.length, 0);
  });
  test('a signed-in member is refused on --confirm', async () => {
    await seedUser({ lastLoginAt: '2026-10-01T00:00:00Z' });
    const { d, calls, lines } = deps();
    assert.equal(await script.runFixMemberEmail(args(['--confirm']), d), 1);
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => /never signed in: FAIL/.test(l)));
    assert.equal((await repo.getUser(sub))!.email, OLD);
  });
  test('--to held by another roster member is refused on --confirm', async () => {
    await seedUser();
    await seedUser({}, NEW, `${sub}-other`);
    const { d, calls, lines } = deps();
    assert.equal(await script.runFixMemberEmail(args(['--confirm']), d), 1);
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => /--to free in roster: FAIL/.test(l)));
  });
  test('dry run reports a failed guard but exits 0 and writes nothing', async () => {
    await seedUser({ lastLoginAt: '2026-10-01T00:00:00Z' });
    const { d, calls, lines } = deps();
    assert.equal(await script.runFixMemberEmail(args(), d), 0);
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => /FAIL/.test(l)));
  });
});

describe('run', () => {
  test('dry run writes nothing anywhere', async () => {
    await seedUser();
    await seedClub(OLD);
    const { d, calls } = deps();
    assert.equal(await script.runFixMemberEmail(args([`--club=${clubId}`, '--slot=sec']), d), 0);
    assert.equal(calls.length, 0);
    assert.equal((await repo.getUser(sub))!.email, OLD);
    assert.equal(((await repo.getClub(tenant, clubId))!.exco!.sec as { email: string }).email, OLD);
  });

  test('confirm updates Cognito, USER record, markers and the exco slot only', async () => {
    await seedUser();
    await seedClub(OLD.toUpperCase());
    const { d, calls } = deps();
    assert.equal(
      await script.runFixMemberEmail(args([`--club=${clubId}`, '--slot=sec', '--confirm']), d),
      0,
    );
    assert.deepEqual(calls, [[sub, OLD, NEW]]);
    const u = (await repo.getUser(sub))!;
    assert.equal(u.email, NEW);
    assert.equal(u.memberships.length, 1);
    const roster = await repo.listTenantUsers(tenant);
    assert.deepEqual(
      roster.map((r) => r.email),
      [NEW],
    );
    const club = (await repo.getClub(tenant, clubId))!;
    assert.deepEqual(club.exco!.sec, { name: 'Sec', email: NEW, cell: '0821234567' });
    assert.deepEqual(club.exco!.chair, { name: 'C' });
    assert.equal(club.name, `Club ${n}`);
  });

  test('exco slot that does not match --from is skipped', async () => {
    await seedUser();
    await seedClub('other@club.com');
    const { d } = deps();
    assert.equal(
      await script.runFixMemberEmail(args([`--club=${clubId}`, '--slot=sec', '--confirm']), d),
      0,
    );
    assert.equal((await repo.getUser(sub))!.email, NEW);
    assert.equal(
      ((await repo.getClub(tenant, clubId))!.exco!.sec as { email: string }).email,
      'other@club.com',
    );
  });

  test('AliasExistsException stops before any DynamoDB write', async () => {
    await seedUser();
    await seedClub(OLD);
    const err = Object.assign(new Error('alias'), { name: 'AliasExistsException' });
    const { d, calls, lines } = deps(OLD, err);
    assert.equal(
      await script.runFixMemberEmail(args([`--club=${clubId}`, '--slot=sec', '--confirm']), d),
      1,
    );
    assert.equal(calls.length, 1);
    assert.ok(lines.some((l) => /repoint the membership/.test(l)));
    assert.equal((await repo.getUser(sub))!.email, OLD);
    assert.equal(((await repo.getClub(tenant, clubId))!.exco!.sec as { email: string }).email, OLD);
  });

  test('Cognito already on --to is treated as done (partial-failure re-run)', async () => {
    await seedUser();
    const { d, calls } = deps(NEW);
    assert.equal(await script.runFixMemberEmail(args(['--confirm']), d), 0);
    assert.equal(calls.length, 0);
    assert.equal((await repo.getUser(sub))!.email, NEW);
  });

  test('roster already on --to reports already corrected, exit 0', async () => {
    await seedUser({}, NEW);
    const { d, calls, lines } = deps(NEW);
    assert.equal(await script.runFixMemberEmail(args(['--confirm']), d), 0);
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => /already corrected/.test(l)));
  });
});
