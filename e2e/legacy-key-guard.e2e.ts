import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
  API_BASE,
  RUN,
  TENANT,
  dismissOnboarding,
  getClubName,
  listPlayers,
  mintRegLink,
  signInAsRep,
} from './helpers';

/**
 * The registration ID-number dedup guard (duplicate remediation, Phase 3), end to end on the REAL
 * local stack. A person whose RSA ID is already rostered under a LEGACY (non-sha256) natural key
 * must not get a second row:
 *
 *   - public /register: the browser sees the SAME generic 409 copy as any duplicate (no club
 *     named — the page is unauthenticated), and the API body is byte-identical to the generic one;
 *   - chair single Register-player: the dialog names the club holding the legacy row;
 *   - chair quick-add: the legacy-ID row errors, the clean row in the same batch is registered;
 *   - chair spreadsheet upload: the review step, then the commit summary, for a legacy-ID row.
 *
 * Legacy rows are seeded by a DIRECT table put (as a pre-sha256 import left them): no API route
 * can create a non-sha key any more. The table is the local stack's dynalite (SmartClubLocal on
 * :4567 — remapped by e2e/support/port-remap.mjs under playwright.altports.config.ts).
 */
test.describe.configure({ mode: 'serial' });

const CHAIR_CLUB = 'tongaat';
const LEGACY_AT = 'verulam';
const PUBLIC_LINK = 'berea';
const UPLOAD_LEGACY_AT = 'ukzn';

/** A Luhn-valid 13-digit RSA ID for a random adult birth date (chair-registration.e2e.ts). */
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
const dobOf = (id: string) => `19${id.slice(0, 2)}-${id.slice(2, 4)}-${id.slice(4, 6)}`;

const tag = RUN.replace(/[^a-z]/g, '').slice(0, 6) || 'run';
const PUBLIC = { first: 'Pub', last: `Publegacy${tag}`, id: rsaId() };
const SINGLE = { first: 'Sol', last: `Singlelegacy${tag}`, id: rsaId() };
const QUICK_LEGACY = { first: 'Qlee', last: `Quicklegacy${tag}`, id: rsaId() };
const QUICK_CLEAN = { first: 'Qcln', last: `Quickclean${tag}`, id: rsaId() };
const UPLOAD_LEGACY = { first: 'Ulee', last: `Uploadlegacy${tag}`, id: rsaId() };
const UPLOAD_CLEAN = { first: 'Ucln', last: `Uploadclean${tag}`, id: rsaId() };

