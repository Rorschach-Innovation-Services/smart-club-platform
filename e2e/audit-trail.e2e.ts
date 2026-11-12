import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import {
  API_BASE,
  RUN,
  TENANT,
  encodeDevAuth,
  operatorIdentity,
  type DevIdentity,
} from './helpers';

/**
 * Audit trail on the REAL local stack (docs/api/audit.md, ADR 0023): an admin adds an umpire
 * and renames it (the A.Dende → M.Jooma shape); the umpire's History shows both entries with
 * the editor's email and the name before and after; the Activity page finds the edit by
 * person and expands it; an operator sees the same entry, attributed to that admin, in the
 * client's Activity in the operator portal; and after the admin deletes the umpire, Activity
 * still lists the entries but the names read "Removed" — the delete's own entry included.
 *
 * The admin is a per-run identity (unique sub and email) with no team-member row. In the UI the
 * "Changed by" box sends the typed email until the feed has shown this admin, and their actor
 * key (the `U#` pointer read) once it has; `filterToAdmin` accepts either. The final API check
 * sends the email itself, so with no team-member row it takes the email path (headlines whose
 * actor email matches) — which matches only this run.
 */
test.describe.configure({ mode: 'serial' });

const ADMIN: DevIdentity = {
  sub: `e2e-audit-${RUN}`,
  email: `audit-${RUN}@dolphins.local`,
  memberships: [{ tenantId: TENANT, role: 'admin', clubIds: [] }],
};
const OLD_NAME = `E2E A.Dende ${RUN}`;
const NEW_NAME = `E2E M.Jooma ${RUN}`;

/** Sign the page in as `identity` through the dev auth the local SPA reads. */
async function signInAs(page: Page, identity: DevIdentity) {
  await page.addInitScript((id) => {
    localStorage.setItem('smartclub.devAuth', JSON.stringify(id));
  }, identity);
}

async function openNav(page: Page, label: string) {
  await page.locator('aside.nav .nav-item', { hasText: label }).click();
  await expect(page.getByRole('heading', { name: label })).toBeVisible();
}

/** Filter an Activity page to this run's admin and umpire records. */
async function filterToAdmin(page: Page) {
  // Wait for the feed read carrying both filters: a row opened before it lands would be
  // unmounted while the filtered page loads. The box sends the email as typed, or this admin's
  // key once the unfiltered feed has shown them (the person list learns it).
  const filtered = page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      url.pathname.endsWith('/audit') &&
      [ADMIN.email, ADMIN.sub].includes(url.searchParams.get('actor') ?? '') &&
      url.searchParams.get('type') === 'umpire'
    );
  });
  const person = page.getByLabel('Changed by');
  await person.fill(ADMIN.email);
  await person.press('Enter');
  await page.getByLabel('Record').selectOption('umpire');
  expect((await filtered).ok()).toBeTruthy();
}

const auditRow = (scope: Page | Locator, action: string) =>
  scope.getByTestId('audit-row').filter({ hasText: action });

/** The "Name" row of an expanded entry's changes table. */
function nameChangeRow(scope: Page | Locator) {
  const table = scope.getByRole('table', { name: /^Changes to Umpire/ });
  // The row's text starts with its field label ("Full name" and "Other spellings" do not match).
  return table.locator('tbody tr').filter({ hasText: /^Name/ });
}

async function expectNameChange(scope: Page | Locator, before: string, after: string) {
  const row = nameChangeRow(scope);
  await expect(row.locator('td[data-label="Before"]')).toHaveText(before);
  await expect(row.locator('td[data-label="After"]')).toHaveText(after);
}

async function operatorPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: 'http://localhost:3201' });
  const page = await context.newPage();
  await signInAs(page, operatorIdentity([TENANT]));
  return page;
}

