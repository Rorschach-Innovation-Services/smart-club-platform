import { test, expect, type Page } from '@playwright/test';
import { API_BASE, RUN, TENANT, operatorAuth, operatorIdentity } from './helpers';

/**
 * A client's public web address, changed from the operator console (ADR 0024).
 *
 * The tenant slug is a fixed internal ID; the address label it is served at can move (a
 * rebrand). In the local stack the label rides `?tenant=` on the bare localhost host, so a
 * renamed client loads at `?tenant=<new label>` and its retired label shows the
 * unavailable screen.
 *
 * Isolation: the suite shares ONE in-memory DB and e2e/helpers.ts pins `x-tenant: dolphins`,
 * so this spec creates its OWN client with run-unique slug and labels (retired labels are
 * permanent tombstones) and never renames a seeded tenant.
 *
 * Identity: like the cloud token, the operator holds the '*' operator row plus admin on the
 * clients (by INTERNAL ID). Landing in the renamed client's console under that identity is
 * the membership-gate check: the host label no longer equals the membership's tenantId.
 */

const SLUG = `addr-${RUN}`;
const NEW = `moved-${RUN}`;
const NAME = `Address Union ${RUN}`;

const OPERATOR_IDENTITY = operatorIdentity([TENANT, SLUG]);
// The seeded client's branded name, read from the registry so the spec doesn't hard-code it.
let firstName = '';

async function signInAsOperatorAdmin(page: Page) {
  await page.addInitScript((identity) => {
    localStorage.setItem('smartclub.devAuth', JSON.stringify(identity));
  }, OPERATOR_IDENTITY);
}

/** The branded org name the admin shell prints in its sidebar footer. */
const orgFooter = (page: Page) => page.locator('.nav-footer strong');
/** The tab's sticky tenant label — written only from a `?tenant=` the page was opened with. */
const stickyTenant = (page: Page) => page.evaluate(() => sessionStorage.getItem('sc.tenant'));
const identityCard = (page: Page) =>
  page.locator('.card').filter({ has: page.locator('.card-title', { hasText: /^Identity$/ }) });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const created = await request.post(`${API_BASE}/platform/tenants`, {
    headers: { 'content-type': 'application/json', 'x-dev-auth': operatorAuth() },
    data: { slug: SLUG, branding: { name: NAME }, submissionDeadline: '2027-03-01' },
  });
  expect(created.status(), await created.text()).toBe(201);

  const first = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: { 'x-dev-auth': operatorAuth() },
  });
  expect(first.ok(), `GET /platform/tenants/${TENANT} → ${first.status()}`).toBeTruthy();
  firstName = ((await first.json()) as { branding?: { name?: string } }).branding?.name ?? '';
  expect(firstName).not.toBe('');
});

test('an operator changes the address from the Identity card, on the address being retired', async ({
  page,
}) => {
  await signInAsOperatorAdmin(page);
  // Open the client's settings ON ITS OWN (about to be retired) address, so success must
  // move this browser to the new address.
  await page.goto(`/platform/tenants/${SLUG}?tenant=${SLUG}`);

  const card = identityCard(page);
  await expect(card.getByText('Internal ID')).toBeVisible();
  // Locally the wildcard is off, so the field shows the bare label (a live URL when armed).
  await expect(card.getByRole('textbox', { name: 'Current web address' })).toHaveValue(
    new RegExp(SLUG),
  );
  await card.getByRole('button', { name: 'Change', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: /change web address/i });
  await expect(dialog).toBeVisible();
  // Every consequence is stated before the operator confirms.
  await expect(dialog).toContainText('stops working immediately');
  await expect(dialog).toContainText('sign in again on the new address');
  await expect(dialog).toContainText('club signup links, invites and clearance notices');
  await expect(dialog).toContainText('can never be given to another client');

  const input = dialog.getByRole('textbox', { name: 'New address' });
  const confirm = dialog.getByRole('button', { name: 'Change address' });

  // Client-side validation mirrors the server's rule (no trailing hyphen).
  await input.fill('bad-');
  await expect(dialog).toContainText('ending in a letter or digit');
  await expect(confirm).toBeDisabled();

  // The server's refusal is shown as-is: another client's internal ID can't be taken.
  await input.fill(TENANT);
  await confirm.click();
  await expect(dialog).toContainText(`address "${TENANT}" is another client's internal ID`);

  await input.fill(NEW);
  // Enter never commits (a mistyped label is retired for good): only the button does.
  await input.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue(NEW);
  expect(new URL(page.url()).searchParams.get('tenant')).toBe(SLUG);
  await confirm.click();

  // The browser was on the retired address: it lands on the same page on the new one.
  await page.waitForURL(
    (u) => u.pathname === `/platform/tenants/${SLUG}` && u.searchParams.get('tenant') === NEW,
  );
  expect(await stickyTenant(page)).toBe(NEW);
  const after = identityCard(page);
  await expect(after.getByRole('textbox', { name: 'Current web address' })).toHaveValue(
    new RegExp(NEW),
  );
  await expect(after).toContainText(`Previous addresses (retired): ${SLUG}`);
  // Still the same client by internal ID.
  await expect(after.locator('input[disabled]')).toHaveValue(SLUG);
  // The portal on the renamed host names its own console from the registry (by internal ID).
  await expect(page.getByRole('button', { name: `${NAME} console` })).toBeVisible();
});

