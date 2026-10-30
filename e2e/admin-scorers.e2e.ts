import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, RUN, adminAuthHeader, apiHeaders, signInAsAdmin } from './helpers';
import { createSeries, fixture, getSeries, ground } from './fixtures-helpers';

/**
 * Admin Scorers page (cricket-only register) on the REAL local stack: add a scorer through the
 * page, merge a duplicate that holds a fixture appointment (the appointment moves to the target,
 * the fixture's umpires stay put), and the fuzzy player search on /admin/players.
 */
test.describe.configure({ mode: 'serial' });

const admin = () => apiHeaders(adminAuthHeader());

interface Official {
  umpireId?: string;
  scorerId?: string;
}
interface FixtureWithOfficials {
  id: string;
  officials?: { umpires?: Official[]; scorers?: Official[] };
}

async function postJson<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(`${API_BASE}${path}`, { headers: admin(), data });
  expect(res.ok(), `POST ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function activeScorerCount(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${API_BASE}/scorers`, { headers: admin() });
  expect(res.ok(), `GET /scorers → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as Array<{ active: boolean }>).filter((s) => s.active).length;
}

async function openScorers(page: Page) {
  await page.locator('aside.nav .nav-item', { hasText: 'Scorers' }).click();
  await expect(page.getByRole('heading', { name: 'Scorers' })).toBeVisible();
  return page.getByRole('table', { name: 'Scorers' });
}

/** A valid 13-digit RSA ID (Luhn check digit), unique per call. */
function rsaId(): string {
  const seq = String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
  const base = `900101${seq}08`;
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return base + String((10 - (sum % 10)) % 10);
}

test('an admin adds a scorer from the Scorers page', async ({ page, request }) => {
  const name = `E2E Scorer Add ${RUN}`;
  await signInAsAdmin(page);
  const table = await openScorers(page);

  await page.getByRole('button', { name: 'Add scorer' }).click();
  const form = page.getByRole('group', { name: 'New scorer' });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Email').fill('e2e-scorer@example.org');
  await form.getByRole('button', { name: 'Add scorer' }).click();
  await expect(form).toHaveCount(0);

  const row = table.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Active');

  const n = await activeScorerCount(request);
  await expect(page.locator('aside.nav .nav-item', { hasText: 'Scorers' })).toContainText(
    String(n),
  );
});

test('merging a scorer moves its appointment and keeps the umpires', async ({ page, request }) => {
  const src = await postJson<{ id: string }>(request, '/scorers', {
    displayName: `E2E Scorer Dup ${RUN}`,
  });
  const dst = await postJson<{ id: string }>(request, '/scorers', {
    displayName: `E2E Scorer Keep ${RUN}`,
  });
  const ump1 = await postJson<{ id: string }>(request, '/umpires', {
    displayName: `E2E Merge Ump A ${RUN}`,
  });
  const ump2 = await postJson<{ id: string }>(request, '/umpires', {
    displayName: `E2E Merge Ump B ${RUN}`,
  });
  const fxId = `f-scm-${RUN}`;
  const series = await createSeries(request, {
    name: `E2E Scorer Merge ${RUN}`,
    fixtures: [fixture({ id: fxId, venueOverride: ground('ScorerMerge') })],
  });
  const put = await request.put(`${API_BASE}/series/${series.id}/fixtures/${fxId}/officials`, {
    headers: admin(),
    data: {
      umpires: [{ umpireId: ump1.id }, { umpireId: ump2.id }],
      scorers: [{ scorerId: src.id }],
    },
  });
  expect(put.ok(), `PUT officials → ${put.status()} ${await put.text()}`).toBeTruthy();

  await signInAsAdmin(page);
  const table = await openScorers(page);
  const srcRow = table.getByRole('row').filter({ hasText: `E2E Scorer Dup ${RUN}` });
  const dstRow = table.getByRole('row').filter({ hasText: `E2E Scorer Keep ${RUN}` });
  await expect(srcRow.locator('td.ump-num')).toHaveText('1');
  await expect(dstRow.locator('td.ump-num')).toHaveText('0');

  await srcRow.getByRole('button', { name: 'Merge…' }).click();
  await srcRow
    .getByRole('combobox', { name: `Merge E2E Scorer Dup ${RUN} into` })
    .selectOption(dst.id);
  await srcRow.getByRole('button', { name: 'Merge', exact: true }).click();

  // The source leaves the Active list; the target now holds the appointment.
  await expect(srcRow).toHaveCount(0);
  await expect(dstRow.locator('td.ump-num')).toHaveText('1');
  await page.getByRole('button', { name: /^Inactive/ }).click();
  const merged = table.getByRole('row').filter({ hasText: `E2E Scorer Dup ${RUN}` });
  await expect(merged).toContainText(`Merged into E2E Scorer Keep ${RUN}`);

  const after = await getSeries(request, series.id);
  const fx = (after.fixtures as unknown as FixtureWithOfficials[]).find((f) => f.id === fxId)!;
  expect(fx.officials?.scorers?.map((s) => s.scorerId)).toEqual([dst.id]);
  expect(fx.officials?.umpires?.map((u) => u.umpireId)).toEqual([ump1.id, ump2.id]);
});

test('player search tolerates a typo and reversed name order', async ({ page, request }) => {
  // A letters-only, run-unique surname (RUN's digits mapped to letters).
  const tag = RUN.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
  const lastName = `Mkhabela${tag}`;
  const firstName = 'Sibusiso';
  await postJson(request, '/clubs/berea/players', {
    firstName,
    lastName,
    idType: 'sa-id',
    idNumber: rsaId(),
    race: 'African',
    gender: 'Male',
    nationality: 'South African',
    cell: '0821234567',
    team: 'premier',
    district: 'Durban Central',
  });

  await signInAsAdmin(page);
  await page.goto('/admin/players');
  // One substitution in the surname ("Mkhabela" → "Mkhebela"), surname typed first.
  const typo = lastName.replace('Mkhabela', 'Mkhebela');
  await page.getByLabel('Search players').fill(`${typo} ${firstName}`);
  await expect(page.getByText(lastName).first()).toBeVisible();
});
