import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API_BASE,
  apiHeaders,
  adminAuthHeader,
  signInAsRep,
  dismissOnboarding,
  RUN,
} from './helpers';

/**
 * Regression for Sentry DOLPHINS-WEB-6 (prod, fixed in 260e805). Import CLIs (Titans compliance
 * intake, Titans contacts, Tuskers) append coaches to a club record in a BARE shape —
 * `{ name, email, cell, source }` — with none of the affiliation form's `teams`/`teamIds` arrays.
 * The affiliation form used to hydrate `club.coaches` verbatim, so on step 3 ("Leagues & Coaches")
 * the moment a chair ticked a league, the per-league banner ran
 * `data.coaches.filter((x) => x.c.teams.includes(key))` and threw
 * `TypeError: Cannot read properties of undefined (reading 'includes')`; the view's error
 * boundary replaced the whole form with "Something went wrong loading this view". The fix
 * backfills EMPTY_COACH defaults (teams: [], teamIds: []) at hydration.
 *
 * WHY the seed shape matters: the bug only exists for coaches WITHOUT `teams`. Anything the form
 * itself saves is already form-shaped, so the seed must bypass the form. PATCH /clubs/:id stores
 * `coaches` as given — it runs through applyClubPatch → repo.updateClub, a shallow spread with no
 * coach normalisation (validateClubPatch only checks idNumber/yearsExperience/yearStarted/teamIds
 * when present) — which is the same repo.updateClub write the import CLIs make. So the seed below
 * PATCHes a coaches array whose entry has NO `teams` and NO `teamIds` keys: exactly the prod shape.
 *
 * If the hydration normalisation is removed, ticking the first league crashes the view and the
 * banner assertions below fail. Assertions are user-observable only (visible text/roles).
 *
 * Residue (shared in-memory DB): verulam's `coaches` is REPLACED with the single bare coach below
 * (the demo seed has none, and replacing rather than appending keeps the sidebar count exact on a
 * reused stack). The form is never saved, so verulam's leagues, affiliation status and roster are
 * untouched; the other specs use verulam only as a roster/clearance club.
 */

// verulam: an in_progress demo club (so the form is editable, not the read-only submitted view)
// with NO leagues selected — step 3 opens with zero banners, so the league tick is the trigger,
// just as for the imported prod clubs. Both leagues below are in its district's catalogue.
const CLUB = 'verulam';
const LEAGUE_A = 'EMCU Division 1';
const LEAGUE_B = 'EMCU Division 2';

async function seedBareCoaches(
  request: APIRequestContext,
  clubId: string,
  coaches: Array<Record<string, unknown>>,
): Promise<void> {
  const get = await request.get(`${API_BASE}/clubs/${clubId}`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  expect(get.ok(), `GET /clubs/${clubId} → ${get.status()}`).toBeTruthy();
  const club = (await get.json()) as { version: number; leagues?: string[] };
  // The premise of this spec: no league banners render until the test ticks one.
  expect(club.leagues ?? [], `${clubId} should start with no leagues selected`).toEqual([]);
  const res = await request.patch(`${API_BASE}/clubs/${clubId}`, {
    headers: apiHeaders(adminAuthHeader()),
    data: { coaches, version: club.version },
  });
  expect(
    res.ok(),
    `PATCH /clubs/${clubId} coaches → ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

test('ticking leagues on step 3 renders the coach banners for a club with import-shaped (bare) coaches', async ({
  page,
  request,
}) => {
  const coachName = `Imported Coach ${RUN}`;
  // The import-CLI shape: NO `teams`, NO `teamIds`.
  await seedBareCoaches(request, CLUB, [
    { name: coachName, body: 'None', level: 'None', status: 'Completed' },
  ]);

  await signInAsRep(page, CLUB);
  await page.goto(`/club/${CLUB}/affiliation`);
  // verulam isn't 'complete', so the first-run walkthrough may pop over the form.
  await dismissOnboarding(page);

  await page.getByRole('button', { name: /Leagues & Coaches/ }).click();
  await expect(page.getByText('Coaches by Designation', { exact: true })).toBeVisible();
  // No league ticked yet → the empty-state prompt, no banners.
  await expect(page.getByText(/Select at least one league above/)).toBeVisible();

  const crash = page.getByText('Something went wrong loading this view');
  // The sidebar summary counts the bare coach: it was hydrated and carried into the form.
  const coachesSummary = page.locator('.aff-summary-row', { hasText: 'Coaches' });

  // ── First league: pre-fix this tick threw on `c.teams.includes` and killed the view ──
  await page.getByRole('button', { name: LEAGUE_A, exact: true }).click();
  await expect(page.getByText(`No coach assigned to ${LEAGUE_A} yet`)).toBeVisible();
  await expect(crash).toHaveCount(0);
  await expect(page.getByText('Coaches by Designation', { exact: true })).toBeVisible();
  await expect(coachesSummary).toContainText('1 listed');

  // ── Second league: the per-banner filter runs again over the same bare coach ──
  await page.getByRole('button', { name: LEAGUE_B, exact: true }).click();
  await expect(page.getByText(`No coach assigned to ${LEAGUE_B} yet`)).toBeVisible();
  await expect(page.getByText(`No coach assigned to ${LEAGUE_A} yet`)).toBeVisible();
  await expect(crash).toHaveCount(0);
  await expect(page.locator('.aff-summary-row', { hasText: 'Leagues' })).toContainText('2 entered');
  await expect(coachesSummary).toContainText('1 listed');

  // The banners stay interactive: adding a coach under a league renders its capture card.
  await page.getByRole('button', { name: 'Add coach' }).first().click();
  await expect(page.getByText(`No coach assigned to ${LEAGUE_A} yet`)).toHaveCount(0);
  await expect(page.getByText(/Coach #2/)).toBeVisible();
  await expect(crash).toHaveCount(0);
});
