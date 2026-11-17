/**
 * Tests for scripts/reset-captains-reports.ts — the abandoned-match parts: the flag parser's
 * third mode, `--reset` refusing an abandoned fixture before any write, and the
 * `--void-abandoned --dates=…` cleanup (dry run, then `--confirm`). Runs against dynalite with
 * the REAL repo and opener; the default notice sender is captured to prove nothing is sent.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptainsReport, Series, StoredFixtureResult, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4747;
const TABLE = 'SmartClubReportReset';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

type Script = typeof import('../scripts/reset-captains-reports.js');
type Notice = import('../src/captains-reports.js').ReportNotice;
let script: Script;
let ddb: Server;
let repo: typeof import('../src/repo.js');
let reports: typeof import('../src/captains-reports.js');

const DAY = 24 * 3600 * 1000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const MATCH_DATE = isoDay(-1);
const OTHER_DATE = isoDay(-3);
const SERIES = 's-premier';

const notices: Notice[] = [];
const logLines: string[] = [];

const club = (id: string, name: string) =>
  ({
    id,
    name,
    district: 'd',
    sub: '',
    chair: `${name} Chair`,
    exco: { chair: { name: `${name} Chair`, email: `chair@${id}.test` } },
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

const fx = (id: string, date: string) => ({
  id,
  round: 1,
  date,
  time: '09:00',
  home: 'umzinto',
  away: 'african-warriors',
});

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

const report = (
  fixtureId: string,
  clubId: 'umzinto' | 'african-warriors',
  over: Partial<CaptainsReport> = {},
): CaptainsReport => {
  const home = clubId === 'umzinto';
  const at = new Date(Date.now() - DAY).toISOString();
  return {
    id: reports.captainsReportId(SERIES, fixtureId, clubId),
    seriesId: SERIES,
    fixtureId,
    clubId,
    status: 'pending',
    source: 'auto',
    matchDate: MATCH_DATE,
    side: home ? 'home' : 'away',
    clubName: home ? 'Umzinto CC' : 'African Warriors',
    opponentName: home ? 'African Warriors' : 'Umzinto CC',
    competition: 'Premier T20',
    resultSummary: null,
    umpiresSnapshot: [],
    recipient: { kind: 'chair', memberId: `chair-${clubId}-${fixtureId}`, name: 'Chair' },
    captainName: '',
    umpires: [],
    general: '',
    linkExpiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
    notifiedAt: at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
};

const storeResult = async (fixtureId: string, over: Partial<StoredFixtureResult>) => {
  const at = new Date(Date.now() - DAY).toISOString();
  await repo.putFixtureResultIfNewer('dolphins', {
    seriesId: SERIES,
    fixtureId,
    ref: `smartclub:dolphins:fixture:${SERIES}:${fixtureId}`,
    orderAt: at,
    recordedAt: at,
    storedAt: at,
    resultSource: 'manual',
    ...over,
  });
};
const ABANDONED = {
  summary: 'Abandoned',
  winner: 'none',
  method: 'abandoned',
  noResult: true,
} as const;

async function seed() {
  await repo.putTenantConfig({
    tenant: 'dolphins',
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: { medicoachSync: true },
    integrations: { medicoach: { goLiveDate: isoDay(-30) } },
  } as unknown as TenantConfig);
  await repo.createClub('dolphins', club('umzinto', 'Umzinto CC'));
  await repo.createClub('dolphins', club('african-warriors', 'African Warriors'));
  await repo.putSeries('dolphins', {
    id: SERIES,
    name: 'Premier T20',
    leagueKey: 'premier',
    startDate: OTHER_DATE,
    teams: ['umzinto', 'african-warriors'],
    participants: [
      { teamId: 'umzinto', clubId: 'umzinto', name: 'Umzinto CC', venue: 'Oval' },
      {
        teamId: 'african-warriors',
        clubId: 'african-warriors',
        name: 'African Warriors',
        venue: 'Oval',
      },
    ],
    fixtures: [fx('f-ab', MATCH_DATE), fx('f-ok', MATCH_DATE), fx('f-old', OTHER_DATE)],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  } as unknown as Series);
}

let backupDir = '';
const args = (over: Partial<import('../scripts/reset-captains-reports.js').ResetArgs>) => ({
  stage: 'test',
  tenant: 'dolphins',
  refs: [],
  mode: 'reset' as const,
  confirm: false,
  backupDir,
  ...over,
});
const sorted = async () =>
  (await repo.listCaptainsReports('dolphins')).sort((a, b) => a.id.localeCompare(b.id));

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  reports = await import('../src/captains-reports.js');
  script = await import('../scripts/reset-captains-reports.js');
  reports.setDefaultReportNoticeSender(async (n) => {
    notices.push(n);
    return n.channels.map((channel) => ({ channel, status: 'sent' as const }));
  });
});
after(async () => {
  reports.setDefaultReportNoticeSender(undefined);
  await stopDynalite(ddb);
});
beforeEach(async () => {
  await resetTable();
  await seed();
  notices.length = 0;
  logLines.length = 0;
  backupDir = await mkdtemp(join(tmpdir(), 'reset-'));
});

describe('parseResetArgs', () => {
  test('--void-abandoned is a third exclusive mode: --dates required, --refs rejected', () => {
    assert.deepEqual(
      script.parseResetArgs(['--stage=prod', '--void-abandoned', '--dates=2026-11-14,2026-11-15']),
      {
        stage: 'prod',
        tenant: 'dolphins',
        confirm: false,
        mode: 'void-abandoned',
        dates: ['2026-11-14', '2026-11-15'],
        refs: [],
      },
    );
    assert.throws(
      () => script.parseResetArgs(['--stage=prod', '--void-abandoned']),
      /--dates is required/,
    );
    assert.throws(
      () =>
        script.parseResetArgs([
          '--stage=prod',
          '--void-abandoned',
          '--dates=2026-11-14',
          '--refs=CR-2026-0001',
        ]),
      /--refs is not allowed/,
    );
    assert.throws(
      () => script.parseResetArgs(['--stage=prod', '--void-abandoned', '--dates=2026-11-31']),
      /YYYY-MM-DD/,
    );
    assert.throws(
      () => script.parseResetArgs(['--stage=prod', '--void-abandoned', '--reset', '--refs=CR-1']),
      /exactly one of/,
    );
  });

  test('--reset / --send still need --refs and refuse --dates', () => {
    assert.deepEqual(script.parseResetArgs(['--stage=dev', '--refs=CR-2026-0001', '--reset']), {
      stage: 'dev',
      tenant: 'dolphins',
      confirm: false,
      mode: 'reset',
      refs: ['CR-2026-0001'],
    });
    assert.throws(() => script.parseResetArgs(['--stage=dev', '--send']), /--refs is required/);
    assert.throws(
      () => script.parseResetArgs(['--stage=dev', '--refs=CR-1', '--reset', '--dates=2026-11-14']),
      /--dates is only for --void-abandoned/,
    );
    assert.throws(() => script.parseResetArgs(['--stage=dev', '--refs=CR-1']), /exactly one of/);
  });
});

describe('--reset on an abandoned fixture', () => {
  test('is refused before any write; the same fixture without the abandonment resets', async () => {
    const submitted = report('f-ab', 'umzinto', {
      status: 'submitted',
      ref: 'CR-2026-0001',
      captainName: 'Sanele Mthembu',
      submittedAt: new Date(Date.now() - DAY).toISOString(),
    });
    await repo.openCaptainsReportIfAbsent('dolphins', submitted);
    await storeResult('f-ab', ABANDONED);
    const before = await sorted();

    const status = await script.runReset(
      args({ mode: 'reset', refs: ['CR-2026-0001'], confirm: true }),
      repo,
      reports,
      (l) => logLines.push(l),
    );
    assert.equal(status, 1);
    assert.match(logLines.join('\n'), /CR-2026-0001: match abandoned .* nothing written/);
    assert.deepEqual(await sorted(), before, 'the submitted report is untouched');
    assert.deepEqual(await readdir(backupDir), [], 'refused before even the backup');
    assert.equal(notices.length, 0);

    // Control: a played result in its place ⇒ the reset goes through (the refusal above was
    // the abandonment, not some other guard).
    await repo.putFixtureResultIfNewer('dolphins', {
      seriesId: SERIES,
      fixtureId: 'f-ab',
      ref: `smartclub:dolphins:fixture:${SERIES}:f-ab`,
      orderAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      storedAt: new Date().toISOString(),
      summary: 'Umzinto won',
      winner: 'home',
      method: 'normal',
      resultSource: 'manual',
    });
    logLines.length = 0;
    assert.equal(
      await script.runReset(
        args({ mode: 'reset', refs: ['CR-2026-0001'], confirm: true }),
        repo,
        reports,
        (l) => logLines.push(l),
      ),
      0,
      logLines.join('\n'),
    );
    const reopened = await repo.getCaptainsReport('dolphins', SERIES, 'f-ab', 'umzinto');
    assert.equal(reopened?.status, 'pending');
    assert.equal(notices.length, 0, '--reset sends nothing');
  });
});

describe('--void-abandoned', () => {
  test('dry run lists and backs up; --confirm voids only pending auto rows of abandoned matches', async () => {
    // f-ab abandoned: one side pending (notified), the other already submitted.
    await repo.openCaptainsReportIfAbsent('dolphins', report('f-ab', 'african-warriors'));
    const submitted = report('f-ab', 'umzinto', {
      status: 'submitted',
      ref: 'CR-2026-0002',
      submittedAt: new Date(Date.now() - DAY).toISOString(),
    });
    await repo.openCaptainsReportIfAbsent('dolphins', submitted);
    await storeResult('f-ab', ABANDONED);
    // f-ok: a no-result match is NOT abandoned — left pending.
    await repo.openCaptainsReportIfAbsent('dolphins', report('f-ok', 'umzinto'));
    await storeResult('f-ok', {
      summary: 'No result',
      winner: 'none',
      method: 'no-result',
      noResult: true,
    });
    // f-old: abandoned, but on a date outside --dates — left pending.
    await repo.openCaptainsReportIfAbsent(
      'dolphins',
      report('f-old', 'umzinto', { matchDate: OTHER_DATE }),
    );
    await storeResult('f-old', ABANDONED);
    const before = await sorted();
    const target = reports.captainsReportId(SERIES, 'f-ab', 'african-warriors');

    const dry = args({ mode: 'void-abandoned', dates: [MATCH_DATE] });
    assert.equal(await script.runVoidAbandoned(dry, repo, reports, (l) => logLines.push(l)), 0);
    assert.deepEqual(await sorted(), before, 'the dry run writes nothing');
    const text = logLines.join('\n');
    assert.match(text, /DRY RUN --void-abandoned .* pending=2 abandoned=1/);
    assert.match(text, new RegExp(`\\[${target}\\] .* would void`));
    const files = await readdir(backupDir);
    assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(join(backupDir, files[0]!), 'utf8'));
    assert.deepEqual(
      saved.reports.map((r: CaptainsReport) => r.id),
      [target],
    );

    logLines.length = 0;
    assert.equal(
      await script.runVoidAbandoned({ ...dry, confirm: true }, repo, reports, (l) =>
        logLines.push(l),
      ),
      0,
    );
    const after = await sorted();
    const voided = after.find((r) => r.id === target)!;
    assert.equal(voided.status, 'void');
    assert.equal(voided.voidReason, 'match abandoned in medicoach');
    assert.ok(voided.voidedAt);
    for (const r of after.filter((x) => x.id !== target))
      assert.deepEqual(
        r,
        before.find((b) => b.id === r.id),
        `${r.id} untouched`,
      );
    assert.match(logLines.join('\n'), /done: voided=1 left=0; no notice sent/);
    assert.equal(notices.length, 0);

    // A re-run finds nothing left to void.
    logLines.length = 0;
    await script.runVoidAbandoned({ ...dry, confirm: true }, repo, reports, (l) =>
      logLines.push(l),
    );
    assert.match(logLines.join('\n'), /abandoned=0/);
  });
});
