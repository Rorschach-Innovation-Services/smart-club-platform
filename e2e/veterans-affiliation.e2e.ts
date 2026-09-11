import { test, expect } from '@playwright/test';
import {
  signInAsAdmin,
  signInAsRep,
  dismissOnboarding,
  mintRegLink,
  registerViaApi,
  uniqueIdNumber,
  createActivePlayer,
  getPlayerByName,
  getVeteransAffiliates,
  getClubPlayerCount,
  getClubName,
  seedPendingVeteransRegistration,
  overrideViaApi,
  rejectViaApi,
  RUN,
} from './helpers';

/**
 * End-to-end coverage of the veterans second-club affiliation feature. A player may play
 * veterans cricket for ANOTHER on-system club without a second roster row: the primary player
 * row carries `veteransClub`/`veteransClubId`, and a VETAFFIL# record under the veterans club
 * lets its portal list affiliates. The core invariant is write-on-activation — a record exists
 * ⇔ the primary row carrying `veteransClubId` is `active` — and the affiliation NEVER creates a
 * roster row or moves a player count.
 *
 * Every test seeds its own uniquely-named data through the real API, then drives the real app
 * (or asserts through the API) and checks user-observable outcomes only — visible text/roles and
 * API response bodies, never internal state. Tests run serially against one shared in-memory DB
 * (see playwright.config.ts) and isolate themselves by run-unique player names; distinct demo
 * club pairs per test keep name searches and the affiliates cards unambiguous. Where a test
 * leaves harmless residue in the shared DB, the comment says so.
 */

// Distinct demo club roles per test. Reps sign in only for 'complete'-affiliation clubs (ukzn,
// crusaders, ilembe) so the first-run onboarding overlay never blocks the roster (a defensive
// dismiss guards the race anyway).
const CLUBS = {
  register: { link: 'berea', vet: 'crusaders' }, // test 1: register AT berea, veterans = crusaders
  portal: { primary: 'ukzn', vet: 'ilembe' }, //     test 2: affiliate under ilembe, rep = ilembe
  adminEdit: { primary: 'tongaat', vet1: 'verulam', vet2: 'phoenix' }, // test 3
  chair: { primary: 'ukzn', vet: 'tongaat' }, //     test 4: rep = ukzn declares veterans = tongaat
  activation: { prev: 'phoenix', link: 'verulam', vet: 'crusaders' }, // test 5
};

test('public registration declaring a veterans club records the affiliation without duplicating the player', async ({
  page,
  request,
}) => {
  // The browser exercises the veterans QUESTION UI (Yes reveals the picker, No hides it, the
  // current/link club is absent from the options), then the registration is submitted through the
  // API helper. WHY the split: the register page's ID-doc step presigns a real S3 PUT with no
  // local twin (the /register/:clubId/id-doc/upload-url route has no isLocalUploadsMode branch and
  // UPLOADS_BUCKET is unset under dev:local:demo), so a browser file upload can't complete in this
  // stack. The API helper uses a `local/…` ID-doc key, which skips the upload entirely.
  const { link, vet } = CLUBS.register;
  const name = `PubReg-${RUN}`;
  const token = await mintRegLink(request, link);
  const vetCountBefore = await getClubPlayerCount(request, vet);

  // ── Browser: the veterans question UI on the real register page ──
  await page.goto(`/register/${link}?t=${encodeURIComponent(token)}`);
  const question = page.getByText('Are you playing veterans cricket for another club?');
  await expect(question).toBeVisible();
  // The veterans club <select> carries this placeholder option; use it to locate the picker.
  const vetSelect = page.locator('select.field-select', {
    has: page.locator('option', { hasText: 'Select the club you play veterans cricket for' }),
  });
  // Default (unanswered): no picker.
  await expect(vetSelect).toHaveCount(0);
  // "No" keeps it hidden.
  await page.getByRole('button', { name: 'No', exact: true }).click();
  await expect(vetSelect).toHaveCount(0);
  // "Yes" reveals it; the link/current club (berea) is NOT an option, the veterans club is.
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(vetSelect).toBeVisible();
  await expect(vetSelect.locator(`option[value="${vet}"]`)).toHaveCount(1);
  await expect(vetSelect.locator(`option[value="${link}"]`)).toHaveCount(0);

  // ── API: submit the registration declaring the veterans club (plain-active outcome) ──
  const idNumber = uniqueIdNumber();
  const res = await registerViaApi(request, link, token, { name, idNumber, veteransClubId: vet });
  expect(res.status(), await res.text()).toBe(201);

  // The joining club's row carries both veterans fields (name derived server-side).
  const row = await getPlayerByName(request, link, name);
  expect(row?.status).toBe('active');
  expect(row?.veteransClubId).toBe(vet);
  expect(row?.veteransClub, 'veterans club name derived server-side').toBeTruthy();

  // The veterans club (as its own rep) sees the affiliate — pointing back at the primary club,
  // and WITHOUT the PII naturalKey.
  const affiliates = await getVeteransAffiliates(request, vet);
  const mine = affiliates.find((a) => a.playerName === `Test ${name}`);
  expect(mine, 'affiliate listed under the veterans club').toBeTruthy();
  expect(mine!.primaryClubId).toBe(link);
  expect(mine!.source).toBe('registration');
  expect('naturalKey' in mine!, 'naturalKey (ID number) projected out').toBe(false);

  // No duplication: the veterans club's player count is untouched (affiliation ≠ roster row).
  expect(await getClubPlayerCount(request, vet)).toBe(vetCountBefore);
});

