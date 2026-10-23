import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_BASE,
  RUN,
  TENANT,
  adminAuthHeader,
  apiHeaders,
  createActivePlayer,
  dismissOnboarding,
  getPlayerByName,
  mintRegLink,
  openClearancesFilteredTo,
  operatorAuth,
  registerViaApi,
  repAuthHeader,
  seedRegistrationClearance,
  signInAsRep,
  signInAsAdmin,
  uniqueIdNumber,
} from './helpers';

/**
 * Per-tenant registration windows (ADR 0017, revised — the HARD gate), end to end through the
 * REAL local stack:
 *
 *  a. while unrestricted, a genuine pending transfer clearance is seeded (the queue fixture);
 *  b. the operator saves a FUTURE window, which closes registration today;
 *  c. the public page is a full closed page; the register POST and the ID-doc presign both 409,
 *     and nothing — no player, no clearance — is recorded;
 *  d. a rep's clearance request is refused with the same message;
 *  e. the admin console says "Registration closed", disables Override & approve and Send
 *     reminder, but still rejects;
 *  f. reopening the rejected clearance parks the player as clearance pending;
 *  g. the source club cannot issue while closed;
 *  h. the operator opens a CURRENT window and the source club issues: the freeze lifts.
 *
 * The spec edits the shared demo tenant's windows, so it snapshots them first and restores them
 * in afterAll. Every name is run-unique, so leftovers never collide with other specs.
 */
test.describe.configure({ mode: 'serial' });

interface TransferWindow {
  label: string;
  start: string;
  end: string;
}

// Spartan (source) → Harlequins (destination): both 'complete' demo clubs no other clearance
// spec uses, so their queues are this spec's own.
const FROM = { id: 'spartan', name: 'Spartan Sporting CC' };
const TO = { id: 'harlequins', name: 'Harlequins CC' };
const WINDOW: TransferWindow = {
  label: `E2E window ${RUN}`,
  start: '2099-01-01',
  end: '2099-01-31',
};
const CURRENT: TransferWindow = {
  label: `E2E open window ${RUN}`,
  start: '2000-01-01',
  end: '2099-12-31',
};
const CLOSED_MSG = `player registration is closed — next window: ${WINDOW.label} (${WINDOW.start} – ${WINDOW.end})`;

const operatorHeaders = apiHeaders(operatorAuth());
const adminHeaders = apiHeaders(adminAuthHeader());

async function operatorWindows(request: APIRequestContext): Promise<TransferWindow[]> {
  const res = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operatorHeaders,
  });
  expect(res.ok(), `GET /platform/tenants/${TENANT} → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { transferWindows?: TransferWindow[] }).transferWindows ?? [];
}

async function putWindows(request: APIRequestContext, windows: TransferWindow[]) {
  const res = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operatorHeaders,
    data: { transferWindows: windows },
  });
  expect(res.ok(), `PUT transferWindows → ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function signInAsOperator(page: Page): Promise<void> {
  await page.goto('/');
  const picker = page.locator('select.field-select').first();
  await expect(picker).toBeVisible();
  await picker.selectOption('operator');
  await page.getByRole('button', { name: 'Enter as operator' }).click();
}

async function clearanceNames(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(`${API_BASE}/admin/clearances`, { headers: adminHeaders });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as Array<{ playerName: string }>).map((c) => c.playerName);
}

let prior: TransferWindow[] = [];

test.beforeAll(async ({ request }) => {
  prior = await operatorWindows(request);
  // Start unrestricted, so the operator's save is what closes registration.
  await putWindows(request, []);
});

test.afterAll(async ({ request }) => {
  await putWindows(request, prior);
});

// Shared across the serial block: the queue fixture seeded while unrestricted.
const queuedName = `WindowQueued-${RUN}`;
// A player active at FROM, created while unrestricted (adding a player is gated too), whom TO's
// rep later tries to request.
const repName = `WindowRep-${RUN}`;
let repIdNumber = '';

test('while unrestricted, a transfer clearance is seeded and a player is added', async ({
  request,
}) => {
  // Case C registration clearance: the player registers into TO naming FROM, which holds no row.
  const clr = await seedRegistrationClearance(request, {
    linkClub: TO.id,
    prevClub: FROM.id,
    name: queuedName,
  });
  expect(clr.status).toBe('pending');
  expect((await getPlayerByName(request, TO.id, queuedName))?.status).toBe('clearance-pending');
  repIdNumber = (await createActivePlayer(request, FROM.id, { name: repName })).idNumber;
});

