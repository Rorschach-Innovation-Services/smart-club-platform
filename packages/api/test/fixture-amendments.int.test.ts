/**
 * Integration tests for the operator's reminder-fixtures upload:
 *   POST /platform/tenants/:slug/fixture-amendments/preview
 *   POST /platform/tenants/:slug/fixture-amendments/confirm
 *
 * In-process dynalite + the REAL Hono app via app.request(), operator auth through the
 * LOCAL_AUTH x-dev-auth bypass (same harness as platform.int.test.ts / umpires.int.test.ts).
 * The workbook is built per test with exceljs in the KZNCU reminder layout. S3 is the only
 * stub (aws-sdk-client-mock): the pre-write backup is a PutObject we inspect.
 *
 * Each test seeds its own tenant slug, so tests never share series state.
 */
import { test, before, after, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';
import type { Club, Series, TenantConfig, Venue } from '../src/types.js';

const DDB_PORT = 4699; // next free odd port after 4697
const TABLE = 'SmartClubFixtureAmendmentsTest';
dynaliteEnv(DDB_PORT, TABLE);

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuthAs('op-1', 'operator@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const ADMIN = devAuthAs('adm-1', 'admin@test', [
  { tenantId: 'fa-auth', role: 'admin', clubIds: [] },
]);
const headers = (auth = OPERATOR) => ({ 'x-dev-auth': auth, 'content-type': 'application/json' });

const SUN = '2026-10-11';

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let s3Mock: ReturnType<typeof mockClient>;

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
});
after(() => stopDynalite(ddb));
beforeEach(() => {
  s3Mock = mockClient(S3Client);
  s3Mock.on(PutObjectCommand).resolves({});
});
afterEach(() => s3Mock.restore());

// ─────────────────────────────── world ───────────────────────────────

const CLUBS = [
  ['alpha', 'Alpha CC', 'Alpha Oval'],
  ['beta', 'Beta CC', 'Beta Park'],
  ['gamma', 'Gamma CC', 'Gamma Field'],
  ['delta', 'Delta CC', 'Delta Fields'],
] as const;
const VENUES: Venue[] = [
  { id: 'v-alpha', name: 'Alpha Oval', homeClubIds: ['alpha'] },
  { id: 'v-beta', name: 'Beta Park', homeClubIds: ['beta'] },
  { id: 'v-gamma', name: 'Gamma Field', homeClubIds: ['gamma'] },
  { id: 'v-delta', name: 'Delta Fields', homeClubIds: ['delta'] },
  { id: 'v-neutral', name: 'Neutral Ground', homeClubIds: [] },
];
const SERIES_ID = 's-prem';