test("a veterans club's portal lists its affiliates with their primary club", async ({
  page,
  request,
}) => {
  const { primary, vet } = CLUBS.portal;
  const name = `Portal-${RUN}`;
  await createActivePlayer(request, primary, { name, veteransClubId: vet });
  const primaryName = await getClubName(request, primary);

  await signInAsRep(page, vet);
  await page.goto(`/club/${vet}/players`);
  await dismissOnboarding(page);

  // The view-only "Veterans affiliates" card shows the affiliate's name and primary club. The
  // veterans club (ilembe) holds no roster row for this player, so the name appears only here.
  // Scope the primary-club assertion to the affiliates table (the one with a "Primary club"
  // column) so it can't strict-mode-collide with the same club name elsewhere on the page.
  await expect(page.getByText('Veterans affiliates')).toBeVisible();
  await expect(page.getByText(`Test ${name}`)).toBeVisible();
  const affiliatesTable = page.locator('table.tbl', {
    has: page.getByRole('columnheader', { name: 'Primary club' }),
  });
  await expect(affiliatesTable.getByText(primaryName)).toBeVisible();
});

test('an admin can change then remove a player’s veterans club from the cross-club register', async ({
  page,
  request,
}) => {
  const { primary, vet1, vet2 } = CLUBS.adminEdit;
  const name = `AdminEdit-${RUN}`;
  await createActivePlayer(request, primary, { name, veteransClubId: vet1 });

  await signInAsAdmin(page);
  await page.goto('/admin/players');
  await page.getByLabel('Search players').fill(name);
  await page.locator('table.tbl tbody tr', { hasText: `Test ${name}` }).click();

  const modal = page.locator('.task-modal');
  await expect(modal).toBeVisible();
  const select = modal.locator('select.field-select');
  await expect(select).toHaveValue(vet1);

  // ── Change the veterans club (vet1 → vet2) and Save ──
  await select.selectOption(vet2);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(select).toHaveValue(vet2);

  // API: the row now points at vet2; the old club's record is gone, the new club's is present.
  await expect
    .poll(async () => (await getPlayerByName(request, primary, name))?.veteransClubId)
    .toBe(vet2);
  expect(
    (await getVeteransAffiliates(request, vet1)).some((a) => a.playerName === `Test ${name}`),
    'old veterans club record deleted on change',
  ).toBe(false);
  const onVet2 = (await getVeteransAffiliates(request, vet2)).find(
    (a) => a.playerName === `Test ${name}`,
  );
  expect(onVet2?.primaryClubId).toBe(primary);
  expect(onVet2?.source).toBe('admin');

  // ── Remove the affiliation ──
  await modal.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(select).toHaveValue('');

  // API: both veterans fields cleared and no record remains under either club.
  await expect
    .poll(async () => (await getPlayerByName(request, primary, name))?.veteransClubId)
    .toBeUndefined();
  expect((await getPlayerByName(request, primary, name))?.veteransClub).toBeUndefined();
  expect(
    (await getVeteransAffiliates(request, vet2)).some((a) => a.playerName === `Test ${name}`),
    'record removed on clear',
  ).toBe(false);
});

