import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, adminAuthHeader, apiHeaders, signInAsAdmin, RUN } from './helpers';
import { createSeries, fixture, getSeries, openAdminSeries } from './fixtures-helpers';

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
