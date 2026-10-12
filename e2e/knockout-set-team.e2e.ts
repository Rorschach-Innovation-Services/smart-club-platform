import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, adminAuthHeader, apiHeaders, signInAsAdmin, RUN } from './helpers';
import {
  approveAndRelease,
  createReleased,
  createSeries,
  dismissOnboarding,
  fixture,
  getSeries,
  ground,
  openAdminSeries,
  signInAsRep,
} from './fixtures-helpers';

/**
 * Knockout "Set team" (ADR 0018) in the admin fixture editor, against the real local stack:
 * a `tbd:` placeholder reads as its words, Set team puts a series team in (placeholder kept
 * in `slots`), Revert puts the placeholder back, a club from outside the series joins the
 * participants, and a Set team that brings the home ground into a booked slot is refused
 * inline. Seeds through the real API; asserts on visible text and the stored series.
 */

const BEST3 = 'tbd:Best%203rd%20place';
const CUP = 'tbd:Community%20Cup%20winner';
// UKZN's demo club ground (packages/api/seed-data/dolphins.json).
const UKZN_GROUND = 'Howard College Oval';

interface KoFixture {
  id: string;
  home: string;
  away: string;
  slots?: { home?: string; away?: string };
}
interface KoSeries {
  id: string;
  version: number;
  teams: string[];
  participants?: Array<{ teamId: string; clubId: string; name: string }>;
  fixtures: KoFixture[];
}

/** A draft knockout series with placeholder sides (POST /series keeps them as sent). */
async function createKnockout(request: APIRequestContext, name: string, date: string) {
  const id = `e2e-ko-${RUN}-${Math.floor(Math.random() * 1e6)}`;
  const res = await request.post(`${API_BASE}/series`, {
    headers: apiHeaders(adminAuthHeader()),
    data: {
      id,
      name,
      kind: 'series',
      leagueKey: 'premier',
      seriesType: 'T20',
      maxOvers: 20,
      startDate: date,
      teams: ['ukzn', 'clares'],
      participants: [
        { teamId: 'ukzn', clubId: 'ukzn', name: 'UKZN CC' },
        { teamId: 'clares', clubId: 'clares', name: 'Clares CC' },
      ],
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date,
          time: '09:00',
          home: 'win:f0',
          away: BEST3,
          stage: 'Quarter-final',
          venueStatus: 'unresolved',
        },
        {
          id: 'f2',
          round: 2,
          date,
          time: '13:30',
          home: 'win:f1',
          away: CUP,
          stage: 'Final',
          venueStatus: 'unresolved',
        },
      ],
      version: 1,
    },
  });
  expect(res.ok(), `POST /series → ${res.status()} ${await res.text()}`).toBeTruthy();
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await getSeries(request, id)) as unknown as KoSeries;
const fx = (s: KoSeries, id: string) => s.fixtures.find((f) => f.id === id)!;

async function openFixtureRow(page: Page, text: string) {
  const row = page.locator('.fix-table tbody tr', { hasText: text }).first();
  await row.locator('[title="Edit fixture"]').click();
  const editor = page.locator('tr.fix-edit-tr');
  await expect(editor).toBeVisible();
  return editor;
}

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('Set team fills a tbd: placeholder and Revert puts it back', async ({ page, request }) => {
  const name = `E2E KO Set ${RUN}`;
  const id = await createKnockout(request, name, '2027-06-05');
  await openAdminSeries(page, name);

  const editor = await openFixtureRow(page, 'Best 3rd place');
  const away = editor.getByLabel('Away (visitors)');
  await expect(away).toBeDisabled();
  await expect(away).toHaveValue('Best 3rd place');

  await editor.getByLabel('Team to set as away').selectOption('clares');
  await editor.getByRole('button', { name: 'Set away team' }).click();
  await expect(away).toHaveValue('Clares CC');
  await expect(editor.getByText('Placeholder: Best 3rd place')).toBeVisible();
  let s = await stored(request, id);
  expect(fx(s, 'f1').away).toBe('clares');
  expect(fx(s, 'f1').slots).toEqual({ away: BEST3 });

  await editor.getByRole('button', { name: 'Revert away to placeholder' }).click();
  await expect(away).toHaveValue('Best 3rd place');
  await expect(editor.getByRole('button', { name: 'Revert away to placeholder' })).toHaveCount(0);
  s = await stored(request, id);
  expect(fx(s, 'f1').away).toBe(BEST3);
  expect(fx(s, 'f1').slots).toBeUndefined();

  // Save after the round-trip keeps the placeholder (the draft followed the server).
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('tr.fix-edit-tr')).toHaveCount(0);
  expect(fx(await stored(request, id), 'f1').away).toBe(BEST3);
});