test('a chair can declare a veterans club from their own roster', async ({ page, request }) => {
  const { primary, vet } = CLUBS.chair;
  const name = `Chair-${RUN}`;
  await createActivePlayer(request, primary, { name }); // no veterans club yet

  await signInAsRep(page, primary);
  await page.goto(`/club/${primary}/players`);
  await dismissOnboarding(page);

  await page.locator('table.tbl tbody tr', { hasText: `Test ${name}` }).click();
  const modal = page.locator('.task-modal');
  await expect(modal).toBeVisible();
  const select = modal.locator('select.field-select');
  await expect(select).toHaveValue('');

  await select.selectOption(vet);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  // It sticks in the UI.
  await expect(select).toHaveValue(vet);
  // Regression (stale-prop fix): after the FIRST Save the Remove button appears without reopening
  // the modal — the editor tracks the saved link locally rather than off the never-refreshed prop.
  await expect(modal.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();

  // API: the affiliation exists, declared from the portal.
  await expect
    .poll(
      async () =>
        (await getVeteransAffiliates(request, vet)).find((a) => a.playerName === `Test ${name}`)
          ?.source,
    )
    .toBe('portal');
  const affiliate = (await getVeteransAffiliates(request, vet)).find(
    (a) => a.playerName === `Test ${name}`,
  );
  expect(affiliate?.primaryClubId).toBe(primary);
});

test('a veterans declaration on a clearance materializes on approval and never on rejection', async ({
  request,
}) => {
  // API-level workflow (write-on-activation across a clearance). Two independent clearances, each
  // declaring the SAME veterans club but a run-unique player name, so their affiliates are
  // isolated by name.
  const { prev, link, vet } = CLUBS.activation;

  // ── Approve path ──
  const approveName = `ActApprove-${RUN}`;
  const approveClr = await seedPendingVeteransRegistration(request, {
    prevClub: prev,
    linkClub: link,
    name: approveName,
    veteransClubId: vet,
  });
  // While clearance-pending, no record exists yet (write-on-activation).
  expect(
    (await getVeteransAffiliates(request, vet)).some((a) => a.playerName === `Test ${approveName}`),
    'no record while clearance-pending',
  ).toBe(false);

  await overrideViaApi(request, approveClr, 'Issued for the veterans e2e');

  // On activation the record materializes with the DESTINATION (link club) as the primary club.
  await expect
    .poll(
      async () =>
        (await getVeteransAffiliates(request, vet)).find(
          (a) => a.playerName === `Test ${approveName}`,
        )?.primaryClubId,
    )
    .toBe(link);

  // ── Reject path ──
  const rejectName = `ActReject-${RUN}`;
  const rejectClr = await seedPendingVeteransRegistration(request, {
    prevClub: prev,
    linkClub: link,
    name: rejectName,
    veteransClubId: vet,
  });
  expect(
    (await getVeteransAffiliates(request, vet)).some((a) => a.playerName === `Test ${rejectName}`),
    'no record while clearance-pending',
  ).toBe(false);

  await rejectViaApi(request, rejectClr, 'Not our player');

  // The pending destination row (which carried the declaration) is deleted; the player reverts to
  // the previous club's row, which never declared a veterans club — so no record is ever written.
  await expect
    .poll(async () =>
      (await getVeteransAffiliates(request, vet)).some(
        (a) => a.playerName === `Test ${rejectName}`,
      ),
    )
    .toBe(false);

  // Leftover (harmless): the approve path leaves a permanent active player at `link` with a
  // materialized affiliate under `vet`; the reject path leaves an active player reverted to
  // `prev`. Both carry run-unique names, so no other test's name searches collide with them.
});
