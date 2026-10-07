import { test, expect, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { API_BASE, RUN, TENANT, adminAuthHeader, apiHeaders, operatorIdentity } from './helpers';
import { createReleased, getSeries, openAdminSeries } from './fixtures-helpers';

/**
 * Operator "Fixture amendments" end to end: the union's weekly reminder sheet goes up from
 * the operator console, the server parses + matches it with the CLI's own code, and the
 * preview lists the venue/time diffs (and the umpire appointments on touched fixtures).
 * Unticking a row re-previews without it; ticking it back and applying writes the changes,
 * which the admin Fixtures page then shows. Uploading the SAME sheet again is all no-op.
 *
 * Seeds (through the real API, RUN-unique so a reused stack's residue never interferes):
 *   - three registry grounds, and a released series of three fixtures on one 2028 day, each
 *     at its own ground at 09:00;
 *   - an umpire appointed to the fixture whose venue will change.
 * The workbook is generated here with exceljs in the KZNCU reminder layout (title, competition
 * heading, Group line, a dated 09:00 "Venue:" block, then a 13:30 restatement block).
 */

const admin = () => apiHeaders(adminAuthHeader());
// A 2028 day picked from the clock: the other fixture specs live in 2027, and repeated runs
// on one stack land on different days, so the tenant-wide clash ledger stays empty.
const DATE = new Date(Date.UTC(2028, 0, 1) + (Math.floor(Date.now() / 1000) % 300) * 86400_000)
  .toISOString()
  .slice(0, 10);
const COMPETITION = `Amend E2E ${RUN}`;
const SERIES_NAME = `${COMPETITION} · T20`;
const SHEET = 'E2E Reminder Fixtures';
const GROUND = {
  one: `E2E Amend One ${RUN}`,
  two: `E2E Amend Two ${RUN}`,
  three: `E2E Amend Three ${RUN}`,
  moved: `E2E Amend Moved ${RUN}`,
};
const UMPIRE = `A.Amend${RUN}`;

type SheetRow = [home: string, away: string, venue: string];

/**
 * The reminder sheet, as a .xlsx buffer:
 *   09:00 block — UKZN v Clares at its own ground (already correct)
 *   13:30 block — Chatsworth v Umlazi at its own ground (time 09:00 → 13:30)
 *               — Crusaders v Berea at a new ground (time + venue change)
 */
async function reminderWorkbook(): Promise<Buffer> {
  const early: SheetRow[] = [['UKZN CC', 'Clares CC', GROUND.one]];
  const late: SheetRow[] = [
    ['Chatsworth Sporting CC', 'Umlazi CC', GROUND.two],
    ['Crusaders CC', 'Berea Rovers CC', GROUND.moved],
  ];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);
  const t = (h: number, m: number) => new Date(Date.UTC(1899, 11, 30, h, m));
  const rows: unknown[][] = [
    [`Reminder Fixtures: ${DATE}`],
    [],
    [`${COMPETITION}: T20`],
    [],
    ['Group A:'],
    ['Week 1 Fixtures', '', '', t(9, 0), new Date(`${DATE}T00:00:00Z`), 'Venue:'],
    ...early.map(([h, a, v]) => [h, '', 'v', '', a, v]),
    ['', '', '', t(13, 30)],
    ...late.map(([h, a, v]) => [h, '', 'v', '', a, v]),
  ];
  rows.forEach((r, i) => {
    if (r.length) ws.getRow(i + 1).values = r as ExcelJS.CellValue[];
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Operator with admin on the default tenant (the cloud shape: operators are auto-admins). */
async function signInAsOperator(page: Page) {
  await page.addInitScript(
    (identity) => {
      localStorage.setItem('smartclub.devAuth', JSON.stringify(identity));
    },
    operatorIdentity([TENANT]),
  );
}

async function uploadSheet(page: Page, buffer: Buffer) {
  await page.getByLabel(/Reminder fixtures workbook/).setInputFiles({
    name: 'reminder.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
}

/** The value under a preview stat tile ("Will be changed", "Already correct", ...). */
const stat = (page: Page, label: string) =>
  page.locator('.mcs-stat', { hasText: label }).locator('.mcs-stat-value');

test('a reminder sheet is previewed, trimmed, applied, and re-uploads as a no-op', async ({
  page,
  request,
}) => {
  for (const [key, name] of Object.entries(GROUND)) {
    const res = await request.put(`${API_BASE}/venues/e2e-amend-${key}-${RUN}`, {
      headers: admin(),
      data: { name },
    });
    expect(res.ok(), `PUT /venues → ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  const series = await createReleased(request, {
    name: SERIES_NAME,
    startDate: DATE,
    fixtures: [
      { id: 'f1', round: 1, date: DATE, time: '09:00', home: 'ukzn', away: 'clares' },
      { id: 'f2', round: 1, date: DATE, time: '09:00', home: 'chatsworth', away: 'umlazi' },
      { id: 'f3', round: 1, date: DATE, time: '09:00', home: 'crusaders', away: 'berea' },
    ].map((f, i) => ({ ...f, venueOverride: [GROUND.one, GROUND.two, GROUND.three][i] })),
  });
  expect(series.released).toBe(true);
  const ump = await request.post(`${API_BASE}/umpires`, {
    headers: admin(),
    data: { displayName: UMPIRE },
  });
  expect(ump.ok(), `POST /umpires → ${ump.status()} ${await ump.text()}`).toBeTruthy();
  const umpireId = ((await ump.json()) as { id: string }).id;
  const appoint = await request.put(`${API_BASE}/series/${series.id}/fixtures/f3/officials`, {
    headers: admin(),
    data: { umpires: [{ umpireId }] },
  });
  expect(appoint.ok(), `PUT officials → ${appoint.status()} ${await appoint.text()}`).toBeTruthy();

  const sheet = await reminderWorkbook();

  // ── Operator console → client settings → Fixture amendments ──
  await signInAsOperator(page);
  await page.goto(`/platform/tenants/${TENANT}?tenant=${TENANT}`);
  await page.getByRole('button', { name: 'Upload sheet' }).click();
  await expect(page).toHaveURL(new RegExp(`/platform/tenants/${TENANT}/fixture-amendments`));
  await expect(page.getByRole('heading', { name: /Fixture amendments/ })).toBeVisible();

  // ── Preview: two diffs, one already-correct row, the umpire to re-check ──
  await uploadSheet(page, sheet);
  const changes = page.getByRole('table', { name: `Changes on ${SHEET}` });
  const retimed = changes.getByRole('row', { name: /Chatsworth Sporting CC v Umlazi CC/ });
  const moved = changes.getByRole('row', { name: /Crusaders CC v Berea Rovers CC/ });
  await expect(retimed).toContainText('Time: 09:00 → 13:30');
  await expect(moved).toContainText('Time: 09:00 → 13:30');
  await expect(moved).toContainText(`Venue: ${GROUND.three} → ${GROUND.moved}`);
  await expect(stat(page, 'Will be changed')).toHaveText('2');
  await expect(stat(page, 'Already correct')).toHaveText('1');
  await expect(stat(page, 'Need attention')).toHaveText('0');
  await expect(page.getByRole('region', { name: 'Umpire appointments affected' })).toContainText(
    `Crusaders CC v Berea Rovers CC: ${UMPIRE}`,
  );
  const apply = (n: number) =>
    page.getByRole('button', { name: `Apply ${n} change${n === 1 ? '' : 's'}` });
  await expect(apply(2)).toBeEnabled();

  // ── Untick a row: the server re-plans without it ──
  const retimedBox = retimed.getByRole('checkbox');
  await retimedBox.uncheck();
  await expect(apply(1)).toBeEnabled();
  await expect(retimed).toContainText('Left as it is');
  await expect(stat(page, 'Will be changed')).toHaveText('1');
  // Tick it back so the whole sheet applies (the re-upload below must then be all no-op).
  await retimedBox.check();
  await expect(apply(2)).toBeEnabled();
  await expect(retimed).not.toContainText('Left as it is');

  // ── Confirm ──
  await apply(2).click();
  await expect(page.locator('.insights-callout.good')).toContainText('Amended 2 fixtures.');
  const written = page.getByRole('table', { name: 'Competitions written' });
  await expect(written.getByRole('row', { name: new RegExp(SERIES_NAME) })).toContainText(
    'Written',
  );
  await expect(page.getByText(/Clubs have NOT been notified/)).toBeVisible();

  // The stored fixtures carry the sheet's values; the untouched one is left alone.
  const after = (await getSeries(request, series.id)).fixtures as unknown as Array<
    Record<string, unknown>
  >;
  const byId = (id: string) => after.find((f) => f.id === id)!;
  expect(byId('f1')).toMatchObject({ time: '09:00', venueOverride: GROUND.one });
  expect(byId('f2')).toMatchObject({ time: '13:30' });
  expect(byId('f3')).toMatchObject({ time: '13:30', venueName: GROUND.moved });

  // ── Re-upload the same sheet: everything already correct, nothing to apply ──
  await page.getByRole('button', { name: 'Upload another sheet' }).click();
  await uploadSheet(page, sheet);
  await expect(stat(page, 'Already correct')).toHaveText('3');
  await expect(stat(page, 'Will be changed')).toHaveText('0');
  await expect(page.getByRole('table', { name: `Changes on ${SHEET}` })).toHaveCount(0);
  await expect(page.getByText('Nothing to change from this sheet.')).toBeVisible();
  await expect(apply(0)).toBeDisabled();

  // ── The admin Fixtures page shows the new time and ground ──
  await openAdminSeries(page, SERIES_NAME);
  const row = page.locator('tbody tr', { hasText: 'Crusaders CC' });
  await expect(row.locator('.fix-row-time')).toHaveText('13:30');
  await expect(row.locator('.fix-row-venue-name')).toContainText(GROUND.moved);
  await expect(
    page.locator('tbody tr', { hasText: 'Chatsworth Sporting CC' }).locator('.fix-row-time'),
  ).toHaveText('13:30');
});