test('a club from outside the series joins its participants', async ({ page, request }) => {
  const name = `E2E KO Outside ${RUN}`;
  const id = await createKnockout(request, name, '2027-06-12');
  await openAdminSeries(page, name);

  const editor = await openFixtureRow(page, 'Community Cup winner');
  const picker = editor.getByLabel('Team to set as away');
  // Grouped: the series' own teams first, then each other club.
  await expect(picker.locator('optgroup').first()).toHaveAttribute('label', 'In this series');
  await picker.selectOption('chatsworth');
  await editor.getByRole('button', { name: 'Set away team' }).click();
  await expect(editor.getByLabel('Away (visitors)')).toHaveValue('Chatsworth Sporting CC');

  const s = await stored(request, id);
  expect(fx(s, 'f2').away).toBe('chatsworth');
  expect(fx(s, 'f2').slots).toEqual({ away: CUP });
  expect(s.teams).toContain('chatsworth');
  expect(s.participants?.find((p) => p.teamId === 'chatsworth')?.clubId).toBe('chatsworth');

  // Revert: the outside club leaves the series again — nothing names it any more.
  await editor.getByRole('button', { name: 'Revert away to placeholder' }).click();
  await expect(editor.getByLabel('Away (visitors)')).toHaveValue('Community Cup winner');
  const r = await stored(request, id);
  expect(r.teams).not.toContain('chatsworth');
  expect(r.participants?.some((p) => p.teamId === 'chatsworth')).toBe(false);
});

test('Set team that books a taken home ground is refused inline', async ({ page, request }) => {
  const date = '2027-06-19';
  // Another series already holds UKZN's ground at 09:00 that day.
  await createSeries(request, {
    name: `E2E KO Busy ${RUN}`,
    fixtures: [
      fixture({
        id: 'f1',
        home: 'berea',
        away: 'umlazi',
        date,
        time: '09:00',
        venueOverride: UKZN_GROUND,
      }),
    ],
  });
  const name = `E2E KO Clash ${RUN}`;
  const id = await createKnockout(request, name, date);
  // Make f1's home a placeholder the admin can set (it is `win:f0` — a forward reference).
  await openAdminSeries(page, name);

  const editor = await openFixtureRow(page, 'Best 3rd place');
  await editor.getByLabel('Team to set as home').selectOption('ukzn');
  await editor.getByRole('button', { name: 'Set home team' }).click();
  await expect(
    editor.getByRole('alert').filter({ hasText: 'Change blocked — not saved' }),
  ).toBeVisible();
  await expect(editor.getByRole('alert')).toContainText(UKZN_GROUND);
  const s = await stored(request, id);
  expect(fx(s, 'f1').home).toBe('win:f0');
  expect(fx(s, 'f1').slots).toBeUndefined();
});

/** Delete every series whose name starts with `prefix` (re-run hygiene on a shared demo DB). */
async function deleteSeriesNamed(request: APIRequestContext, prefix: string) {
  const res = await request.get(`${API_BASE}/series`, { headers: apiHeaders(adminAuthHeader()) });
  for (const s of (await res.json()) as Array<{ id: string; name: string }>)
    if (s.name.startsWith(prefix))
      await request.delete(`${API_BASE}/series/${s.id}`, {
        headers: apiHeaders(adminAuthHeader()),
      });
}

/** A knockout with explicit fixtures, optionally approved + released (withheld fields). */
async function createKo(
  request: APIRequestContext,
  opts: {
    name: string;
    fixtures: Array<Record<string, unknown>>;
    release?: { withheld?: { venue?: true; time?: true } };
  },
) {
  const id = `e2e-ko-${RUN}-${Math.floor(Math.random() * 1e6)}`;
  const res = await request.post(`${API_BASE}/series`, {
    headers: apiHeaders(adminAuthHeader()),
    data: {
      id,
      name: opts.name,
      kind: 'series',
      leagueKey: 'premier',
      seriesType: 'T20',
      maxOvers: 20,
      startDate: opts.fixtures[0].date,
      teams: ['ukzn', 'clares'],
      participants: [
        { teamId: 'ukzn', clubId: 'ukzn', name: 'UKZN CC' },
        { teamId: 'clares', clubId: 'clares', name: 'Clares CC' },
      ],
      fixtures: opts.fixtures,
      version: 1,
    },
  });
  expect(res.ok(), `POST /series → ${res.status()} ${await res.text()}`).toBeTruthy();
  if (opts.release) await approveAndRelease(request, id, opts.release.withheld);
  return id;
}

test('labels: every placeholder reads as words in the admin table and editor, never an id', async ({
  page,
  request,
}) => {
  const date = '2027-07-03';
  const name = `E2E KO Labels ${RUN}`;
  await createKo(request, {
    name,
    fixtures: [
      { id: 'f1', round: 1, date, time: '09:00', home: 'pos:s-g-a:1', away: BEST3 },
      { id: 'f2', round: 1, date, time: '13:30', home: 'pos:s-g-b:2', away: CUP },
      { id: 'f3', round: 2, date, time: '16:00', home: 'win:f1', away: 'win:f2', stage: 'Final' },
    ],
  });
  await openAdminSeries(page, name);
  const table = page.locator('.fix-table');
  for (const text of [
    'Group A – 1st',
    'Best 3rd place',
    'Group B – 2nd',
    'Community Cup winner',
    'Winner of Semi-final 1',
  ])
    await expect(table).toContainText(text);
  await expect(table).not.toContainText('Unknown team');
  await expect(table).not.toContainText('tbd:');
  await expect(table).not.toContainText('pos:');
  const editor = await openFixtureRow(page, 'Group A – 1st');
  await expect(editor.getByLabel('Home (host)')).toHaveValue('Group A – 1st');
});

