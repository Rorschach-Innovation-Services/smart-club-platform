import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
  API_BASE,
  RUN,
  adminAuthHeader,
  apiHeaders,
  dismissOnboarding,
  getClubName,
  listPlayers,
  signInAsRep,
} from './helpers';

/**
 * Chair-led player registration from the club portal's Players page, end to end through the
 * REAL local stack. Every chair route runs the same clearance-aware core as the public
 * self-registration, so:
 *
 *   - the single Register-player form, declaring a previous ON-SYSTEM club, opens a clearance
 *     that both clubs see in their Clearances view;
 *   - the quick-add grid registers several players in one go and badges each row;
 *   - the spreadsheet upload starts from the downloadable template, annotates every parsed row
 *     with what committing it will do (new / already on your roster / clearance from X), and
 *     the summary counts what actually happened.
 *
 * The workbook is built in the spec from the template the page serves (exceljs), so the
 * template's headers are exercised exactly as a chair would use them.
 *
 * Shared DB, serial run: every name and RSA ID is RUN-unique, and the IDs are generated
 * Luhn-valid with a random birth date (no checksum-math fixtures that collide across runs).
 */
test.describe.configure({ mode: 'serial' });

const CHAIR_CLUB = 'tongaat';
const PREVIOUS_CLUB = 'verulam';
const OTHER_CLUB = 'ukzn';

