/**
 * Official appointment notices: the NOTIFY#officials ledger-as-queue end to end, through the
 * REAL Hono app on an in-process dynalite (same harness as umpires.int.test.ts).
 *
 * Enqueue (routes): the manual officials PUT and the workbook confirm write one `queued` row per
 * official in the RESULTING officials set; an identical re-save adds nothing; removing an
 * official deletes its row (so a re-appointment queues again); a merge queues nothing.
 *
 * Drain (OfficialNotices cron, runOfficialNotices with injected seams): queued rows send once and
 * complete; completed rows never re-send; a row with no usable contact stays queued (no attempt
 * counted) and sends once contacts are added; a fixture with no date leaves the row queued until
 * a date lands; a row whose official is no longer on the fixture is dropped; provider failures
 * count attempts and exhaust at the cap (captured to Sentry).
 *
 * Senders run in dry-run (NOTIFY_DRY_RUN=1). Run with the API package's runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Series, TenantConfig } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4719; // unique: 4599–4717 are taken
const TABLE = 'SmartClubOfficialNoticesTest';
const TENANT = 'dolphins';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';
process.env.NOTIFY_DRY_RUN = '1';

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const headers = {
  'x-tenant': TENANT,
  'x-dev-auth': ADMIN,
  'content-type': 'application/json',
};

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const participants = [
  { teamId: 'home-club', clubId: 'home-club', name: 'Home Club' },
  { teamId: 'away-club', clubId: 'away-club', name: 'Away Club' },
  { teamId: 'other-club', clubId: 'other-club', name: 'Other Club' },
];

const series = (id: string, fixtures: unknown[], over: Partial<Series> = {}): Series =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: participants.map((p) => p.teamId),
    participants,
    fixtures,
    kind: 'series',
    approved: true,
    released: false,
    releasedAt: null,
    version: 1,
    ...over,
  }) as Series;

const fx = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  round: 1,
  date: '2026-11-15',
  time: '09:00',
  home: 'home-club',
  away: 'away-club',
  venueName: 'Kingsmead',
  ...extra,
});

const createUmpire = async (body: Record<string, unknown>) => {
  const res = await call('POST', '/umpires', body);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string };
};

const appoint = async (seriesId: string, fixtureId: string, body: unknown) => {
  const res = await call('PUT', `/series/${seriesId}/fixtures/${fixtureId}/officials`, body);
  assert.equal(res.status, 200, await res.clone().text());
};

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let cron: typeof import('../src/crons/official-notices.js');
let notify: typeof import('../src/notify/index.js');

type SendArgs = Parameters<
  (typeof import('../src/notify/index.js'))['sendOfficialAppointedNotice']
>[0];

const ledger = async (seriesId?: string) =>
  (await repo.listOfficialsNotify(TENANT)).filter((r) => !seriesId || r.seriesId === seriesId);

/** Run the cron over ONLY this test tenant, recording every send. */
async function run(
  overrides: Partial<import('../src/crons/official-notices.js').OfficialNoticesDeps> = {},
) {
  const sends: SendArgs[] = [];
  const captured: Array<Record<string, string>> = [];
  const summary = await cron.runOfficialNotices({
    captureException: (_err, tags) => captured.push(tags),
    log: () => {},
    send: async (args) => {
      sends.push(args);
      return notify.sendOfficialAppointedNotice(args);
    },
    ...overrides,
    repo: {
      ...repo,
      listTenants: async () => (await repo.listTenants()).filter((t) => t.tenant === TENANT),
    },
  });
  return { summary, sends, captured };
}

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));

  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const admin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await admin.send(
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

  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  cron = await import('../src/crons/official-notices.js');
  notify = await import('../src/notify/index.js');

  await repo.putTenantConfig({
    tenant: TENANT,
    branding: { name: 'KZN Dolphins', title: 'KZN Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
  } as unknown as TenantConfig);
  for (const p of participants) await repo.putClub(TENANT, { id: p.clubId, name: p.name } as never);
  await createUmpire({
    displayName: 'A.Ngubane',
    fullName: 'Andile Ngubane',
    email: 'an@example.org',
  });
  await createUmpire({ displayName: 'B.Tyali', email: 'bt@example.org', phone: '0820000002' });
  await createUmpire({ displayName: 'C.Ref', email: 'cr@example.org' });
  await createUmpire({ displayName: 'D.Nocontact' });
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('enqueue (routes)', () => {
  test('manual PUT queues one row per official; identical re-PUT adds nothing', async () => {
    await repo.putSeries(TENANT, series('s-put', [fx('f1')]));
    await appoint('s-put', 'f1', {
      umpires: ['u-a-ngubane', 'u-b-tyali'],
      referee: { umpireId: 'u-c-ref' },
    });
    const rows = await ledger('s-put');
    assert.deepEqual(rows.map((r) => `${r.role}:${r.umpireId}:${r.status}`).sort(), [
      'referee:u-c-ref:queued',
      'umpire:u-a-ngubane:queued',
      'umpire:u-b-tyali:queued',
    ]);
    const before = rows.map((r) => r.queuedAt).sort();
    await appoint('s-put', 'f1', {
      umpires: ['u-a-ngubane', 'u-b-tyali'],
      referee: { umpireId: 'u-c-ref' },
    });
    const after = await ledger('s-put');
    assert.equal(after.length, 3);
    assert.deepEqual(after.map((r) => r.queuedAt).sort(), before, 'existing rows untouched');
  });

  test('removing an official deletes its row; re-adding queues again', async () => {
    await repo.putSeries(TENANT, series('s-rm', [fx('f1')]));
    await appoint('s-rm', 'f1', { umpires: ['u-a-ngubane', 'u-b-tyali'] });
    await run();
    assert.ok((await ledger('s-rm')).every((r) => r.status === 'completed'));

    await appoint('s-rm', 'f1', { umpires: ['u-a-ngubane'] });
    assert.deepEqual(
      (await ledger('s-rm')).map((r) => r.umpireId),
      ['u-a-ngubane'],
    );
    await appoint('s-rm', 'f1', { umpires: ['u-a-ngubane', 'u-b-tyali'] });
    const rows = await ledger('s-rm');
    assert.equal(rows.find((r) => r.umpireId === 'u-b-tyali')?.status, 'queued');
    assert.equal(rows.find((r) => r.umpireId === 'u-a-ngubane')?.status, 'completed');

    // Clear-all deletes every row.
    await appoint('s-rm', 'f1', { umpires: [] });
    assert.deepEqual(await ledger('s-rm'), []);
  });

  test('merge re-points appointments but queues nothing', async () => {
    await repo.putSeries(TENANT, series('s-merge', [fx('f1')]));
    await createUmpire({ displayName: 'M.Dup', email: 'md@example.org' });
    await createUmpire({ displayName: 'M.Real', email: 'mr@example.org' });
    await appoint('s-merge', 'f1', { umpires: ['u-m-dup'] });
    await run();
    const res = await call('POST', '/umpires/u-m-dup/merge', { targetId: 'u-m-real' });
    assert.equal(res.status, 200, await res.clone().text());
    const rows = await ledger('s-merge');
    assert.ok(!rows.some((r) => r.umpireId === 'u-m-real'), 'merge must not enqueue');
    // The source's completed row is now stale (the cron only reads queued rows; no send).
    const { sends } = await run();
    assert.ok(!sends.some((s) => s.official.email === 'mr@example.org'));
  });

  test('workbook confirm queues only the fixtures it changed', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const OCT = new Date(Date.UTC(2026, 9, 1));
    const at = (h: number) => new Date(Date.UTC(1899, 11, 30, h, 0));
    const workbook = async (rows: unknown[][]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('T20 Runner');
      ws.getRow(1).values = [
        'Ref',
        'Month',
        'Day',
        'Time',
        'Date',
        'Home Team',
        'Away Team',
        'Venue',
        'Umpire',
        'Umpire',
      ];
      rows.forEach((r, i) => (ws.getRow(i + 2).values = r as never));
      return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    };
    const row = (time: Date, home: string, away: string, venue: string, ...umps: string[]) => [
      'Premier league T20',
      OCT,
      'Sunday',
      time,
      4,
      home,
      away,
      venue,
      ...umps,
    ];
    await repo.putSeries(
      TENANT,
      series(
        's-wb',
        [
          fx('f1', { date: '2026-10-04', venueName: 'Kingsmead Oval' }),
          fx('f2', {
            date: '2026-10-04',
            time: '13:00',
            home: 'away-club',
            away: 'other-club',
            venueName: 'Lahee Park',
          }),
        ],
        { name: 'Premier T20', maxOvers: 20 } as Partial<Series>,
      ),
    );
    // f2 already appointed exactly as the sheet says (and notified); f1 is new.
    await appoint('s-wb', 'f2', { umpires: ['u-b-tyali'] });
    await run();
    const dataBase64 = await workbook([
      row(at(9), 'Home Club', 'Away Club', 'Kingsmead Oval', 'A.Ngubane'),
      row(at(13), 'Away Club', 'Other Club', 'Lahee Park', 'B.Tyali'),
    ]);
    const prev = await call('POST', '/umpires/appointments/preview', {
      filename: 'runner.xlsx',
      dataBase64,
    });
    assert.equal(prev.status, 200, await prev.clone().text());
    const { planHash } = (await prev.json()) as { planHash: string };
    const ok = await call('POST', '/umpires/appointments/confirm', {
      filename: 'runner.xlsx',
      dataBase64,
      planHash,
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.deepEqual(await ok.json(), { written: 1, created: 0 });
    const rows = await ledger('s-wb');
    assert.deepEqual(rows.map((r) => `${r.fixtureId}:${r.umpireId}:${r.status}`).sort(), [
      'f1:u-a-ngubane:queued',
      'f2:u-b-tyali:completed',
    ]);
  });
});

describe('drain (cron)', () => {
  test('sends each queued row once with the real time/venue; completed rows never re-send', async () => {
    await repo.putSeries(
      TENANT,
      series('s-drain', [fx('f1')], { withheld: { time: true, venue: true } } as Partial<Series>),
    );
    await appoint('s-drain', 'f1', { umpires: ['u-a-ngubane'], referee: { umpireId: 'u-c-ref' } });
    const first = await run();
    const mine = first.sends.filter((s) => s.seriesName === 'Series s-drain');
    assert.equal(mine.length, 2);
    const ump = mine.find((s) => s.roleLabel === 'umpire')!;
    assert.equal(ump.official.name, 'Andile Ngubane');
    assert.equal(ump.orgName, 'KZN Dolphins');
    assert.equal(ump.fixtureLabel, 'Home Club v Away Club');
    assert.equal(ump.dateLabel, 'Sun 2026-11-15');
    // Withheld from clubs, but officials get the real kick-off and ground (ADR 0011 is club-facing).
    assert.equal(ump.time, '09:00');
    assert.equal(ump.venue, 'Kingsmead');
    assert.deepEqual(
      ump.channels,
      ['email', 'whatsapp'],
      'both channels: official_appointed registered in Meta 12 Oct 2026 (whatsappInvites defaults on)',
    );
    assert.ok(mine.some((s) => s.roleLabel === 'referee'));
    const rows = await ledger('s-drain');
    assert.ok(rows.every((r) => r.status === 'completed'));
    assert.ok(
      rows.every((r) => r.results?.every((x) => !('to' in x))),
      'no addresses stored',
    );

    const second = await run();
    assert.equal(second.sends.filter((s) => s.seriesName === 'Series s-drain').length, 0);
  });

  test('WhatsApp joins once the template is registered', async () => {
    await repo.putSeries(TENANT, series('s-wa', [fx('f1')]));
    await appoint('s-wa', 'f1', { umpires: ['u-b-tyali'] });
    const { sends } = await run({ whatsappTemplateStatus: 'registered' });
    const s = sends.find((x) => x.seriesName === 'Series s-wa')!;
    assert.deepEqual(s.channels, ['email', 'whatsapp']);
  });

  test('a no-contact row stays queued (no attempt counted) and sends once contacts are added', async () => {
    await repo.putSeries(TENANT, series('s-nc', [fx('f1')]));
    await appoint('s-nc', 'f1', { umpires: ['u-d-nocontact'] });
    await run();
    await run();
    let [row] = await ledger('s-nc');
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 0);
    const patch = await call('PATCH', '/umpires/u-d-nocontact', { email: 'dn@example.org' });
    assert.equal(patch.status, 200, await patch.clone().text());
    const { sends } = await run();
    assert.equal(sends.filter((s) => s.seriesName === 'Series s-nc').length, 1);
    [row] = await ledger('s-nc');
    assert.equal(row.status, 'completed');
  });

  test('a fixture with no date leaves the row queued until a date is set', async () => {
    await repo.putSeries(TENANT, series('s-nd', [fx('f1', { date: undefined })]));
    await appoint('s-nd', 'f1', { umpires: ['u-a-ngubane'] });
    const first = await run();
    assert.equal(first.sends.filter((s) => s.seriesName === 'Series s-nd').length, 0);
    assert.equal((await ledger('s-nd'))[0].status, 'queued');
    await repo.putSeries(TENANT, series('s-nd', [fx('f1', { date: '2026-11-22' })]));
    const second = await run();
    const s = second.sends.filter((x) => x.seriesName === 'Series s-nd');
    assert.equal(s.length, 1);
    assert.equal(s[0].dateLabel, 'Sun 2026-11-22');
    assert.equal((await ledger('s-nd'))[0].status, 'completed');
  });

  test('a stale row (official no longer on the fixture) is dropped without sending', async () => {
    await repo.putSeries(TENANT, series('s-stale', [fx('f1')]));
    await appoint('s-stale', 'f1', { umpires: ['u-a-ngubane'] });
    // A raced enqueue left a row for someone who is not appointed.
    await repo.queueOfficialsNotify(TENANT, {
      seriesId: 's-stale',
      fixtureId: 'f1',
      role: 'umpire',
      umpireId: 'u-b-tyali',
    });
    const { sends, summary } = await run();
    const mine = sends.filter((s) => s.seriesName === 'Series s-stale');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].official.email, 'an@example.org');
    assert.ok(summary.stale >= 1);
    assert.deepEqual(
      (await ledger('s-stale')).map((r) => r.umpireId),
      ['u-a-ngubane'],
    );
  });

  test('provider failures count attempts and exhaust at the cap', async () => {
    await repo.putSeries(TENANT, series('s-fail', [fx('f1')]));
    await appoint('s-fail', 'f1', { umpires: ['u-a-ngubane'] });
    const failing = {
      attemptCap: 3,
      send: async (args: SendArgs) => ({
        results: args.channels.map((channel) => ({
          channel,
          status: 'failed' as const,
          error: 'SES throttled',
        })),
      }),
    };
    await run(failing);
    await run(failing);
    let [row] = await ledger('s-fail');
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 2);
    const third = await run(failing);
    [row] = await ledger('s-fail');
    assert.equal(row.status, 'exhausted');
    assert.equal(row.attempts, 3);
    assert.ok(third.captured.some((t) => t.seriesId === 's-fail'));
    // Exhausted rows are no longer drained.
    const fourth = await run();
    assert.equal(fourth.sends.filter((s) => s.seriesName === 'Series s-fail').length, 0);
  });

  test('deleting the series sweeps its ledger rows', async () => {
    await repo.putSeries(TENANT, series('s-gone', [fx('f1')]));
    await appoint('s-gone', 'f1', { umpires: ['u-a-ngubane'] });
    assert.equal((await ledger('s-gone')).length, 1);
    await repo.deleteFixtureOfficialsForSeries(TENANT, 's-gone');
    assert.deepEqual(await ledger('s-gone'), []);
  });
});

