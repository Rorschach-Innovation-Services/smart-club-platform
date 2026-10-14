import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import dayjs from 'dayjs';
import { API_BASE, RUN, apiHeaders, repAuthHeader, signInAsAdmin } from './helpers';
import {
  CLUB_NAME,
  createReleased,
  fixture,
  ground,
  gotoClubFixtures,
  openAdminSeries,
  repGetSeries,
  signInAsRep,
} from './fixtures-helpers';

/**
 * Fixture postponement negotiation (ADR 0015), end to end through the REAL local stack:
 *
 *   chair A (away) requests a new date → chair B (home) counters → chair A accepts, which
 *   moves the fixture at once (new date, "Postponed" badge, struck-through original date in
 *   the club grid AND the admin fixture table) → the union office sets a final date → both
 *   chairs acknowledge the ruling.
 *
 * The suite runs serially on ONE shared in-memory DB, so the steps share state through
 * module-level variables, and every date is drawn from a RUN-random week in 2028–29: no demo or
 * sibling-spec fixture plays on those days, so the team-busy and ground checks only ever see
 * this spec's own fixture. The ground is a RUN-unique custom name, which also lets the club
 * grid row be found by it.
 */
test.describe.configure({ mode: 'serial' });

const HOME = 'ukzn';
const AWAY = 'clares';
const SERIES_NAME = `E2E Postpone ${RUN}`;
const GROUND = ground('postpone');
const TIME = '10:00';

// A Saturday somewhere in 2028–29, then one week apart for each move.
const BASE = dayjs('2028-01-01')
  .add(Math.floor(Math.random() * 90) * 7, 'day')
  .day(6);
const iso = (weeks: number) => BASE.add(weeks * 7, 'day').format('YYYY-MM-DD');
const ORIGINAL = iso(0);
const REQUESTED = iso(1);
const COUNTERED = iso(2);
const FINAL = iso(3);
/** The struck-through original date and the proposals read `ddd D MMM` (formatWeekdayDay). */
const day = (d: string) => dayjs(d).format('ddd D MMM');
/** The club grid's date cell leads with `D MMM` (then the weekday on its own line). */
const gridDay = (d: string) => dayjs(d).format('D MMM');

let seriesId = '';

interface ClubPostponement {
  id: string;
  seriesId: string;
  status: string;
  awaiting: string;
  proposals: Array<{ by: string; date: string }>;
  acknowledgements?: Record<string, unknown>;
}

async function clubPostponements(
  request: APIRequestContext,
  clubId: string,
): Promise<ClubPostponement[]> {
  const res = await request.get(`${API_BASE}/clubs/${clubId}/postponements`, {
    headers: apiHeaders(repAuthHeader(clubId)),
  });
  expect(res.ok(), `GET /clubs/${clubId}/postponements → ${res.status()}`).toBeTruthy();
  const { inbound, outbound } = (await res.json()) as {
    inbound: ClubPostponement[];
    outbound: ClubPostponement[];
  };
  return [...inbound, ...outbound].filter((r) => r.seriesId === seriesId);
}

/** The club fixtures-grid row for this spec's fixture (found by its RUN-unique ground). */
const fixtureRow = (page: Page) => page.locator('tr', { hasText: GROUND });
/** This spec's request card in the club's Postponements panel. */
const requestCard = (page: Page) =>
  page.getByRole('region', { name: 'Postponements' }).locator('.clr-card', {
    hasText: SERIES_NAME,
  });

test.beforeAll(async ({ request }) => {
  const s = await createReleased(request, {
    name: SERIES_NAME,
    fixtures: [
      fixture({
        id: 'f1',
        home: HOME,
        away: AWAY,
        date: ORIGINAL,
        time: TIME,
        venueOverride: GROUND,
      }),
    ],
  });
  seriesId = s.id;
});

