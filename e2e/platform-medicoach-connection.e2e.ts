import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { verifySignature, IMPORT_CHECK_REFS_PATH } from '../packages/api/src/medicoach-sync-contract';
import {
  API_BASE,
  RUN,
  TENANT,
  adminAuthHeader,
  apiHeaders,
  operatorAuth,
  operatorIdentity,
} from './helpers';

/**
 * The operator's Match Centre connection console (ADR 0020, Phase 1) end to end:
 * client settings → Match Centre card → its console page → "Check now" → back to the
 * client list.
 *
 * 1. Nothing listens on the stack's MEDICOACH_SYNC_URL (:4799) — the reconcile can't ask
 *    medicoach, so the console must show "Not reachable" rather than fail. A stack reused
 *    without the sync env is a dry run instead: the warning banner + client-list pill.
 * 2. A STUB medicoach on :4799 (the medicoach-sync spec's pattern) answers check-refs with
 *    every ref `unmapped`; with the tenant's sync on and a released series seeded, "Check now"
 *    lists that series as awaiting carry and the client list carries the amber badge.
 *
 * afterAll re-reconciles with the stub answering "all mapped" (so no MCAWAIT# rows are left
 * on the shared tenant), restores the tenant's features, then closes the stub.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const SERIES_ID = `s-e2e-mcconn-${RUN}`;
const SERIES_NAME = `Match Centre carry E2E ${RUN}`;
const VENUE = `E2E Carry Ground ${RUN}`;
const DATE = '2027-03-06';

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

let stub: Server | null = null;
let stubMode: 'unmapped' | 'mapped' = 'unmapped';
let priorFeatures: Record<string, boolean> | undefined;

function startStub(): Promise<void> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const check = verifySignature({
        secret: SYNC_SECRET,
        method: req.method ?? 'GET',
        pathAndQuery: req.url ?? '',
        body: raw,
        timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
        signatureHeader: req.headers['x-sync-signature'] as string | undefined,
      });
      if (!check.ok) return void res.writeHead(401).end('{"error":"bad signature"}');
      if (req.method !== 'POST' || req.url !== IMPORT_CHECK_REFS_PATH)
        return void res.writeHead(404).end('{"error":"not stubbed"}');
      const { refs } = JSON.parse(raw) as { refs: string[] };
      const answer =
        stubMode === 'unmapped' ? { mapped: [], unmapped: refs } : { mapped: refs, unmapped: [] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  stub = server;
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

async function signInAsOperator(page: Page) {
  await page.addInitScript((identity) => {
    localStorage.setItem('smartclub.devAuth', JSON.stringify(identity));
  }, operatorIdentity([TENANT]));
}

/** The connection view straight from the API — tells the spec whether the stack is a dry run. */
async function connectionView(request: APIRequestContext) {
  const res = await request.get(`${API_BASE}/platform/tenants/${TENANT}/medicoach/connection`, {
    headers: operator(),
  });
  expect(res.ok(), `GET connection → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { dryRun: boolean; syncEnabled: boolean; awaitingTotal: number };
}

const card = (page: Page, title: RegExp) =>
  page.locator('.card', { has: page.locator('.card-title', { hasText: title }) });

/** One "label  value" line of the Connection card (the innermost div holding the label). */
const statusRow = (page: Page, label: string) =>
  card(page, /^Connection/)
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .last();

/** The client-list row whose slug cell reads exactly `slug`. */
const clientRow = (page: Page, slug: string) =>
  page.getByRole('row').filter({ has: page.getByText(slug, { exact: true }) });

async function seedReleasedSeries(request: APIRequestContext) {
  const venueId = `v-e2e-mcconn-${RUN}`;
  const venue = await request.put(`${API_BASE}/venues/${venueId}`, {
    headers: admin(),
    data: { id: venueId, name: VENUE },
  });
  expect(venue.ok(), `PUT venue → ${venue.status()} ${await venue.text()}`).toBeTruthy();
  const fixture = (id: string, time: string) => ({
    id,
    round: 1,
    date: DATE,
    time,
    home: 'ukzn',
    away: 'crusaders',
    venueName: VENUE,
  });
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: SERIES_ID,
      name: SERIES_NAME,
      startDate: DATE,
      leagueKey: 'premier',
      teams: ['ukzn', 'crusaders'],
      participants: [
        { teamId: 'ukzn', clubId: 'ukzn', name: 'UKZN' },
        { teamId: 'crusaders', clubId: 'crusaders', name: 'Crusaders' },
      ],
      fixtures: [fixture('f1', '09:30'), fixture('f2', '14:00')],
    },
  });
  expect(create.ok(), `POST /series → ${create.status()} ${await create.text()}`).toBeTruthy();
  let version = ((await create.json()) as { version: number }).version;
  for (const patch of [{ approved: true }, { released: true }]) {
    const res = await request.patch(`${API_BASE}/series/${SERIES_ID}`, {
      headers: admin(),
      data: { ...patch, version },
    });
    expect(res.ok(), `PATCH series → ${res.status()} ${await res.text()}`).toBeTruthy();
    version = ((await res.json()) as { version: number }).version;
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  priorFeatures = ((await cfg.json()) as { features?: Record<string, boolean> }).features ?? {};
});

test.afterAll(async ({ request }) => {
  if (stub) {
    // Clear the awaiting rows this spec caused while the sync (and so the walk) is still on.
    stubMode = 'mapped';
    await request.post(`${API_BASE}/platform/tenants/${TENANT}/medicoach/reconcile`, {
      headers: operator(),
    });
  }
  if (priorFeatures)
    await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
      headers: operator(),
      data: { features: priorFeatures },
    });
  if (stub) await new Promise<void>((r) => stub!.close(() => r()));
});

test('an operator checks the Match Centre connection when medicoach cannot be reached', async ({
  page,
  request,
}) => {
  const { dryRun, syncEnabled } = await connectionView(request);
  await signInAsOperator(page);

  // Client settings → the Match Centre card.
  await page.goto(`/platform/tenants/${TENANT}?tenant=${TENANT}`);
  const mc = card(page, /^Match Centre$/);
  await expect(mc).toBeVisible();
  await expect(mc.locator('.pill')).toContainText('(inferred)');
  await expect(mc.getByRole('alert')).toHaveCount(dryRun ? 1 : 0);
  if (dryRun) await expect(mc.getByRole('alert')).toContainText('Sync secrets not configured');
  await expect(mc.getByRole('status')).toContainText('awaiting carry to Match Centre');

  // → its console page.
  await mc.getByRole('button', { name: 'Open console' }).click();
  await expect(page).toHaveURL(new RegExp(`/platform/tenants/${TENANT}/medicoach$`));
  await expect(page.getByRole('heading', { name: /Match Centre\s*connection/ })).toBeVisible();
  await expect(card(page, /^Connection/).locator('.pill')).toContainText('(inferred)');
  const awaiting = card(page, /^Awaiting carry$/);
  await expect(awaiting.getByRole('status')).toContainText('awaiting carry to Match Centre');

  // Check now: nothing answers on the sync URL (or no request is made in a dry run) — the
  // reconcile is stamped unreachable and the page says so instead of erroring. The toast says
  // no check happened rather than reporting the stale awaiting count as a fresh result.
  const check = page.getByRole('button', { name: 'Check now' });
  await expect(check).toBeEnabled();
  await check.click();
  if (dryRun) {
    await expect(page.locator('.toast')).toContainText(
      'Sync secrets are not configured — no check was made.',
    );
  } else {
    await expect(page.locator('.toast.error')).toContainText(
      "Couldn't reach the Match Centre — showing the last known state.",
    );
  }
  await expect(page.locator('.toast')).not.toContainText(/awaiting carry/);
  await expect(statusRow(page, 'Match Centre')).toContainText('Not reachable');
  await expect(statusRow(page, 'Last reconcile')).not.toContainText('Never');
  await expect(check).toBeEnabled();
  await expect(page.getByRole('heading', { name: /Match Centre\s*connection/ })).toBeVisible();

  // Back on the client list: the client's row and its status cell render.
  await page.goto(`/platform?tenant=${TENANT}`);
  const row = clientRow(page, TENANT);
  await expect(row).toBeVisible();
  await expect(row.getByText(/^(Live|In setup)$/)).toBeVisible();
  // The Dry-run pill is gated on the client's sync being on (like the awaiting pill).
  await expect(row.getByText('Dry-run', { exact: true })).toHaveCount(dryRun && syncEnabled ? 1 : 0);
});

test('released fixtures medicoach has no record of are listed and badged as awaiting carry', async ({
  page,
  request,
}) => {
  const { dryRun } = await connectionView(request);
  test.skip(dryRun, 'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the env)');

  await startStub();
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: { ...priorFeatures, medicoachSync: true } },
  });
  expect(put.ok(), `enable sync → ${put.status()} ${await put.text()}`).toBeTruthy();
  await seedReleasedSeries(request);

  await signInAsOperator(page);
  await page.goto(`/platform/tenants/${TENANT}/medicoach?tenant=${TENANT}`);
  await expect(page.getByRole('heading', { name: /Match Centre\s*connection/ })).toBeVisible();
  await page.getByRole('button', { name: 'Check now' }).click();

  // Medicoach answered: reachable, and our two fixtures are listed under their series.
  await expect(statusRow(page, 'Match Centre')).toContainText('Reachable');
  await expect(statusRow(page, 'Match Centre')).not.toContainText('Not reachable');
  const awaiting = card(page, /^Awaiting carry$/);
  await expect(awaiting.getByRole('status')).toContainText(/\d+ fixtures? awaiting carry/);
  await expect(awaiting).toContainText('need a one-off carry');
  const seriesRow = awaiting.getByRole('row', { name: new RegExp(SERIES_NAME) });
  await expect(seriesRow).toHaveCount(1);
  await expect(seriesRow.getByRole('cell').nth(1)).toHaveText('premier');
  await expect(seriesRow.getByRole('cell').nth(2)).toHaveText('2');
  await expect(page.locator('.toast')).toContainText(/fixtures? awaiting carry/);

  // The client list carries the amber "N awaiting carry" badge for this client.
  await page.goto(`/platform?tenant=${TENANT}`);
  const row = clientRow(page, TENANT);
  await expect(row.getByText(/^\d+ awaiting carry$/)).toBeVisible();
  const { awaitingTotal } = await connectionView(request);
  await expect(row.getByText(`${awaitingTotal} awaiting carry`, { exact: true })).toBeVisible();
});
