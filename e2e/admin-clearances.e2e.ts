import { test, expect } from '@playwright/test';
import {
  signInAsAdmin,
  seedPendingClearance,
  seedRegistrationClearance,
  listPlayers,
  rejectViaApi,
  overrideViaApi,
  fetchClearance,
  openClearancesFilteredTo,
  RUN,
} from './helpers';

/**
 * End-to-end coverage of the admin Player Clearances page. Every test seeds its own
 * uniquely-named clearance(s) through the real API, then drives the real app in the
 * browser and asserts on visible text / roles only. Tests run serially against one
 * shared in-memory DB (see playwright.config.ts), so each isolates itself by giving
 * its players a run-unique name and, in the UI, searching for that name so the status
 * pills count only its own cards.
 */

// Distinct source→destination club pairs per test keep club-name searches unambiguous.
const CLUBS = {
  search: { from: 'ukzn', to: 'clares', toName: 'Clares' },
  reject: { from: 'crusaders', to: 'berea' },
  override: { from: 'phoenix', to: 'verulam' },
  stale: { from: 'rhythm', to: 'warriors' },
  // Case C (registration-origin, source club exists but holds no row): the player registers at
  // `linkClub` and declares `prevClub` as their previous club. `prevClub` holds no row for the
  // run-unique name, so reject moves the registration there. See the test for why leftovers at
  // `prevClub` are harmless.
  regC: { linkClub: 'verulam', prevClub: 'phoenix', prevName: 'Phoenix' },
};

// A status pill button reads "<Label> <count>"; assert on the count that follows the label.
async function pillCount(page: import('@playwright/test').Page, label: string) {
  const pill = page.locator('.filter-pill', { hasText: new RegExp(`^${label}\\b`) });
  await expect(pill).toBeVisible();
  const text = (await pill.innerText()).trim();
  const m = text.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : NaN;
}

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('search narrows across statuses, counts, and clears', async ({ page, request }) => {
  const keep = `KeepPending-${RUN}`;
  const drop = `RejectedOne-${RUN}`;
  const a = await seedPendingClearance(request, {
    from: CLUBS.search.from,
    to: CLUBS.search.to,
    name: keep,
  });
  const b = await seedPendingClearance(request, {
    from: CLUBS.search.from,
    to: CLUBS.search.to,
    name: drop,
  });
  await rejectViaApi(request, b, 'Fees outstanding');

  await page.goto('/admin/clearances');
  const search = page.getByLabel('Search clearances');
  await expect(search).toBeVisible();

  // Searching the rejected player's name leaves exactly that one card, under All and Rejected.
  await search.fill(drop);
  await expect(page.getByText(`Test ${drop}`)).toBeVisible();
  await expect(page.getByText(`Test ${keep}`)).toHaveCount(0);
  expect(await pillCount(page, 'All')).toBe(1);
  expect(await pillCount(page, 'Rejected')).toBe(1);
  expect(await pillCount(page, 'Pending')).toBe(0);
  // The card carries a "Rejected" pill and is listed under the Rejected filter too.
  await page.locator('.filter-pill', { hasText: /^Rejected\b/ }).click();
  await expect(page.getByText(`Test ${drop}`)).toBeVisible();
  // Reset the status filter to All before the next (cross-status) searches.
  await page.locator('.filter-pill', { hasText: /^All\b/ }).click();

  // Searching the shared destination-club name surfaces BOTH this test's cards.
  await search.fill(CLUBS.search.toName);
  await expect(page.getByText(`Test ${keep}`)).toBeVisible();
  await expect(page.getByText(`Test ${drop}`)).toBeVisible();

  // Searching an ID number matches the one card it belongs to.
  await search.fill(b.idNumber);
  await expect(page.getByText(`Test ${drop}`)).toBeVisible();
  await expect(page.getByText(`Test ${keep}`)).toHaveCount(0);
  expect(await pillCount(page, 'All')).toBe(1);

  // Clearing restores both of this test's cards.
  await search.fill('');
  await expect(page.getByText(`Test ${keep}`)).toBeVisible();
  await expect(page.getByText(`Test ${drop}`)).toBeVisible();

  // A nonsense query shows the empty state and the running total.
  const nonsense = `zzz-no-match-${RUN}`;
  await search.fill(nonsense);
  await expect(page.getByText(`No clearances match "${nonsense}".`)).toBeVisible();
  await expect(page.getByText(/Showing 0 of \d+ clearances/)).toBeVisible();

  // Sanity: both seeded ids came back from the API.
  expect(a.id).not.toBe(b.id);
});