test('an umpire rename is in its History, in Activity, in the operator portal, and erased on delete', async ({
  page,
  browser,
  request,
}) => {
  await signInAs(page, ADMIN);
  await page.goto('/');
  await openNav(page, 'Umpires');
  const table = page.getByRole('table', { name: 'Umpires' });

  // Add, then rename, through the page.
  await page.getByRole('button', { name: 'Add umpire' }).click();
  const add = page.getByRole('group', { name: 'New umpire' });
  await add.getByLabel('Sheet name').fill(OLD_NAME);
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/umpires'),
  );
  await add.getByRole('button', { name: 'Add umpire' }).click();
  // The register id is a name slug: once erased it must not show either.
  const umpireId = ((await (await created).json()) as { id: string }).id;
  expect(umpireId).toBeTruthy();
  await expect(add).toHaveCount(0);
  await table
    .getByRole('row')
    .filter({ hasText: OLD_NAME })
    .getByRole('button', { name: 'Edit' })
    .click();
  const edit = page.getByRole('group', { name: `Edit ${OLD_NAME}` });
  await edit.getByLabel('Sheet name').fill(NEW_NAME);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toHaveCount(0);
  const row = table.getByRole('row').filter({ hasText: NEW_NAME });
  await expect(row).toBeVisible();

  // History: both entries, by this admin, with the name before and after.
  await row.getByRole('button', { name: `History: ${NEW_NAME}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(auditRow(dialog, 'Edited umpire')).toHaveCount(1);
  await expect(auditRow(dialog, 'Added umpire')).toHaveCount(1);
  await expect(dialog.getByTestId('audit-row')).toHaveCount(2);
  for (const r of await dialog.getByTestId('audit-row').all())
    await expect(r).toContainText(ADMIN.email);
  await auditRow(dialog, 'Edited umpire')
    .getByRole('button', { name: /Show changes/ })
    .click();
  await expectNameChange(dialog, OLD_NAME, NEW_NAME);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Activity: filtered to this admin, the edit expands to the same values.
  await openNav(page, 'Activity');
  await filterToAdmin(page);
  const edited = auditRow(page, 'Edited umpire').filter({ hasText: NEW_NAME });
  await expect(edited).toHaveCount(1);
  await expect(edited).toContainText(ADMIN.email);
  await expect(auditRow(page, 'Added umpire').filter({ hasText: OLD_NAME })).toHaveCount(1);
  await edited.getByRole('button', { name: /Show changes/ }).click();
  await expectNameChange(page, OLD_NAME, NEW_NAME);

  // Operator portal: the client's Activity shows the same entry, attributed to the admin and
  // visible to the union (not an operators-only entry).
  const op = await operatorPage(browser);
  try {
    await op.goto(`/platform/tenants/${TENANT}/activity`);
    await expect(op.getByRole('heading', { name: /activity/i })).toBeVisible();
    await filterToAdmin(op);
    const seen = auditRow(op, 'Edited umpire').filter({ hasText: NEW_NAME });
    await expect(seen).toHaveCount(1);
    await expect(seen).toContainText(ADMIN.email);
    await expect(seen).not.toContainText('Operators only');
    await expect(seen).not.toContainText('Platform operator');
    await seen.getByRole('button', { name: /Show changes/ }).click();
    await expectNameChange(op, OLD_NAME, NEW_NAME);
  } finally {
    await op.context().close();
  }

  // Delete the umpire (typed confirmation).
  await openNav(page, 'Umpires');
  await table.getByRole('row').filter({ hasText: NEW_NAME }).getByTestId('official-delete').click();
  const confirm = page.getByTestId('official-delete-confirm');
  await expect(confirm).toBeDisabled();
  await page.getByTestId('official-delete-typed').fill(NEW_NAME);
  await confirm.click();
  await expect(page.getByTestId('officials-notice')).toContainText(`${NEW_NAME} deleted`);
  await expect(table.getByRole('row').filter({ hasText: NEW_NAME })).toHaveCount(0);

  // Activity keeps the entries, but the names are gone.
  await openNav(page, 'Activity');
  await filterToAdmin(page);
  const feed = page.getByRole('table', { name: 'Activity' });
  await expect(auditRow(page, 'Deleted umpire')).toHaveCount(1);
  await expect(auditRow(page, 'Edited umpire')).toHaveCount(1);
  await expect(auditRow(page, 'Added umpire')).toHaveCount(1);
  await expect(auditRow(page, 'Edited umpire')).toContainText('Removed');
  await expect(auditRow(page, 'Added umpire')).toContainText('Removed');
  // The delete's own entry reads "Removed" too, never the slug id.
  await expect(auditRow(page, 'Deleted umpire')).toContainText('Removed');
  await expect(auditRow(page, 'Deleted umpire')).not.toContainText(umpireId);
  await expect(feed).not.toContainText(OLD_NAME);
  await expect(feed).not.toContainText(NEW_NAME);
  await expect(feed).not.toContainText(umpireId);
  await auditRow(page, 'Edited umpire')
    .getByRole('button', { name: /Show changes/ })
    .click();
  await expect(nameChangeRow(page)).toContainText('Removed');
  await expect(feed).not.toContainText(OLD_NAME);
  await expect(feed).not.toContainText(NEW_NAME);

  // The API agrees (as this admin, the identity the UI used): no entry carries either name.
  const res = await request.get(
    `${API_BASE}/admin/audit?actor=${encodeURIComponent(ADMIN.email)}&type=umpire`,
    {
      headers: {
        'x-tenant': TENANT,
        'x-dev-auth': encodeDevAuth(ADMIN),
      },
    },
  );
  expect(res.ok(), `GET /admin/audit → ${res.status()}`).toBeTruthy();
  const body = await res.text();
  // Non-vacuous: this run's three entries are in the page …
  const page1 = JSON.parse(body) as {
    items: Array<{ action: string; actor: { email?: string }; targets: Array<{ id: string }> }>;
  };
  const ours = page1.items.filter(
    (e) => e.actor.email === ADMIN.email && e.targets.some((t) => t.id === umpireId),
  );
  expect(ours.map((e) => e.action).sort()).toEqual([
    'umpire.create',
    'umpire.delete',
    'umpire.update',
  ]);
  // … and none of them (nor anything else in the page) carries either name.
  expect(body).not.toContain(OLD_NAME);
  expect(body).not.toContain(NEW_NAME);
});
