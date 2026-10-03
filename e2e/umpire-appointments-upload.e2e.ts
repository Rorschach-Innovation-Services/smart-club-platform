import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { API_BASE, RUN, adminAuthHeader, apiHeaders, signInAsAdmin } from './helpers';

/**
 * Admin "Upload appointments" end to end: the union's weekly sheet goes up from the Umpires
 * page, the server parses and matches it with the CLI's own code, the preview lists the
 * matched row, its venue/time difference and the umpire not on the panel; ticking "create
 * these umpires" re-plans, and Confirm writes the appointment the Fixtures table then shows.
 *
 * Seeds a run-unique Premier T20 series (on a run-unique date, so a reused stack's earlier
 * runs never make the row ambiguous); it stays as residue in the in-memory DB.
 */

const admin = () => apiHeaders(adminAuthHeader());
const SERIES_ID = `s-e2e-upload-${RUN}`;
// A day in 2027 picked from the clock, so repeated runs on one stack use different dates.
const DATE = new Date(Date.UTC(2027, 0, 1) + (Math.floor(Date.now() / 1000) % 300) * 86400_000)
  .toISOString()
  .slice(0, 10);
const KNOWN = `K.Known${RUN}`;
const NEWBIE = `N.Newbie${RUN}`;

async function workbook(): Promise<Buffer> {
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
  ws.getRow(2).values = [
    'Premier league T20',
    new Date(Date.UTC(Number(DATE.slice(0, 4)), Number(DATE.slice(5, 7)) - 1, 1)),
    'Saturday',
    new Date(Date.UTC(1899, 11, 30, 10, 30)),
    Number(DATE.slice(8)),
    'UKZN',
    'Crusaders',
    'Kingsmead Oval',
    KNOWN,
    NEWBIE,
  ];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('an appointments sheet is previewed, then written from the console', async ({
  page,
  request,
}) => {
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: SERIES_ID,
      name: `Upload E2E ${RUN}`,
      startDate: DATE,
      leagueKey: 'premier',
      maxOvers: 20,
      teams: ['ukzn', 'crusaders'],
      participants: [
        { teamId: 'ukzn', clubId: 'ukzn', name: 'UKZN CC', venue: 'Howard College Oval' },
        { teamId: 'crusaders', clubId: 'crusaders', name: 'Crusaders CC' },
      ],
      fixtures: [
        { id: 'f1', round: 1, date: DATE, time: '10:00', home: 'ukzn', away: 'crusaders' },
      ],
    },
  });
  expect(create.ok(), `POST /series → ${create.status()} ${await create.text()}`).toBeTruthy();
  const ump = await request.post(`${API_BASE}/umpires`, {
    headers: admin(),
    data: { displayName: KNOWN },
  });
  expect(ump.ok()).toBeTruthy();

  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Umpires' }).click();
  await page.getByRole('button', { name: 'Upload appointments' }).click();
  await expect(page.getByRole('heading', { name: /Upload appointments/ })).toBeVisible();

  await page.getByLabel(/Appointments workbook/).setInputFiles({
    name: 'runner.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await workbook(),
  });

  const matched = page.getByRole('table', { name: 'Matched rows' });
  const row = matched.getByRole('row', { name: /UKZN v Crusaders/ });
  await expect(row).toContainText('Not written');
  await expect(row).toContainText(`unknown umpire: ${NEWBIE}`);
  const diffs = page.getByRole('table', { name: 'Venue and time differences' });
  await expect(diffs.getByRole('row', { name: /Time/ })).toContainText('10:30');
  await expect(diffs.getByRole('row', { name: /Venue/ })).toContainText('Kingsmead Oval');
  await expect(page.getByRole('button', { name: /Write 0 appointments/ })).toBeDisabled();

  await page.getByRole('checkbox', { name: /Create these umpires/ }).check();
  await expect(row).toContainText('New');
  await page.getByRole('button', { name: 'Write 1 appointment and add 1 umpire' }).click();
  await expect(page.getByText(/Wrote 1 appointment, added 1 umpire/)).toBeVisible();

  // The appointment is stored, and the fixture's own time/venue were left alone.
  const series = await request.get(`${API_BASE}/series`, { headers: admin() });
  const f1 = (
    (await series.json()) as Array<{ id: string; fixtures: Array<Record<string, unknown>> }>
  )
    .find((s) => s.id === SERIES_ID)!
    .fixtures.find((f) => f.id === 'f1')!;
  expect((f1.officials as { umpires: Array<{ name: string }> }).umpires.map((u) => u.name)).toEqual(
    [KNOWN, NEWBIE],
  );
  expect(f1.time).toBe('10:00');
});