test('rejecting a clearance in the UI cancels the move, then reopen restores it and it can be re-rejected', async ({
  page,
  request,
}) => {
  const name = `RejectUI-${RUN}`;
  const clr = await seedPendingClearance(request, {
    from: CLUBS.reject.from,
    to: CLUBS.reject.to,
    name,
  });

  await openClearancesFilteredTo(page, name);
  const card = page.locator('.clr-card', { hasText: `Test ${name}` });
  await expect(card).toBeVisible();
  expect(await pillCount(page, 'Pending')).toBe(1);

  await card.getByRole('button', { name: 'Reject' }).click();

  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toBeVisible();
  const reason = 'Outstanding subscriptions for the 2025 season';
  await dialog.getByPlaceholder('Reason (optional — shown to both clubs)').fill(reason);
  await dialog.getByRole('button', { name: 'Yes, reject clearance' }).click();

  // Dialog closes only on success; the toast now reads with the new "cancels the move" copy —
  // this is a rep-initiated (request-origin) clearance, so the source is reactivated in place.
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'move is cancelled' })).toBeVisible();

  // The card now shows a "Rejected" pill; in the searched set Pending→0, Rejected→1.
  await expect(card.locator('.clr-resolved-bar')).toContainText('Rejected');
  expect(await pillCount(page, 'Pending')).toBe(0);
  expect(await pillCount(page, 'Rejected')).toBe(1);

  // Observable outcome via the API: status rejected + the reason we typed.
  const after = await fetchClearance(request, clr.id);
  expect(after?.status).toBe('rejected');
  expect(after?.rejectReason).toBe(reason);

  // ── Reopen via the UI ── the rejected card offers a Reopen button (a snapshot exists).
  await card.getByRole('button', { name: 'Reopen' }).click();
  const reopenDialog = page.locator('.fix-confirm-box');
  await expect(reopenDialog).toBeVisible();
  // The reopen confirm has no reason field, just the confirm button.
  await reopenDialog.getByRole('button', { name: 'Yes, reopen clearance' }).click();

  await expect(reopenDialog).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'reopened' })).toBeVisible();

  // Back to pending: searched Pending→1, Rejected→0 (both depend on the post-reopen refetch).
  await expect.poll(() => pillCount(page, 'Pending')).toBe(1);
  await expect.poll(() => pillCount(page, 'Rejected')).toBe(0);

  // The clearance is pending again and the reject reason has been cleared.
  const reopened = await fetchClearance(request, clr.id);
  expect(reopened?.status).toBe('pending');
  expect(reopened?.rejectReason).toBeUndefined();

  // Both clubs' comm logs now carry the REOPENED notice too.
  for (const clubId of [CLUBS.reject.from, CLUBS.reject.to]) {
    await page.goto(`/admin/clubs/${clubId}`);
    await expect(page.getByText(/Clearance reopened notice/).first()).toBeVisible();
  }

  // ── Reject again via the UI (no reason this time) ── it resolves back to rejected.
  await openClearancesFilteredTo(page, name);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Reject' }).click();
  const dialog2 = page.locator('.fix-confirm-box');
  await expect(dialog2).toBeVisible();
  await dialog2.getByRole('button', { name: 'Yes, reject clearance' }).click();
  await expect(dialog2).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'move is cancelled' })).toBeVisible();

  const reRejected = await fetchClearance(request, clr.id);
  expect(reRejected?.status).toBe('rejected');
});