test('the away chair requests a new date from the fixtures grid', async ({ browser }) => {
  const away = await signInAsRep(browser, AWAY);
  const row = fixtureRow(away);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Postpone' }).click();

  const dialog = away.getByRole('dialog');
  await expect(dialog.getByText(`${CLUB_NAME[HOME]} is asked to agree`)).toBeVisible();
  await dialog.getByLabel('New date').fill(REQUESTED);
  await dialog.getByLabel('Kick-off').fill(TIME);
  await dialog.getByLabel('Reason').fill('Ground under water');
  // The rep-safe clash hints come back clean for a free week.
  await expect(dialog.getByText('No clashes found for that date.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog).toHaveCount(0);

  // The grid swaps the Postpone button for the open-request pill.
  await expect(row.getByText('Postponement open')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Postpone' })).toHaveCount(0);
  await expect(requestCard(away).getByText(`Waiting for ${CLUB_NAME[HOME]}`)).toBeVisible();
  await away.context().close();
});

test('the home chair counters with another date', async ({ browser, request }) => {
  const home = await signInAsRep(browser, HOME);
  const card = requestCard(home);
  await expect(card.getByText('Your turn to respond')).toBeVisible();
  await expect(card.getByText('“Ground under water”')).toBeVisible();

  await card.getByRole('button', { name: 'Propose another date' }).click();
  await card.getByLabel('Counter date').fill(COUNTERED);
  await card.getByLabel('Note').fill('The following Saturday suits us');
  await card.getByRole('button', { name: 'Send counter-proposal' }).click();
  await expect(card.getByText(`Waiting for ${CLUB_NAME[AWAY]}`)).toBeVisible();
  await home.context().close();

  const [req] = await clubPostponements(request, HOME);
  expect(req.status).toBe('open');
  expect(req.awaiting).toBe('requesting');
  expect(req.proposals.map((p) => [p.by, p.date])).toEqual([
    ['requesting', REQUESTED],
    ['opposing', COUNTERED],
  ]);
});

test('the away chair accepts and the fixture moves at once, in the club grid and the admin table', async ({
  browser,
  page,
  request,
}) => {
  const away = await signInAsRep(browser, AWAY);
  const card = requestCard(away);
  await expect(card.getByText('Your turn to respond')).toBeVisible();
  await card.getByRole('button', { name: /^Accept / }).click();
  await expect(requestCard(away)).toHaveCount(0); // closed requests move under the history toggle

  // Club grid: the new date, the Postponed badge and the struck-through original date.
  await gotoClubFixtures(away, AWAY);
  const row = fixtureRow(away);
  await expect(row).toContainText(gridDay(COUNTERED));
  await expect(row.getByText('Postponed')).toBeVisible();
  await expect(row.locator('s', { hasText: day(ORIGINAL) })).toBeVisible();
  await away.context().close();

  // The stored fixture, as the clubs see it.
  const projected = await repGetSeries(request, HOME, seriesId);
  expect(projected?.fixtures[0]).toMatchObject({
    date: COUNTERED,
    status: 'postponed',
    originalDate: ORIGINAL,
  });

  // Admin fixture table: the same struck-through original date.
  await signInAsAdmin(page);
  await openAdminSeries(page, SERIES_NAME);
  await expect(page.locator('s', { hasText: day(ORIGINAL) })).toBeVisible();
});

test('the union office overrides with a final date', async ({ page, request }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/postponements');
  await page.locator('.filter-pill', { hasText: 'Agreed' }).click();
  const row = page.locator('tr', { hasText: SERIES_NAME });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Set final date' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Final date')).toHaveValue(COUNTERED);
  await dialog.getByLabel('Final date').fill(FINAL);
  await dialog.getByRole('button', { name: 'Set final date' }).click();
  await expect(dialog).toHaveCount(0);

  await page.locator('.filter-pill', { hasText: 'Union ruling' }).click();
  await expect(row.getByText('Acknowledged 0/2')).toBeVisible();

  // The fixture takes the ruling; the original schedule is still the FIRST date.
  const projected = await repGetSeries(request, HOME, seriesId);
  expect(projected?.fixtures[0]).toMatchObject({
    date: FINAL,
    status: 'postponed',
    originalDate: ORIGINAL,
  });
});

test('both chairs see the union ruling and acknowledge it', async ({ browser, page, request }) => {
  for (const clubId of [AWAY, HOME]) {
    const rep = await signInAsRep(browser, clubId);
    const card = requestCard(rep);
    await expect(card.getByText('Union ruling')).toBeVisible();
    await expect(card.getByText(day(FINAL)).first()).toBeVisible();
    await card.getByRole('button', { name: 'Acknowledge ruling' }).click();
    await expect(card.getByRole('button', { name: 'Acknowledge ruling' })).toHaveCount(0);
    // The grid now shows the ruled date, still struck through against the original.
    const row = fixtureRow(rep);
    await expect(row).toContainText(gridDay(FINAL));
    await expect(row.locator('s', { hasText: day(ORIGINAL) })).toBeVisible();
    await rep.context().close();
  }

  const [req] = await clubPostponements(request, HOME);
  expect(req.status).toBe('admin-final');
  expect(Object.keys(req.acknowledgements ?? {}).sort()).toEqual([AWAY, HOME].sort());

  await signInAsAdmin(page);
  await page.goto('/admin/postponements');
  await page.locator('.filter-pill', { hasText: 'Union ruling' }).click();
  await expect(
    page.locator('tr', { hasText: SERIES_NAME }).getByText('Acknowledged 2/2'),
  ).toBeVisible();
});