describe('backfill CLI', () => {
  test('claims existing appointments as completed; dry run writes nothing; re-run claims nothing', async () => {
    const { backfillOfficialNotify } = await import('../src/backfill-official-notify.js');
    await repo.putSeries(TENANT, series('s-bf', [fx('f1')]));
    // A pre-feature appointment: written straight to the store, no ledger row.
    await repo.putFixtureOfficials(TENANT, 's-bf', 'f1', {
      umpires: [{ umpireId: 'u-a-ngubane', name: 'A.Ngubane' }],
      referee: { umpireId: 'u-c-ref', name: 'C.Ref' },
    });
    const opts = { tenant: TENANT, log: () => {} };
    await backfillOfficialNotify(repo, { ...opts, confirm: false });
    assert.deepEqual(await ledger('s-bf'), []);
    const done = await backfillOfficialNotify(repo, { ...opts, confirm: true });
    assert.ok(done.claimed >= 2);
    const rows = await ledger('s-bf');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'completed' && r.reason === 'backfill'));
    const again = await backfillOfficialNotify(repo, { ...opts, confirm: true });
    assert.equal(again.claimed, 0);
    const { sends } = await run();
    assert.equal(sends.filter((s) => s.seriesName === 'Series s-bf').length, 0);
  });
});

describe('notify-status route', () => {
  const STATUS_KEYS = [
    'attempts',
    'completedAt',
    'fixtureId',
    'reason',
    'role',
    'status',
    'umpireId',
  ];

  test('returns the series ledger with only whitelisted fields', async () => {
    await repo.putSeries(TENANT, series('s-status', [fx('f1'), fx('f2')]));
    await appoint('s-status', 'f1', { umpires: ['u-a-ngubane'] });
    await run(); // completes f1's row with results/addresses on the ledger
    await repo.queueOfficialsNotify(
      TENANT,
      { seriesId: 's-status', fixtureId: 'f2', role: 'umpire', umpireId: 'u-b-tyali' },
      { status: 'completed', reason: 'backfill' },
    );
    const res = await call('GET', '/series/s-status/officials/notify-status');
    assert.equal(res.status, 200, await res.clone().text());
    const { rows } = (await res.json()) as { rows: Array<Record<string, unknown>> };
    assert.equal(rows.length, 2);
    for (const r of rows) {
      for (const k of Object.keys(r)) assert.ok(STATUS_KEYS.includes(k), `leaked field ${k}`);
    }
    const sent = rows.find((r) => r.fixtureId === 'f1')!;
    assert.equal(sent.status, 'completed');
    assert.equal(sent.umpireId, 'u-a-ngubane');
    assert.equal(sent.role, 'umpire');
    assert.ok(typeof sent.completedAt === 'string');
    assert.equal(sent.reason, undefined);
    const backfilled = rows.find((r) => r.fixtureId === 'f2')!;
    assert.equal(backfilled.reason, 'backfill');
  });

  test('non-admins get 403', async () => {
    const REP = devAuth('rep@test', [{ tenantId: TENANT, role: 'rep', clubIds: ['home-club'] }]);
    const res = await app.request('/series/s-status/officials/notify-status', {
      headers: { ...headers, 'x-dev-auth': REP },
    });
    assert.equal(res.status, 403);
  });
});
