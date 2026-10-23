import { test, expect, type Locator } from '@playwright/test';
import { RUN, signInAsAdmin } from './helpers';
import { createSeries, fixture, ground, openAdminSeries } from './fixtures-helpers';

/**
 * Series editor "Officials" column: umpires and scorers are two independent partial writes on
 * one fixture. Assign both, reload, and both persist — neither save clobbers the other. A
 * run-unique draft series keeps the fixture this spec's own.
 */
test.describe.configure({ mode: 'serial' });

const UMP1 = `E2E Ump A ${RUN}`;
const UMP2 = `E2E Ump B ${RUN}`;
const SC1 = `E2E Scorer A ${RUN}`;
const SC2 = `E2E Scorer B ${RUN}`;

/** Type a new name into a picker slot and add it to the register via "+ Add … as a new …". */
async function addNew(picker: Locator, slot: string, name: string, noun: string) {
  await picker.getByRole('combobox', { name: slot, exact: true }).fill(name);
  await picker.getByRole('button', { name: `+ Add “${name}” as a new ${noun}` }).click();
  await expect(picker.getByRole('button', { name: `Remove ${name}` })).toBeVisible();
}

test('umpires and scorers save independently and both persist', async ({ page, request }) => {
  const series = await createSeries(request, {
    name: `E2E Officials ${RUN}`,
    fixtures: [fixture({ id: `f-off-${RUN}`, venueOverride: ground('Officials') })],
  });

  await signInAsAdmin(page);
  const detail = await openAdminSeries(page, series.name);
  await expect(detail.getByRole('columnheader', { name: 'Officials' })).toBeVisible();
  const cell = detail.locator('.ump-cell').first();
  await expect(cell).toBeVisible();

  // Only one picker at a time: with the scorer picker open, the umpire button is gone.
  await cell.getByRole('button', { name: 'Assign scorers' }).click();
  const scorerPicker = cell.getByRole('group', { name: 'Assign scorers' });
  await expect(scorerPicker).toBeVisible();
  await expect(cell.getByRole('button', { name: 'Assign umpires' })).toHaveCount(0);
  await scorerPicker.getByRole('button', { name: 'Cancel' }).click();
  await expect(scorerPicker).toHaveCount(0);

  // Umpires first.
  await cell.getByRole('button', { name: 'Assign umpires' }).click();
  const umpPicker = cell.getByRole('group', { name: 'Assign umpires' });
  await expect(cell.getByRole('button', { name: 'Assign scorers' })).toHaveCount(0);
  await addNew(umpPicker, 'Umpire 1', UMP1, 'umpire');
  await addNew(umpPicker, 'Umpire 2', UMP2, 'umpire');
  await umpPicker.getByRole('button', { name: 'Save umpires' }).click();
  await expect(umpPicker).toHaveCount(0);

  // Then scorers — a separate partial write.
  await cell.getByRole('button', { name: 'Assign scorers' }).click();
  const scPicker = cell.getByRole('group', { name: 'Assign scorers' });
  await addNew(scPicker, 'Scorer', SC1, 'scorer');
  await addNew(scPicker, 'Backup scorer', SC2, 'scorer');
  await scPicker.getByRole('button', { name: 'Save scorers' }).click();
  await expect(scPicker).toHaveCount(0);

  const lines = cell.locator('.ump-names');
  await expect(lines.first()).toContainText(`${UMP1}, ${UMP2}`);
  await expect(lines.nth(1)).toContainText(`Scorers: ${SC1}, ${SC2}`);

  // Reload: both lines come back from the server intact.
  await page.reload();
  const again = await openAdminSeries(page, series.name);
  const cell2 = again.locator('.ump-cell').first();
  await expect(cell2.locator('.ump-names').first()).toContainText(`${UMP1}, ${UMP2}`);
  await expect(cell2.locator('.ump-names').nth(1)).toContainText(`Scorers: ${SC1}, ${SC2}`);
});
