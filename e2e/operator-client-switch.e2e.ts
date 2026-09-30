import { test, expect, type Page } from '@playwright/test';
import { API_BASE, RUN, TENANT } from './helpers';

/**
 * Operator ↔ client navigation in one click, both directions:
 * Clients table "Open console" → that client's admin console (with its branding) → a
 * refresh keeps the client → the sidebar client switcher → back to the first client.
 *
 * Tenant plumbing in the local stack: the SPA resolves its tenant from `?tenant=` on the
 * bare localhost host, and now remembers it for the tab (sessionStorage `sc.tenant`), so a
 * refresh WITHOUT the param stays on the same client. Switching is always a full page load.
 *
 * Identity: operators are auto-granted admin on every tenant in the cloud (their token's
 * memberships claim carries both the '*' operator row and per-tenant admin rows). The dev
 * picker's "operator" only mints the '*' row, so this spec seeds the dev identity directly
 * with the cloud shape: operator + admin on both tenants.
 */

const SECOND = `sw-${RUN}`;
const SECOND_NAME = `Switch Union ${RUN}`;

const OPERATOR_IDENTITY = {
  sub: 'dev-operator',
  email: 'operator@platform.local',
  memberships: [
    { tenantId: '*', role: 'operator', clubIds: [] },
    { tenantId: TENANT, role: 'admin', clubIds: [] },
    { tenantId: SECOND, role: 'admin', clubIds: [] },
  ],
};
const OPERATOR_AUTH = Buffer.from(JSON.stringify(OPERATOR_IDENTITY)).toString('base64');

async function signInAsOperatorAdmin(page: Page) {
  await page.addInitScript((identity) => {
    localStorage.setItem('smartclub.devAuth', JSON.stringify(identity));
  }, OPERATOR_IDENTITY);
}

/** The branded org name the admin shell prints in its sidebar footer. */
const orgFooter = (page: Page) => page.locator('.nav-footer strong');

test.beforeAll(async ({ request }) => {
  const created = await request.post(`${API_BASE}/platform/tenants`, {
    headers: { 'content-type': 'application/json', 'x-dev-auth': OPERATOR_AUTH },
    data: { slug: SECOND, branding: { name: SECOND_NAME }, submissionDeadline: '2027-03-01' },
  });
  expect(created.status(), await created.text()).toBe(201);
});

test('an operator hops from the portal into a client console and back via the switcher', async ({
  page,
}) => {
  await signInAsOperatorAdmin(page);
  await page.goto(`/platform?tenant=${TENANT}`);

  // Portal → second client, one click from its Clients row.
  const row = page.getByRole('row', { name: new RegExp(SECOND_NAME) });
  await row.getByRole('button', { name: /open console/i }).click();

  await expect(page).toHaveURL(new RegExp(`\\?tenant=${SECOND}$`));
  await expect(orgFooter(page)).toHaveText(SECOND_NAME);
  await expect(page.getByRole('button', { name: 'Switch client' })).toBeVisible();

  // The SPA drops ?tenant= as it routes; a refresh on the bare URL must stay on this client.
  await page.goto('/');
  await expect(orgFooter(page)).toHaveText(SECOND_NAME);
  await page.reload();
  await expect(orgFooter(page)).toHaveText(SECOND_NAME);

  // Admin shell → back to the first client through the switcher.
  await page.getByRole('button', { name: 'Switch client' }).click();
  const menu = page.getByRole('menu', { name: 'Switch client' });
  const current = menu.getByRole('menuitem', { name: new RegExp(SECOND_NAME) });
  await expect(current).toHaveAttribute('aria-current', 'true');
  await expect(current).toBeDisabled();

  await menu.getByRole('menuitem', { name: new RegExp(`\\b${TENANT}\\b`) }).click();
  await expect(page).toHaveURL(new RegExp(`\\?tenant=${TENANT}$`));
  await expect(orgFooter(page)).not.toHaveText(SECOND_NAME);
  await page.getByRole('button', { name: 'Switch client' }).click();
  await expect(
    page
      .getByRole('menu', { name: 'Switch client' })
      .getByRole('menuitem', { name: new RegExp(`\\b${TENANT}\\b`) }),
  ).toHaveAttribute('aria-current', 'true');
});
