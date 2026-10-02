import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_BASE,
  TENANT,
  adminAuthHeader,
  apiHeaders,
  operatorAuth,
  signInAsAdmin,
} from './helpers';

/**
 * Operator-configured fixture reminders (`TenantConfig.fixtureReminders`), end to end through
 * the REAL local stack: the operator turns reminders on in the tenant's console page with lead
 * days and channels, saves, and after a reload the card shows what was stored. The setting is
 * operator-only — a tenant admin can neither read it nor write it, through the API or the UI.
 *
 * The spec edits the shared demo tenant, so it snapshots the setting first and restores it in
 * afterAll.
 */
test.describe.configure({ mode: 'serial' });

interface Reminders {
  enabled: boolean;
  leadDays: number[];
  channels: string[];
}

const operatorHeaders = apiHeaders(operatorAuth());

async function operatorReminders(request: APIRequestContext): Promise<Reminders | undefined> {
  const res = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operatorHeaders,
  });
  expect(res.ok(), `GET /platform/tenants/${TENANT} → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { fixtureReminders?: Reminders }).fixtureReminders;
}

let prior: Reminders | undefined;

test.beforeAll(async ({ request }) => {
  prior = await operatorReminders(request);
  // Start from a known OFF state so the save is a real change.
  const res = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operatorHeaders,
    data: { fixtureReminders: { enabled: false, leadDays: [1], channels: ['email'] } },
  });
  expect(res.ok(), `reset reminders → ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  const res = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operatorHeaders,
    data: { fixtureReminders: prior ?? { enabled: false, leadDays: [1], channels: ['email'] } },
  });
  expect(res.ok(), `restore reminders → ${res.status()}`).toBeTruthy();
});

async function signInAsOperator(page: Page): Promise<void> {
  await page.goto('/');
  const picker = page.locator('select.field-select').first();
  await expect(picker).toBeVisible();
  await picker.selectOption('operator');
  await page.getByRole('button', { name: 'Enter as operator' }).click();
}

const remindersCard = (page: Page) => page.locator('.card', { hasText: 'Fixture reminders' });

test('the operator enables reminders with lead days and channels, and they persist', async ({
  page,
  request,
}) => {
  await signInAsOperator(page);
  await page.goto(`/platform/tenants/${TENANT}`);
  const card = remindersCard(page);
  await expect(card).toBeVisible();

  const enabled = card.getByLabel('Send fixture reminders');
  const lead = card.getByLabel('Lead days');
  const email = card.getByLabel('Email', { exact: true });
  const whatsapp = card.getByLabel('WhatsApp', { exact: true });
  const save = card.getByRole('button', { name: 'Save reminder settings' });
  await expect(enabled).not.toBeChecked();
  await expect(email).toBeChecked();
  await expect(whatsapp).not.toBeChecked();
  await expect(save).toBeDisabled();

  await enabled.check();
  // Out-of-range input is refused before it reaches the server.
  await lead.fill('3, 45');
  await save.click();
  await expect(card.getByText('Lead days must be whole numbers from 1 to 30')).toBeVisible();

  await lead.fill('3, 1');
  await whatsapp.check();
  await save.click();
  // Saved ⇒ no longer dirty, and the lead days come back sorted.
  await expect(save).toBeDisabled();
  await expect(lead).toHaveValue('1, 3');

  expect(await operatorReminders(request)).toEqual({
    enabled: true,
    leadDays: [1, 3],
    channels: ['email', 'whatsapp'],
  });

  await page.reload();
  const reloaded = remindersCard(page);
  await expect(reloaded.getByLabel('Send fixture reminders')).toBeChecked();
  await expect(reloaded.getByLabel('Lead days')).toHaveValue('1, 3');
  await expect(reloaded.getByLabel('Email', { exact: true })).toBeChecked();
  await expect(reloaded.getByLabel('WhatsApp', { exact: true })).toBeChecked();
  await expect(reloaded.getByRole('button', { name: 'Save reminder settings' })).toBeDisabled();
});

test('a tenant admin can neither see nor change the reminder setting', async ({
  page,
  request,
}) => {
  const adminHeaders = apiHeaders(adminAuthHeader());

  // Not projected to the tenant's own config…
  const cfg = await request.get(`${API_BASE}/tenant/config`, { headers: adminHeaders });
  expect(cfg.ok()).toBeTruthy();
  expect(await cfg.json()).not.toHaveProperty('fixtureReminders');
  // …the operator route is closed to them…
  const platform = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: adminHeaders,
  });
  expect(platform.status()).toBe(403);
  // …and a write through the tenant route is silently stripped.
  const put = await request.put(`${API_BASE}/tenant/config`, {
    headers: adminHeaders,
    data: { fixtureReminders: { enabled: false, leadDays: [7], channels: ['email'] } },
  });
  expect(put.ok(), `PUT /tenant/config → ${put.status()}`).toBeTruthy();
  expect((await operatorReminders(request))?.leadDays).toEqual([1, 3]);

  // UI: the admin console has no reminders card, even on a hand-typed operator URL.
  await signInAsAdmin(page);
  await expect(page.locator('aside.nav').first()).toBeVisible();
  await page.goto(`/platform/tenants/${TENANT}`);
  await expect(page.locator('aside.nav').first()).toBeVisible();
  await expect(page.getByText('Send fixture reminders')).toHaveCount(0);
  await expect(page.getByText('Save reminder settings')).toHaveCount(0);
});
