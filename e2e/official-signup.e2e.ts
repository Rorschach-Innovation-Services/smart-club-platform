import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_BASE, RUN, adminAuthHeader, apiHeaders, signInAsAdmin } from './helpers';
import { createSeries, fixture, ground, openAdminSeries } from './fixtures-helpers';

/**
 * Official self-registration on the REAL local stack (docs/api/officials.md): the admin mints a
 * per-role link from the Umpires / Scorers page, the official registers on the public page in a
 * fresh unauthenticated context, and the record waits under Pending (sidebar dot, not
 * appointable) until Approve, Merge or Reject. Replace and Turn off kill the old URL.
 */
test.describe.configure({ mode: 'serial' });

const admin = () => apiHeaders(adminAuthHeader());
type Role = 'umpire' | 'scorer';
const plural = (r: Role) => (r === 'umpire' ? 'umpires' : 'scorers');
const Title = (r: Role) => (r === 'umpire' ? 'Umpires' : 'Scorers');

/** Letters-only, run-unique tag (names are matched case/punctuation-insensitively). */
const TAG = RUN.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
let phoneSeq = Math.floor(Math.random() * 1e6);
/** A fresh SA cell each call, so same-phone resubmission never folds two tests together. */
const cell = () => `083${String(phoneSeq++ % 1e7).padStart(7, '0')}`;

async function openRegister(page: Page, role: Role) {
  await page.locator('aside.nav .nav-item', { hasText: Title(role) }).click();
  await expect(page.getByRole('heading', { name: Title(role) })).toBeVisible();
  return page.getByRole('table', { name: Title(role) });
}

/** Ensure a live link through the modal and return its path (`/officials/register?t=…`). */
async function createLink(page: Page, replace = false): Promise<string> {
  const modal = page.getByTestId('signup-link-modal');
  if (!(await modal.isVisible())) await page.getByTestId('officials-signup-link').click();
  await expect(modal.getByTestId('signup-link-state')).toBeVisible();
  const create = modal.getByTestId('signup-link-create');
  if (await create.isVisible()) await create.click();
  else if (replace) {
    await modal.getByTestId('signup-link-replace').click();
    await expect(modal).toContainText('The current link stops working straight away');
    await modal.getByTestId('signup-link-confirm').click();
    await expect(modal).toContainText('The previous link no longer works');
  }
  const url = await modal.getByTestId('signup-link-url').inputValue();
  expect(url).toMatch(/\/officials\/register\?t=/);
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

async function closeModal(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('signup-link-modal')).toHaveCount(0);
}

interface Submission {
  firstNames: string;
  surname: string;
  phone: string;
  email?: string;
}

/** Register on the public page in a fresh context (no admin identity in storage). */
async function submitPublic(browser: Browser, path: string, role: Role, s: Submission) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(path);
  await expect(
    p.getByRole('heading', {
      name: role === 'umpire' ? 'Umpire registration' : 'Scorer registration',
    }),
  ).toBeVisible();
  await p.getByLabel(/First names/).fill(s.firstNames);
  await p.getByLabel(/Surname/).fill(s.surname);
  await p.getByLabel(/Cell phone/).fill(s.phone);
  if (s.email) await p.getByLabel(/^Email/).fill(s.email);
  if (role === 'scorer') {
    await expect(p.getByLabel('ID number')).toBeVisible();
    await p.getByLabel('Emergency contact number').fill('0820001111');
  } else await expect(p.getByLabel('ID number')).toHaveCount(0);
  await p.getByRole('checkbox').check();
  await p.getByRole('button', { name: 'Register' }).click();
  await expect(p.getByRole('heading', { name: 'Registration received' })).toBeVisible();
  await ctx.close();
}

async function expectLinkDead(browser: Browser, path: string) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(path);
  await expect(p.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
  await ctx.close();
}

async function register(request: APIRequestContext, role: Role) {
  const res = await request.get(`${API_BASE}/${plural(role)}`, { headers: admin() });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Array<Record<string, unknown> & { id: string; displayName: string }>;
}

