import { test, expect, type Page } from '@playwright/test';
import { signInAsAdmin, RUN } from './helpers';
import {
  createReleased,
  createSeries,
  fixture,
  gotoClubFixtures,
  ground,
  openAdminSeries,
  signInAsRep,
} from './fixtures-helpers';

/**
 * Browser-level coverage of the fixture editor's clash hints, the inline 409 handling and
 * the club portal's withheld/revealed venue text. Drives the REAL admin console and rep
 * portal; asserts on visible text/roles only. Seeds through the real API (the `request`
 * fixture). Runs serially against the one shared demo DB (playwright.config.ts).
 */

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

/** The open inline editor row. B/Y each carry a single fixture, so one editor at a time. */
function editorRow(page: Page) {
  return page.locator('tr.fix-edit-tr');
}

/** Open the single fixture's inline editor inside the selected series' table. */
async function openFixtureEditor(page: Page) {
  await page.locator('[title="Edit fixture"]').first().click();
  const row = editorRow(page);
  await expect(row).toBeVisible();
  return row;
}

test('admin editor: a clashing venue is flagged, the save is refused inline, a free ground saves', async ({
  page,
  request,
}) => {
  const G = ground('browserG');
  const gFree = ground('browserFree');
  const D = '2027-04-01';
  const aName = `E2E Browser A ${RUN}`;
  await createReleased(request, {
    name: aName,
    fixtures: [
      fixture({
        id: 'f1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        time: '09:00',
        venueOverride: G,
      }),
    ],
  });
  const bName = `E2E Browser B ${RUN}`;
  const B = await createReleased(request, {
    name: bName,
    fixtures: [
      fixture({
        id: 'f1',
        home: 'ukzn',
        away: 'clares',
        date: D,
        time: '09:00',
        venueOverride: ground('browserBinit'),
      }),
    ],
  });
  expect(B.released).toBe(true);

  await openAdminSeries(page, bName);
  const row = await openFixtureEditor(page);

  const venue = row.locator('select', { hasText: 'Other (type below)' });
  await venue.selectOption('custom');
  await row.getByPlaceholder('Only for an off-site venue').fill(G);

  // Within the debounce window the picker marks the clashing option and the panel names
  // the ground and the other series; a live series warns that the save will be refused.
  await expect(row.locator('option[value="custom"]')).toContainText('⚠ clash');
  const clashAlert = row.getByRole('alert').filter({ hasText: 'This fixture would clash' });
  await expect(clashAlert).toBeVisible();
  await expect(clashAlert).toContainText(G);
  await expect(clashAlert).toContainText(aName);
  await expect(
    row.getByText('This series is live — this change will be refused on save.'),
  ).toBeVisible();

  // Saving is refused: the inline panel flips to "Change blocked — not saved", a toast
  // appears, and the row stays open (Save still visible).
  await row.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    row.getByRole('alert').filter({ hasText: 'Change blocked — not saved' }),
  ).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Change blocked' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Save changes' })).toBeVisible();

  // A free ground saves: the row closes and the table shows the new venue.
  await row.getByPlaceholder('Only for an off-site venue').fill(gFree);
  await row.getByRole('button', { name: 'Save changes' }).click();
  await expect(editorRow(page)).toHaveCount(0);
  await expect(page.locator('.fix-row-venue-name', { hasText: gFree })).toBeVisible();

  // Rep sees the saved free ground.
  const rep = await signInAsRep(page.context().browser()!, 'ukzn');
  await expect(rep.getByText(gFree).first()).toBeVisible();
  await rep.context().close();
});

test('club portal: a withheld venue reads "to be confirmed"; reveal shows the edited ground', async ({
  page,
  request,
}) => {
  const wName = `E2E Withheld W ${RUN}`;
  const D = '2027-04-05';
  const W = await createReleased(request, {
    name: wName,
    fixtures: [
      fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: ground('whInit') }),
    ],
    withheld: { venue: true },
  });
  expect(W.withheld?.venue).toBe(true);

  // Rep: venue withheld.
  const rep = await signInAsRep(page.context().browser()!, 'ukzn');
  await expect(rep.getByText('Venue to be confirmed').first()).toBeVisible();
  await expect(rep.getByText(/venues to be confirmed/).first()).toBeVisible();

  // Admin edits the venue (no clash) — the store changes but clubs still see nothing.
  const gWNew = ground('whRevealed');
  await openAdminSeries(page, wName);
  const row = await openFixtureEditor(page);
  const venue = row.locator('select', { hasText: 'Other (type below)' });
  await venue.selectOption('custom');
  await row.getByPlaceholder('Only for an off-site venue').fill(gWNew);
  await row.getByRole('button', { name: 'Save changes' }).click();
  await expect(editorRow(page)).toHaveCount(0);

  await gotoClubFixtures(rep, 'ukzn');
  await expect(rep.getByText('Venue to be confirmed').first()).toBeVisible();
  await expect(rep.getByText(gWNew)).toHaveCount(0);

  // Admin reveals venues through the confirm modal.
  await page.locator('.ph-actions').getByRole('button', { name: 'Reveal venues' }).click();
  await page.locator('.fix-confirm-box').getByRole('button', { name: 'Reveal venues' }).click();

  // Rep now sees the EDITED ground and the "venues confirmed" eyebrow.
  await gotoClubFixtures(rep, 'ukzn');
  await expect(rep.getByText(gWNew).first()).toBeVisible();
  await expect(rep.getByText(/venues confirmed/).first()).toBeVisible();
  await rep.context().close();
});

test('admin editor on a DRAFT: the clash panel shows but the save still succeeds', async ({
  page,
  request,
}) => {
  const Gx = ground('draftClashG');
  const D = '2027-04-09';
  await createReleased(request, {
    fixtures: [fixture({ id: 'f1', home: 'spartan', away: 'tongaat', date: D, venueOverride: Gx })],
  });
  const yName = `E2E Draft Y ${RUN}`;
  await createSeries(request, {
    name: yName,
    fixtures: [
      fixture({
        id: 'f1',
        home: 'ukzn',
        away: 'clares',
        date: D,
        venueOverride: ground('draftYinit'),
      }),
    ],
  });

  await openAdminSeries(page, yName);
  const row = await openFixtureEditor(page);
  const venue = row.locator('select', { hasText: 'Other (type below)' });
  await venue.selectOption('custom');
  await row.getByPlaceholder('Only for an off-site venue').fill(Gx);

  // The panel warns, but a draft's copy is "checked again when you release".
  await expect(
    row.getByRole('alert').filter({ hasText: 'This fixture would clash' }),
  ).toBeVisible();
  await expect(row.getByText('Clashes are checked again when you release.')).toBeVisible();

  // The draft save still succeeds (no in-season gate) and the row closes.
  await row.getByRole('button', { name: 'Save changes' }).click();
  await expect(editorRow(page)).toHaveCount(0);
  await expect(page.locator('.fix-row-venue-name', { hasText: Gx }).first()).toBeVisible();
});
