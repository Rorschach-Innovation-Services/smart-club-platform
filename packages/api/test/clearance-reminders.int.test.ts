/**
 * ClearanceReminders cron (packages/api/src/crons/clearance-reminders.ts), run against an
 * in-process dynalite through the real repo + real (dry-run) senders, with an injected clock:
 * eligibility (pending ≥ 7 tenant days, last reminder ≥ 7 days old, a reopen restarts the clock),
 * missed-run catch-up, the shared INVITE# day-claim (a manual reminder suppresses the cron),
 * release-on-failure, the WhatsApp template/feature gate, the clearances-module gate, and the admin
 * digest (nudged + chairless off-system clearances + on-system sources with no usable chair
 * contact; nothing eligible ⇒ no digest), and that only DELIVERED reminders start the cadence.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4693;
const TABLE = 'SmartClubTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.STAGE = 'local';
process.env.AWS_REGION ??= 'localhost';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';
process.env.NOTIFY_DRY_RUN = '1';

type Cron = typeof import('../src/crons/clearance-reminders.js');
type Repo = typeof import('../src/repo.js');
type Notify = typeof import('../src/notify/index.js');
type TenantConfig = import('../src/types.js').TenantConfig;
type Club = import('../src/types.js').Club;
type PlayerRegistration = import('../src/types.js').PlayerRegistration;
type PlayerClearance = import('../src/types.js').PlayerClearance;
type SendArgs = Parameters<Notify['sendClearanceNotice']>[0];
type DigestArgs = Parameters<Notify['sendClearanceReminderDigest']>[0];

let ddbServer: Server;
let cron: Cron;
let repo: Repo;
let notify: Notify;

/** 07:00 SAST on 20 Oct — the scheduled run. */
const at = (date: string) => new Date(`${date}T05:00:00Z`);
const TODAY = '2026-10-20';