/** A Luhn-valid 13-digit RSA ID for a random adult birth date (1975–1999). */
function rsaId(): string {
  const y = 1975 + Math.floor(Math.random() * 25);
  const m = 1 + Math.floor(Math.random() * 12);
  const d = 1 + Math.floor(Math.random() * 28);
  const seq = 5000 + Math.floor(Math.random() * 5000);
  const body = `${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}${seq}08`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let v = Number(body[11 - i]);
    if (i % 2 === 0) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** The ISO birth date an RSA ID encodes (these are all 19xx). */
const dobOf = (id: string) => `19${id.slice(0, 2)}-${id.slice(2, 4)}-${id.slice(4, 6)}`;

// RUN tokens are base36 — letters only keeps the names valid in every field.
const tag = RUN.replace(/[^a-z]/g, '').slice(0, 6) || 'run';
const SINGLE = { first: 'Sipho', last: `Single${tag}`, id: rsaId() };
const QUICK = [
  { first: 'Ann', last: `Quick${tag}`, id: rsaId() },
  { first: 'Ben', last: `Quick${tag}`, id: rsaId() },
];
const UPLOAD_NEW = { first: 'Cara', last: `Upload${tag}`, id: rsaId() };
const ELSEWHERE = { first: 'Dumi', last: `Elsewhere${tag}`, id: rsaId() };

interface Clearance {
  id: string;
  playerName: string;
  fromClubId: string;
  toClubId: string;
  status: string;
}

async function adminClearances(request: APIRequestContext): Promise<Clearance[]> {
  const res = await request.get(`${API_BASE}/admin/clearances`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  expect(res.ok(), `GET /admin/clearances → ${res.status()}`).toBeTruthy();
  return (await res.json()) as Clearance[];
}

/** An active player on another club's roster, registered with an RSA ID (admin route). */
async function seedActiveSaIdPlayer(
  request: APIRequestContext,
  clubId: string,
  p: { first: string; last: string; id: string },
): Promise<void> {
  const res = await request.post(`${API_BASE}/clubs/${clubId}/players`, {
    headers: apiHeaders(adminAuthHeader()),
    data: {
      firstName: p.first,
      lastName: p.last,
      idType: 'sa-id',
      idNumber: p.id,
      race: 'African',
      gender: 'Male',
      nationality: 'South African',
      cell: '0821234567',
      team: 'premier',
      district: 'Durban Central',
    },
  });
  expect(res.ok(), `seed ${clubId} player → ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function openPlayers(page: Page): Promise<void> {
  await signInAsRep(page, CHAIR_CLUB);
  await page.goto(`/club/${CHAIR_CLUB}/players`);
  await dismissOnboarding(page);
}

test('a single registration declaring an on-system previous club opens a clearance both clubs see', async ({
  page,
  request,
}) => {
  await openPlayers(page);
  await page.getByRole('button', { name: 'Register player' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Team').selectOption('premier');
  await dialog.getByLabel('First name(s)').fill(SINGLE.first);
  await dialog.getByLabel('Surname').fill(SINGLE.last);
  await dialog.getByLabel('ID number').fill(SINGLE.id);
  await dialog.getByLabel('Race').selectOption('African');
  await dialog.getByLabel('Gender').selectOption('Male');
  await dialog.getByLabel('Cell').fill('0821234567');
  // The previous-club list is the tenant directory, minus the chair's own club.
  const prev = dialog.getByLabel('Club last registered for');
  await expect(prev.locator(`option[value="${PREVIOUS_CLUB}"]`)).toHaveCount(1);
  await expect(prev.locator(`option[value="${CHAIR_CLUB}"]`)).toHaveCount(0);
  await prev.selectOption(PREVIOUS_CLUB);
  await dialog.getByRole('button', { name: /register player/i }).click();
  await expect(dialog).toHaveCount(0);

  const playerName = `${SINGLE.first} ${SINGLE.last}`;
  const clr = (await adminClearances(request)).find((c) => c.playerName === playerName);
  expect(clr, 'the registration should open a clearance').toBeTruthy();
  expect(clr).toMatchObject({ fromClubId: PREVIOUS_CLUB, toClubId: CHAIR_CLUB, status: 'pending' });
  const row = (await listPlayers(request, CHAIR_CLUB)).find((p) => p.lastName === SINGLE.last);
  expect(row?.status).toBe('clearance-pending');

  // Both clubs' Clearances views list it.
  await page.goto(`/club/${CHAIR_CLUB}/clearances`);
  await expect(page.getByText(playerName).first()).toBeVisible();
  await signInAsRep(page, PREVIOUS_CLUB);
  await page.goto(`/club/${PREVIOUS_CLUB}/clearances`);
  await dismissOnboarding(page);
  await expect(page.getByText(playerName).first()).toBeVisible();
});

test('the quick-add grid registers several players and badges each row', async ({
  page,
  request,
}) => {
  await openPlayers(page);
  await page.getByRole('button', { name: 'Quick add' }).click();
  const dialog = page.getByRole('dialog');
  for (const [i, p] of QUICK.entries()) {
    await dialog.getByLabel(`Row ${i + 1} first name`).fill(p.first);
    await dialog.getByLabel(`Row ${i + 1} surname`).fill(p.last);
    await dialog.getByLabel(`Row ${i + 1} ID number`).fill(p.id);
  }
  await dialog.getByRole('button', { name: 'Register 2 players' }).click();
  await expect(dialog.getByText('Registered', { exact: true })).toHaveCount(2);
  await expect(dialog.getByLabel('Row 1 first name')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  const roster = await listPlayers(request, CHAIR_CLUB);
  for (const p of QUICK) {
    const row = roster.find((r) => r.firstName === p.first && r.lastName === p.last);
    expect(row?.status, `${p.first} ${p.last} is on the roster`).toBe('active');
  }
});

test('a spreadsheet from the template is reviewed with conflict notes, then committed', async ({
  page,
  request,
}, testInfo) => {
  await seedActiveSaIdPlayer(request, OTHER_CLUB, ELSEWHERE);
  const otherName = await getClubName(request, OTHER_CLUB);

  await openPlayers(page);
  await page.getByRole('button', { name: 'Upload spreadsheet' }).click();
  const dialog = page.getByRole('dialog');

  // Step 1 — download the template the page links to and fill it in.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: /download template/i }).click(),
  ]);
  const templatePath = testInfo.outputPath('roster-template.xlsx');
  await download.saveAs(templatePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const sheet = wb.worksheets[0];
  const headerRow = sheet.getRow(1);
  const col: Record<string, number> = {};
  headerRow.eachCell((cell, n) => {
    col[String(cell.value).trim()] = n;
  });
  for (const h of [
    'Player First Name',
    'Player Surname',
    'ID Number',
    'Date of Birth',
    'Gender',
    'Race',
  ])
    expect(col[h], `template has a "${h}" column`).toBeTruthy();
  // Clear any example rows below the header, then write ours.
  for (let r = sheet.rowCount; r > 1; r--) sheet.spliceRows(r, 1);
  const rows = [UPLOAD_NEW, QUICK[0], ELSEWHERE];
  rows.forEach((p, i) => {
    const row = sheet.getRow(i + 2);
    row.getCell(col['Player First Name']).value = p.first;
    row.getCell(col['Player Surname']).value = p.last;
    row.getCell(col['ID Number']).value = p.id;
    row.getCell(col['Date of Birth']).value = dobOf(p.id);
    row.getCell(col['Gender']).value = 'Male';
    row.getCell(col['Race']).value = 'African';
    row.commit();
  });
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  // Step 2 — upload and parse.
  await dialog.getByLabel('Roster workbook').setInputFiles({
    name: 'roster.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  await dialog.getByRole('button', { name: 'Read workbook' }).click();

  // Step 3 — the review says what each row will do.
  await expect(dialog.getByText(/3 player rows found/)).toBeVisible();
  const reviewRow = (p: { first: string; last: string }) =>
    dialog.locator('tr', { hasText: `${p.first} ${p.last}` });
  await expect(reviewRow(UPLOAD_NEW).getByText('New registration')).toBeVisible();
  await expect(reviewRow(QUICK[0]).getByText('Already on your roster')).toBeVisible();
  await expect(
    reviewRow(ELSEWHERE).getByText(`Will open a clearance from ${otherName}`),
  ).toBeVisible();
  // The duplicate is left out by default.
  await expect(dialog.getByLabel(`Include ${QUICK[0].first} ${QUICK[0].last}`)).not.toBeChecked();

  await dialog.getByRole('button', { name: 'Register 2 players' }).click();
  await expect(dialog.getByText('Upload complete')).toBeVisible();
  await expect(dialog.getByText('1 registered, 1 clearance opened')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  const roster = await listPlayers(request, CHAIR_CLUB);
  const statusOf = (p: { first: string; last: string }) =>
    roster.find((r) => r.firstName === p.first && r.lastName === p.last)?.status;
  expect(statusOf(UPLOAD_NEW)).toBe('active');
  expect(statusOf(ELSEWHERE)).toBe('clearance-pending');
  // The duplicate stayed a single row.
  expect(
    roster.filter((r) => r.lastName === QUICK[0].last && r.firstName === QUICK[0].first),
  ).toHaveLength(1);

  const clr = (await adminClearances(request)).find(
    (c) => c.playerName === `${ELSEWHERE.first} ${ELSEWHERE.last}`,
  );
  expect(clr).toMatchObject({ fromClubId: OTHER_CLUB, toClubId: CHAIR_CLUB, status: 'pending' });
});