test('a released knockout: the club portal shows the set team, withheld times stay hidden', async ({
  page,
  request,
}) => {
  const date = '2027-07-10';
  const name = `E2E KO Released ${RUN}`;
  // A RUN-unique ground, so a re-run against the same stack neither clashes at release nor
  // finds the previous run's row.
  const venue = ground('koReleased');
  // Clares is set into the 09:00 slot below; a previous run's copy (same demo DB) would make
  // it team_busy, so earlier copies are removed first.
  await deleteSeriesNamed(request, 'E2E KO Released ');
  const id = await createKo(request, {
    name,
    fixtures: [
      { id: 'f1', round: 1, date, time: '09:00', home: 'ukzn', away: BEST3, venueOverride: venue },
    ],
    release: { withheld: { time: true } },
  });
  // Before: the UKZN chair sees the placeholder in words.
  const rep = await signInAsRep(page.context().browser()!, 'ukzn');
  const row = rep.locator('tr', { hasText: venue });
  await expect(row).toContainText('Best 3rd place');
  await expect(rep.getByText('tbd:', { exact: false })).toHaveCount(0);
  await expect(row).not.toContainText('09:00');

  await openAdminSeries(page, name);
  const editor = await openFixtureRow(page, 'Best 3rd place');
  await editor.getByLabel('Team to set as away').selectOption('clares');
  await editor.getByRole('button', { name: 'Set away team' }).click();
  await expect(editor.getByLabel('Away (visitors)')).toHaveValue('Clares CC');
  const s = (await getSeries(request, id)) as unknown as KoSeries & {
    released: boolean;
    withheld?: { time?: true };
  };
  expect(s.released).toBe(true);
  expect(s.withheld).toEqual({ time: true });

  // After: the chair sees the opponent's name; the withheld kick-off is still not shown.
  await rep.reload();
  await dismissOnboarding(rep);
  await expect(row).toContainText('Clares CC');
  await expect(row).not.toContainText('Best 3rd place');
  await expect(row).not.toContainText('09:00');
  await rep.context().close();
  await request.delete(`${API_BASE}/series/${id}`, { headers: apiHeaders(adminAuthHeader()) });
});

test('a stale tab: Set team says the series changed; after a reload it works', async ({
  page,
  request,
}) => {
  const date = '2027-07-17';
  const name = `E2E KO Stale ${RUN}`;
  const id = await createKo(request, {
    name,
    fixtures: [{ id: 'f1', round: 1, date, time: '09:00', home: 'pos:s-g-a:1', away: BEST3 }],
  });
  await openAdminSeries(page, name);
  const editor = await openFixtureRow(page, 'Best 3rd place');
  // Another tab moves the series on.
  const cur = await getSeries(request, id);
  const bump = await request.patch(`${API_BASE}/series/${id}`, {
    headers: apiHeaders(adminAuthHeader()),
    data: { name: `${name}`, version: cur.version },
  });
  expect(bump.ok()).toBeTruthy();
  await editor.getByLabel('Team to set as away').selectOption('clares');
  await editor.getByRole('button', { name: 'Set away team' }).click();
  await expect(editor.getByRole('alert')).toContainText(/changed|refresh/i);
  expect(fx(await stored(request, id), 'f1').away).toBe(BEST3);

  await page.reload();
  await openAdminSeries(page, name);
  const again = await openFixtureRow(page, 'Best 3rd place');
  await again.getByLabel('Team to set as away').selectOption('clares');
  await again.getByRole('button', { name: 'Set away team' }).click();
  await expect(again.getByLabel('Away (visitors)')).toHaveValue('Clares CC');
  expect(fx(await stored(request, id), 'f1').away).toBe('clares');
});

test('a team already playing at that time is refused inline; nothing stored', async ({
  page,
  request,
}) => {
  const date = '2027-07-24';
  // Clares already plays (released) at 09:00 that day, somewhere else.
  await createReleased(request, {
    name: `E2E KO Clares busy ${RUN}`,
    fixtures: [
      fixture({
        id: 'f1',
        home: 'clares',
        away: 'berea',
        date,
        time: '09:00',
        venueOverride: ground('koBusy'),
      }),
    ],
  });
  const name = `E2E KO TeamBusy ${RUN}`;
  const id = await createKo(request, {
    name,
    fixtures: [{ id: 'f1', round: 1, date, time: '09:00', home: 'pos:s-g-a:1', away: BEST3 }],
  });
  await openAdminSeries(page, name);
  const editor = await openFixtureRow(page, 'Best 3rd place');
  await editor.getByLabel('Team to set as away').selectOption('clares');
  await editor.getByRole('button', { name: 'Set away team' }).click();
  await expect(editor.getByRole('alert')).toContainText('Clares CC already plays on');
  const s = await stored(request, id);
  expect(fx(s, 'f1').away).toBe(BEST3);
  expect(s.version).toBe(1);
});