async function seedTenant(slug: string) {
  await repo.putTenantConfig({
    tenant: slug,
    branding: { name: slug, title: slug, logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
  } as unknown as TenantConfig);
  for (const [id, name, ground] of CLUBS)
    await repo.putClub(slug, {
      id,
      name,
      district: 'Test',
      sub: '',
      chair: '',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
      teams: 1,
      women: 0,
      juniors: 0,
      color: '#0E7C6B',
      ground: { venue: ground },
      leagues: [],
      version: 1,
    } as unknown as Club);
  for (const v of VENUES) await repo.putVenue(slug, v);
  await repo.putSeries(slug, {
    id: SERIES_ID,
    name: 'Premier League · T20 · Group 1',
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: CLUBS.map(([id]) => id),
    participants: CLUBS.map(([id, name]) => ({ teamId: id, clubId: id, name })),
    fixtures: [
      {
        id: 'f1',
        round: 2,
        date: SUN,
        time: '09:00',
        home: 'alpha',
        away: 'beta',
        venueId: 'v-beta',
        venueName: 'Beta Park',
      },
      {
        id: 'f2',
        round: 2,
        date: SUN,
        time: '13:30',
        home: 'gamma',
        away: 'delta',
        venueId: 'v-gamma',
        venueName: 'Gamma Field',
      },
      {
        id: 'f3',
        round: 2,
        date: SUN,
        time: '13:30',
        home: 'beta',
        away: 'gamma',
        venueId: 'v-beta',
        venueName: 'Beta Park',
      },
    ],
    kind: 'series',
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 5,
  } as unknown as Series);
}

type SheetRow = [string, string, string, string?];
/** A KZNCU-layout reminder workbook: a 09:00 block, then a 13:30 restatement block. */
async function workbook(early: SheetRow[], late: SheetRow[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Premier Men Reminder Fixtures');
  const t = (h: number, m: number) => new Date(Date.UTC(1899, 11, 30, h, m));
  const rows: unknown[][] = [
    ['Reminder Fixtures: 10th & 11th October 2026'],
    [],
    ['Premier Men: T20'],
    [],
    ['Group A:'],
    ['Week 2 Fixtures', '', '', t(9, 0), new Date(`${SUN}T00:00:00Z`), 'Venue:'],
    ...early.map(([h, a, v]) => [h, '', 'v', '', a, v]),
    ['', '', '', t(13, 30)],
    ...late.map(([h, a, v]) => [h, '', 'v', '', a, v]),
  ];
  rows.forEach((r, i) => {
    if (r.length) ws.getRow(i + 1).values = r as ExcelJS.CellValue[];
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

/** The baseline sheet: f1 unchanged, f2 retimed 13:30 → 09:00, f3 moved to Neutral Ground. */
const baseline = () =>
  workbook(
    [
      ['Alpha', 'Beta', 'Beta Park'],
      ['Gamma ', 'Delta', 'Gamma Field'],
    ],
    [['Beta', 'Gamma', 'Neutral Ground']],
  );

const post = (slug: string, op: 'preview' | 'confirm', body: unknown, auth = OPERATOR) =>
  app.request(`/platform/tenants/${slug}/fixture-amendments/${op}`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

interface Preview {
  planHash: string;
  counts: Record<string, number>;
  sheets: Array<{
    sheet: string;
    status: string;
    alreadyCorrect: number;
    rows: Array<{ rowId: string; outcome: string; changes?: Array<{ field: string }> }>;
  }>;
  gate: { ok: boolean; introduced: unknown[]; preExisting: unknown[] };
  officials?: Array<{ seriesId: string; fixtureId: string; umpires: string[] }>;
  touchedSeries: Array<{ id: string; version: number }>;
}

const fixtureOf = async (slug: string, id: string) =>
  ((await repo.getSeries(slug, SERIES_ID))!.fixtures as Array<Record<string, unknown>>).find(
    (f) => f.id === id,
  )!;

// ─────────────────────────────── tests ───────────────────────────────

describe('fixture amendments upload — preview', () => {
  test('operators only', async () => {
    await seedTenant('fa-auth');
    const res = await post('fa-auth', 'preview', { dataBase64: await baseline() }, ADMIN);
    assert.equal(res.status, 403);
  });

  test('unknown tenant 404; bad files refused before reading', async () => {
    assert.equal((await post('fa-nope', 'preview', { dataBase64: await baseline() })).status, 404);
    await seedTenant('fa-bad');
    assert.equal((await post('fa-bad', 'preview', {})).status, 400);
    const notZip = await post('fa-bad', 'preview', {
      filename: 'x.xlsx',
      dataBase64: Buffer.from('a,b,c').toString('base64'),
    });
    assert.equal(notZip.status, 400);
    assert.match(((await notZip.json()) as { error: string }).error, /not an Excel .xlsx/);
    const csv = await post('fa-bad', 'preview', { filename: 'x.csv', dataBase64: 'UEsDBA==' });
    assert.equal(csv.status, 400);
    const huge = await post('fa-bad', 'preview', { dataBase64: 'A'.repeat(2_900_000) });
    assert.equal(huge.status, 413);
    const badSkip = await post('fa-bad', 'preview', {
      dataBase64: await baseline(),
      skipRowIds: [1, 2],
    });
    assert.equal(badSkip.status, 400);
  });

  test('a slim preview with changes, collapsed no-ops and the officials report; writes nothing', async () => {
    await seedTenant('fa-prev');
    await repo.putFixtureOfficials('fa-prev', SERIES_ID, 'f2', {
      umpires: [{ umpireId: 'u1', name: 'J. Umpire' }],
    });
    const res = await post('fa-prev', 'preview', {
      filename: 'reminder.xlsx',
      dataBase64: await baseline(),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('"fixtures"'), 'never the series bodies');
    const pv = JSON.parse(text) as Preview;
    assert.match(pv.planHash, /^[0-9a-f]{64}$/);
    assert.equal(pv.counts['matched-change'], 2);
    assert.equal(pv.counts['matched-no-change'], 1);
    assert.equal(pv.sheets[0].alreadyCorrect, 1);
    assert.deepEqual(
      pv.sheets[0].rows.map((r) => [r.rowId, r.outcome, r.changes?.map((c) => c.field)]),
      [
        ['Premier Men Reminder Fixtures:8', 'matched-change', ['time']],
        ['Premier Men Reminder Fixtures:10', 'matched-change', ['venue']],
      ],
    );
    assert.equal(pv.gate.ok, true);
    assert.deepEqual(pv.officials, [
      { seriesId: SERIES_ID, fixtureId: 'f2', umpires: ['J. Umpire'] },
    ]);
    assert.deepEqual(pv.touchedSeries, [
      { id: SERIES_ID, name: 'Premier League · T20 · Group 1', version: 5 },
    ]);
    assert.equal((await repo.getSeries('fa-prev', SERIES_ID))!.version, 5, 'nothing written');
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
  });
});

describe('fixture amendments upload — confirm', () => {
  test('writes the changes after an S3 backup; re-upload is all no-op', async () => {
    await seedTenant('fa-ok');
    const dataBase64 = await baseline();
    const pv = (await (await post('fa-ok', 'preview', { dataBase64 })).json()) as Preview;
    const res = await post('fa-ok', 'confirm', { dataBase64, planHash: pv.planHash });
    assert.equal(res.status, 200);
    const out = (await res.json()) as {
      backupKey: string;
      fixturesAmended: number;
      series: Array<{ seriesId: string; status: string; version: number }>;
      splitSlotRisks: unknown[];
      clubsNotified: boolean;
    };
    assert.equal(out.fixturesAmended, 2);
    assert.deepEqual(
      out.series.map((s) => [s.seriesId, s.status, s.version]),
      [[SERIES_ID, 'written', 6]],
    );
    assert.deepEqual(out.splitSlotRisks, []);
    assert.equal(out.clubsNotified, false);

    // Backup: one PutObject under the unreachable prefix, holding the series as read.
    const puts = s3Mock.commandCalls(PutObjectCommand);
    assert.equal(puts.length, 1);
    const input = puts[0].args[0].input;
    assert.equal(input.Bucket, 'test-uploads');
    assert.match(input.Key!, /^_backups\/fixture-amendments\/fa-ok\/.+\.json$/);
    assert.equal(input.Key, out.backupKey);
    const backup = JSON.parse(String(input.Body)) as { series: Series[]; by: string };
    assert.equal(backup.by, 'operator@platform');
    assert.equal(backup.series[0].version, 5);

    const f2 = await fixtureOf('fa-ok', 'f2');
    assert.equal(f2.time, '09:00');
    const f3 = await fixtureOf('fa-ok', 'f3');
    assert.equal(f3.venueId, 'v-neutral');
    assert.equal(f3.venueName, 'Neutral Ground');
    assert.equal(f3.venueReason, 'Union reminder fixtures upload');

    const again = (await (await post('fa-ok', 'preview', { dataBase64 })).json()) as Preview;
    assert.equal(again.counts['matched-change'], 0);
    assert.equal(again.counts['matched-no-change'], 3);
    const noop = await post('fa-ok', 'confirm', { dataBase64, planHash: again.planHash });
    assert.equal(noop.status, 400);
    assert.equal(((await noop.json()) as { code: string }).code, 'nothing_to_apply');
  });

  test('a stale or missing planHash is refused with the fresh preview', async () => {
    await seedTenant('fa-stale');
    const dataBase64 = await baseline();
    const pv = (await (await post('fa-stale', 'preview', { dataBase64 })).json()) as Preview;
    // Someone edits the series between preview and confirm.
    const s = (await repo.getSeries('fa-stale', SERIES_ID))!;
    await repo.putSeries('fa-stale', { ...s, version: s.version + 1 });
    const res = await post('fa-stale', 'confirm', { dataBase64, planHash: pv.planHash });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; preview: Preview };
    assert.equal(body.code, 'plan_changed');
    assert.notEqual(body.preview.planHash, pv.planHash);
    assert.equal((await fixtureOf('fa-stale', 'f2')).time, '13:30', 'nothing written');
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
    const missing = await post('fa-stale', 'confirm', { dataBase64 });
    assert.equal(missing.status, 409);
  });

  test('skip toggles: the hash covers them and only ticked rows are written', async () => {
    await seedTenant('fa-skip');
    const dataBase64 = await baseline();
    const full = (await (await post('fa-skip', 'preview', { dataBase64 })).json()) as Preview;
    const skipRowIds = ['Premier Men Reminder Fixtures:10'];
    const pv = (await (
      await post('fa-skip', 'preview', { dataBase64, skipRowIds })
    ).json()) as Preview;
    assert.notEqual(pv.planHash, full.planHash);
    // The un-skipped hash does not confirm a skipped plan.
    const wrong = await post('fa-skip', 'confirm', {
      dataBase64,
      skipRowIds,
      planHash: full.planHash,
    });
    assert.equal(wrong.status, 409);
    const res = await post('fa-skip', 'confirm', { dataBase64, skipRowIds, planHash: pv.planHash });
    assert.equal(res.status, 200);
    assert.equal((await fixtureOf('fa-skip', 'f2')).time, '09:00');
    assert.equal((await fixtureOf('fa-skip', 'f3')).venueId, 'v-beta', 'skipped row untouched');
  });

  test('an introduced clash blocks confirm (no bypass), nothing written', async () => {
    await seedTenant('fa-clash');
    // Gamma v Delta onto Beta Park at 09:00, which f1 holds.
    const dataBase64 = await workbook(
      [
        ['Alpha', 'Beta', 'Beta Park'],
        ['Gamma', 'Delta', 'Beta Park'],
      ],
      [],
    );
    const pv = (await (await post('fa-clash', 'preview', { dataBase64 })).json()) as Preview;
    assert.equal(pv.gate.ok, false);
    assert.ok(pv.gate.introduced.length > 0);
    const res = await post('fa-clash', 'confirm', { dataBase64, planHash: pv.planHash });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; details: { introduced: unknown[] } };
    assert.equal(body.code, 'clash_gate');
    assert.ok(body.details.introduced.length > 0);
    assert.equal((await fixtureOf('fa-clash', 'f2')).venueId, 'v-gamma');
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
  });

  test('a failed backup aborts before any write', async () => {
    await seedTenant('fa-nobackup');
    s3Mock.on(PutObjectCommand).rejects(new Error('s3 down'));
    const dataBase64 = await baseline();
    const pv = (await (await post('fa-nobackup', 'preview', { dataBase64 })).json()) as Preview;
    const res = await post('fa-nobackup', 'confirm', { dataBase64, planHash: pv.planHash });
    assert.equal(res.status, 500);
    assert.equal((await repo.getSeries('fa-nobackup', SERIES_ID))!.version, 5);
  });
});
