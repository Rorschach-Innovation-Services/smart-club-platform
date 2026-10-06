/**
 * FixtureReminders cron (packages/api/src/crons/fixture-reminders.ts): window math across the
 * SAST day boundary, the channel gate (WhatsApp only once the template is registered), and full
 * runs against an in-process dynalite through the real repo + real (dry-run) senders — enabled /
 * opt-out gating, the club projection (a withheld kick-off never reaches the reminder), the
 * per-(club, date) dedupe marker, dry-run bookkeeping and per-tenant / per-club error isolation.
 *
 * The run is driven with an injected clock; the only other seams used are a pass-through `send`
 * wrapper (to observe exactly what each chair was sent) and a tenant filter so each test only
 * sees the tenants it created.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

const DDB_PORT = 4669; // next free odd port after 4667
const TABLE = 'SmartClubTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.STAGE = 'local';
process.env.AWS_REGION ??= 'localhost';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';
process.env.NOTIFY_DRY_RUN = '1';

type Cron = typeof import('../src/crons/fixture-reminders.js');
type Repo = typeof import('../src/repo.js');
type Notify = typeof import('../src/notify/index.js');
type Email = typeof import('../src/notify/email.js');

let ddbServer: Server;
let cron: Cron;
let repo: Repo;
let notify: Notify;
let email: Email;

// 22:30 UTC on 1 Oct is already 00:30 SAST on 2 Oct, so tomorrow (lead day 1) is 3 Oct.
const NOW = new Date('2026-10-01T22:30:00Z');
const TARGET = '2026-10-03';
const PORTAL = 'https://portal.test';

type TenantConfig = import('../src/types.js').TenantConfig;
type Club = import('../src/types.js').Club;
type SendArgs = Parameters<Notify['sendFixtureReminder']>[0];

const mkConfig = (
  tenant: string,
  fixtureReminders: TenantConfig['fixtureReminders'],
  extra: Partial<TenantConfig> = {},
): TenantConfig =>
  ({
    tenant,
    branding: { name: tenant, title: tenant, logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    ...(fixtureReminders ? { fixtureReminders } : {}),
    ...extra,
  }) as TenantConfig;

const mkClub = (id: string, name: string, extra: Partial<Club> = {}): Club =>
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
    ground: { venue: `${name} Oval` },
    leagues: [],
    version: 1,
    ...extra,
  }) as Club;

const participants = [
  { teamId: 'home', clubId: 'home', name: 'Glenwood CC' },
  { teamId: 'away', clubId: 'away', name: 'Northlands CC' },
  { teamId: 'third', clubId: 'third', name: 'Third CC' },
  { teamId: 'fourth', clubId: 'fourth', name: 'Fourth CC' },
];

const mkSeries = (id: string, fixtures: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  name: `Series ${id}`,
  startDate: '2026-09-01',
  teams: participants.map((p) => p.teamId),
  participants,
  fixtures,
  released: true,
  releasedAt: '2026-09-01T00:00:00.000Z',
  version: 1,
  ...extra,
});

/**
 * Seed one tenant: config + the four clubs + one series. By default `home` plays `away` on the
 * target date at 10:00 (time WITHHELD, venue revealed) and `third` plays `fourth` the day after.
 */
async function seedTenant(
  tenant: string,
  fixtureReminders: TenantConfig['fixtureReminders'],
  opts: {
    clubs?: Partial<Record<string, Partial<Club>>>;
    series?: Record<string, unknown>;
    config?: Partial<TenantConfig>;
  } = {},
) {
  await repo.putTenantConfig(mkConfig(tenant, fixtureReminders, opts.config));
  for (const p of participants) {
    await repo.putClub(tenant, mkClub(p.clubId, p.name, opts.clubs?.[p.clubId] ?? {}));
  }
  await repo.putSeries(
    tenant,
    mkSeries(
      's1',
      [
        {
          id: 'f1',
          round: 1,
          date: TARGET,
          time: '10:00',
          home: 'home',
          away: 'away',
          venueName: 'Kings Park',
        },
        { id: 'f2', round: 1, date: '2026-10-04', time: '14:00', home: 'third', away: 'fourth' },
      ],
      { withheld: { time: true }, ...opts.series },
    ) as unknown as import('../src/types.js').Series,
  );
}

