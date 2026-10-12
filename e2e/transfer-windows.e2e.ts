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
  signInAsAdmin,
  signInAsRep,
  uniqueIdNumber,
} from './helpers';

/**
 * Per-tenant transfer windows (ADR 0017), end to end through the REAL local stack:
 *
 *  1. the operator adds a window on the tenant's console page and saves it. The window lies in
 *     the future, so transfers are CLOSED today;
 *  2. a club rep's clearance request is refused with the server's "transfers are closed — next
 *     window: …" 409, shown in the toast;
 *  3. the public registration form shows the closed notice; a registration naming another club
 *     lands as an "Auto-rejected — window closed" clearance in the admin console, under the
 *     closed banner, and the admin reopens it;
 *  4. the source club then approves it in its portal and the player is active at the joining club.
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

const operatorHeaders = apiHeaders(operatorAuth());

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

let prior: TransferWindow[] = [];

test.beforeAll(async ({ request }) => {
  prior = await operatorWindows(request);
  // Start unrestricted, so the operator's save is what closes transfers.
  await putWindows(request, []);
});

test.afterAll(async ({ request }) => {
  await putWindows(request, prior);
});

// Shared across the serial block.
const autoName = `WindowAuto-${RUN}`;

test('the operator saves a future transfer window, which closes transfers today', async ({
  page,
  request,
}) => {
  await signInAsOperator(page);
  await page.goto(`/platform/tenants/${TENANT}`);
  const card = page.locator('.card', { hasText: 'Transfer windows' });
  await expect(card).toBeVisible();
  await expect(card.getByText('No windows — transfers are open all year.')).toBeVisible();
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

  // The served status is closed, with this window as the next one.
  const tenant = await request.get(`${API_BASE}/tenant`, { headers: { 'x-tenant': TENANT } });
  expect(tenant.ok()).toBeTruthy();
  expect(
    ((await tenant.json()) as { transferWindowStatus?: unknown }).transferWindowStatus,
  ).toMatchObject({ open: false, next: WINDOW });
});

test("a rep's clearance request is refused while transfers are closed", async ({
  page,
  request,
}) => {
  const name = `WindowRep-${RUN}`;
  const player = await createActivePlayer(request, FROM.id, { name });

  await signInAsRep(page, TO.id);
  await page.goto(`/club/${TO.id}/clearances`);
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Request a player' }).click();

  const modal = page.locator('.task-modal', { hasText: `Request a player for ${TO.name}` });
  await expect(modal).toBeVisible();
  await modal.locator('select.field-select').selectOption(FROM.id);
  await modal.getByPlaceholder('RSA ID or passport / visa number').fill(player.idNumber);
  await modal.getByRole('button', { name: 'Send request' }).click();

  await expect(
    page.locator('.toast', {
      hasText: `transfers are closed — next window: ${WINDOW.label} (${WINDOW.start} – ${WINDOW.end})`,
    }),
  ).toBeVisible();
  // Refused, so the form stays open and no clearance exists for the player.
  await expect(modal).toBeVisible();
  const all = await request.get(`${API_BASE}/admin/clearances`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  const list = (await all.json()) as Array<{ playerName: string }>;
  expect(list.some((c) => c.playerName === `Test ${name}`)).toBe(false);
  // The player is still active at the source club.
  expect((await getPlayerByName(request, FROM.id, name))?.status).toBe('active');
});

test('a public registration naming another club is auto-rejected, and the admin reopens it', async ({
  page,
  request,
}) => {
  const token = await mintRegLink(request, TO.id);

  // The public form warns before anyone submits.
  await page.goto(`/register/${TO.id}?t=${encodeURIComponent(token)}`);
  const notice = page
    .getByRole('note')
    .filter({ hasText: 'Transfers between clubs are currently closed' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`(${WINDOW.label})`);

  // The submit itself goes through the API: the browser's ID-document upload needs a presigned
  // S3 PUT the local stack has no twin for (see helpers.regPayload).
  const res = await registerViaApi(request, TO.id, token, {
    name: autoName,
    idNumber: uniqueIdNumber(),
    lastClubId: FROM.id,
  });
  expect(res.status(), await res.text()).toBe(201);
  expect(await res.json()).toMatchObject({ ok: true, transferWindow: { closed: true } });
  // Recorded, not registered.
  expect(await getPlayerByName(request, TO.id, autoName)).toBeUndefined();

  await signInAsAdmin(page);
  await openClearancesFilteredTo(page, autoName);
  await expect(
    page.getByRole('status').filter({ hasText: `Transfers closed — next window: ${WINDOW.label}` }),
  ).toBeVisible();
  const card = page.locator('.clr-card', { hasText: `Test ${autoName}` });
  await expect(card).toBeVisible();
  await expect(card.locator('.clr-resolved-bar')).toContainText('Auto-rejected — window closed');
  await expect(card.locator('.clr-resolved-bar')).toContainText(`Not registered at ${TO.name}`);

  // Reopen is not window-gated: it is how the union office admits a transfer while closed.
  await card.getByRole('button', { name: 'Reopen' }).click();
  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toContainText(`placed on ${TO.name}'s roster as clearance pending`);
  await dialog.getByRole('button', { name: 'Yes, reopen clearance' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'reopened' })).toBeVisible();

  await expect
    .poll(async () => (await getPlayerByName(request, TO.id, autoName))?.status)
    .toBe('clearance-pending');
});

test('the source club approves the reopened clearance and the player joins', async ({
  page,
  request,
}) => {
  await signInAsRep(page, FROM.id);
  await page.goto(`/club/${FROM.id}/clearances`);
  await dismissOnboarding(page);

  const card = page.locator('.clr-card', { hasText: `Test ${autoName}` });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Reopened by Union office');
  await card.getByRole('button', { name: /Fees cleared/ }).click();
  await expect(card.getByRole('button', { name: /Fees cleared/ })).toHaveClass(/\bon\b/);
  await card.getByRole('button', { name: /Misconduct cleared/ }).click();
  await card.getByRole('button', { name: `Issue clearance to ${TO.name}` }).click();

  await expect(
    page.locator('.toast', { hasText: `Test ${autoName} cleared to ${TO.name}` }),
  ).toBeVisible();
  await expect
    .poll(async () => (await getPlayerByName(request, TO.id, autoName))?.status)
    .toBe('active');
});