/** Put a pre-sha256 player row (natural key = a name/dob slug) straight into the table. */
async function putLegacyRow(clubId: string, p: { first: string; last: string; id: string }) {
  const { DynamoDBClient, PutItemCommand } = createRequire(
    path.resolve('packages/api/package.json'),
  )('@aws-sdk/client-dynamodb') as typeof import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({
    endpoint: 'http://localhost:4567',
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const slug = `${p.first}-${p.last}-${dobOf(p.id)}`.toLowerCase();
  const S = (v: string) => ({ S: v });
  await ddb.send(
    new PutItemCommand({
      TableName: 'SmartClubLocal',
      Item: {
        pk: S(`TENANT#${TENANT}#CLUB#${clubId}`),
        sk: S(`PLAYER#${slug}`),
        naturalKey: S(slug),
        clubId: S(clubId),
        firstName: S(p.first),
        lastName: S(p.last),
        dob: S(dobOf(p.id)),
        idType: S('sa-id'),
        idNumber: S(p.id),
        status: S('active'),
        team: S('premier'),
        isMinor: { BOOL: false },
        consentAt: S('2024-02-01T00:00:00.000Z'),
        createdAt: S('2024-02-01T00:00:00.000Z'),
        version: { N: '0' },
      },
    }),
  );
  return slug;
}

const rowsNamed = async (request: APIRequestContext, clubId: string, last: string) =>
  (await listPlayers(request, clubId)).filter((r) => r.lastName === last);

async function openPlayers(page: Page): Promise<void> {
  await signInAsRep(page, CHAIR_CLUB);
  await page.goto(`/club/${CHAIR_CLUB}/players`);
  await dismissOnboarding(page);
}

/** A public sa-id registration body (local/ ID-doc key: the route skips the S3 ownership check). */
const publicBody = (p: { first: string; last: string; id: string }) => ({
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
  lastClub: '—',
  idDocMeta: {
    objectKey: `local/${TENANT}/legacy-guard-${RUN}-${p.last}.png`,
    size: 100,
    contentType: 'image/png',
  },
});

test.beforeAll(async () => {
  await putLegacyRow(LEGACY_AT, PUBLIC);
  await putLegacyRow(LEGACY_AT, SINGLE);
  await putLegacyRow(CHAIR_CLUB, QUICK_LEGACY);
  await putLegacyRow(UPLOAD_LEGACY_AT, UPLOAD_LEGACY);
});

test('public /register: a legacy-key ID gets the generic 409 — same copy, same body, no new row', async ({
  page,
  request,
}) => {
  const token = await mintRegLink(request, PUBLIC_LINK);

  // API contract first: the legacy-key refusal body equals an ordinary duplicate's body.
  const legacyRes = await request.post(
    `${API_BASE}/register/${PUBLIC_LINK}?t=${encodeURIComponent(token)}`,
    {
      headers: { 'content-type': 'application/json', 'x-tenant': TENANT },
      data: publicBody(PUBLIC),
    },
  );
  expect(legacyRes.status()).toBe(409);
  const legacyBody = await legacyRes.text();
  const dup = { first: 'Dup', last: `Plain${tag}`, id: rsaId() };
  const first = await request.post(
    `${API_BASE}/register/${PUBLIC_LINK}?t=${encodeURIComponent(token)}`,
    { headers: { 'content-type': 'application/json', 'x-tenant': TENANT }, data: publicBody(dup) },
  );
  expect(first.status(), await first.text()).toBe(201);
  const again = await request.post(
    `${API_BASE}/register/${PUBLIC_LINK}?t=${encodeURIComponent(token)}`,
    { headers: { 'content-type': 'application/json', 'x-tenant': TENANT }, data: publicBody(dup) },
  );
  expect(again.status()).toBe(409);
  expect(legacyBody, 'legacy-key 409 is byte-identical to the generic duplicate 409').toBe(
    await again.text(),
  );
  expect(legacyBody).not.toContain(await getClubName(request, LEGACY_AT));

  // Browser: the person fills the real form. Nothing is stubbed: the ID document goes through
  // the real local-mode presign and is PUT to the stack's /local-uploads sink, then the
  // registration POST runs for real.
  const presigned = page.waitForResponse(
    (r) => /\/register\/[^/]+\/id-doc\/upload-url/.test(r.url()) && r.request().method() === 'POST',
  );
  const uploaded = page.waitForResponse(
    (r) => r.url().includes('/local-uploads/local/') && r.request().method() === 'PUT',
  );

  await page.goto(`/register/${PUBLIC_LINK}?t=${encodeURIComponent(token)}`);
  await page.getByLabel(/^District/).selectOption({ index: 1 });
  const team = page.getByLabel(/^Team/);
  await team.selectOption({ index: 1 });
  await page.getByLabel(/^Surname/).fill(PUBLIC.last);
  await page.getByLabel(/^First name/).fill(PUBLIC.first);
  await page.getByLabel(/^ID number/).fill(PUBLIC.id);
  await page.getByLabel(/^Race/).selectOption('African');
  await page.getByLabel(/^Gender/).selectOption('Male');
  await page.getByLabel(/^Phone/).fill('0821234567');
  const prev = page.getByLabel(/for which last registered/);
  if (await prev.count()) await prev.selectOption('__first__');
  await page.locator('#reg-id-file').setInputFiles({
    name: 'id.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 e2e'),
  });
  await page.getByRole('checkbox', { name: /I request to register/ }).check();
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  const presign = await presigned;
  expect(presign.status(), await presign.text()).toBe(200);
  const { uploadUrl, objectKey } = (await presign.json()) as {
    uploadUrl: string;
    objectKey: string;
  };
  expect(objectKey).toMatch(new RegExp(`^local/${TENANT}/[^/]+/reg-[0-9a-f-]+-id\\.pdf$`));
  expect(uploadUrl).toContain(`/local-uploads/${objectKey}`);
  const put = await uploaded;
  expect(put.ok(), `local upload PUT answered ${put.status()}`).toBe(true);

  await expect(
    page.getByText('This person is already registered, or a transfer is already in progress.'),
  ).toBeVisible();
  // Still on the form (no success screen), and the club holding the legacy row is not named.
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeVisible();
  // (The club list in the previous-club picker names every club, so the check is on the
  // message itself: it is the fixed generic sentence and nothing else.)
  const legacyName = await getClubName(request, LEGACY_AT);
  const msg = page.getByText(/already registered, or a transfer/);
  await expect(msg).not.toContainText(legacyName);
  await page.screenshot({ path: test.info().outputPath('public-409.png'), fullPage: true });

  // Nothing written: no row at the link club, the legacy row is the only one.
  expect(await rowsNamed(request, PUBLIC_LINK, PUBLIC.last)).toHaveLength(0);
  expect(await rowsNamed(request, LEGACY_AT, PUBLIC.last)).toHaveLength(1);
});

test('chair single register: the dialog names the club holding the legacy-key row', async ({
  page,
  request,
}) => {
  const legacyClub = await getClubName(request, LEGACY_AT);
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
  await dialog.getByLabel('Club last registered for').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: /register player/i }).click();

  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText(
    `This ID is already registered at ${legacyClub} under an older record.`,
  );
  await expect(alert).toContainText(
    'Ask the union office to resolve the duplicate before registering this player.',
  );
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('chair-single.png'), fullPage: true });

  expect(await rowsNamed(request, CHAIR_CLUB, SINGLE.last)).toHaveLength(0);
});