const mkConfig = (tenant: string, extra: Partial<TenantConfig> = {}): TenantConfig =>
  ({
    tenant,
    branding: { name: `${tenant} Union`, title: tenant, logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    ...extra,
  }) as TenantConfig;

const mkClub = (id: string, name: string): Club =>
  ({
    id,
    name,
    district: 'Test District',
    sub: `sub-${id}`,
    chair: 'Chair',
    exco: { chair: { name: `${name} Chair`, email: `chair@${id}.test`, cell: '0821234567' } },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    version: 1,
  }) as Club;

let seq = 0;
const mkPlayer = (clubId: string, extra: Partial<PlayerRegistration> = {}): PlayerRegistration => {
  seq++;
  return {
    naturalKey: `nk-${seq}`,
    clubId,
    firstName: 'Player',
    lastName: `Number${seq}`,
    dob: '1994-02-02',
    isMinor: false,
    status: 'active',
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...extra,
  } as PlayerRegistration;
};

const mkClearance = (
  id: string,
  fromClubId: string,
  toClubId: string,
  nk: string,
  requestedAt: string,
  extra: Partial<PlayerClearance> = {},
): PlayerClearance =>
  ({
    id,
    playerNaturalKey: nk,
    playerName: `Player ${id}`,
    fromClubId,
    toClubId,
    fromClubName: `${fromClubId} name`,
    toClubName: `${toClubId} name`,
    requestedAt,
    feesCleared: false,
    misconductCleared: false,
    status: 'pending',
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
    ...extra,
  }) as PlayerClearance;

/** Tenant with src/dst clubs, one admin user, and a pending clearance requested at `requestedAt`. */
async function seedTenant(
  tenant: string,
  requestedAt: string,
  opts: {
    config?: Partial<TenantConfig>;
    clearance?: Partial<PlayerClearance>;
    srcExco?: Club['exco'];
  } = {},
) {
  await repo.putTenantConfig(mkConfig(tenant, opts.config));
  await repo.createClub(tenant, {
    ...mkClub('src', 'Source CC'),
    ...(opts.srcExco ? { exco: opts.srcExco } : {}),
  } as Club);
  await repo.createClub(tenant, mkClub('dst', 'Dest CC'));
  await repo.putUser({
    sub: `admin-${tenant}`,
    email: `admin@${tenant}.test`,
    memberships: [{ tenantId: tenant, role: 'admin', clubIds: [] }],
    onboardingSeen: {},
  });
  const player = mkPlayer('src');
  await repo.createPlayer(tenant, player);
  const clearance = mkClearance(
    `clr-${tenant}`,
    'src',
    'dst',
    player.naturalKey,
    requestedAt,
    opts.clearance,
  );
  await repo.createClearance(tenant, clearance);
  return clearance;
}

/** A pending clearance from an OFF-SYSTEM (directory) source club into `dst`. */
async function seedChairless(tenant: string, id: string, requestedAt: string) {
  const player = mkPlayer('dst', { status: 'clearance-pending' } as Partial<PlayerRegistration>);
  await repo.createPlayerWithSourcelessClearance(
    tenant,
    player,
    mkClearance(id, 'off-system', 'dst', player.naturalKey, requestedAt, {
      fromClubName: 'Off System CC',
      fromClubDirectory: true,
      origin: 'registration',
    } as Partial<PlayerClearance>),
  );
}

/** Run the cron over ONLY `tenants`, recording every chair send and digest. */
async function run(
  tenants: string[],
  date: string,
  overrides: Partial<import('../src/crons/clearance-reminders.js').ClearanceRemindersDeps> = {},
) {
  const sends: SendArgs[] = [];
  const digests: DigestArgs[] = [];
  const captured: Array<Record<string, string>> = [];
  const summary = await cron.runClearanceReminders({
    now: () => at(date),
    captureException: (_err, tags) => captured.push(tags),
    log: () => {},
    send: async (args) => {
      sends.push(args);
      return notify.sendClearanceNotice(args);
    },
    sendDigest: async (args) => {
      digests.push(args);
      return notify.sendClearanceReminderDigest(args);
    },
    ...overrides,
    repo: {
      ...repo,
      ...overrides.repo,
      listTenants: async () => (await repo.listTenants()).filter((t) => tenants.includes(t.tenant)),
    },
  });
  return { summary, sends, digests, captured };
}

const reminderRows = async (tenant: string, clubId = 'src') =>
  ((await repo.getClub(tenant, clubId))?.commLog ?? []).filter(
    (e) => e.kind === 'clearance-reminder',
  );

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));
  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const direct = new DynamoDBClient({
    endpoint: `http://localhost:${DDB_PORT}`,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await direct.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  cron = await import('../src/crons/clearance-reminders.js');
  repo = await import('../src/repo.js');
  notify = await import('../src/notify/index.js');
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
});

describe('eligibility math', () => {
  const c = (requestedAt: string, extra: Partial<PlayerClearance> = {}) =>
    mkClearance('x', 'a', 'b', 'nk', requestedAt, extra);

  test('pending days count tenant (SAST) calendar days', () => {
    // 22:30 UTC on 12 Oct is already 13 Oct in SAST.
    assert.equal(cron.daysPending(c('2026-10-12T22:30:00Z'), TODAY), 7);
    assert.equal(cron.daysPending(c('2026-10-12T21:30:00Z'), TODAY), 8);
  });

  test('due at 7 days pending, not at 6', () => {
    assert.equal(cron.isReminderDue(c('2026-10-14T08:00:00Z'), TODAY, null), false);
    assert.equal(cron.isReminderDue(c('2026-10-13T08:00:00Z'), TODAY, null), true);
  });

  test('again only once the last reminder is 7+ days old', () => {
    const old = c('2026-09-01T08:00:00Z');
    assert.equal(cron.isReminderDue(old, TODAY, '2026-10-14T05:00:00Z'), false);
    assert.equal(cron.isReminderDue(old, TODAY, '2026-10-13T05:00:00Z'), true);
  });

  test('a reopen restarts the clock', () => {
    const reopened = c('2026-09-01T08:00:00Z', { reopenedAt: '2026-10-17T08:00:00Z' });
    assert.equal(cron.isReminderDue(reopened, TODAY, null), false);
    assert.equal(cron.isReminderDue(reopened, '2026-10-24', null), true);
  });

  test('a resolved clearance is never due', () => {
    assert.equal(
      cron.isReminderDue(c('2026-09-01T08:00:00Z', { status: 'approved' }), TODAY, null),
      false,
    );
  });
});

