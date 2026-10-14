import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API_BASE,
  RUN,
  adminAuthHeader,
  apiHeaders,
  createActivePlayer,
  getPlayerByName,
  listPlayers,
  mintRegLink,
  openClearancesFilteredTo,
  registerViaApi,
  repAuthHeader,
  signInAsAdmin,
} from './helpers';

/**
 * Tenant-wide player erasure (`DELETE /admin/players/:nk`) driven from the admin console, end to
 * end through the REAL local stack: a player registered at one club transfers to another (public
 * registration naming the old club → the old club approves, issuing a certificate), then the
 * union admin erases them from the player modal's danger zone. Afterwards the person is on no
 * club's roster and their clearance is gone from the console and the API.
 *
 * Asserts on visible text / roles, plus the API for the cross-club outcome.
 */

// Ilembe (source) → Umlazi (destination): 'complete' demo clubs no other clearance spec uses.
const FROM = 'ilembe';
const TO = 'umlazi';

interface ClearanceRow {
  id: string;
  version: number;
  playerName: string;
  fromClubId: string;
  status: string;
}

async function adminClearances(request: APIRequestContext): Promise<ClearanceRow[]> {
  const res = await request.get(`${API_BASE}/admin/clearances`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  expect(res.ok(), `GET /admin/clearances → ${res.status()}`).toBeTruthy();
  return (await res.json()) as ClearanceRow[];
}

test('an admin erases a transferred player from every club and the clearance list', async ({
  page,
  request,
}) => {
  const name = `Erase-${RUN}`;
  const fullName = `Test ${name}`;

  // ── Register at the source, then re-register at the destination naming it → clearance ──
  const player = await createActivePlayer(request, FROM, { name });
  const token = await mintRegLink(request, TO);
  const reg = await registerViaApi(request, TO, token, {
    name,
    idNumber: player.idNumber,
    lastClubId: FROM,
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const clr = (await adminClearances(request)).find(
    (c) => c.playerName === fullName && c.fromClubId === FROM,
  );
  expect(clr, 'the registration opened a clearance').toBeTruthy();

  // ── The source club approves (issues the clearance + its certificate) ──
  const issue = await request.patch(`${API_BASE}/clubs/${FROM}/clearances/${clr!.id}`, {
    headers: apiHeaders(repAuthHeader(FROM)),
    data: { action: 'issue', feesCleared: true, misconductCleared: true, version: clr!.version },
  });
  expect(issue.ok(), `issue clearance → ${issue.status()} ${await issue.text()}`).toBeTruthy();
  await expect.poll(async () => (await getPlayerByName(request, TO, name))?.status).toBe('active');

  // ── Erase from the admin player modal ──
  await signInAsAdmin(page);
  await page.goto('/admin/players');
  await page.getByLabel('Search players').fill(name);
  await page.locator('table.tbl tbody tr', { hasText: fullName }).first().click();

  const modal = page.locator('.task-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByText('every club in this organisation')).toBeVisible();
  const erase = modal.getByRole('button', { name: 'Erase player everywhere' });
  const confirm = modal.getByLabel(`Type ${fullName} to confirm`);
  // A near-miss keeps the button disabled; only the exact full name arms it.
  await confirm.fill(name);
  await expect(erase).toBeDisabled();
  await confirm.fill(fullName);
  await expect(erase).toBeEnabled();
  await erase.click();

  const toast = page.locator('.toast', { hasText: `${fullName} erased — ` });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText(new RegExp(`^${fullName} erased — `));
  await expect(toast).toContainText('1 clearance');
  await expect(modal).toHaveCount(0);

  // ── Gone from every roster and from the clearances list ──
  await expect(page.locator('table.tbl tbody tr', { hasText: fullName })).toHaveCount(0);
  for (const clubId of [FROM, TO]) {
    expect(
      (await listPlayers(request, clubId)).some((p) => p.lastName === name),
      `no ${clubId} row left`,
    ).toBe(false);
  }
  expect((await adminClearances(request)).some((c) => c.id === clr!.id)).toBe(false);

  await openClearancesFilteredTo(page, name);
  await expect(page.locator('.clr-card', { hasText: fullName })).toHaveCount(0);

  // A second erase finds nothing in any category.
  const again = await request.delete(
    `${API_BASE}/admin/players/${encodeURIComponent(player.naturalKey)}`,
    { headers: apiHeaders(adminAuthHeader()) },
  );
  expect(again.status()).toBe(404);
});
