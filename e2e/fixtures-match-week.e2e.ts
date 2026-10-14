import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { verifySignature } from '../packages/api/src/medicoach-sync-contract';
import {
  API_BASE,
  TENANT,
  RUN,
  adminAuthHeader,
  apiHeaders,
  operatorAuth,
  setReportNoticeWindow,
  signInAsAdmin,
} from './helpers';
import { approveAndRelease, createSeries, fixture, getSeries, ground } from './fixtures-helpers';

/**
 * The match-week office happy path, end to end against the real local stack:
 *  1. This week: add a fixture from the hub, appoint an umpire and a scorer, and re-save the
 *     umpires alone — the scorer stays (each officials key replaces only its own part).
 *  2. Results: a result pulled from a STUB medicoach is confirmed, withdrawn, confirmed again;
 *     a newer result from medicoach then shows as changed since confirmed.
 *  3. Leagues & tournaments: create a knockout (preview → create), Set team on a final side,
 *     record the round-1 results, advance — the other `win:` side fills, the manual side stays.
 *
 * Results only ever arrive through the medicoach puller, so the spec stands up the same stub
 * the captain's-report specs use (:4799, HMAC-checked) and turns `medicoachSync` on for the
 * tenant (restored in afterAll). A reused stack without MEDICOACH_SYNC_URL/SECRET answers
 * "Sync now" with a dry run, and the result tests skip. Edge cases live in the int tests.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';

let stub: Server;
let page: unknown = null;
let priorFeatures: Record<string, boolean> | undefined;
let priorIntegrations: unknown;

const admin = () => apiHeaders(adminAuthHeader());
const operator = () => apiHeaders(operatorAuth());
const isoDay = (offset: number) =>
  new Date(Date.now() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    const check = verifySignature({
      secret: SYNC_SECRET,
      method: req.method ?? 'GET',
      pathAndQuery: req.url ?? '',
      body: '',
      timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
      signatureHeader: req.headers['x-sync-signature'] as string | undefined,
    });
    if (!check.ok) {
      res.writeHead(401).end('{"error":"bad signature"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

interface StubResult {
  seriesId: string;
  fixtureId: string;
  date: string;
  winner: 'home' | 'away';
  recordedAt: string;
}

/** A changes page carrying one manual result per entry. */
function resultsPage(results: StubResult[]) {
  const cursor = results.map((r) => r.recordedAt).sort()[results.length - 1];
  return {
    version: 1,
    tenant: TENANT,
    nextCursor: cursor,
    hasMore: false,
    fixtures: results.map((r) => ({
      ref: `smartclub:${TENANT}:fixture:${r.seriesId}:${r.fixtureId}`,
      syncStamp: r.recordedAt,
      schedule: {
        scheduledTime: `${r.date}T09:00:00+02:00`,
        timeTbc: false,
        dateTbc: false,
        venue: null,
        postponed: false,
        cancelled: false,
        changedAt: '2026-09-01T00:00:00.000Z',
      },
      teams: { homeRef: null, awayRef: null },
      result: {
        homeScore: r.winner === 'home' ? '180/4' : '140/9',
        awayScore: r.winner === 'home' ? '150/8' : '141/3',
        summary: r.winner === 'home' ? 'Home won by 30 runs' : 'Away won by 7 wickets',
        winner: r.winner,
        method: 'normal',
        noResult: false,
        source: 'manual',
        recordedAt: r.recordedAt,
        scoringSide: null,
        captainRef: null,
        medicoachMatchUrl: null,
      },
      resultClearedAt: null,
    })),
  };
}

/** Serve `results` from the stub and pull them; skips when the stack runs sync as a dry run. */
async function pullResults(request: APIRequestContext, results: StubResult[]) {
  page = resultsPage(results);
  const sync = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
    headers: admin(),
  });
  expect(sync.ok(), `sync-now → ${sync.status()} ${await sync.text()}`).toBeTruthy();
  const summary = (await sync.json()) as { status: string; counts: { resultsStored: number } };
  test.skip(
    summary.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  expect(summary.counts.resultsStored).toBe(results.length);
}

