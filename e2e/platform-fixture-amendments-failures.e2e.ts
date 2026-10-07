import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
  API_BASE,
  RUN,
  TENANT,
  adminAuthHeader,
  apiHeaders,
  operatorAuth,
  operatorIdentity,
} from './helpers';
import { createReleased, createSeries, getSeries, patchSeries } from './fixtures-helpers';

/**
 * Operator "Fixture amendments" failure modes, driven through the real UI against the real
 * local API (the happy path lives in platform-fixture-amendments.e2e.ts):
 *
 *   - a non-.xlsx pick, or a CSV renamed .xlsx, is refused with a clear message;
 *   - a file over 2 MB is refused before any request;
 *   - sheets that flunk the structural gate (wandering 'v' column, too few fixture rows) are
 *     shown as "Sheet not read" with the reason, and their rows are never applied;
 *   - an admin edit between preview and Apply → 409 plan_changed: a toast, the fresh preview
 *     (with the fixture's new live values) replaces the stale one, nothing is written;
 *   - a change that lands on a ground a released fixture holds blocks the whole upload;
 *   - a change that lands on a ground a DRAFT fixture holds can relocate that draft instead,
 *     and the result reports the relocation apart from the sheet amendments.
 *
 * Each test seeds its own registry grounds and released series (RUN-unique names) on its own
 * day, so neither repeated runs on one stack nor the other tests can put a clash on its dates.
 */

const admin = () => apiHeaders(adminAuthHeader());
const operator = () => apiHeaders(operatorAuth([TENANT]));

// 2029 days picked from the clock (the happy-path spec lives in 2028, the other fixture specs
// in 2027); each test adds its own week offset so the tests never share a date.
const BASE_DAY = Date.UTC(2029, 0, 1) + (Math.floor(Date.now() / 1000) % 40) * 7 * 86400_000;
const dayOf = (week: number) =>
  new Date(BASE_DAY + week * 7 * 86400_000 * 40).toISOString().slice(0, 10);

type SheetRow = [home: string, away: string, venue: string];

interface World {
  date: string;
  competition: string;
  seriesName: string;
  sheet: string;
  ground: { one: string; two: string; three: string; moved: string };
  seriesId: string;
}

/**
 * Registry grounds + a released series of three 09:00 fixtures on one day, each at its own
 * ground: UKZN v Clares @one, Chatsworth v Umlazi @two, Crusaders v Berea @three.
 */
