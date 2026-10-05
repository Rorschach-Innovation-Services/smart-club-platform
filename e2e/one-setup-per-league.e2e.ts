import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_BASE, RUN, TENANT, adminAuthHeader, apiHeaders, signInAsAdmin } from './helpers';

/**
 * One setup per league, end to end on the REAL local stack: the operator sets a league up
 * (wizard + structure editor), the admin can only start seasons on set-up leagues, the
 * season follows the live calendar until its first generate and is frozen after, and the
 * generated series carries the structure's name and overs.
 */

const LEAGUE_LABEL = 'Premier League';
const SEASON = `E2E ${RUN}`;

type Json = Record<string, any>;

function operatorAuthHeader(): string {
  return Buffer.from(
    JSON.stringify({
      sub: 'dev-operator',
      email: 'operator@platform.local',
      memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
    }),
  ).toString('base64');
}
const opHeaders = { 'content-type': 'application/json', 'x-dev-auth': operatorAuthHeader() };
const adminHeaders = () => apiHeaders(adminAuthHeader());

async function opGetConfig(request: APIRequestContext): Promise<Json> {
  const res = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: opHeaders });
  expect(res.status()).toBe(200);
  return res.json();
}

async function opPut(request: APIRequestContext, body: Json) {
  const res = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: opHeaders,
    data: body,
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

function leagueByLabel(config: Json, label: string): Json {
  const league = (config.leagues ?? []).find((l: Json) => l.label === label);
  expect(league, `league "${label}" in demo config`).toBeTruthy();
  return league;
}

async function listRuns(request: APIRequestContext): Promise<Json[]> {
  const res = await request.get(`${API_BASE}/season-runs`, { headers: adminHeaders() });
  expect(res.status()).toBe(200);
  return res.json();
}

async function ourRun(request: APIRequestContext, leagueKey: string): Promise<Json> {
  const run = (await listRuns(request)).find(
    (r) => r.leagueKey === leagueKey && r.seasonLabel === SEASON,
  );
  expect(run, 'the season this spec started').toBeTruthy();
  return run!;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "4 Oct" — how the stage narrative prints a block's dates. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Shift the first block of a calendar by `days`, keeping its length (operator PUT). */
async function shiftCalendar(request: APIRequestContext, calendarId: string, days: number) {
  const config = await opGetConfig(request);
  const calendars = (config.calendars ?? []).map((c: Json) =>
    c.id !== calendarId
      ? c
      : {
          ...c,
          blocks: c.blocks.map((b: Json, i: number) =>
            i === 0 ? { ...b, start: addDays(b.start, days), end: addDays(b.end, days) } : b,
          ),
        },
  );
  await opPut(request, { calendars });
  return calendars.find((c: Json) => c.id === calendarId);
}

async function signInAsOperator(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.locator('select.field-select').first().selectOption('operator');
  await page.getByRole('button', { name: 'Enter as operator' }).click();
  await expect(page).toHaveURL(/\/platform/);
  return page;
}

test.describe.configure({ mode: 'serial' });

test('operator sets a league up; admin starts, the calendar follows live until generate, series carries structure name + overs', async ({
  page,
  browser,
  request,
}) => {
  // Deterministic start: the league has no setup (a reused stack may carry one from an
  // earlier run of this spec).
  const before = await opGetConfig(request);
  const league = leagueByLabel(before, LEAGUE_LABEL);
  await opPut(request, {
    leagues: before.leagues.map((l: Json) => {
      if (l.key !== league.key) return l;
      const { setup: _drop, ...rest } = l;
      return rest;
    }),
  });

  // ── Operator: the season wizard creates a calendar and the league's setup ──
  const op = await signInAsOperator(browser);
  await op.goto(`/platform/tenants/${TENANT}`);
  await op.getByRole('button', { name: 'Set up a season' }).first().click();
  await op.getByPlaceholder('e.g. 2026/27').fill(SEASON);
  await op.getByRole('button', { name: 'Continue' }).click();

  await expect(op.getByText('Step 2 of 3')).toBeVisible();
  await op.getByLabel('Add a league').selectOption(LEAGUE_LABEL);
  await op.getByText('Start from a template', { exact: true }).click();
  await op.getByText('Flat round robin', { exact: true }).click();
  // Match format lives only on the structure: step 2 has no overs/format input.
  await expect(op.getByRole('spinbutton', { name: /overs/i })).toHaveCount(0);
  await op.getByRole('button', { name: 'Continue' }).click();

  await expect(op.getByText('Step 3 of 3')).toBeVisible();
  await op.getByRole('button', { name: /^Create season/ }).click();
  await op.getByRole('button', { name: 'Done' }).click();

  const leagueRow = op.getByRole('row').filter({ hasText: LEAGUE_LABEL }).first();
  await expect(leagueRow).toContainText(`Flat round robin · ${SEASON}`);
  await expect(leagueRow.getByRole('button', { name: 'Change setup' })).toBeVisible();

  // No DNS card and no competition-defaults card any more.
  await expect(op.getByText(/DNS/)).toHaveCount(0);
  await expect(op.getByText(/Competition defaults/i)).toHaveCount(0);

  // ── Operator: structure editor opens in Preview; Edit sets overs; Esc asks first ──
  const structureRow = op
    .getByRole('row')
    .filter({ hasText: `${LEAGUE_LABEL} · ${SEASON}` })
    .filter({ has: op.getByRole('button', { name: 'View' }) });
  await structureRow.getByRole('button', { name: 'View' }).click();
  await expect(op.getByText("You're previewing — nothing here changes anything.")).toBeVisible();
  await op.getByRole('button', { name: 'Edit structure' }).click();
  await op.getByRole('spinbutton', { name: 'Overs (optional)' }).fill('20');
  await op.keyboard.press('Escape');
  await expect(
    op.getByText('Discard your unsaved changes and go back to the preview?'),
  ).toBeVisible();
  await op.getByRole('button', { name: 'Keep editing' }).click();
  await op.getByRole('button', { name: /^Save for/ }).click();
  await expect(leagueRow).toContainText('20 overs');

  const afterSetup = await opGetConfig(request);
  const setup = leagueByLabel(afterSetup, LEAGUE_LABEL).setup;
  expect(setup).toBeTruthy();
  const structure = afterSetup.structures.find((s: Json) => s.id === setup.structureId);
  const calendar = afterSetup.calendars.find((c: Json) => c.id === setup.calendarId);
  expect(structure.overs).toBe(20);
  expect(calendar.label).toBe(SEASON);
  await op.context().close();

  // ── Admin: launcher offers only set-up leagues ──
  await signInAsAdmin(page);
  // Seasons & series: the seasons panel the rest of this test works in.
  await page.goto('/admin/fixtures?tab=series');
  await page.getByRole('button', { name: 'Start a season' }).first().click();
  const launcher = page.getByRole('dialog', { name: 'Start a season' });
  const leagueSelect = launcher.getByRole('combobox', { name: 'League' });
  await expect(leagueSelect.locator('option', { hasText: LEAGUE_LABEL }).first()).toBeEnabled();
  await expect(leagueSelect.locator('option[disabled]').first()).toBeAttached();
  await expect(launcher.getByText(/Ask your operator to set this league up/)).toBeVisible();
  await leagueSelect.selectOption({ label: LEAGUE_LABEL });
  await launcher.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('textbox', { name: 'Season' }).fill(SEASON);
  await expect(page.getByText('Flat round robin · 20 overs').first()).toBeVisible();
  await page.getByRole('button', { name: 'Start season' }).click();
  await expect(page.getByText(`${LEAGUE_LABEL} · ${SEASON} started`)).toBeVisible();

  // ── Live calendar until first generate (the stale-dates bug) ──
  let run = await ourRun(request, league.key);
  expect(run.calendarLive).toBe(true);
  expect(run.calendarFrozenAt).toBeFalsy();
  const originalStart = run.calendarSnapshot.blocks[0].start;

  const shifted = await shiftCalendar(request, calendar.id, 7);
  run = await ourRun(request, league.key);
  expect(run.calendarSnapshot.blocks[0].start).toBe(shifted.blocks[0].start);
  expect(run.calendarSnapshot.blocks[0].start).toBe(addDays(originalStart, 7));

  // The admin sees the new dates without restarting the season.
  await page.reload();
  // The run chips only render when more than one season exists (a reused stack).
  const chip = page.getByRole('button', { name: `${LEAGUE_LABEL} · ${SEASON}` });
  if (await chip.count()) await chip.click();
  await expect(
    page.getByText(new RegExp(`Block 1, ${shortDate(addDays(originalStart, 7))} `)).first(),
  ).toBeVisible();
  const genButton = page.getByRole('button', { name: /^Generate \d+ fixtures$/ }).first();
  await expect(genButton).toBeVisible();
  await genButton.click();
  await expect(page.getByText(/Fixtures live as 1 series/).first()).toBeVisible();

  // ── Frozen after generate ──
  run = await ourRun(request, league.key);
  expect(run.calendarLive).toBeFalsy();
  expect(run.calendarFrozenAt).toBeTruthy();
  const frozenStart = run.calendarSnapshot.blocks[0].start;
  expect(frozenStart).toBe(addDays(originalStart, 7));
  await shiftCalendar(request, calendar.id, 7);
  run = await ourRun(request, league.key);
  expect(run.calendarSnapshot.blocks[0].start).toBe(frozenStart);

  // ── The series carries the structure's name and overs ──
  const seriesIds = run.stages.flatMap((s: Json) => (s.groups ?? []).map((g: Json) => g.seriesId));
  expect(seriesIds.filter(Boolean)).toHaveLength(1);
  const res = await request.get(`${API_BASE}/series`, { headers: adminHeaders() });
  expect(res.status()).toBe(200);
  const series = ((await res.json()) as Json[]).find((s) => s.id === seriesIds[0])!;
  expect(series, 'the generated series in the admin list').toBeTruthy();
  expect(series.seriesType).toBe(structure.name);
  expect(series.maxOvers).toBe(20);
  expect(series.seasonRunId).toBe(run.id);
  expect(series.fixtures.length).toBeGreaterThan(0);
  for (const f of series.fixtures) expect(f.date >= frozenStart).toBe(true);
});

test('a stale admin tab cannot wipe or forge a league setup', async ({ request }) => {
  const config = await opGetConfig(request);
  const league = leagueByLabel(config, LEAGUE_LABEL);
  const stored = league.setup;
  expect(stored, 'set up by the previous test').toBeTruthy();

  // Wipe: the admin console PUTs its cached leagues, which predate the setup.
  const wipe = config.leagues.map((l: Json) => {
    const { setup: _s, competitions: _c, ...rest } = l;
    return rest;
  });
  let res = await request.put(`${API_BASE}/tenant/config`, {
    headers: adminHeaders(),
    data: { leagues: wipe },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(leagueByLabel(await opGetConfig(request), LEAGUE_LABEL).setup).toEqual(stored);

  // Forge: an admin cannot point a league at a different structure/calendar.
  const forge = config.leagues.map((l: Json) =>
    l.key === league.key
      ? { ...l, setup: { structureId: 'st-forged', calendarId: 'cal-forged' } }
      : l,
  );
  res = await request.put(`${API_BASE}/tenant/config`, {
    headers: adminHeaders(),
    data: { leagues: forge },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(leagueByLabel(await opGetConfig(request), LEAGUE_LABEL).setup).toEqual(stored);
});

test('starting a season on a league with no setup is refused with setup_missing', async ({
  request,
}) => {
  const config = await opGetConfig(request);
  const bare = (config.leagues ?? []).find((l: Json) => !l.setup);
  expect(bare, 'a league without a setup').toBeTruthy();
  const res = await request.post(`${API_BASE}/season-runs`, {
    headers: adminHeaders(),
    data: { id: `run-e2e-${RUN}`, leagueKey: bare.key, seasonLabel: SEASON },
  });
  expect(res.status()).toBe(400);
  expect(JSON.stringify(await res.json())).toContain('setup_missing');
});