/** Run the cron over ONLY `tenants`, recording every send (which still goes through for real). */
async function run(
  tenants: string[],
  overrides: Partial<import('../src/crons/fixture-reminders.js').FixtureRemindersDeps> = {},
) {
  const sends: SendArgs[] = [];
  const captured: Array<Record<string, string>> = [];
  const summary = await cron.runFixtureReminders({
    now: () => NOW,
    portalLinkFor: () => PORTAL,
    captureException: (_err, tags) => captured.push(tags),
    log: () => {},
    send: async (args) => {
      sends.push(args);
      return notify.sendFixtureReminder(args);
    },
    ...overrides,
    repo: {
      ...repo,
      ...overrides.repo,
      listTenants: async () => (await repo.listTenants()).filter((t) => tenants.includes(t.tenant)),
    },
  });
  return { summary, sends, captured };
}

const commLog = async (tenant: string, clubId: string) =>
  (await repo.getClub(tenant, clubId))?.commLog ?? [];

const ENABLED = { enabled: true, leadDays: [1], channels: ['email'] } as NonNullable<
  TenantConfig['fixtureReminders']
>;

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
  cron = await import('../src/crons/fixture-reminders.js');
  repo = await import('../src/repo.js');
  notify = await import('../src/notify/index.js');
  email = await import('../src/notify/email.js');
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
});

describe('window math', () => {
  test('tenant date flips at 22:00 UTC (00:00 SAST), not at UTC midnight', () => {
    assert.equal(cron.tenantDate(new Date('2026-10-01T21:59:59Z')), '2026-10-01');
    assert.equal(cron.tenantDate(new Date('2026-10-01T22:00:00Z')), '2026-10-02');
    // The scheduled run (05:00 UTC) is 07:00 SAST the same calendar day.
    assert.equal(cron.tenantDate(new Date('2026-10-02T05:00:00Z')), '2026-10-02');
  });

  test('target dates = tenant today + each lead day, deduped and ascending', () => {
    assert.deepEqual(cron.reminderTargetDates(NOW, [3, 1, 1]), ['2026-10-03', '2026-10-05']);
    // Month rollover.
    assert.deepEqual(cron.reminderTargetDates(new Date('2026-10-30T06:00:00Z'), [2]), [
      '2026-11-01',
    ]);
  });
});

describe('channel gate', () => {
  const cfg = (channels: Array<'email' | 'whatsapp'>, features?: Record<string, boolean>) =>
    mkConfig('x', { enabled: true, leadDays: [1], channels }, features ? { features } : {});

  test('WhatsApp is dropped while the template is pending', () => {
    assert.deepEqual(cron.reminderChannels(cfg(['email', 'whatsapp']), 'pending'), ['email']);
    assert.deepEqual(cron.reminderChannels(cfg(['whatsapp']), 'pending'), []);
  });

  test('WhatsApp is kept once registered, unless the whatsappInvites feature is off', () => {
    assert.deepEqual(cron.reminderChannels(cfg(['email', 'whatsapp']), 'registered'), [
      'email',
      'whatsapp',
    ]);
    assert.deepEqual(
      cron.reminderChannels(cfg(['email', 'whatsapp'], { whatsappInvites: false }), 'registered'),
      ['email'],
    );
  });

  test('the registry entry ships as registered (approved in Meta 6 Oct 2026)', async () => {
    const { WHATSAPP_TEMPLATES } = await import('../src/notify/whatsapp-templates.js');
    assert.equal(WHATSAPP_TEMPLATES.fixtureReminder.status, 'registered');
  });
});