async function seedWorld(request: APIRequestContext, tag: string, week: number): Promise<World> {
  const date = dayOf(week);
  const competition = `Amend Fail ${tag} ${RUN}`;
  const ground = {
    one: `E2E AF ${tag} One ${RUN}`,
    two: `E2E AF ${tag} Two ${RUN}`,
    three: `E2E AF ${tag} Three ${RUN}`,
    moved: `E2E AF ${tag} Moved ${RUN}`,
  };
  for (const [key, name] of Object.entries(ground)) {
    const res = await request.put(`${API_BASE}/venues/e2e-af-${tag}-${key}-${RUN}`, {
      headers: admin(),
      data: { name },
    });
    expect(res.ok(), `PUT /venues → ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  const series = await createReleased(request, {
    name: `${competition} · T20`,
    startDate: date,
    fixtures: [
      { id: 'f1', round: 1, date, time: '09:00', home: 'ukzn', away: 'clares' },
      { id: 'f2', round: 1, date, time: '09:00', home: 'chatsworth', away: 'umlazi' },
      { id: 'f3', round: 1, date, time: '09:00', home: 'crusaders', away: 'berea' },
    ].map((f, i) => ({ ...f, venueOverride: [ground.one, ground.two, ground.three][i] })),
  });
  expect(series.released).toBe(true);
  return {
    date,
    competition,
    seriesName: `${competition} · T20`,
    sheet: `E2E Reminder ${tag}`,
    ground,
    seriesId: series.id,
  };
}

/** One sheet in the KZNCU reminder layout: a dated 09:00 "Venue:" block, then a 13:30 block. */
function addReminderSheet(
  wb: ExcelJS.Workbook,
  w: Pick<World, 'date' | 'competition' | 'sheet'>,
  early: SheetRow[],
  late: SheetRow[],
) {
  const ws = wb.addWorksheet(w.sheet);
  const t = (h: number, m: number) => new Date(Date.UTC(1899, 11, 30, h, m));
  const rows: unknown[][] = [
    [`Reminder Fixtures: ${w.date}`],
    [],
    [`${w.competition}: T20`],
    [],
    ['Group A:'],
    ['Week 1 Fixtures', '', '', t(9, 0), new Date(`${w.date}T00:00:00Z`), 'Venue:'],
    ...early.map(([h, a, v]) => [h, '', 'v', '', a, v]),
    ['', '', '', t(13, 30)],
    ...late.map(([h, a, v]) => [h, '', 'v', '', a, v]),
  ];
  rows.forEach((r, i) => {
    if (r.length) ws.getRow(i + 1).values = r as ExcelJS.CellValue[];
  });
  return ws;
}

/** The standard amendment: Chatsworth v Umlazi → 13:30; Crusaders v Berea → 13:30 @moved. */
async function standardWorkbook(w: World): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addReminderSheet(
    wb,
    w,
    [['UKZN CC', 'Clares CC', w.ground.one]],
    [
      ['Chatsworth Sporting CC', 'Umlazi CC', w.ground.two],
      ['Crusaders CC', 'Berea Rovers CC', w.ground.moved],
    ],
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function openAmendments(page: Page) {
  await page.addInitScript(
    (identity) => {
      localStorage.setItem('smartclub.devAuth', JSON.stringify(identity));
    },
    operatorIdentity([TENANT]),
  );
  await page.goto(`/platform/tenants/${TENANT}/fixture-amendments?tenant=${TENANT}`);
  await expect(page.getByRole('heading', { name: /Fixture amendments/ })).toBeVisible();
}

async function upload(page: Page, buffer: Buffer, name = 'reminder.xlsx', mimeType = XLSX_MIME) {
  await page.getByLabel(/Reminder fixtures workbook/).setInputFiles({ name, mimeType, buffer });
}

/** Counts the amendment API calls the page makes (preview + confirm). */
function countAmendmentCalls(page: Page) {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/fixture-amendments/')) calls.push(r.url());
  });
  return calls;
}

const stat = (page: Page, label: string) =>
  page.locator('.mcs-stat', { hasText: label }).locator('.mcs-stat-value');
const applyBtn = (page: Page) => page.getByRole('button', { name: /^Apply \d+ changes?$/ });
const errorAlert = (page: Page) => page.locator('.insights-callout.alert[role="alert"]');

type StoredFixture = Record<string, unknown> & { id: string };
async function storedFixtures(request: APIRequestContext, seriesId: string) {
  const s = await getSeries(request, seriesId);
  return { version: s.version, fixtures: s.fixtures as unknown as StoredFixture[] };
}

test('a non-.xlsx file is refused: a .csv pick never leaves the browser, a renamed CSV is a 400', async ({
  page,
}) => {
  const calls = countAmendmentCalls(page);
  await openAmendments(page);

  await upload(
    page,
    Buffer.from('home,away,venue\nUKZN,Clares,Somewhere\n'),
    'fixtures.csv',
    'text/csv',
  );
  await expect(errorAlert(page)).toHaveText(
    'Choose the reminder fixtures sheet as an Excel .xlsx file.',
  );
  await expect(stat(page, 'Will be changed')).toHaveCount(0);
  expect(calls, 'a .csv is refused before any request').toEqual([]);

  // Same content renamed .xlsx: passes the browser's name check, refused by the server's
  // zip-signature check with a clean 400 surfaced verbatim.
  const res = page.waitForResponse((r) => r.url().includes('/fixture-amendments/preview'));
  await upload(page, Buffer.from('home,away,venue\nUKZN,Clares,Somewhere\n'), 'renamed.xlsx');
  expect((await res).status()).toBe(400);
  await expect(errorAlert(page)).toHaveText('that file is not an Excel .xlsx workbook');
  await expect(stat(page, 'Will be changed')).toHaveCount(0);
  await expect(applyBtn(page)).toHaveCount(0);
});

test('a file over 2 MB is refused in the browser; the server backs it with a 413', async ({
  page,
  request,
}) => {
  const calls = countAmendmentCalls(page);
  await openAmendments(page);

  const big = Buffer.alloc(2 * 1024 * 1024 + 1024, 0x41);
  await upload(page, big, 'huge.xlsx');
  await expect(errorAlert(page)).toHaveText(
    'That file is larger than 2 MB. The reminder fixtures sheet is usually far smaller.',
  );
  await expect(applyBtn(page)).toHaveCount(0);
  expect(calls, 'an oversized file is refused before any request').toEqual([]);

  // The UI never sends it, so the server's own cap is checked directly.
  const direct = await request.post(
    `${API_BASE}/platform/tenants/${TENANT}/fixture-amendments/preview`,
    { headers: operator(), data: { filename: 'huge.xlsx', dataBase64: big.toString('base64') } },
  );
  expect(direct.status()).toBe(413);
  expect(((await direct.json()) as { error: string }).error).toBe(
    'the workbook is larger than 2 MB',
  );
});

test('sheets that flunk the layout gate are shown as not read, and their rows never apply', async ({
  page,
  request,
}) => {
  const w = await seedWorld(request, 'gate', 0);
  const before = await storedFixtures(request, w.seriesId);

  // Sheet 1 (valid): every row already correct. Sheet 2: the 'v' wanders between columns.
  // Sheet 3: one fixture row among three junk rows (1 of 4 < the 75% floor). Sheets 2 and 3
  // would each move a real fixture if they were read.
  const wb = new ExcelJS.Workbook();
  addReminderSheet(
    wb,
    { ...w, sheet: 'Good Sheet' },
    [
      ['UKZN CC', 'Clares CC', w.ground.one],
      ['Chatsworth Sporting CC', 'Umlazi CC', w.ground.two],
      ['Crusaders CC', 'Berea Rovers CC', w.ground.three],
    ],
    [],
  );
  const wandering = addReminderSheet(
    wb,
    { ...w, sheet: 'Wandering V' },
    [['Chatsworth Sporting CC', 'Umlazi CC', w.ground.moved]],
    [],
  );
  // A second fixture row with its 'v' one column left of the first's.
  wandering.getRow(8).values = ['Crusaders CC', 'v', 'Berea Rovers CC', '', '', w.ground.moved];
  const sparse = addReminderSheet(
    wb,
    { ...w, sheet: 'Mostly Notes' },
    [['Crusaders CC', 'Berea Rovers CC', w.ground.moved]],
    [],
  );
  sparse.getRow(9).values = ['Umpires', 'to', 'confirm'];
  sparse.getRow(10).values = ['Bring', 'your', 'own balls'];
  sparse.getRow(11).values = ['Teas', 'at', 'the clubhouse'];
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await openAmendments(page);
  await upload(page, buffer);

  const wanderingSec = page.getByRole('region', { name: 'Sheet Wandering V' });
  await expect(wanderingSec).toContainText('Sheet not read');
  await expect(wanderingSec).toContainText(
    "This sheet was left out: layout not recognised: the 'v' column varies (columns 2, 3).",
  );
  const sparseSec = page.getByRole('region', { name: 'Sheet Mostly Notes' });
  await expect(sparseSec).toContainText('Sheet not read');
  await expect(sparseSec).toContainText(
    'This sheet was left out: layout not recognised: only 1 of 4 content rows read as fixtures.',
  );
  // Neither refused sheet lists a change; the good sheet's three rows are already correct.
  await expect(page.getByRole('table', { name: /^Changes on / })).toHaveCount(0);
  await expect(stat(page, 'Will be changed')).toHaveText('0');
  await expect(stat(page, 'Already correct')).toHaveText('3');
  await expect(applyBtn(page)).toBeDisabled();

  // A workbook made ONLY of refused sheets has no rows at all: the server answers 400
  // no_rows, and the page still shows each sheet's reason for being left out.
  const onlyBad = new ExcelJS.Workbook();
  const ws = addReminderSheet(
    onlyBad,
    { ...w, sheet: 'Only Wandering' },
    [['Chatsworth Sporting CC', 'Umlazi CC', w.ground.moved]],
    [],
  );
  ws.getRow(8).values = ['Crusaders CC', 'v', 'Berea Rovers CC', '', '', w.ground.moved];
  await page.getByRole('button', { name: 'Choose another file' }).click();
  await upload(page, Buffer.from(await onlyBad.xlsx.writeBuffer()));
  await expect(errorAlert(page)).toHaveText('no fixture rows were recognised in the workbook');
  const onlySec = page.getByRole('region', { name: 'Sheet Only Wandering' });
  await expect(onlySec).toContainText('Sheet not read');
  await expect(onlySec).toContainText(
    "This sheet was left out: layout not recognised: the 'v' column varies (columns 2, 3).",
  );
  await expect(applyBtn(page)).toHaveCount(0);

  const after = await storedFixtures(request, w.seriesId);
  expect(after.version, 'nothing written').toBe(before.version);
});

test('an admin edit between preview and Apply is refused with the fresh preview (plan_changed)', async ({
  page,
  request,
}) => {
  const w = await seedWorld(request, 'race', 1);
  await openAmendments(page);
  await upload(page, await standardWorkbook(w));

  const changes = page.getByRole('table', { name: `Changes on ${w.sheet}` });
  const retimed = changes.getByRole('row', { name: /Chatsworth Sporting CC v Umlazi CC/ });
  await expect(retimed).toContainText('Time: 09:00 → 13:30');
  await expect(applyBtn(page)).toHaveText('Apply 2 changes');
  await expect(applyBtn(page)).toBeEnabled();

  // A concurrent admin moves Chatsworth v Umlazi to 10:00 through the admin PATCH.
  const cur = await getSeries(request, w.seriesId);
  const edit = await patchSeries(request, w.seriesId, {
    version: cur.version,
    fixtures: cur.fixtures.map((f) => (f.id === 'f2' ? { ...f, time: '10:00' } : f)),
  });
  expect(edit.ok(), `admin PATCH → ${edit.status()} ${await edit.text()}`).toBeTruthy();
  const edited = await storedFixtures(request, w.seriesId);

  const confirm = page.waitForResponse((r) => r.url().includes('/fixture-amendments/confirm'));
  await applyBtn(page).click();
  expect((await confirm).status()).toBe(409);

  await expect(
    page.locator('.toast', { hasText: 'The fixtures changed since your preview' }),
  ).toBeVisible();
  await expect(errorAlert(page)).toContainText(
    'The fixtures changed since your preview. Check the updated preview, then confirm again.',
  );
  // The fresh preview replaced the stale one: the row now starts from the live 10:00.
  await expect(retimed).toContainText('Time: 10:00 → 13:30');
  await expect(retimed).not.toContainText('Time: 09:00 → 13:30');

  // Nothing of the stale plan was written.
  const afterRefusal = await storedFixtures(request, w.seriesId);
  expect(afterRefusal.version).toBe(edited.version);
  const byId = (id: string) => afterRefusal.fixtures.find((f) => f.id === id)!;
  expect(byId('f2')).toMatchObject({ time: '10:00' });
  expect(byId('f3')).toMatchObject({ time: '09:00', venueOverride: w.ground.three });

  // The fresh preview confirms as is.
  await expect(applyBtn(page)).toBeEnabled();
  await applyBtn(page).click();
  await expect(page.locator('.insights-callout.good')).toContainText('Amended 2 fixtures.');
  const done = await storedFixtures(request, w.seriesId);
  expect(done.fixtures.find((f) => f.id === 'f2')).toMatchObject({ time: '13:30' });
});

test('a change onto a ground a released fixture holds blocks the whole upload', async ({
  page,
  request,
}) => {
  const w = await seedWorld(request, 'clash', 2);
  // Another released competition already plays at the "moved" ground at 13:30 that day.
  await createReleased(request, {
    name: `Amend Fail Holder ${RUN}`,
    startDate: w.date,
    fixtures: [
      {
        id: 'h1',
        round: 1,
        date: w.date,
        time: '13:30',
        home: 'phoenix',
        away: 'verulam',
        venueOverride: w.ground.moved,
      },
    ],
  });
  const before = await storedFixtures(request, w.seriesId);
  const buffer = await standardWorkbook(w);

  await openAmendments(page);
  await upload(page, buffer);

  const blockPanel = page.locator('.insights-callout.alert', { hasText: 'Blocked' });
  // One double-booking, listed once (the gate sees it from both fixtures' sides).
  await expect(blockPanel).toContainText(
    'Blocked — these amendments would introduce 1 venue clash.',
  );
  await expect(blockPanel).toContainText(`${w.date} 13:30 at ${w.ground.moved}`);
  await expect(blockPanel).toContainText('Crusaders CC v Berea Rovers CC');
  await expect(blockPanel).toContainText('Phoenix CC v Verulam CC');
  // A released fixture holds the ground: relocation can't clear it, so it isn't suggested.
  await expect(blockPanel).not.toContainText('draft relocation');
  await expect(applyBtn(page)).toHaveText('Apply 2 changes');
  await expect(applyBtn(page)).toBeDisabled();
  await expect(page.getByText('Resolve the blocking clash first.')).toBeVisible();

  // The server refuses the plan too, even with its own fresh hash.
  const pv = await request.post(
    `${API_BASE}/platform/tenants/${TENANT}/fixture-amendments/preview`,
    { headers: operator(), data: { filename: 'r.xlsx', dataBase64: buffer.toString('base64') } },
  );
  const { planHash } = (await pv.json()) as { planHash: string };
  const forced = await request.post(
    `${API_BASE}/platform/tenants/${TENANT}/fixture-amendments/confirm`,
    {
      headers: operator(),
      data: { filename: 'r.xlsx', dataBase64: buffer.toString('base64'), planHash },
    },
  );
  expect(forced.status()).toBe(409);
  expect(((await forced.json()) as { code: string }).code).toBe('clash_gate');
  expect((await storedFixtures(request, w.seriesId)).version, 'nothing written').toBe(
    before.version,
  );

  // Unticking the offending row lifts the block for the rest of the sheet.
  const moved = page
    .getByRole('table', { name: `Changes on ${w.sheet}` })
    .getByRole('row', { name: /Crusaders CC v Berea Rovers CC/ });
  await moved.getByRole('checkbox').uncheck();
  await expect(blockPanel).toHaveCount(0);
  await expect(applyBtn(page)).toHaveText('Apply 1 change');
  await expect(applyBtn(page)).toBeEnabled();
});

test('a change onto a ground a draft fixture holds relocates the draft when opted in', async ({
  page,
  request,
}) => {
  const w = await seedWorld(request, 'reloc', 3);
  // A DRAFT competition plays at the "moved" ground at 13:30 that day.
  const draft = await createSeries(request, {
    name: `Amend Fail Draft ${RUN}`,
    startDate: w.date,
    fixtures: [
      {
        id: 'd1',
        round: 1,
        date: w.date,
        time: '13:30',
        home: 'phoenix',
        away: 'verulam',
        venueOverride: w.ground.moved,
      },
    ],
  });
  const before = await storedFixtures(request, w.seriesId);

  await openAmendments(page);
  await upload(page, await standardWorkbook(w));

  // Without relocation: the draft's ground is a clash this upload would introduce.
  const blockPanel = page.locator('.insights-callout.alert', { hasText: 'Blocked' });
  await expect(blockPanel).toContainText(`${w.date} 13:30 at ${w.ground.moved}`);
  await expect(blockPanel).toContainText('Phoenix CC v Verulam CC');
  // A DRAFT holds the ground: the panel points at relocation.
  await expect(blockPanel).toContainText('turn on draft relocation below');
  await expect(applyBtn(page)).toBeDisabled();

  // Opt in: the page re-previews and lists the move.
  await page.getByLabel('Move clashing draft fixtures to another ground').check();
  const moves = page.getByRole('table', { name: 'Draft fixtures that will move' });
  const move = moves.getByRole('row', { name: /Phoenix CC v Verulam CC/ });
  await expect(move).toBeVisible();
  await expect(move.locator('td[data-label="From"]')).toHaveText(w.ground.moved);
  await expect(move.locator('td[data-label="Date"]')).toHaveText(w.date);
  await expect(move.locator('td[data-label="Ground taken by"]')).toContainText(
    'Crusaders CC v Berea Rovers CC',
  );
  const to = (await move.locator('td[data-label="To"]').innerText()).split('\n')[0].trim();
  expect(to).not.toBe('');
  expect(to).not.toBe(w.ground.moved);
  await expect(blockPanel).toHaveCount(0);
  await expect(applyBtn(page)).toHaveText('Apply 2 changes');
  await expect(applyBtn(page)).toBeEnabled();

  await applyBtn(page).click();
  // The draft move is reported apart from the two sheet amendments.
  await expect(page.locator('.insights-callout.good')).toContainText(
    'Amended 2 fixtures and moved 1 draft fixture.',
  );

  const after = await storedFixtures(request, w.seriesId);
  expect(after.version).toBeGreaterThan(before.version);
  expect(after.fixtures.find((f) => f.id === 'f3')).toMatchObject({
    time: '13:30',
    venueName: w.ground.moved,
  });
  const d1 = (await storedFixtures(request, draft.id)).fixtures.find((f) => f.id === 'd1')!;
  expect(d1.time).toBe('13:30');
  expect(d1.venueName ?? d1.venueOverride).toBe(to);
  expect(d1.venueName ?? d1.venueOverride).not.toBe(w.ground.moved);
});