test('the operator saves a future window, which closes registration today', async ({
  page,
  request,
}) => {
  await signInAsOperator(page);
  await page.goto(`/platform/tenants/${TENANT}`);
  const card = page.locator('.card', { hasText: 'Transfer windows' });
  await expect(card).toBeVisible();
  const save = card.getByRole('button', { name: 'Save transfer windows' });
  await expect(save).toBeDisabled();

  await card.getByRole('button', { name: 'Add window' }).click();
  const row = card.getByRole('group', { name: 'Window 1' });
  await row.getByLabel('Name').fill(WINDOW.label);
  await row.getByLabel('Opens').fill(WINDOW.start);
  await row.getByLabel('Closes').fill(WINDOW.end);
  await save.click();

  await expect(page.locator('.toast', { hasText: 'Transfer windows saved' })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(await operatorWindows(request)).toEqual([WINDOW]);

  const tenant = await request.get(`${API_BASE}/tenant`, { headers: { 'x-tenant': TENANT } });
  expect(tenant.ok()).toBeTruthy();
  expect(
    ((await tenant.json()) as { transferWindowStatus?: unknown }).transferWindowStatus,
  ).toMatchObject({ open: false, next: WINDOW });
});

test('the public registration page is closed and nothing can be submitted or recorded', async ({
  page,
  request,
}) => {
  const token = await mintRegLink(request, TO.id);

  await page.goto(`/register/${TO.id}?t=${encodeURIComponent(token)}`);
  await expect(page.getByRole('heading', { name: 'Player registration is closed' })).toBeVisible();
  await expect(page.getByText('Nothing has been submitted or recorded')).toBeVisible();
  await expect(page.getByText(WINDOW.label, { exact: true })).toBeVisible();
  // A full page before the form: nothing to fill in, nothing to upload.
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('input, select, textarea')).toHaveCount(0);

  // A brand-new player: refused with the structured 409, and not on the roster.
  const freshName = `WindowFresh-${RUN}`;
  const fresh = await registerViaApi(request, TO.id, token, {
    name: freshName,
    idNumber: uniqueIdNumber(),
  });
  expect(fresh.status(), await fresh.text()).toBe(409);
  expect(await fresh.json()).toMatchObject({
    error: CLOSED_MSG,
    transferWindow: { closed: true, nextWindow: WINDOW },
  });
  expect(await getPlayerByName(request, TO.id, freshName)).toBeUndefined();

  // A transfer attempt: refused too, and — unlike the old auto-reject — no clearance row.
  const moverName = `WindowMover-${RUN}`;
  const mover = await registerViaApi(request, TO.id, token, {
    name: moverName,
    idNumber: uniqueIdNumber(),
    lastClubId: FROM.id,
  });
  expect(mover.status(), await mover.text()).toBe(409);
  expect(await mover.json()).toMatchObject({ error: CLOSED_MSG, transferWindow: { closed: true } });
  expect(await getPlayerByName(request, TO.id, moverName)).toBeUndefined();
  expect(await clearanceNames(request)).not.toContain(`Test ${moverName}`);

  // The ID-document presign is refused as well, so no object can be orphaned.
  const presign = await request.post(
    `${API_BASE}/register/${TO.id}/id-doc/upload-url?t=${encodeURIComponent(token)}`,
    {
      headers: { 'content-type': 'application/json', 'x-tenant': TENANT },
      data: { contentType: 'application/pdf' },
    },
  );
  expect(presign.status(), await presign.text()).toBe(409);
  expect(await presign.json()).toMatchObject({ error: CLOSED_MSG });
});

test("a rep's clearance request is refused while registration is closed", async ({
  page,
  request,
}) => {
  const name = repName;

  await signInAsRep(page, TO.id);
  await page.goto(`/club/${TO.id}/clearances`);
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Request a player' }).click();

  const modal = page.locator('.task-modal', { hasText: `Request a player for ${TO.name}` });
  await expect(modal).toBeVisible();
  await modal.locator('select.field-select').selectOption(FROM.id);
  await modal.getByPlaceholder('RSA ID or passport / visa number').fill(repIdNumber);
  // The modal says so up front and won't send...
  await expect(modal.getByRole('alert')).toContainText(/player registration is closed/i);
  await expect(modal.getByRole('button', { name: 'Send request' })).toBeDisabled();

  // ...and the route refuses on its own too.
  const res = await request.post(`${API_BASE}/clubs/${TO.id}/clearances`, {
    headers: apiHeaders(repAuthHeader(TO.id)),
    data: { fromClubId: FROM.id, idNumber: repIdNumber },
  });
  expect(res.status(), await res.text()).toBe(409);
  expect(await res.json()).toMatchObject({ error: CLOSED_MSG });
  expect(await clearanceNames(request)).not.toContain(`Test ${name}`);
  expect((await getPlayerByName(request, FROM.id, name))?.status).toBe('active');
});