describe('reminder runs', () => {
  test('reminds opted-in clubs (absent flag counts as in), skips explicit opt-outs, and never leaks a withheld time', async () => {
    await seedTenant('rem-a', ENABLED, { clubs: { away: { remindersOptIn: false } } });
    const { summary, sends } = await run(['rem-a']);

    assert.deepEqual(
      { ...summary, dryRun: undefined },
      { tenants: 1, clubsNotified: 1, skipped: 1, errors: 0, dryRun: undefined },
    );
    assert.equal(summary.dryRun, true);
    assert.equal(sends.length, 1);
    const [sent] = sends;
    assert.equal(sent.clubName, 'Glenwood CC');
    assert.equal(sent.dateLabel, 'Sat 2026-10-03');
    assert.equal(sent.portalLink, PORTAL);
    assert.deepEqual(sent.fixtures, [
      {
        seriesName: 'Series s1',
        sideName: 'Glenwood CC',
        opponentName: 'Northlands CC',
        isHome: true,
        venue: 'Kings Park',
      },
    ]);
    // The rendered email (what the chair actually receives) carries no kick-off time.
    const content = email.fixtureReminderEmailContent({ chairName: 'x', ...sent });
    assert.doesNotMatch(content.text, /10:00/);
    assert.doesNotMatch(content.html, /10:00/);
    assert.match(content.text, /Kings Park/);

    const log = await commLog('rem-a', 'home');
    assert.equal(log.length, 1);
    assert.equal(log[0].kind, 'fixture-reminder');
    assert.equal(log[0].channel, 'email');
    assert.equal(log[0].status, 'sent');
    assert.equal(log[0].to, 'chair@home.test');
    assert.equal(log[0].idempotencyKey, `fixture-reminder-${TARGET}-email`);
    assert.equal(log[0].by, cron.FIXTURE_REMINDER_ACTOR);
    // Dry-run: the sender returned a synthetic id — nothing was delivered.
    assert.match(log[0].messageId ?? '', /^dry-run-/);
    assert.equal((await commLog('rem-a', 'away')).length, 0);
    // `third` plays the day after the window, so it is not reminded today.
    assert.equal((await commLog('rem-a', 'third')).length, 0);
  });

  test('a revealed time is included', async () => {
    await seedTenant('rem-time', ENABLED, { series: { withheld: undefined } });
    const { sends } = await run(['rem-time']);
    const home = sends.find((s) => s.clubName === 'Glenwood CC')!;
    assert.equal(home.fixtures[0].time, '10:00');
  });

  test('same-day idempotency: repeat runs on one tenant day send each club one reminder per match date', async () => {
    await seedTenant('rem-dup', ENABLED);
    const first = await run(['rem-dup']);
    assert.equal(first.summary.clubsNotified, 2); // home + away
    const again = await run(['rem-dup']);
    assert.equal(again.sends.length, 0);
    assert.equal(again.summary.clubsNotified, 0);
    assert.equal(again.summary.skipped, 2);
    // Later the same SAST day (06:30 vs 00:30): still the same send date, still deduped.
    const later = await run(['rem-dup'], { now: () => new Date('2026-10-02T04:30:00Z') });
    assert.equal(later.sends.length, 0);
    assert.equal((await commLog('rem-dup', 'home')).length, 1);
  });

  test('lead days [7, 1] remind the same match date on both days', async () => {
    await seedTenant('rem-two', { ...ENABLED, leadDays: [7, 1] });
    // 26 Sep (SAST) + 7 = 3 Oct; 2 Oct + 1 = 3 Oct. Each run's marker carries its own send date,
    // so the week-ahead marker (still inside its 72h TTL or not) never blocks the day-before one.
    const weekAhead = await run(['rem-two'], { now: () => new Date('2026-09-26T05:00:00Z') });
    assert.deepEqual(weekAhead.sends.map((s) => s.clubName).sort(), [
      'Glenwood CC',
      'Northlands CC',
    ]);
    const dayBefore = await run(['rem-two'], { now: () => new Date('2026-10-02T05:00:00Z') });
    assert.deepEqual(dayBefore.sends.map((s) => s.clubName).sort(), [
      'Glenwood CC',
      'Northlands CC',
    ]);
    assert.ok(dayBefore.sends.every((s) => s.dateLabel === 'Sat 2026-10-03'));
    const log = await commLog('rem-two', 'home');
    assert.equal(log.length, 2);
    // Comm-log idempotency keys stay per (match date, channel).
    assert.ok(log.every((e) => e.idempotencyKey === `fixture-reminder-${TARGET}-email`));
    // A rerun on the day-before date is still a no-op.
    const rerun = await run(['rem-two'], { now: () => new Date('2026-10-02T05:00:00Z') });
    assert.equal(rerun.sends.length, 0);
  });

  test('disabled, unconfigured and unreleased tenants send nothing', async () => {
    await seedTenant('rem-off', { ...ENABLED, enabled: false });
    await seedTenant('rem-none', undefined);
    await seedTenant('rem-draft', ENABLED, { series: { released: false } });
    const { summary, sends } = await run(['rem-off', 'rem-none', 'rem-draft']);
    assert.equal(sends.length, 0);
    assert.equal(summary.tenants, 1); // only rem-draft is enabled
    assert.equal(summary.clubsNotified, 0);
  });

  test('WhatsApp is skipped while the template is pending, and sent once registered', async () => {
    const both = { ...ENABLED, channels: ['email', 'whatsapp'] } as typeof ENABLED;
    await seedTenant('rem-wa-pending', both);
    const pending = await run(['rem-wa-pending'], { whatsappTemplateStatus: 'pending' });
    assert.ok(pending.sends.every((s) => s.channels.join() === 'email'));
    assert.deepEqual(
      (await commLog('rem-wa-pending', 'home')).map((e) => e.channel),
      ['email'],
    );

    await seedTenant('rem-wa-live', both);
    await run(['rem-wa-live'], { whatsappTemplateStatus: 'registered' });
    const log = await commLog('rem-wa-live', 'home');
    assert.deepEqual(log.map((e) => e.channel).sort(), ['email', 'whatsapp']);
    const wa = log.find((e) => e.channel === 'whatsapp')!;
    assert.equal(wa.status, 'sent');
    assert.equal(wa.to, '27821234567');
    assert.equal(wa.idempotencyKey, `fixture-reminder-${TARGET}-whatsapp`);
  });

  test('a failing tenant does not stop the others', async () => {
    await seedTenant('rem-bad', ENABLED);
    await seedTenant('rem-good', ENABLED);
    const { summary, captured } = await run(['rem-bad', 'rem-good'], {
      repo: {
        ...repo,
        listSeries: async (tenant: string) => {
          if (tenant === 'rem-bad') throw new Error('boom');
          return repo.listSeries(tenant);
        },
      } as unknown as Repo,
    });
    assert.equal(summary.tenants, 2);
    assert.equal(summary.errors, 1);
    assert.equal(summary.clubsNotified, 2);
    assert.deepEqual(captured, [{ tenant: 'rem-bad', cron: 'fixture-reminders' }]);
    assert.equal((await commLog('rem-good', 'home')).length, 1);
  });

  test('a failing club does not stop the others, and its claim is released for a retry', async () => {
    await seedTenant('rem-club', ENABLED);
    const failing = await run(['rem-club'], {
      send: async (args) => {
        if (args.clubName === 'Glenwood CC') throw new Error('provider exploded');
        return notify.sendFixtureReminder(args);
      },
    });
    assert.equal(failing.summary.errors, 1);
    assert.equal(failing.summary.clubsNotified, 1);
    assert.deepEqual(failing.captured, [
      { tenant: 'rem-club', clubId: 'home', cron: 'fixture-reminders' },
    ]);
    // The retry reminds only the club that failed — its marker was released, away's was kept.
    const retry = await run(['rem-club']);
    assert.deepEqual(
      retry.sends.map((s) => s.clubName),
      ['Glenwood CC'],
    );
    assert.equal((await commLog('rem-club', 'home')).length, 1);
  });
});