test('the new address loads the club and an operator reaches its console', async ({ page }) => {
  await signInAsOperatorAdmin(page);
  await page.goto(`/?tenant=${NEW}`);
  // The membership gate matches the internal ID from the tenant payload, not the host label:
  // a label-keyed match would bounce this operator to /platform.
  await expect(page).toHaveURL(/\/admin\/dashboard/);
  await expect(orgFooter(page)).toHaveText(NAME);
  // A refresh without the param stays on the renamed client.
  await page.goto('/');
  await expect(orgFooter(page)).toHaveText(NAME);
});

test('the dev picker signs in once on the renamed client', async ({ page }) => {
  await page.goto(`/?tenant=${NEW}`);
  const role = page.locator('select.field-select').first();
  await expect(role).toBeVisible();
  await role.selectOption('admin');
  await page.getByRole('button', { name: 'Enter as admin' }).click();
  // The minted membership carries the internal ID, so the console opens (not "No access").
  await expect(page).toHaveURL(/\/admin\/dashboard/);
  await expect(orgFooter(page)).toHaveText(NAME);
  await expect(page.getByText('No access')).toHaveCount(0);
});

test('the retired address shows the unavailable screen with the moved hint', async ({ page }) => {
  await page.goto(`/?tenant=${SLUG}`);
  await expect(page.getByText(/This club isn.t available/)).toBeVisible();
  await expect(page.getByText(/may have moved to a new web address/)).toBeVisible();
  // The screen never names the new address.
  await expect(page.locator('body')).not.toContainText(NEW);
});

test('the Clients table shows the new address; Open console and the switcher use it', async ({
  page,
}) => {
  await signInAsOperatorAdmin(page);
  await page.goto(`/platform?tenant=${TENANT}`);

  const row = page.getByRole('row', { name: new RegExp(NAME) });
  await expect(row).toContainText(NEW);
  await expect(row.getByText(`ID ${SLUG}`)).toBeVisible();

  await row.getByRole('button', { name: /open console/i }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard/);
  await expect(orgFooter(page)).toHaveText(NAME);
  expect(await stickyTenant(page)).toBe(NEW);

  // Away to the seeded client through the switcher, then back to the renamed one.
  await page.getByRole('button', { name: 'Switch client' }).click();
  const menu = page.getByRole('menu', { name: 'Switch client' });
  const current = menu.getByRole('menuitem', { name: new RegExp(NAME) });
  // The current client is recognised by internal ID even though the host label differs.
  await expect(current).toHaveAttribute('aria-current', 'true');
  await expect(current).toContainText(NEW);
  await menu.getByRole('menuitem', { name: new RegExp(`\\b${TENANT}\\b`) }).click();
  await expect(orgFooter(page)).toHaveText(firstName);
  expect(await stickyTenant(page)).toBe(TENANT);

  await page.getByRole('button', { name: 'Switch client' }).click();
  await page
    .getByRole('menu', { name: 'Switch client' })
    .getByRole('menuitem', { name: new RegExp(NAME) })
    .click();
  await expect(orgFooter(page)).toHaveText(NAME);
  await expect(page).toHaveURL(/\/admin\/dashboard/);
  expect(await stickyTenant(page)).toBe(NEW);
});