/** Delete every series whose name starts with `prefix` (re-run hygiene on a shared demo DB). */
async function deleteSeriesNamed(request: APIRequestContext, prefix: string) {
  const res = await request.get(`${API_BASE}/series`, { headers: admin() });
  for (const s of (await res.json()) as Array<{ id: string; name: string }>)
    if (s.name.startsWith(prefix))
      await request.delete(`${API_BASE}/series/${s.id}`, { headers: admin() });
}

async function createPerson(request: APIRequestContext, kind: 'umpires' | 'scorers', name: string) {
  const res = await request.post(`${API_BASE}/${kind}`, {
    headers: admin(),
    data: { displayName: name },
  });
  expect(res.ok(), `POST /${kind} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

interface Fx {
  id: string;
  round?: number;
  date: string;
  home: string;
  away: string;
  slots?: { home?: string; away?: string };
  slotsManual?: { home?: true; away?: true };
  officials?: { umpires: Array<{ umpireId: string }>; scorers?: Array<{ scorerId: string }> };
  result?: { recordedAt: string; changedSinceConfirmed?: boolean; confirmation?: unknown };
}
const fixturesOf = async (request: APIRequestContext, id: string) =>
  (await getSeries(request, id)).fixtures as unknown as Fx[];

/** Pick a person in an OfficialsDialog slot: type the name, click the suggestion. */
async function pick(dialog: ReturnType<Page['getByRole']>, slot: string, name: string) {
  await dialog.getByRole('combobox', { name: slot, exact: true }).fill(name);
  await dialog.getByRole('option', { name }).click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  // Pinned closed: an evening run must not fire the match-day captain's report pass here.
  await setReportNoticeWindow(request, 'closed');
  await startStub();
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  const body = (await cfg.json()) as { features?: Record<string, boolean>; integrations?: unknown };
  priorFeatures = body.features ?? {};
  priorIntegrations = body.integrations ?? {};
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: {
      features: { ...priorFeatures, medicoachSync: true },
      integrations: { medicoach: { goLiveDate: isoDay(-30) } },
    },
  });
  expect(put.ok(), `enable sync → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await setReportNoticeWindow(request, 'real');
  await new Promise<void>((r) => stub.close(() => r()));
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures, integrations: priorIntegrations },
  });
});

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('this week: add a fixture, appoint an umpire and a scorer; re-saving umpires keeps the scorer', async ({
  page,
  request,
}) => {
  await deleteSeriesNamed(request, 'E2E Match week ');
  const name = `E2E Match week ${RUN}`;
  const s = await createSeries(request, {
    name,
    teams: ['harlequins', 'spartan'],
    fixtures: [],
    startDate: isoDay(0),
  });
  const ump = `Ump MW${RUN}`;
  const scorer = `Scorer MW${RUN}`;
  await createPerson(request, 'umpires', ump);
  await createPerson(request, 'scorers', scorer);

  // The week the hub opens on (WeekView: Mon/Tue show the weekend just played).
  const today = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // SAST
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((dow + 6) % 7) - (dow === 1 || dow === 2 ? 7 : 0));
  const saturday = addDays(monday, 5);

  await page.goto('/admin/fixtures');
  await expect(page.getByRole('tab', { name: /This week/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: '+ Add fixture' }).click();
  const add = page.getByRole('dialog', { name: 'Add a fixture' });
  await add.getByLabel('Series').selectOption({ label: name });
  await add.getByLabel('Date').fill(saturday);
  await add.getByLabel('Start time').fill('17:45');
  await add.getByLabel('Home (host)').selectOption('harlequins');
  await add.getByLabel('Away (visitors)').selectOption('spartan');
  await add.getByLabel('Somewhere else').check();
  await add.getByLabel('Ground name').fill(ground('matchWeek'));
  await add.getByRole('button', { name: 'Add fixture' }).click();
  await expect(add).toHaveCount(0);

  const line = page.locator('li.fh-line', { hasText: name });
  await expect(line).toHaveCount(1);
  const [fx] = await fixturesOf(request, s.id);
  expect(fx).toMatchObject({ date: saturday, home: 'harlequins', away: 'spartan' });

  await line.getByRole('button', { name: /^Add umpire to/ }).click();
  let dialog = page.getByRole('dialog', { name: 'Appoint umpires' });
  await pick(dialog, 'Umpire 1', ump);
  await dialog.getByRole('button', { name: 'Save umpires' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    line.getByRole('button', { name: new RegExp(`Change umpires .*\\(${ump}\\)`) }),
  ).toBeVisible();

  await line.getByRole('button', { name: /^Add scorer to/ }).click();
  dialog = page.getByRole('dialog', { name: 'Appoint scorers' });
  await pick(dialog, 'Scorer', scorer);
  await dialog.getByRole('button', { name: 'Save scorers' }).click();
  await expect(dialog).toHaveCount(0);
  const scorerChip = line.getByRole('button', {
    name: new RegExp(`Change scorers .*\\(${scorer}\\)`),
  });
  await expect(scorerChip).toBeVisible();

  // Re-save the umpires alone: the scorer must survive (the officials PUT is per-key).
  await line.getByRole('button', { name: new RegExp(`Change umpires .*\\(${ump}\\)`) }).click();
  dialog = page.getByRole('dialog', { name: 'Appoint umpires' });
  await dialog.getByRole('button', { name: 'Save umpires' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(scorerChip).toBeVisible();
  const [after] = await fixturesOf(request, s.id);
  expect(after.officials?.umpires).toHaveLength(1);
  expect(after.officials?.scorers).toHaveLength(1);
});

test('results: confirm, withdraw, confirm again; a newer result shows as changed', async ({
  page,
  request,
}) => {
  await deleteSeriesNamed(request, 'E2E Confirm ');
  const name = `E2E Confirm ${RUN}`;
  const date = isoDay(-1);
  const s = await createSeries(request, {
    name,
    fixtures: [
      fixture({
        id: 'f1',
        date,
        time: '15:00',
        home: 'phoenix',
        away: 'verulam',
        venueOverride: ground('confirm'),
      }),
    ],
  });
  await approveAndRelease(request, s.id);
  await pullResults(request, [
    { seriesId: s.id, fixtureId: 'f1', date, winner: 'home', recordedAt: new Date().toISOString() },
  ]);

  await page.goto('/admin/fixtures?tab=results');
  await page.getByPlaceholder('Search a team, ground or series').fill(name);
  const toConfirm = page.getByRole('region', { name: 'Results to confirm' });
  const confirmBtn = toConfirm.getByRole('button', {
    name: 'Confirm the result of Phoenix CC v Verulam CC',
  });
  await confirmBtn.click();
  await expect(confirmBtn).toHaveCount(0);
  expect((await fixturesOf(request, s.id))[0].result?.confirmation).toBeTruthy();

  // Withdraw (from the Confirmed list), then it is back to confirm.
  const confirmed = page.getByRole('region', { name: 'Confirmed results' });
  await confirmed.getByRole('button', { name: 'Show' }).click();
  await confirmed
    .getByRole('button', { name: 'Withdraw confirmation of Phoenix CC v Verulam CC' })
    .click();
  await expect(confirmBtn).toBeVisible();
  expect((await fixturesOf(request, s.id))[0].result?.confirmation).toBeFalsy();
  await confirmBtn.click();
  await expect(confirmBtn).toHaveCount(0);

  // Medicoach re-records the result later: the confirmation no longer covers it.
  await pullResults(request, [
    {
      seriesId: s.id,
      fixtureId: 'f1',
      date,
      winner: 'away',
      recordedAt: new Date(Date.now() + 1000).toISOString(),
    },
  ]);
  expect((await fixturesOf(request, s.id))[0].result?.changedSinceConfirmed).toBe(true);
  await page.reload();
  await page.getByPlaceholder('Search a team, ground or series').fill(name);
  await expect(
    page.getByText('Medicoach changed this result after it was confirmed — check it again.'),
  ).toBeVisible();
  await expect(confirmBtn).toHaveText('Confirm again');
});

test('a knockout: create from the hub, Set team on the final, advance fills the other side only', async ({
  page,
  request,
}) => {
  const name = `E2E Cup ${RUN}`;
  // A Saturday far ahead, varied per run so a reused DB never makes a team busy.
  const first = addDays('2028-01-01', 7 * Math.floor(Math.random() * 200));

  await page.goto('/admin/fixtures?tab=series');
  await page.getByRole('button', { name: '+ Create tournament' }).click();
  const dlg = page.getByRole('dialog', { name: 'Create a tournament' });
  await dlg.getByLabel('Name').fill(name);
  await dlg.getByRole('button', { name: 'None' }).click();
  for (const club of ['Tongaat CC', 'Ilembe CC', 'Rhythm DHSOB CC', 'African Warriors CC'])
    await dlg.getByLabel(club, { exact: true }).check();
  await dlg.getByLabel('First round').fill(first);
  await dlg.getByRole('button', { name: 'Preview fixtures' }).click();
  await expect(dlg.getByRole('region', { name: 'Fixture preview' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Create tournament (draft)' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();

  const all = (await (
    await request.get(`${API_BASE}/series`, { headers: admin() })
  ).json()) as Array<{
    id: string;
    name: string;
  }>;
  const ko = all.find((x) => x.name.startsWith(name));
  expect(ko, 'the knockout series exists').toBeTruthy();
  const fx = await fixturesOf(request, ko!.id);
  const r1 = fx.filter((f) => (f.round ?? 1) === 1);
  const final = fx.find((f) => f.home.startsWith('win:'))!;
  expect(r1).toHaveLength(2);
  expect(final.away.startsWith('win:')).toBe(true);
  const a = r1.find((f) => final.home === `win:${f.id}`)!;
  const b = r1.find((f) => final.away === `win:${f.id}`)!;

  // Set team on the final's away side (b's HOME team; b's result below says AWAY won).
  const row = page.locator('.fix-table tbody tr', { hasText: /Winner of/ }).first();
  await row.locator('[title="Edit fixture"]').click();
  const editor = page.locator('tr.fix-edit-tr');
  await editor.getByLabel('Team to set as away').selectOption(b.home);
  await editor.getByRole('button', { name: 'Set away team' }).click();
  await expect(editor.getByRole('button', { name: 'Revert away to placeholder' })).toBeVisible();
  let fin = (await fixturesOf(request, ko!.id)).find((f) => f.id === final.id)!;
  expect(fin.away).toBe(b.home);
  expect(fin.slotsManual).toEqual({ away: true });

  await pullResults(request, [
    {
      seriesId: ko!.id,
      fixtureId: a.id,
      date: a.date,
      winner: 'home',
      recordedAt: new Date().toISOString(),
    },
    {
      seriesId: ko!.id,
      fixtureId: b.id,
      date: b.date,
      winner: 'away',
      recordedAt: new Date().toISOString(),
    },
  ]);

  await page.getByRole('tab', { name: 'Bracket' }).click();
  await page.getByRole('button', { name: 'Advance knockout' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '1 knockout place filled' }),
  ).toBeVisible();
  fin = (await fixturesOf(request, ko!.id)).find((f) => f.id === final.id)!;
  expect(fin.home).toBe(a.home);
  expect(fin.slots?.home).toBe(`win:${a.id}`);
  // The manual side is the admin's: advance never overwrites it with b's winner.
  expect(fin.away).toBe(b.home);
  expect(fin.slotsManual).toEqual({ away: true });
});