describe('channel gate', () => {
  test('WhatsApp only when the template is registered and whatsappInvites is on', () => {
    assert.deepEqual(cron.reminderChannels(mkConfig('x'), 'registered'), ['email', 'whatsapp']);
    assert.deepEqual(cron.reminderChannels(mkConfig('x'), 'pending'), ['email']);
    assert.deepEqual(
      cron.reminderChannels(mkConfig('x', { features: { whatsappInvites: false } }), 'registered'),
      ['email'],
    );
  });
});

describe('reminder runs', () => {
  test('nudges a 7-day-old clearance, logs the reminder, and digests it to admins', async () => {
    const clearance = await seedTenant('cr-due', '2026-10-13T08:00:00Z');
    const { summary, sends, digests } = await run(['cr-due'], TODAY);

    assert.deepEqual(
      { ...summary, dryRun: undefined },
      {
        tenants: 1,
        reminded: 1,
        skipped: 0,
        chairless: 0,
        noContact: 0,
        digests: 1,
        errors: 0,
        dryRun: undefined,
      },
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].fromClubName, 'Source CC');
    assert.equal(sends[0].chair.email, 'chair@src.test');
    assert.deepEqual(sends[0].channels, ['email', 'whatsapp']);

    const rows = await reminderRows('cr-due');
    assert.deepEqual(rows.map((r) => r.channel).sort(), ['email', 'whatsapp']);
    assert.ok(rows.every((r) => r.by === cron.CLEARANCE_REMINDER_ACTOR));
    assert.ok(
      rows.every((r) =>
        r.idempotencyKey.startsWith(`clearance-${clearance.id}-reminder-${TODAY}-`),
      ),
    );
    assert.match(rows[0].messageId ?? '', /^dry-run-/);
    // Reminders never count toward the creation cap's `clearance` kind.
    const srcLog = (await repo.getClub('cr-due', 'src'))?.commLog ?? [];
    assert.equal(srcLog.filter((e) => e.kind === 'clearance').length, 0);

    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].to, ['admin@cr-due.test']);
    assert.equal(digests[0].orgName, 'cr-due Union');
    assert.deepEqual(digests[0].nudged, [
      {
        playerName: clearance.playerName,
        fromClubName: 'src name',
        toClubName: 'dst name',
        daysPending: 7,
      },
    ]);
    assert.deepEqual(digests[0].chairless, []);
    assert.deepEqual(digests[0].noContact, []);
  });

  test('6 days pending: nothing sent and no digest', async () => {
    await seedTenant('cr-young', '2026-10-14T08:00:00Z');
    const { summary, sends, digests } = await run(['cr-young'], TODAY);
    assert.equal(summary.tenants, 1);
    assert.equal(sends.length, 0);
    assert.equal(digests.length, 0);
  });

  test('cadence: day 7 sends, a same-day rerun and day 13 do not, day 14 sends again', async () => {
    await seedTenant('cr-cadence', '2026-10-13T08:00:00Z');
    assert.equal((await run(['cr-cadence'], TODAY)).sends.length, 1);
    const rerun = await run(['cr-cadence'], TODAY);
    assert.equal(rerun.sends.length, 0);
    assert.equal(rerun.digests.length, 0);
    assert.equal((await run(['cr-cadence'], '2026-10-26')).sends.length, 0);
    assert.equal((await run(['cr-cadence'], '2026-10-27')).sends.length, 1);
    assert.equal((await reminderRows('cr-cadence')).length, 4); // 2 runs × 2 channels
  });

  test('missed run: a failed day-14 run is caught up on day 15, then the clock follows day 15', async () => {
    await seedTenant('cr-missed', '2026-10-13T08:00:00Z');
    assert.equal((await run(['cr-missed'], TODAY)).sends.length, 1);
    // No run on 27 Oct (the cron failed). 28 Oct still sends — no modulo silence.
    assert.equal((await run(['cr-missed'], '2026-10-28')).sends.length, 1);
    assert.equal((await run(['cr-missed'], '2026-11-03')).sends.length, 0);
    assert.equal((await run(['cr-missed'], '2026-11-04')).sends.length, 1);
  });

  test('a reopened clearance waits 7 days from the reopen', async () => {
    await seedTenant('cr-reopen', '2026-09-01T08:00:00Z', {
      clearance: { reopenedAt: '2026-10-17T08:00:00Z' },
    });
    assert.equal((await run(['cr-reopen'], TODAY)).sends.length, 0);
    assert.equal((await run(['cr-reopen'], '2026-10-24')).sends.length, 1);
  });

  test('a manual reminder today (shared claim) suppresses the cron send', async () => {
    const clearance = await seedTenant('cr-manual', '2026-10-13T08:00:00Z');
    const { clearanceReminderClaimKey } = await import('../src/clearance-reminder.js');
    assert.equal(
      await repo.claimInviteSend(
        'cr-manual',
        'src',
        clearanceReminderClaimKey(clearance.id, TODAY),
        ['email'],
        'clearance-reminder',
      ),
      null,
    );
    const { summary, sends, digests } = await run(['cr-manual'], TODAY);
    assert.equal(sends.length, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(digests.length, 0);
  });

  test('a failed send is isolated and its claim released, so the next run retries', async () => {
    await seedTenant('cr-fail', '2026-10-13T08:00:00Z');
    const failing = await run(['cr-fail'], TODAY, {
      send: async () => {
        throw new Error('provider exploded');
      },
    });
    assert.equal(failing.summary.errors, 1);
    assert.equal(failing.summary.reminded, 0);
    assert.deepEqual(failing.captured, [
      { tenant: 'cr-fail', clearanceId: 'clr-cr-fail', cron: 'clearance-reminders' },
    ]);
    assert.equal((await reminderRows('cr-fail')).length, 0);
    const retry = await run(['cr-fail'], TODAY);
    assert.equal(retry.sends.length, 1);
    assert.equal(retry.summary.reminded, 1);
  });

  test('WhatsApp is dropped while the template is pending', async () => {
    await seedTenant('cr-wa', '2026-10-13T08:00:00Z');
    const { sends } = await run(['cr-wa'], TODAY, { whatsappTemplateStatus: 'pending' });
    assert.deepEqual(sends[0].channels, ['email']);
    assert.deepEqual(
      (await reminderRows('cr-wa')).map((r) => r.channel),
      ['email'],
    );
  });

  test('a tenant with the clearances module off is skipped', async () => {
    await seedTenant('cr-nomod', '2026-10-13T08:00:00Z', {
      config: { features: { 'module.clearances': false } },
    });
    const { summary, sends } = await run(['cr-nomod'], TODAY);
    assert.equal(summary.tenants, 0);
    assert.equal(sends.length, 0);
  });

  test('chairless (off-system source) clearances are never claimed or sent, but are digested', async () => {
    await seedTenant('cr-chairless', '2026-10-15T08:00:00Z'); // 5 days: not due
    await seedChairless('cr-chairless', 'clr-dir', '2026-10-13T08:00:00Z');
    const { summary, sends, digests } = await run(['cr-chairless'], TODAY);
    assert.equal(sends.length, 0);
    assert.equal(summary.chairless, 1);
    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].nudged, []);
    assert.deepEqual(digests[0].chairless, [
      {
        playerName: 'Player clr-dir',
        fromClubName: 'Off System CC',
        toClubName: 'dst name',
        daysPending: 7,
      },
    ]);
    // Never claimed: the day's key is still free.
    const { clearanceReminderClaimKey } = await import('../src/clearance-reminder.js');
    assert.equal(
      await repo.claimInviteSend(
        'cr-chairless',
        'off-system',
        clearanceReminderClaimKey('clr-dir', TODAY),
        ['email'],
        'clearance-reminder',
      ),
      null,
    );
    // The mention is logged on the DESTINATION club (PII-free: no admin named).
    const mentions = await reminderRows('cr-chairless', 'dst');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].idempotencyKey, `clearance-clr-dir-reminder-${TODAY}-digest`);
    assert.equal(mentions[0].by, cron.CLEARANCE_REMINDER_ACTOR);
    assert.equal(mentions[0].to, undefined);
    // Same weekly cadence as a chair reminder: not on day 8 or 13, again on day 14.
    assert.equal((await run(['cr-chairless'], '2026-10-21')).digests.length, 0);
    // (The on-system clearance falls due by 26 Oct, so a digest goes out — without the chairless one.)
    assert.deepEqual((await run(['cr-chairless'], '2026-10-26')).digests[0]?.chairless, []);
    assert.equal((await run(['cr-chairless'], '2026-10-27')).digests[0]?.chairless.length, 1);
  });

  test('chairless digest is missed-run robust: a skipped day-14 run is caught up on day 15', async () => {
    await seedTenant('cr-chairless-missed', '2026-10-19T08:00:00Z'); // on-system one: never due here
    await seedChairless('cr-chairless-missed', 'clr-dir-missed', '2026-10-13T08:00:00Z');
    assert.equal((await run(['cr-chairless-missed'], TODAY)).summary.chairless, 1);
    // No run on 27 Oct. Under the old modulo rule 28 Oct (age 15) was silent for a week.
    const caughtUp = await run(['cr-chairless-missed'], '2026-10-28');
    assert.equal(caughtUp.digests[0]?.chairless.length, 1);
    // The clock now follows the 28 Oct mention.
    assert.equal((await run(['cr-chairless-missed'], '2026-11-03')).digests.length, 0);
    assert.equal((await run(['cr-chairless-missed'], '2026-11-04')).digests.length, 1);
  });

  test('a chairless digest that fails to send records no mention, so the next run retries', async () => {
    await seedTenant('cr-chairless-fail', '2026-10-15T08:00:00Z'); // 5 days: not due
    await seedChairless('cr-chairless-fail', 'clr-dir-fail', '2026-10-13T08:00:00Z');
    const failed = await run(['cr-chairless-fail'], TODAY, {
      sendDigest: async (args) => ({
        results: args.to.map((to) => ({
          channel: 'email' as const,
          to,
          status: 'failed' as const,
          error: 'ses down',
        })),
      }),
    });
    assert.equal(failed.summary.chairless, 1);
    assert.equal((await reminderRows('cr-chairless-fail', 'dst')).length, 0);
    assert.equal((await run(['cr-chairless-fail'], '2026-10-21')).digests.length, 1);
    assert.equal((await reminderRows('cr-chairless-fail', 'dst')).length, 1);
  });

  /** Whether the day's INVITE# key is free (claims it to find out, then releases it again). */
  const claimFree = async (tenant: string, clubId: string, clearanceId: string, date: string) => {
    const { clearanceReminderClaimKey } = await import('../src/clearance-reminder.js');
    const key = clearanceReminderClaimKey(clearanceId, date);
    const replay = await repo.claimInviteSend(tenant, clubId, key, ['email'], 'clearance-reminder');
    if (replay) return false;
    await repo.releaseInviteClaim(tenant, clubId, key);
    return true;
  };

  test('a source club with no usable chair contact is digested, never claimed, and stays due', async () => {
    const clearance = await seedTenant('cr-nocontact', '2026-10-13T08:00:00Z', {
      srcExco: { chair: { name: 'Nobody', email: 'not-an-email', cell: '' } } as Club['exco'],
    });
    const { summary, sends, digests } = await run(['cr-nocontact'], TODAY);
    assert.equal(sends.length, 0, 'nothing to send to — no claim, no send');
    assert.equal(summary.noContact, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.reminded, 0);
    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].nudged, []);
    assert.deepEqual(digests[0].chairless, []);
    assert.deepEqual(digests[0].noContact, [
      {
        playerName: clearance.playerName,
        fromClubName: 'src name',
        toClubName: 'dst name',
        daysPending: 7,
      },
    ]);
    assert.ok(await claimFree('cr-nocontact', 'src', clearance.id, TODAY), 'day key never burned');
    // One PII-free digest mention on the SOURCE club; no skipped chair rows.
    const rows = await reminderRows('cr-nocontact');
    assert.deepEqual(
      rows.map((r) => `${r.idempotencyKey}/${r.status}`),
      [`clearance-${clearance.id}-reminder-${TODAY}-digest/sent`],
    );
    assert.equal(rows[0].to, undefined);

    // Weekly digest cadence while the contact stays broken.
    assert.equal((await run(['cr-nocontact'], '2026-10-21')).digests.length, 0);
    assert.equal((await run(['cr-nocontact'], '2026-10-27')).digests[0]?.noContact?.length, 1);

    // Contact fixed: the chair is reminded on the very next run — the digest mention never
    // started the CHAIR cadence.
    await repo.updateClub(
      'cr-nocontact',
      'src',
      { exco: { chair: { name: 'Fixed', email: 'fixed@src.test', cell: '' } } } as Partial<Club>,
      'test',
      new Date().toISOString(),
    );
    const fixed = await run(['cr-nocontact'], '2026-10-28');
    assert.equal(fixed.sends.length, 1);
    assert.equal(fixed.sends[0].chair.email, 'fixed@src.test');
    assert.equal(fixed.summary.reminded, 1);
    assert.equal(fixed.digests[0]?.nudged.length, 1);
    assert.deepEqual(fixed.digests[0]?.noContact, []);
  });

  test('a send where every channel fails releases the claim and does not start the cadence', async () => {
    const clearance = await seedTenant('cr-allfail', '2026-10-13T08:00:00Z');
    const failing = await run(['cr-allfail'], TODAY, {
      send: async (args) => ({
        results: args.channels.map((channel) => ({
          channel,
          status: 'failed' as const,
          to: 'x',
          error: 'provider down',
        })),
      }),
    });
    assert.equal(failing.summary.skipped, 1);
    assert.equal(failing.summary.reminded, 0);
    assert.equal(failing.digests.length, 0);
    // Rows kept for the audit trail, but the day key is free and the clearance still due.
    assert.deepEqual(
      (await reminderRows('cr-allfail')).map((r) => r.status),
      ['failed', 'failed'],
    );
    assert.ok(await claimFree('cr-allfail', 'src', clearance.id, TODAY));
    const retry = await run(['cr-allfail'], TODAY);
    assert.equal(retry.sends.length, 1);
    assert.equal(retry.summary.reminded, 1);
  });

  test('a failing tenant does not stop the others', async () => {
    await seedTenant('cr-bad', '2026-10-13T08:00:00Z');
    await seedTenant('cr-good', '2026-10-13T08:00:00Z');
    const { summary, captured } = await run(['cr-bad', 'cr-good'], TODAY, {
      repo: {
        ...repo,
        listAllClearances: async (tenant: string) => {
          if (tenant === 'cr-bad') throw new Error('boom');
          return repo.listAllClearances(tenant);
        },
      } as unknown as Repo,
    });
    assert.equal(summary.tenants, 2);
    assert.equal(summary.errors, 1);
    assert.equal(summary.reminded, 1);
    assert.deepEqual(captured, [{ tenant: 'cr-bad', cron: 'clearance-reminders' }]);
  });
});