test('chair quick-add: the legacy-ID row errors, the clean row is registered', async ({
  page,
  request,
}) => {
  await openPlayers(page);
  await page.getByRole('button', { name: 'Quick add' }).click();
  const dialog = page.getByRole('dialog');
  for (const [i, p] of [QUICK_LEGACY, QUICK_CLEAN].entries()) {
    await dialog.getByLabel(`Row ${i + 1} first name`).fill(p.first);
    await dialog.getByLabel(`Row ${i + 1} surname`).fill(p.last);
    await dialog.getByLabel(`Row ${i + 1} ID number`).fill(p.id);
  }
  await dialog.getByRole('button', { name: 'Register 2 players' }).click();
  await expect(dialog.getByText('Registered', { exact: true })).toHaveCount(1);
  // The Result cell carries the short form in its pill and the full chair-facing reason as a
  // visible note under it (a hover title alone is unreachable on touch and keyboard).
  const rowError = dialog.getByText(/under an older record — union office must resolve/);
  await expect(rowError).toBeVisible();
  await expect(
    dialog.getByRole('note').filter({ hasText: 'Ask the union office to resolve the duplicate' }),
  ).toHaveCount(1);
  // Where the reason lands relative to what the chair can see without scrolling the grid.
  const errBox = await rowError.boundingBox();
  const vp = page.viewportSize();
  test.info().annotations.push({
    type: 'quick-add-error-position',
    description: `error box x=${Math.round(errBox?.x ?? -1)} w=${Math.round(errBox?.width ?? -1)} viewport w=${vp?.width}`,
  });
  // The errored row stays editable (only settled rows lock); the registered one locks.
  await expect(dialog.getByLabel('Row 1 first name')).toBeEnabled();
  await expect(dialog.getByLabel('Row 2 first name')).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('quick-add.png'), fullPage: true });

  const clean = await rowsNamed(request, CHAIR_CLUB, QUICK_CLEAN.last);
  expect(clean.map((r) => r.status)).toEqual(['active']);
  // Only the seeded legacy row for that person — no second row minted.
  const legacy = await rowsNamed(request, CHAIR_CLUB, QUICK_LEGACY.last);
  expect(legacy).toHaveLength(1);
  expect(legacy[0].naturalKey).not.toMatch(/^[0-9a-f]{64}$/);
});

test('roster upload: the review flags a legacy-ID row and leaves it out; the clean row is registered', async ({
  page,
  request,
}, testInfo) => {
  const legacyClub = await getClubName(request, UPLOAD_LEGACY_AT);
  await openPlayers(page);
  await page.getByRole('button', { name: 'Upload spreadsheet' }).click();
  const dialog = page.getByRole('dialog');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: /download template/i }).click(),
  ]);
  const templatePath = testInfo.outputPath('roster-template.xlsx');
  await download.saveAs(templatePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const sheet = wb.worksheets[0];
  const col: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, n) => {
    col[String(cell.value).trim()] = n;
  });
  for (let r = sheet.rowCount; r > 1; r--) sheet.spliceRows(r, 1);
  [UPLOAD_LEGACY, UPLOAD_CLEAN].forEach((p, i) => {
    const row = sheet.getRow(i + 2);
    row.getCell(col['Player First Name']).value = p.first;
    row.getCell(col['Player Surname']).value = p.last;
    row.getCell(col['ID Number']).value = p.id;
    row.getCell(col['Date of Birth']).value = dobOf(p.id);
    row.getCell(col['Gender']).value = 'Male';
    row.getCell(col['Race']).value = 'African';
    row.commit();
  });
  await dialog.getByLabel('Roster workbook').setInputFiles({
    name: 'roster.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  });
  await dialog.getByRole('button', { name: 'Read workbook' }).click();
  await expect(dialog.getByText(/2 player rows found/)).toBeVisible();

  // Review step: record what the chair is told about the legacy-ID row BEFORE committing.
  const reviewRow = dialog.locator('tr', {
    hasText: `${UPLOAD_LEGACY.first} ${UPLOAD_LEGACY.last}`,
  });
  const reviewNote = (await reviewRow.innerText()).replace(/\s+/g, ' ');
  testInfo.annotations.push({ type: 'review-note-for-legacy-row', description: reviewNote });
  await page.screenshot({ path: testInfo.outputPath('upload-review.png'), fullPage: true });

  // UI1: /roster/parse consults the ID index, so the review already says what the commit would
  // refuse — the row is flagged (short form + the full reason as a note) and starts excluded.
  expect(reviewNote).toMatch(new RegExp(`Already at ${legacyClub} under an older record`, 'i'));
  expect(reviewNote).not.toMatch(/new registration/i);
  await expect(
    reviewRow
      .getByRole('note')
      .filter({ hasText: 'Ask the union office to resolve the duplicate' }),
  ).toBeVisible();

  await dialog.getByRole('button', { name: /Register 1 player\b/ }).click();
  await expect(dialog.getByText('Upload complete')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('upload-summary.png'), fullPage: true });

  expect(await rowsNamed(request, CHAIR_CLUB, UPLOAD_CLEAN.last)).toHaveLength(1);
  expect(await rowsNamed(request, CHAIR_CLUB, UPLOAD_LEGACY.last)).toHaveLength(0);
});
