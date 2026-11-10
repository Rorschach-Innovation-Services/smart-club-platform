import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_BASE,
  RUN,
  adminAuthHeader,
  apiHeaders,
  repAuthHeader,
  signInAsAdmin,
} from './helpers';
import { createSeries, fixture, getSeries, ground, openAdminSeries } from './fixtures-helpers';

/**
 * Delete (erase) an umpire / scorer on the REAL local stack (docs/api/officials.md): the
 * dialog shows the preview counts and is gated on the typed name; afterwards the person is gone
 * from every tab and picker, the upcoming fixture has lost them and the played one reads
 * "Removed umpire" / "Removed scorer". A club rep cannot reach the DELETE.
 */
test.describe.configure({ mode: 'serial' });

const admin = () => apiHeaders(adminAuthHeader());
type Role = 'umpire' | 'scorer';
const plural = (r: Role) => (r === 'umpire' ? 'umpires' : 'scorers');
const Title = (r: Role) => (r === 'umpire' ? 'Umpires' : 'Scorers');

interface FixtureWithOfficials {
  id: string;
  officials?: {
    umpires?: Array<{ umpireId: string; name: string }>;
    scorers?: Array<{ scorerId: string; name: string }>;
  };
}

async function postJson<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(`${API_BASE}${path}`, { headers: admin(), data });
  expect(res.ok(), `POST ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function openRegister(page: Page, role: Role) {
  await page.locator('aside.nav .nav-item', { hasText: Title(role) }).click();
  await expect(page.getByRole('heading', { name: Title(role) })).toBeVisible();
  return page.getByRole('table', { name: Title(role) });
}

for (const role of ['umpire', 'scorer'] as const) {
  test(`${role}: Delete previews, needs the typed name, vacates upcoming and anonymises played`, async ({
    page,
    request,
  }) => {
    const name = `E2E Gone ${role} ${RUN}`;
    const person = await postJson<{ id: string }>(request, `/${plural(role)}`, {
      displayName: name,
      phone: '0829990000',
    });
    // Someone else stays on the register, so the Active tab still has a Ratings cell to check.
    const keepName = `E2E Keep ${role} ${RUN}`;
    await postJson(request, `/${plural(role)}`, { displayName: keepName });
    const past = `f-er-past-${role}-${RUN}`;
    const next = `f-er-next-${role}-${RUN}`;
    const series = await createSeries(request, {
      name: `E2E Erase ${role} ${RUN}`,
      fixtures: [
        fixture({ id: past, date: '2025-02-01', venueOverride: ground(`ErasePast${role}`) }),
        fixture({ id: next, date: '2027-03-01', venueOverride: ground(`EraseNext${role}`) }),
      ],
    });
    for (const fx of [past, next]) {
      const res = await request.put(`${API_BASE}/series/${series.id}/fixtures/${fx}/officials`, {
        headers: admin(),
        data:
          role === 'umpire'
            ? { umpires: [{ umpireId: person.id }] }
            : { scorers: [{ scorerId: person.id }] },
      });
      expect(res.ok(), `PUT officials → ${res.status()} ${await res.text()}`).toBeTruthy();
    }

    // A club rep is refused both the preview and the DELETE.
    const rep = apiHeaders(repAuthHeader('berea'));
    expect(
      (
        await request.get(`${API_BASE}/${plural(role)}/${person.id}/erase-preview`, {
          headers: rep,
        })
      ).status(),
    ).toBe(403);
    expect(
      (await request.delete(`${API_BASE}/${plural(role)}/${person.id}`, { headers: rep })).status(),
    ).toBe(403);

    await signInAsAdmin(page);
    const table = await openRegister(page, role);
    const row = table.getByRole('row').filter({ hasText: name });
    await expect(row.locator('td.ump-num')).toHaveText('2');
    await row.getByTestId('official-delete').click();
    const dialog = page.getByTestId('official-delete-dialog');
    await expect(page.getByTestId('official-delete-summary')).toHaveText(
      role === 'umpire'
        ? 'Their personal details will be permanently erased. They will be removed from 1 upcoming fixture. 1 past appointment and their ratings are kept under “Removed umpire”.'
        : 'Their personal details will be permanently erased. They will be removed from 1 upcoming fixture. 1 past appointment is kept under “Removed scorer”.',
    );
    await expect(dialog.getByRole('list', { name: 'Fixtures losing this official' })).toContainText(
      '1 Mar 2027',
    );
    const confirm = page.getByTestId('official-delete-confirm');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('official-delete-typed').fill(name.slice(0, -1));
    await expect(confirm).toBeDisabled();
    await page.getByTestId('official-delete-typed').fill(name);
    await confirm.click();
    await expect(page.getByTestId('officials-notice')).toContainText(`${name} deleted`);

    // Gone from every tab; the stub never shows.
    const placeholder = role === 'umpire' ? 'Removed umpire' : 'Removed scorer';
    for (const tab of [/^Active/, /^Pending/, /^Inactive/, /^All/]) {
      await page.locator('.filter-row').getByRole('button', { name: tab }).click();
      await expect(table.getByRole('row').filter({ hasText: name })).toHaveCount(0);
      await expect(table.getByRole('row').filter({ hasText: placeholder })).toHaveCount(0);
    }
    if (role === 'umpire') {
      // The ratings column still renders for everyone else.
      await page
        .locator('.filter-row')
        .getByRole('button', { name: /^Active/ })
        .click();
      await expect(table.getByRole('columnheader', { name: 'Ratings' })).toBeVisible();
      await expect(
        table.getByRole('row').filter({ hasText: keepName }).locator('td[data-label="Ratings"]'),
      ).toContainText('No ratings yet');
    }

    // The fixtures: upcoming vacated, played anonymised.
    const after = await getSeries(request, series.id);
    const fxs = after.fixtures as unknown as FixtureWithOfficials[];
    const list = (id: string) => {
      const o = fxs.find((f) => f.id === id)?.officials;
      return (role === 'umpire' ? o?.umpires : o?.scorers) ?? [];
    };
    expect(list(next)).toEqual([]);
    expect(list(past).map((x) => x.name)).toEqual([placeholder]);

    const detail = await openAdminSeries(page, series.name);
    await expect(detail.locator('.ump-cell', { hasText: placeholder })).toHaveCount(1);
    await expect(detail.getByText(name)).toHaveCount(0);

    // Not offered by the picker any more.
    const cell = detail.locator('.ump-cell').last();
    const kind = role === 'umpire' ? 'umpires' : 'scorers';
    await cell.getByRole('button', { name: `Assign ${kind}` }).click();
    const picker = cell.getByRole('group', { name: `Assign ${kind}` });
    await picker
      .getByRole('combobox', { name: role === 'umpire' ? 'Umpire 1' : 'Scorer', exact: true })
      .fill('Removed');
    await expect(picker.getByRole('option')).toHaveCount(0);
    await picker
      .getByRole('combobox', { name: role === 'umpire' ? 'Umpire 1' : 'Scorer', exact: true })
      .fill(`Gone ${role}`);
    await expect(picker.getByRole('option')).toHaveCount(0);
  });
}
