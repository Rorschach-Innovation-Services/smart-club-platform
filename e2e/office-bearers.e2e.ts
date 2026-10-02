import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, RUN, dismissOnboarding, operatorAuth, tenantAdminAuth } from './helpers';

/**
 * School-vertical office bearers, end to end through the REAL local stack. In a football
 * (school) tenant:
 *
 *   - the affiliation form no longer asks for the Principal's ID number or term dates (a
 *     cricket-only governance capture), and refuses to submit until the Director of Academics'
 *     name, cell and email are captured;
 *   - the School Leadership roster modal on the school home keeps "Submit roster" disabled
 *     without the Director of Academics, and the exco route enforces the same rule server-side.
 *
 * Seeding mirrors football-vertical.e2e.ts: a RUN-unique football tenant through the operator
 * routes, one school playing Boys U15, with the Principal, Director of Sport and Director of
 * Football already on record — only the Director of Academics is missing.
 */
test.describe.configure({ mode: 'serial' });

const TENANT = `fbob-${RUN}`;
const LEAGUE_KEY = 'boys-u15';
const SCHOOL_NAME = `Bearers High ${RUN}`;
let schoolId = '';

const operatorHeaders = { 'content-type': 'application/json', 'x-dev-auth': operatorAuth() };
const tenantHeaders = {
  'content-type': 'application/json',
  'x-tenant': TENANT,
  'x-dev-auth': tenantAdminAuth(TENANT),
};
const bearer = (who: string) => ({
  name: `${who} Person`,
  cell: '0821112222',
  email: `${who.toLowerCase()}@bearers.example`,
});

async function getSchool(
  request: APIRequestContext,
): Promise<{ version: number; affiliation?: string; exco?: Record<string, any> }> {
  const res = await request.get(`${API_BASE}/clubs/${schoolId}`, { headers: tenantHeaders });
  expect(res.ok(), `GET /clubs/${schoolId} → ${res.status()}`).toBeTruthy();
  return res.json();
}

test.beforeAll(async ({ request }) => {
  const created = await request.post(`${API_BASE}/platform/tenants`, {
    headers: operatorHeaders,
    data: {
      slug: TENANT,
      branding: { name: `Bearers Schools ${RUN}` },
      submissionDeadline: '2027-03-01',
      sport: 'football',
      seasonLabel: '2027',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const configured = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operatorHeaders,
    data: {
      districts: ['North', 'South'],
      leagues: [{ key: LEAGUE_KEY, label: 'Boys U15', group: 'Boys', district: 'All districts' }],
    },
  });
  expect(configured.status(), await configured.text()).toBe(200);
  const club = await request.post(`${API_BASE}/platform/tenants/${TENANT}/clubs`, {
    headers: operatorHeaders,
    data: { name: SCHOOL_NAME, district: 'North' },
  });
  expect(club.ok(), `create school → ${club.status()} ${await club.text()}`).toBeTruthy();
  schoolId = ((await club.json()) as { id: string }).id;

  const { version } = await getSchool(request);
  const patched = await request.patch(`${API_BASE}/clubs/${schoolId}`, {
    headers: tenantHeaders,
    data: {
      leagues: [LEAGUE_KEY],
      ground: { venue: 'Bearers Field', address: '1 Field Road, Cape Town' },
      exco: {
        chair: bearer('Principal'),
        sec: bearer('Sport'),
        tre: bearer('Football'),
      },
      version,
    },
  });
  expect(patched.ok(), `PATCH school → ${patched.status()} ${await patched.text()}`).toBeTruthy();
});

async function signInAsSchoolRep(page: Page): Promise<void> {
  await page.goto(`/?tenant=${TENANT}`);
  const signOut = page.getByRole('button', { name: 'Sign out' });
  if (await signOut.isVisible().catch(() => false)) await signOut.click();
  const picker = page.locator('select.field-select').first();
  await expect(picker).toBeVisible();
  await picker.selectOption('rep');
  await page.getByPlaceholder('ukzn, clares').fill(schoolId);
  await page.getByRole('button', { name: 'Enter as rep' }).click();
}

test('the school affiliation form drops Principal ID / term and will not submit without a Director of Academics', async ({
  page,
  request,
}) => {
  const before = await getSchool(request);
  await signInAsSchoolRep(page);
  await page.goto(`/club/${schoolId}/affiliation?tenant=${TENANT}`);
  await dismissOnboarding(page);

  const form = page.getByRole('dialog', { name: '2027 Affiliation Form' });
  await expect(form).toBeVisible();
  const stepButton = (name: string) =>
    page.getByRole('button', { name: new RegExp(`STEP \\d\\s*${name}`) });

  await stepButton('School Leadership').click();
  await expect(form.getByText(/^Director of Academics\*$/)).toBeVisible();
  await expect(form.getByText(/^Principal\*?$/)).toBeVisible();
  for (const gone of ['ID Number', 'Term Start', 'Term End'])
    await expect(form.getByText(gone, { exact: true }), `${gone} is not asked`).toHaveCount(0);

  await stepButton('Leagues & Coaches').click();
  await form.getByRole('button', { name: 'Submit affiliation' }).click();
  await expect(
    page.getByText('Add the Director of Academics’s name, cell and email'),
  ).toBeVisible();
  // Sent back to the leadership step; nothing was submitted.
  await expect(form.getByText(/^Director of Academics\*$/)).toBeVisible();
  const after = await getSchool(request);
  expect(after.affiliation).toBe(before.affiliation);
  expect(after.exco?.vc).toBeUndefined();
});

test('the School Leadership roster needs a Director of Academics to submit — in the modal and on the server', async ({
  page,
  request,
}) => {
  // Server: the stored roster lacks a Director of Academics, so a roster save is refused.
  const refused = await request.post(`${API_BASE}/clubs/${schoolId}/exco`, {
    headers: tenantHeaders,
    data: { chair: bearer('Principal') },
  });
  expect(refused.status()).toBe(400);
  expect(await refused.text()).toMatch(/Director of Academics name, cell and email are required/);

  await signInAsSchoolRep(page);
  await page.goto(`/club/${schoolId}?tenant=${TENANT}`);
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Edit school leadership' }).click();

  const modal = page.locator('.ob-modal', { hasText: 'School Leadership Roster' });
  await expect(modal).toBeVisible();
  const submit = modal.getByRole('button', { name: 'Submit roster' });
  await expect(submit).toBeDisabled();
  await expect(modal.getByText(/Director of Academics are required to submit/)).toBeVisible();

  // The role card is the innermost block holding both its title and its inputs.
  const academics = modal
    .locator('div')
    .filter({ has: page.getByText(/^Director of Academics\*$/) })
    .filter({ has: page.getByPlaceholder('Name & surname') })
    .last();
  await academics.getByPlaceholder('Name & surname').fill('Academics Person');
  await academics.getByPlaceholder('0XX XXX XXXX').fill('0823334444');
  await academics.getByPlaceholder('name@club.co.za').fill('academics@bearers.example');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(modal).toHaveCount(0);

  const { exco } = await getSchool(request);
  expect(exco?.vc).toMatchObject({ name: 'Academics Person', email: 'academics@bearers.example' });
  // The per-role merge kept the bearers already on record.
  expect(exco?.chair).toMatchObject(bearer('Principal'));
  expect(exco?.tre).toMatchObject(bearer('Football'));
});