test('overriding a clearance in the UI issues it and logs both clubs', async ({
  page,
  request,
}) => {
  const name = `OverrideUI-${RUN}`;
  const clr = await seedPendingClearance(request, {
    from: CLUBS.override.from,
    to: CLUBS.override.to,
    name,
  });

  await openClearancesFilteredTo(page, name);
  const card = page.locator('.clr-card', { hasText: `Test ${name}` });
  await expect(card).toBeVisible();
  expect(await pillCount(page, 'Pending')).toBe(1);

  await card.getByRole('button', { name: 'Override & approve' }).click();

  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toBeVisible();
  await dialog
    .getByPlaceholder('Reason (optional — shown to both clubs, recorded against your name)')
    .fill('Issued on the union office authority');
  await dialog.getByRole('button', { name: 'Yes, issue clearance' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Union override');

  // The card now shows the resolved (Union override) pill; searched Resolved→1, Pending→0.
  await expect(card.locator('.clr-resolved-bar')).toContainText('Union override');
  expect(await pillCount(page, 'Pending')).toBe(0);
  expect(await pillCount(page, 'Resolved')).toBe(1);

  const after = await fetchClearance(request, clr.id);
  expect(after?.status).toBe('admin-override');

  for (const clubId of [CLUBS.override.from, CLUBS.override.to]) {
    await page.goto(`/admin/clubs/${clubId}`);
    await expect(page.getByText(/Clearance approved notice/).first()).toBeVisible();
  }
});

test('a clearance resolved behind the UI closes the reject dialog with a warning', async ({
  page,
  request,
}) => {
  const name = `Stale409-${RUN}`;
  const clr = await seedPendingClearance(request, {
    from: CLUBS.stale.from,
    to: CLUBS.stale.to,
    name,
  });

  await openClearancesFilteredTo(page, name);
  const card = page.locator('.clr-card', { hasText: `Test ${name}` });
  await expect(card).toBeVisible();

  // Resolve it via the API behind the UI's back — the page holds a now-stale pending card.
  await overrideViaApi(request, clr, 'Resolved out of band');

  await card.getByRole('button', { name: 'Reject' }).click();
  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Yes, reject clearance' }).click();

  // The stale write 409s: a warning toast, and — because the 409 already refetched the list
  // behind the dialog — the dialog CLOSES. A retry would only re-send the stale version and
  // 409 again, so there is nothing left to retry.
  await expect(page.locator('.toast')).toContainText('already resolved');
  await expect(dialog).toHaveCount(0);

  // The refetched card is now resolved: no action buttons, and the Union-override pill.
  await expect(card.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Override & approve' })).toHaveCount(0);
  await expect(card.locator('.clr-resolved-bar')).toContainText('Union override');
});

test('rejecting a registration-origin (case C) clearance moves the player to the previous club, and reopen moves them back', async ({
  page,
  request,
}) => {
  const name = `RegCaseC-${RUN}`;
  const { linkClub, prevClub, prevName } = CLUBS.regC;
  // A run-unique name means `prevClub` (Phoenix) holds no row for this player → case C. The test
  // ends with a reopen, so what it leaves behind is a `clearance-pending` row at Verulam and a
  // pending clearance in Phoenix's queue — never colliding with another test's name searches.
  const clr = await seedRegistrationClearance(request, { linkClub, prevClub, name });
  expect(clr.origin).toBe('registration');

  await openClearancesFilteredTo(page, name);
  const card = page.locator('.clr-card', { hasText: `Test ${name}` });
  await expect(card).toBeVisible();
  // Case-C sub copy on the pending card, and Reject is enabled (server predicted case C).
  await expect(card).toContainText('has no record of this player');
  const rejectBtn = card.getByRole('button', { name: 'Reject' });
  await expect(rejectBtn).toBeEnabled();
  await rejectBtn.click();

  const dialog = page.locator('.fix-confirm-box');
  await expect(dialog).toBeVisible();
  // The confirm body spells out that the registration moves to the previous club (Phoenix).
  await expect(dialog).toContainText('moves the registration');
  await expect(dialog).toContainText(prevName);
  await dialog.getByRole('button', { name: 'Yes, reject clearance' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'moved back to' })).toBeVisible();

  // The registration is now ACTIVE at Phoenix with the SAME ID-doc objectKey, and gone from Verulam.
  await expect
    .poll(
      async () => (await listPlayers(request, prevClub)).find((p) => p.lastName === name)?.status,
    )
    .toBe('active');
  const moved = (await listPlayers(request, prevClub)).find((p) => p.lastName === name);
  expect(moved?.idDocMeta?.objectKey).toBe(clr.idDocObjectKey);
  expect((await listPlayers(request, linkClub)).find((p) => p.lastName === name)).toBeUndefined();

  // ── Reopen via the UI ── the registration moves back: clearance-pending at Verulam, gone from Phoenix.
  await card.getByRole('button', { name: 'Reopen' }).click();
  const reopenDialog = page.locator('.fix-confirm-box');
  await expect(reopenDialog).toBeVisible();
  await reopenDialog.getByRole('button', { name: 'Yes, reopen clearance' }).click();
  await expect(reopenDialog).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'reopened' })).toBeVisible();

  await expect
    .poll(
      async () => (await listPlayers(request, linkClub)).find((p) => p.lastName === name)?.status,
    )
    .toBe('clearance-pending');
  expect((await listPlayers(request, prevClub)).find((p) => p.lastName === name)).toBeUndefined();
  // The card is pending again (Reject available once more).
  await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();
});
