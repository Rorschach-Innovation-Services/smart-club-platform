import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API_BASE,
  TENANT,
  RUN,
  adminAuthHeader,
  apiHeaders,
  operatorAuth,
  signInAsAdmin,
} from './helpers';
import {
  CLUB_NAME,
  createReleased,
  fixture,
  getSeries,
  ground,
  openAdminSeries,
} from './fixtures-helpers';

/**
 * Fixture create/delete propagation to medicoach (contract §2 create/delete ops), from the
 * admin console's side, on a RELEASED series that is sync-mapped (`medicoachSync` on, a
 * mapped leagueKey):
 *  1. adding a fixture from the hub saves cleanly and queues it for medicoach;
 *  2. removing a fixture is refused once (409 synced_fixture_removed) and the dialog explains
 *     that "Remove from both" deletes the Match Centre copy, result included — confirming it
 *     removes the fixture;
 *  3. the whole-series delete confirm discloses that Match Centre deletes its copies too.
 *
 * Writes only queue (PENDINGSYNC#); nothing flushes without "Sync now", so no stub medicoach
 * is needed. The tenant's features are restored in afterAll; the series is deleted at the end
 * of the test (via the confirm), so no residue beyond run-unique grounds.
 */

const admin = () => apiHeaders(adminAuthHeader());
const operator = () => apiHeaders(operatorAuth());
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

let priorFeatures: Record<string, boolean> | undefined;

async function outboxCount(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${API_BASE}/integrations/medicoach/status`, { headers: admin() });
  expect(res.ok(), `status → ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { outbox?: { count: number } }).outbox?.count ?? 0;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  priorFeatures = ((await cfg.json()) as { features?: Record<string, boolean> }).features ?? {};
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: { ...priorFeatures, medicoachSync: true } },
  });
  expect(put.ok(), `enable sync → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures },
  });
});

test('a synced series: add saves, remove asks "Remove from both", series delete discloses Match Centre', async ({
  page,
  request,
}) => {
  // The week the hub opens on (WeekView: Mon/Tue show the weekend just played).
  const today = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // SAST
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((dow + 6) % 7) - (dow === 1 || dow === 2 ? 7 : 0));
  const saturday = addDays(monday, 5);

  const name = `E2E Fixture sync ${RUN}`;
  const s = await createReleased(request, {
    name,
    // A run-unique league: a create is refused when another run-less series of the same
    // league + stream shares the group label (other specs leave 'premier' series behind).
    leagueKey: `e2e-fxsync-${RUN}`,
    teams: ['ukzn', 'clares', 'harlequins', 'spartan'],
    fixtures: [
      fixture({
        id: 'f1',
        home: 'ukzn',
        away: 'clares',
        date: saturday,
        time: '09:00',
        venueOverride: ground('fxsyncSeed'),
      }),
    ],
  });
  expect(s.released).toBe(true);

  await signInAsAdmin(page);
  const before = await outboxCount(request);

  // ── 1. Add a fixture to the released, mapped series ──
  await page.goto('/admin/fixtures');
  await page.getByRole('button', { name: '+ Add fixture' }).click();
  const add = page.getByRole('dialog', { name: 'Add a fixture' });
  await add.getByLabel('Series').selectOption({ label: name });
  await add.getByLabel('Date').fill(saturday);
  await add.getByLabel('Start time').fill('13:30');
  await add.getByLabel('Home (host)').selectOption('harlequins');
  await add.getByLabel('Away (visitors)').selectOption('spartan');
  await add.getByLabel('Somewhere else').check();
  await add.getByLabel('Ground name').fill(ground('fxsyncAdd'));
  await add.getByRole('button', { name: 'Add fixture' }).click();
  await expect(add).toHaveCount(0);

  const lines = page.locator('li.fh-line', { hasText: name });
  await expect(lines).toHaveCount(2);
  const stored = (await getSeries(request, s.id)).fixtures as Array<{ home: string; away: string }>;
  expect(stored.map((f) => `${f.home}-${f.away}`).sort()).toEqual([
    'harlequins-spartan',
    'ukzn-clares',
  ]);
  // The new fixture is queued for medicoach (as a create) — the write path did not regress.
  expect(await outboxCount(request)).toBeGreaterThan(before);

  // ── 2. Remove the seeded fixture: refused once, then "Remove from both" ──
  const label = `${CLUB_NAME.ukzn} v ${CLUB_NAME.clares}`;
  await page.getByRole('button', { name: `More for ${label}` }).click();
  await page.getByRole('menuitem', { name: `Remove ${label}` }).click();
  const remove = page.getByRole('dialog', { name: 'Remove this fixture?' });
  await remove.getByRole('button', { name: 'Remove fixture' }).click();
  const alert = remove.getByRole('alert');
  await expect(alert).toContainText(
    'Match Centre already holds this fixture. Removing it here deletes it from Match Centre too, including any recorded result.',
  );
  await expect(remove.getByRole('button', { name: 'Remove here only' })).toHaveCount(0);
  await remove.getByRole('button', { name: 'Remove from both' }).click();
  await expect(remove).toHaveCount(0);
  await expect(lines).toHaveCount(1);
  const left = (await getSeries(request, s.id)).fixtures as Array<{ home: string }>;
  expect(left.map((f) => f.home)).toEqual(['harlequins']);

  // ── 3. Delete the whole series: the confirm discloses the Match Centre deletes ──
  const detail = await openAdminSeries(page, name);
  await detail.getByRole('button', { name: 'Delete series' }).click();
  const confirm = page.locator('.fix-confirm-body');
  await expect(confirm).toContainText(
    'Any of them Match Centre holds are deleted there too, including recorded results.',
  );
  await page.locator('.fix-confirm-actions').getByRole('button', { name: 'Delete series' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  const all = (await (
    await request.get(`${API_BASE}/series`, { headers: admin() })
  ).json()) as Array<{
    id: string;
  }>;
  expect(all.find((x) => x.id === s.id)).toBeUndefined();
});