test('the admin console blocks completion while closed but still rejects', async ({
  page,
  request,
}) => {
  await signInAsAdmin(page);
  await openClearancesFilteredTo(page, queuedName);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Registration closed — next window: ${WINDOW.label}` }),
  ).toBeVisible();

  const card = page.locator('.clr-card', { hasText: `Test ${queuedName}` });
  await expect(card).toBeVisible();
  const override = card.getByRole('button', { name: 'Override & approve' });
  await expect(override).toBeDisabled();
  await expect(override.locator('xpath=ancestor::span[@title][1]')).toHaveAttribute(
    'title',
    new RegExp(`Registration is closed until ${WINDOW.label}`),
  );
  const remind = card.getByRole('button', { name: 'Send reminder' });
  await expect(remind).toBeVisible();
  await expect(remind).toBeDisabled();

  // The reminder route refuses on its own too.
  const clrs = (await (
    await request.get(`${API_BASE}/admin/clearances`, { headers: adminHeaders })
  ).json()) as Array<{ id: string; playerName: string; fromClubId: string; version: number }>;
  const clr = clrs.find((c) => c.playerName === `Test ${queuedName}`)!;
  const remindRes = await request.post(`${API_BASE}/admin/clearances/${clr.id}/remind`, {
    headers: adminHeaders,
    data: { fromClubId: clr.fromClubId, version: clr.version },
  });
  expect(remindRes.status(), await remindRes.text()).toBe(409);

  // Reject is not window-gated.
  await card.getByRole('button', { name: 'Reject' }).click();
  const dialog = page.locator('.fix-confirm-box');
  await dialog.getByRole('button', { name: 'Yes, reject clearance' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('.clr-resolved-bar')).toContainText('Rejected');
  // Case C: the registration moves to the source club it named.
  await expect
    .poll(async () => (await getPlayerByName(request, TO.id, queuedName))?.status)
    .toBeUndefined();
});

test('reopening while closed parks the player as clearance pending', async ({ page, request }) => {
  await signInAsAdmin(page);
  await openClearancesFilteredTo(page, queuedName);
  const card = page.locator('.clr-card', { hasText: `Test ${queuedName}` });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Reopen' }).click();
  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toContainText('stays pending');
  await expect(dialog).toContainText('until the window opens');
  await dialog.getByRole('button', { name: 'Yes, reopen clearance' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'reopened' })).toBeVisible();
  // Pending again but frozen: the card says so instead of looking actionable.
  await expect(card).toContainText('Parked — completes when the window opens');

  await expect
    .poll(async () => (await getPlayerByName(request, TO.id, queuedName))?.status)
    .toBe('clearance-pending');
});

async function openSourceCardReady(page: Page) {
  await signInAsRep(page, FROM.id);
  await page.goto(`/club/${FROM.id}/clearances`);
  await dismissOnboarding(page);
  const card = page.locator('.clr-card', { hasText: `Test ${queuedName}` });
  await expect(card).toBeVisible();
  const fees = card.getByRole('button', { name: /Fees cleared/ });
  if (!/\bon\b/.test((await fees.getAttribute('class')) ?? '')) {
    await fees.click();
    await expect(fees).toHaveClass(/\bon\b/);
  }
  const misconduct = card.getByRole('button', { name: /Misconduct cleared/ });
  if (!/\bon\b/.test((await misconduct.getAttribute('class')) ?? '')) {
    await misconduct.click();
    await expect(misconduct).toHaveClass(/\bon\b/);
  }
  return card;
}

test('the source club cannot issue the clearance while closed', async ({ page }) => {
  const card = await openSourceCardReady(page);
  const issue = card.getByRole('button', { name: `Issue clearance to ${TO.name}` });
  await expect(issue).toBeDisabled();
  await expect(issue.locator('xpath=ancestor::span[@title][1]')).toHaveAttribute(
    'title',
    new RegExp(`Registration is closed until ${WINDOW.label}`),
  );
});

test('once a window is open the source club issues and the player joins', async ({
  page,
  request,
}) => {
  await putWindows(request, [CURRENT]);
  const tenant = await request.get(`${API_BASE}/tenant`, { headers: { 'x-tenant': TENANT } });
  expect(
    ((await tenant.json()) as { transferWindowStatus?: unknown }).transferWindowStatus,
  ).toMatchObject({ open: true });

  const card = await openSourceCardReady(page);
  const issue = card.getByRole('button', { name: `Issue clearance to ${TO.name}` });
  await expect(issue).toBeEnabled();
  await issue.click();
  await expect(
    page.locator('.toast', { hasText: `Test ${queuedName} cleared to ${TO.name}` }),
  ).toBeVisible();
  await expect
    .poll(async () => (await getPlayerByName(request, TO.id, queuedName))?.status)
    .toBe('active');
});
