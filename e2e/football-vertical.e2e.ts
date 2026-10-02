import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  API_BASE,
  RUN,
  signInAsRep,
  dismissOnboarding,
  mintRegLink,
  operatorAuth,
  tenantAdminAuth,
} from './helpers';

/**
 * End-to-end coverage of the Smart School (football) vertical: one platform, a football
 * tenant beside the cricket ones. A tenant's `sport` selects a code-defined profile —
 * "School" terminology, school-leadership role labels, football positions, CAF/UEFA/SAFA
 * coaching bodies — and switches off the veterans / CQI / compliance / clearances modules.
 *
 * Tenant plumbing in the local stack: the SPA resolves its tenant from `?tenant=` on a bare
 * localhost host (src/config.ts) — read once per page load — so every page.goto into the
 * football tenant carries it; the dev sign-in picker then mints a membership for THAT tenant.
 * API calls carry the slug in `x-tenant`.
 *
 * Seeding: test 1 drives the operator's CreateTenantWizard for real and checks what it wrote.
 * The school-facing tests run against a SEPARATE football tenant seeded in beforeAll through
 * the same operator routes the portal calls (POST /platform/tenants, PUT
 * /platform/tenants/:slug, POST /platform/tenants/:slug/clubs), so they do not depend on the
 * wizard test's outcome. Both tenants are run-unique and harmless residue in the shared DB.
 */

const operatorHeaders = { 'content-type': 'application/json', 'x-dev-auth': operatorAuth() };
const tenantHeaders = (tenant: string) => ({
  'content-type': 'application/json',
  'x-tenant': tenant,
  'x-dev-auth': tenantAdminAuth(tenant),
});

// Slugs: lowercase letter first, letters/digits/hyphens. RUN is base36 + digits.
const FOOTBALL = `fb-${RUN}`;
const WIZARD_SLUG = `fbw-${RUN}`;
const LEAGUE_KEY = 'boys-u15';
const SCHOOL_NAME = `Alpha High ${RUN}`;
let schoolId = '';

// The dolphins demo club the cricket regression signs into ('complete' affiliation, so no
// onboarding overlay) — the same one the veterans spec uses.
const CRICKET_CLUB = 'ukzn';

