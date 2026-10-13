/**
 * Tests for scripts/backfill-captains-report-notices.ts — the one-off open + chair notice for
 * fixtures that never got a captain's report. Flag parsing, the link-base derivation and the
 * --confirm refusals are pure; the dry run, backup and series filter run against dynalite
 * with the REAL repo and opener (only the sender is captured).
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4723;
const TABLE = 'SmartClubReportBackfill';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

type Script = typeof import('../scripts/backfill-captains-report-notices.js');
let script: Script;
let ddb: Server;
let repo: typeof import('../src/repo.js');
let reports: typeof import('../src/captains-reports.js');

const DATE = '2026-10-10';
const NOW = new Date('2026-10-13T08:00:00.000Z');

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  reports = await import('../src/captains-reports.js');
  script = await import('../scripts/backfill-captains-report-notices.js');
});
after(async () => {
  await stopDynalite(ddb);
});

describe('parseBackfillArgs', () => {
  test('parses every flag', () => {
    assert.deepEqual(
      script.parseBackfillArgs([
        '--tenant=dolphins',
        '--dates=2026-10-10,2026-10-11',
        '--series=a,b',
        '--confirm',
        '--backup-dir=/tmp/x',
        '--link-base=https://x.test',
      ]),
      {
        tenant: 'dolphins',
        dates: ['2026-10-10', '2026-10-11'],
        seriesIds: ['a', 'b'],
        confirm: true,
        backupDir: '/tmp/x',
        linkBase: 'https://x.test',
      },
    );
  });
  test('rejects bad dates, unknown flags and missing required ones', () => {
    assert.throws(
      () => script.parseBackfillArgs(['--tenant=d', '--dates=2026-10-32']),
      /YYYY-MM-DD/,
    );
    assert.throws(
      () => script.parseBackfillArgs(['--tenant=d', '--dates=10/10/2026']),
      /YYYY-MM-DD/,
    );
    assert.throws(
      () => script.parseBackfillArgs(['--tenant=d', '--dates=2026-10-10', '--x']),
      /unknown/,
    );
    assert.throws(() => script.parseBackfillArgs(['--dates=2026-10-10']), /--tenant/);
    assert.throws(() => script.parseBackfillArgs(['--tenant=d']), /--dates/);
  });
});

describe('link base + refusals', () => {
  test('prod derives the platform host; other stages need a flag; a flag wins', () => {
    assert.equal(
      script.resolveLinkBase(undefined, { SST_RESOURCE_App: '{"name":"x","stage":"prod"}' }),
      'https://platform.club.medicoach.co.za',
    );
    assert.equal(script.resolveLinkBase(undefined, { SST_STAGE: 'dev' }), undefined);
    assert.equal(
      script.resolveLinkBase('https://d.test/', { SST_STAGE: 'prod' }),
      'https://d.test',
    );
  });
  test('localhost and any dry-run channel refuse --confirm', () => {
    assert.match(script.confirmRefusals('http://localhost:5173', { email: false }).join(), /dead/);
    assert.match(script.confirmRefusals('https://p.test', { email: true }).join(), /email/);
    assert.deepEqual(
      script.confirmRefusals('https://p.test', { email: false, whatsapp: false }),
      [],
    );
  });
});

// ── dynalite: dry run, backup, series filter ──
const club = (id: string, chair: { name: string; email?: string }) =>
  ({
    id,
    name: id.toUpperCase(),
    district: 'd',
    sub: '',
    chair: chair.name,
    exco: { chair },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#000',
    ground: { venue: 'Ground' },
    leagues: ['premier'],
  }) as never;
const series = (id: string, home: string, away: string): Series =>
  ({
    id,
    name: id,
    leagueKey: 'premier',
    startDate: DATE,
    teams: [home, away],
    participants: [home, away].map((t) => ({ teamId: t, clubId: t, name: t.toUpperCase() })),
    fixtures: [{ id: 'f1', round: 1, date: DATE, time: '09:00', home, away }],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

async function resetTable() {
  const { DynamoDBClient, ScanCommand, DeleteItemCommand } =
    await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const items = (await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? [];
  for (const i of items)
    await c.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
}

const sent: string[] = [];
const lines: string[] = [];
const deps = (
  over: Partial<import('../scripts/backfill-captains-report-notices.js').BackfillDeps> = {},
) => ({
  repo,
  reports,
  dryRun: { email: false, whatsapp: false },
  linkBase: 'https://platform.test',
  log: (l: string) => lines.push(l),
  now: () => NOW,
  linkSecret: () => 'test-secret',
  sendNotice: async (n: import('../src/captains-reports.js').ReportNotice) => {
    sent.push(n.clubName);
    return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
  },
  ...over,
});

describe('runBackfill', () => {
  beforeEach(async () => {
    await resetTable();
    sent.length = 0;
    lines.length = 0;
    await repo.putTenantConfig({
      tenant: 'dolphins',
      branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-01',
      knownClubs: [],
      features: { medicoachSync: true },
      integrations: { medicoach: { goLiveDate: '2026-10-01' } },
    } as unknown as TenantConfig);
    await repo.createClub('dolphins', club('a', { name: 'A Chair', email: 'a@x.test' }));
    await repo.createClub('dolphins', club('b', { name: '' }));
    await repo.createClub('dolphins', club('c', { name: 'C Chair', email: 'c@x.test' }));
    await repo.createClub('dolphins', club('d', { name: 'D Chair', email: 'd@x.test' }));
    await repo.putSeries('dolphins', series('s1', 'a', 'b'));
    await repo.putSeries('dolphins', series('s2', 'c', 'd'));
  });

  test('dry run prints the plan (incl. chair-contact gaps) and writes nothing', async () => {
    const status = await script.runBackfill(
      { tenant: 'dolphins', dates: [DATE], confirm: false },
      deps(),
    );
    assert.equal(status, 0);
    const out = lines.join('\n');
    assert.match(out, /DRY RUN/);
    assert.match(out, /home A: would open \+ notify chair/);
    assert.match(out, /NO CONTACT/);
    assert.match(out, /no result/);
    assert.match(out, /4 side\(s\) would open/);
    assert.deepEqual(await repo.listCaptainsReports('dolphins'), []);
    assert.equal(sent.length, 0);
  });

  test('--confirm writes the backup, opens + notifies, and an existing side is left alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'capbackfill-'));
    // The series-filtered run first: only s2 opens.
    assert.equal(
      await script.runBackfill(
        { tenant: 'dolphins', dates: [DATE], seriesIds: ['s2'], confirm: true, backupDir: dir },
        deps(),
      ),
      0,
    );
    assert.deepEqual(sent.sort(), ['C', 'D']);
    assert.ok((await repo.listCaptainsReports('dolphins')).every((r) => r.seriesId === 's2'));

    lines.length = 0;
    await script.runBackfill({ tenant: 'dolphins', dates: [DATE], confirm: false }, deps());
    assert.match(lines.join('\n'), /home C: report pending\/auto\/chair notified → left alone/);

    sent.length = 0;
    await script.runBackfill(
      { tenant: 'dolphins', dates: [DATE], confirm: true, backupDir: dir },
      deps({ now: () => new Date(NOW.getTime() + 60_000) }),
    );
    assert.deepEqual(sent, ['A'], 's2 sides untouched; the chair-less club gets no send');
    const files = (await readdir(dir)).filter((f) =>
      f.startsWith('captains-report-backfill-backup-dolphins-'),
    );
    assert.equal(files.length, 2);
    const pre = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))),
    );
    assert.ok(
      pre.some((p) => p.backup.some((b: { reports: unknown[] }) => b.reports.length === 2)),
    );
    // The window override is restored after the run.
    assert.equal(reports.reportNoticeWindowOpen(new Date('2026-10-13T08:00:00.000Z')), false);
  });

  test('--confirm is refused on a localhost link base or a dry-run channel', async () => {
    const args = { tenant: 'dolphins', dates: [DATE], confirm: true };
    assert.equal(await script.runBackfill(args, deps({ linkBase: 'http://localhost:5173' })), 1);
    assert.equal(
      await script.runBackfill(args, deps({ dryRun: { email: true, whatsapp: false } })),
      1,
    );
    assert.match(lines.join('\n'), /REFUSED --confirm/);
    assert.deepEqual(await repo.listCaptainsReports('dolphins'), []);
  });
});