async function postJson<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(`${API_BASE}${path}`, { headers: admin(), data });
  expect(res.ok(), `POST ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

const displayOf = (role: Role, s: Submission) =>
  role === 'scorer' ? `${s.firstNames} ${s.surname}` : `${s.firstNames[0]}.${s.surname}`;

for (const role of ['scorer', 'umpire'] as const) {
  test(`${role}: link → public submit → Pending (not appointable) → Approve → appointable`, async ({
    page,
    browser,
    request,
  }) => {
    const sub: Submission = {
      firstNames: 'Nomsa',
      surname: `Khumalo${role === 'umpire' ? 'u' : 's'}${TAG}`,
      phone: cell(),
      email: `nomsa.${role}.${TAG}@example.org`,
    };
    const name = displayOf(role, sub);
    const series = await createSeries(request, {
      name: `E2E Signup ${role} ${RUN}`,
      fixtures: [fixture({ id: `f-sg-${role}-${RUN}`, venueOverride: ground(`Signup${role}`) })],
    });

    await signInAsAdmin(page);
    await openRegister(page, role);
    const path = await createLink(page);
    await closeModal(page);
    await submitPublic(browser, path, role, sub);

    await page.reload();
    const table = await openRegister(page, role);
    await expect(page.getByTestId(`nav-pending-${plural(role)}`)).toBeVisible();
    await page.getByRole('button', { name: /^Pending/ }).click();
    const row = table.getByTestId('pending-row').filter({ hasText: name });
    await expect(row).toContainText(sub.phone);
    await expect(row).toContainText('Pending');
    await expect(row.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
    // Not under Inactive.
    await page.getByRole('button', { name: /^Inactive/ }).click();
    await expect(table.getByRole('row').filter({ hasText: name })).toHaveCount(0);

    // Not offered in the fixture's Officials picker while pending.
    const pick = async (expectFound: boolean) => {
      const detail = await openAdminSeries(page, series.name);
      const cellEl = detail.locator('.ump-cell').first();
      const kind = role === 'umpire' ? 'umpires' : 'scorers';
      await cellEl.getByRole('button', { name: `Assign ${kind}` }).click();
      const picker = cellEl.getByRole('group', { name: `Assign ${kind}` });
      await picker
        .getByRole('combobox', { name: role === 'umpire' ? 'Umpire 1' : 'Scorer', exact: true })
        .fill(sub.surname);
      const option = picker.getByRole('option', { name: new RegExp(name.replace('.', '\\.')) });
      if (expectFound) await expect(option).toBeVisible();
      else await expect(option).toHaveCount(0);
      await picker.getByRole('button', { name: 'Cancel' }).click();
    };
    await pick(false);

    await openRegister(page, role);
    await page.getByRole('button', { name: /^Pending/ }).click();
    await row.getByTestId('pending-approve').click();
    await expect(page.getByTestId('officials-notice')).toContainText(`${name} approved`);
    await page.getByRole('button', { name: /^Active/ }).click();
    await expect(table.getByRole('row').filter({ hasText: name })).toContainText('Active');
    await pick(true);
  });
}

test('scorer: a submission matching a contact-less entry is merged and fills its contacts', async ({
  page,
  browser,
  request,
}) => {
  const sub: Submission = { firstNames: 'Lerato', surname: `Mabena${TAG}`, phone: cell() };
  const existing = await postJson<{ id: string }>(request, '/scorers', {
    displayName: `Lerato Mabena${TAG}`,
  });

  await signInAsAdmin(page);
  const table = await openRegister(page, 'scorer');
  const path = await createLink(page);
  await closeModal(page);
  await submitPublic(browser, path, 'scorer', sub);

  await page.reload();
  await openRegister(page, 'scorer');
  await page.getByRole('button', { name: /^Pending/ }).click();
  const row = table.getByTestId('pending-row').filter({ hasText: sub.phone });
  await expect(row.getByRole('list', { name: /Possible matches/ })).toContainText(
    `Lerato Mabena${TAG} (same name)`,
  );
  await row.getByTestId('pending-merge').click();
  await row.getByTestId('pending-merge-target').selectOption(existing.id);
  await row.getByTestId('pending-merge-confirm').click();
  await expect(page.getByTestId('officials-notice')).toContainText(`Phone added: ${sub.phone}`);

  const target = (await register(request, 'scorer')).find((s) => s.id === existing.id)!;
  expect(target.phone).toBe(sub.phone);
  expect(target.consentAt).toBeTruthy();
  expect((await register(request, 'scorer')).some((s) => s.phone === sub.phone && s.pending)).toBe(
    false,
  );
});

test('umpire: a different phone on the existing entry raises the contact choice and honours it', async ({
  page,
  browser,
  request,
}) => {
  const held = cell();
  const sub: Submission = { firstNames: 'Sipho', surname: `Zondi${TAG}`, phone: cell() };
  const existing = await postJson<{ id: string }>(request, '/umpires', {
    displayName: `S.Zondi${TAG}`,
    phone: held,
  });

  await signInAsAdmin(page);
  const table = await openRegister(page, 'umpire');
  const path = await createLink(page);
  await closeModal(page);
  await submitPublic(browser, path, 'umpire', sub);

  await page.reload();
  await openRegister(page, 'umpire');
  await page.getByRole('button', { name: /^Pending/ }).click();
  const row = table.getByTestId('pending-row').filter({ hasText: sub.phone });
  await row.getByTestId('pending-merge').click();
  await row.getByTestId('pending-merge-target').selectOption(existing.id);
  await row.getByTestId('pending-merge-confirm').click();

  const dialog = page.getByTestId('contact-choice-dialog');
  await expect(dialog).toContainText(held);
  await expect(dialog).toContainText(sub.phone);
  const confirm = page.getByTestId('contact-choice-confirm');
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole('group', { name: 'Phone' })
    .getByLabel(/Use submitted/)
    .check();
  await confirm.click();
  await expect(page.getByTestId('officials-notice')).toContainText(
    `Phone replaced: was ${held}, now ${sub.phone}`,
  );
  const target = (await register(request, 'umpire')).find((u) => u.id === existing.id)!;
  expect(target.phone).toBe(sub.phone);
});

test('Reject removes a pending registration', async ({ page, browser, request }) => {
  const sub: Submission = { firstNames: 'Thabo', surname: `Reject${TAG}`, phone: cell() };
  await signInAsAdmin(page);
  const table = await openRegister(page, 'umpire');
  const path = await createLink(page);
  await closeModal(page);
  await submitPublic(browser, path, 'umpire', sub);

  await page.reload();
  await openRegister(page, 'umpire');
  await page.getByRole('button', { name: /^Pending/ }).click();
  const row = table.getByTestId('pending-row').filter({ hasText: sub.phone });
  await row.getByTestId('pending-reject').click();
  await page.getByTestId('pending-reject-confirm').click();
  await expect(row).toHaveCount(0);
  expect((await register(request, 'umpire')).some((u) => u.phone === sub.phone)).toBe(false);
});

test('Replace link and Turn off link kill the old URL', async ({ page, browser }) => {
  await signInAsAdmin(page);
  await openRegister(page, 'scorer');
  const first = await createLink(page);
  const second = await createLink(page, true);
  expect(second).not.toBe(first);
  await expectLinkDead(browser, first);

  const modal = page.getByTestId('signup-link-modal');
  await modal.getByTestId('signup-link-revoke').click();
  await modal.getByTestId('signup-link-confirm').click();
  await expect(modal.getByTestId('signup-link-state')).toContainText('No registration link yet');
  await expectLinkDead(browser, second);
});

test('a resubmission while the admin reviews makes Approve refuse; the record stays pending', async ({
  page,
  browser,
  request,
}) => {
  const sub: Submission = { firstNames: 'Ayanda', surname: `Stale${TAG}`, phone: cell() };
  await signInAsAdmin(page);
  const table = await openRegister(page, 'umpire');
  const path = await createLink(page);
  await closeModal(page);
  await submitPublic(browser, path, 'umpire', sub);

  await page.reload();
  await openRegister(page, 'umpire');
  await page.getByRole('button', { name: /^Pending/ }).click();
  const row = table.getByTestId('pending-row').filter({ hasText: sub.phone });
  await expect(row).toBeVisible();

  // The applicant submits again (same cell) while the Pending tab is open: updated in place.
  await submitPublic(browser, path, 'umpire', { ...sub, email: `stale.${TAG}@example.org` });

  await row.getByTestId('pending-approve').click();
  await expect(page.getByTestId('officials-notice')).toHaveText(
    'This registration was updated by the applicant while you were reviewing it. Check the details again before approving.',
  );
  await expect(row).toContainText('Pending');
  const stored = (await register(request, 'umpire')).find((u) => u.phone === sub.phone)!;
  expect(stored.pending).toBe(true);
  expect(stored.active).toBe(false);
});