async function seedFootballTenant(request: APIRequestContext): Promise<string> {
  const created = await request.post(`${API_BASE}/platform/tenants`, {
    headers: operatorHeaders,
    data: {
      slug: FOOTBALL,
      branding: { name: `Cape Schools Football ${RUN}` },
      submissionDeadline: '2027-03-01',
      sport: 'football',
      seasonLabel: '2027',
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const configured = await request.put(`${API_BASE}/platform/tenants/${FOOTBALL}`, {
    headers: operatorHeaders,
    data: {
      districts: ['North', 'South', 'East', 'West', 'CBD & Atlantic Seaboard'],
      leagues: [{ key: LEAGUE_KEY, label: 'Boys U15', group: 'Boys', district: 'All districts' }],
    },
  });
  expect(configured.status(), await configured.text()).toBe(200);

  const club = await request.post(`${API_BASE}/platform/tenants/${FOOTBALL}/clubs`, {
    headers: operatorHeaders,
    data: { name: SCHOOL_NAME, district: 'North' },
  });
  expect(club.ok(), `create school → ${club.status()} ${await club.text()}`).toBeTruthy();
  const { id } = (await club.json()) as { id: string };

  // The school plays Boys U15, so the affiliation form's step 3 shows its coach banner.
  const current = await request.get(`${API_BASE}/clubs/${id}`, {
    headers: tenantHeaders(FOOTBALL),
  });
  expect(current.ok(), `GET /clubs/${id} → ${current.status()}`).toBeTruthy();
  const { version } = (await current.json()) as { version: number };
  const patched = await request.patch(`${API_BASE}/clubs/${id}`, {
    headers: tenantHeaders(FOOTBALL),
    data: { leagues: [LEAGUE_KEY], version },
  });
  expect(patched.ok(), `PATCH leagues → ${patched.status()} ${await patched.text()}`).toBeTruthy();
  return id;
}

/** Dev sign-in into a NON-default tenant: the picker reads the tenant the page loaded with. */
async function signInTo(
  page: Page,
  tenant: string,
  role: 'admin' | 'rep' | 'operator',
  clubId?: string,
) {
  await page.goto(`/?tenant=${tenant}`);
  // A previous dev identity persists in localStorage — sign it out first (as signInAsRep does).
  const signOut = page.getByRole('button', { name: 'Sign out' });
  const picker = page.locator('select.field-select').first();
  // Wait for the page to settle on one or the other: checking `signOut` the instant after
  // goto races the authed app's first render and can miss a still-signed-in identity.
  await expect(signOut.or(picker).first()).toBeVisible();
  if (await signOut.isVisible().catch(() => false)) await signOut.click();
  await expect(picker).toBeVisible();
  await picker.selectOption(role);
  if (role === 'rep') await page.getByPlaceholder('ukzn, clares').fill(clubId ?? '');
  await page.getByRole('button', { name: `Enter as ${role}` }).click();
}

/** The primary nav's labels, in display order (the nav sorts them alphabetically). */
async function navLabels(page: Page): Promise<string[]> {
  const labels = page.locator('aside.nav .nav-item .ni-label');
  await expect(labels.first()).toBeVisible();
  return labels.allInnerTexts();
}

test.beforeAll(async ({ request }) => {
  schoolId = await seedFootballTenant(request);
});

test('an operator creates a football client through the wizard, with its own season label', async ({
  page,
  request,
}) => {
  await signInTo(page, 'dolphins', 'operator');
  await page.goto('/platform/new');

  // Step 1 · Slug
  await page.getByPlaceholder('sharks').fill(WIZARD_SLUG);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2 · Identity — sport + season label live here.
  await page.getByPlaceholder('e.g. Sharks Cricket Union').fill(`Wizard Schools ${RUN}`);
  const sport = page
    .locator('.field', { has: page.locator('.field-label', { hasText: /^Sport$/ }) })
    .locator('select');
  await sport.selectOption('football');
  // Choosing football spells out what the client starts without.
  await expect(page.getByText('A football client starts differently:')).toBeVisible();
  await page.getByPlaceholder('e.g. 2027').fill('2027');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3 · Logo, Step 4 · Brand — defaults.
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 5 · Deadline — the summary names the sport and season label before creating.
  await page.locator('input[type="date"]').fill('2027-03-01');
  await expect(page.getByText('football', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create client' }).click();

  // Step 6 · First admin — skipped (a real admin grant provisions a Cognito user).
  await expect(page.getByText('is created. Grant its first administrator')).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // What the wizard wrote.
  const res = await request.get(`${API_BASE}/platform/tenants/${WIZARD_SLUG}`, {
    headers: operatorHeaders,
  });
  expect(res.ok(), `GET /platform/tenants/${WIZARD_SLUG} → ${res.status()}`).toBeTruthy();
  const cfg = (await res.json()) as {
    sport?: string;
    seasonLabel?: string;
    requiredDocs?: unknown[];
    features?: Record<string, boolean>;
  };
  expect(cfg.sport).toBe('football');
  expect(cfg.seasonLabel).toBe('2027');
  // A football client starts with an explicitly EMPTY document catalogue (absent would fall
  // back to the cricket defaults).
  expect(cfg.requiredDocs).toEqual([]);
});

test('the school portal says "School" and shows only Home, Affiliation, Fixtures and Players', async ({
  page,
}) => {
  await signInTo(page, FOOTBALL, 'rep', schoolId);
  await page.goto(`/club/${schoolId}?tenant=${FOOTBALL}`);
  await dismissOnboarding(page);

  await expect(page.getByText(`School Portal · ${SCHOOL_NAME}`)).toBeVisible();
  expect(await navLabels(page)).toEqual([
    'Affiliation',
    'Fixtures',
    'Home',
    'Need Help?',
    'Players',
  ]);

  // A hand-typed CQI deep link renders home, not a broken page (its API 403s).
  await page.goto(`/club/${schoolId}/cqi?tenant=${FOOTBALL}`);
  await dismissOnboarding(page);
  await expect(page.getByText(`School Portal · ${SCHOOL_NAME}`)).toBeVisible();
  await expect(page.locator('aside.nav .nav-item.active .ni-label')).toHaveText('Home');
  // Same for compliance documents.
  await page.goto(`/club/${schoolId}/documents?tenant=${FOOTBALL}`);
  await dismissOnboarding(page);
  await expect(page.locator('aside.nav .nav-item.active .ni-label')).toHaveText('Home');
});

test('the affiliation form walks School Details → School Leadership → Leagues & Coaches', async ({
  page,
  request,
}) => {
  await signInTo(page, FOOTBALL, 'rep', schoolId);
  await page.goto(`/club/${schoolId}/affiliation?tenant=${FOOTBALL}`);
  await dismissOnboarding(page);

  // The form opens as a dialog headed with the tenant's own season label.
  const form = page.getByRole('dialog', { name: '2027 Affiliation Form' });
  await expect(form).toBeVisible();
  const stepButton = (name: string) =>
    page.getByRole('button', { name: new RegExp(`STEP \\d\\s*${name}`) });
  for (const name of ['School Details', 'School Leadership', 'Leagues & Coaches'])
    await expect(stepButton(name)).toBeVisible();
  await expect(stepButton('Executive Committee')).toHaveCount(0);

  // Step 1 — the ground takes an address and a number of fields.
  await expect(form.locator('.field-label', { hasText: /^School Name/ })).toBeVisible();
  await page.getByPlaceholder('e.g. Berea Rovers Oval').fill('Alpha High Field');
  const address = page.getByPlaceholder('Street, suburb, city');
  await expect(address).toBeVisible();
  await address.fill('1 Main Road, Rondebosch, Cape Town');
  await expect(
    page.locator('.field-label', { hasText: /^Number of fields\s*\(optional\)$/ }),
  ).toBeVisible();
  const fields = page.getByPlaceholder('e.g. 2');
  await fields.fill('3');
  await expect(address).toHaveValue('1 Main Road, Rondebosch, Cape Town');
  await expect(fields).toHaveValue('3');

  // Step 2 — the four leadership roles plus additional members.
  await stepButton('School Leadership').click();
  for (const role of [
    'Principal',
    'Director of Sport',
    'Director of Football',
    'Director of Academics',
  ])
    // Row titles render as "<label>*" for the required roles.
    await expect(form.getByText(new RegExp(`^${role}\\*?$`))).toBeVisible();
  await expect(form.getByText(/^Chairperson\*?$/)).toHaveCount(0);
  await expect(form.getByText('Additional Members', { exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Add another member' })).toBeVisible();

  // Step 3 — a coach for Boys U15 picks CAF/UEFA/SAFA and levels A–D.
  await stepButton('Leagues & Coaches').click();
  await page.getByRole('button', { name: 'Add coach' }).first().click();
  const body = page
    .locator('.field', { has: page.getByText('Coaching Body', { exact: true }) })
    .locator('select')
    .first();
  const level = page
    .locator('.field', { has: page.getByText('Coaching Level', { exact: true }) })
    .locator('select')
    .first();
  await expect(body).toBeVisible();
  expect(await body.locator('option').allInnerTexts()).toEqual(['None', 'CAF', 'UEFA', 'SAFA']);
  expect(await level.locator('option').allInnerTexts()).toEqual(['None', 'A', 'B', 'C', 'D']);

  // The server accepts the ground's number of fields on the school's own record.
  const club = await request.get(`${API_BASE}/clubs/${schoolId}`, {
    headers: tenantHeaders(FOOTBALL),
  });
  const { version, ground } = (await club.json()) as { version: number; ground?: object };
  const saved = await request.patch(`${API_BASE}/clubs/${schoolId}`, {
    headers: tenantHeaders(FOOTBALL),
    data: {
      ground: {
        ...(ground ?? {}),
        venue: 'Alpha High Field',
        address: '1 Main Road',
        pitchCount: 3,
      },
      version,
    },
  });
  expect(saved.ok(), `PATCH ground → ${saved.status()} ${await saved.text()}`).toBeTruthy();
  expect(((await saved.json()) as { ground: { pitchCount?: number } }).ground.pitchCount).toBe(3);
});

test('the public registration page asks for a position — no cricket profile, history or veterans', async ({
  page,
  request,
}) => {
  const token = await mintRegLinkFor(request, FOOTBALL, schoolId);
  await page.goto(`/register/${schoolId}?t=${encodeURIComponent(token)}&tenant=${FOOTBALL}`);

  await expect(page.getByText('Register as a player for the 2027 season.')).toBeVisible();
  const position = page.getByLabel('Position');
  await expect(position).toBeVisible();
  const options = await position.locator('option').allInnerTexts();
  expect(options).toContain('Goalkeeper');
  expect(options).toContain('Striker');

  await expect(page.getByText('Batting hand')).toHaveCount(0);
  await expect(page.getByText('Bowling hand')).toHaveCount(0);
  await expect(page.getByText('Batting type')).toHaveCount(0);
  await expect(page.getByText('Registration history')).toHaveCount(0);
  await expect(page.getByText('Are you playing veterans cricket for another club?')).toHaveCount(0);
});

test('the league admin console hides the disabled modules and rolls up two phases', async ({
  page,
}) => {
  await signInTo(page, FOOTBALL, 'admin');
  await page.goto(`/admin/dashboard?tenant=${FOOTBALL}`);

  const labels = await navLabels(page);
  for (const hidden of [
    'Compliance Docs',
    'CQI Submissions',
    'Clearances',
    'Registration Reviews',
    'Veterans Requests',
    'Umpires',
    "Captain's reports",
  ])
    expect(labels, `${hidden} is not in the football admin nav`).not.toContain(hidden);
  expect(labels).toContain('All Schools');
  expect(labels).toContain('Fixtures & Venues');

  await expect(
    page.getByText('Cohort progress through the 2-phase smart integration journey'),
  ).toBeVisible();
  await expect(page.locator('.phase-step')).toHaveCount(2);
  await expect(page.getByText('PHASE 01')).toBeVisible();
  await expect(page.getByText('PHASE 02')).toBeVisible();

  // Deep links into a disabled module fall back to the dashboard.
  await page.goto(`/admin/cqi?tenant=${FOOTBALL}`);
  await expect(page.locator('aside.nav .nav-item.active .ni-label')).toHaveText('Cohort Dashboard');
});

test('a cricket tenant in the same run keeps its cricket nav, labels and registration form', async ({
  page,
  request,
}) => {
  // Club rep: every module on, "Club" wording, cricket affiliation steps.
  await signInAsRep(page, CRICKET_CLUB);
  await page.goto(`/club/${CRICKET_CLUB}`);
  await dismissOnboarding(page);
  await expect(page.getByText(/^Club Portal · /).first()).toBeVisible();
  const repNav = await navLabels(page);
  for (const item of [
    'Affiliation',
    'CQI',
    'Clearances',
    'Documents',
    'Fixtures',
    'Home',
    'Players',
  ])
    expect(repNav, `${item} is in the cricket club nav`).toContain(item);
  await page.goto(`/club/${CRICKET_CLUB}/affiliation`);
  await expect(page.getByRole('button', { name: /STEP 2\s*Executive Committee/ })).toBeVisible();

  // Public registration: batting/bowling profile and the registration-history section.
  const token = await mintRegLink(request, CRICKET_CLUB);
  await page.goto(`/register/${CRICKET_CLUB}?t=${encodeURIComponent(token)}`);
  await expect(page.getByText('Batting hand')).toBeVisible();
  await expect(page.getByText('Registration history')).toBeVisible();
  await expect(page.getByLabel('Position')).toHaveCount(0);

  // Admin: the full module nav and the five-phase roll-up.
  await signInTo(page, 'dolphins', 'admin');
  await page.goto('/admin/dashboard');
  const adminNav = await navLabels(page);
  for (const item of [
    'All Clubs',
    'Compliance Docs',
    'CQI Submissions',
    'Clearances',
    'Registration Reviews',
    'Veterans Requests',
    'Umpires',
    "Captain's reports",
  ])
    expect(adminNav, `${item} is in the cricket admin nav`).toContain(item);
  await expect(
    page.getByText('Cohort progress through the 5-phase smart integration journey'),
  ).toBeVisible();
});

/** Mint a school's player reg-link token in a non-default tenant (admin). */
async function mintRegLinkFor(
  request: APIRequestContext,
  tenant: string,
  clubId: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/clubs/${clubId}/reg-link`, {
    headers: tenantHeaders(tenant),
  });
  expect(
    res.ok(),
    `POST /clubs/${clubId}/reg-link → ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const { playerRegLink } = (await res.json()) as { playerRegLink: { token: string } };
  return playerRegLink.token;
}
