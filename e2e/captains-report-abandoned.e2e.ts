import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
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
import { approveAndRelease, createSeries, fixture, ground } from './fixtures-helpers';

/**
 * No captain's reports for an abandoned match, end to end:
 *  - a released fixture dated today, no result yet, window forced OPEN: "Sync now" opens one
 *    pending report per side (the match-day opener);
 *  - medicoach then records the match ABANDONED: the next "Sync now" voids both pending
 *    reports — the admin's Pending count drops by two, the rows read "Void · Match abandoned",
 *    and the chair's link shows the closed-report page;
 *  - a second fixture whose abandoned result arrives before any notice never gets a report.
 *
 * The abandoned result is the real wire shape (packages/api/test/data/csa-e2e/changes.json:
 * winner 'none', method 'abandoned', noResult true). Same STUB medicoach harness as
 * captains-report-matchday.e2e.ts (:4799, HMAC-checked); a stack reused without the sync env
 * answers "Sync now" with a dry run, and the spec skips. Its own clubs (Umlazi v Harlequins,
 * Berea v Ilembe — not the other report specs') and RUN-unique series, so the shared
 * in-memory DB's other report rows are untouched. The window is restored in afterAll.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
const HOME = 'umlazi';
const AWAY = 'harlequins';
const EARLY_HOME = 'berea';
const EARLY_AWAY = 'ilembe';
const SERIES_NAME = `Captain's report abandoned E2E ${RUN}`;
const EARLY_SERIES_NAME = `Captain's report abandoned early E2E ${RUN}`;

const isoDay = (offset: number) =>
  new Date(Date.now() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
// Match day = today in SAST (the opener's tenant-local "today").
const MATCH_DATE = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);

let stub: Server;
let stubPage: unknown = null;
let seriesId = '';
let priorFeatures: Record<string, boolean> | undefined;
let priorIntegrations: unknown;

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
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stubPage));
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

/** An empty page: medicoach has nothing for this tenant yet (the cursor must be a string). */
function emptyPage() {
  return {
    version: 1,
    tenant: TENANT,
    nextCursor: new Date().toISOString(),
    hasMore: false,
    fixtures: [],
  };
}

/** Medicoach records the fixture ABANDONED (host-recorded shape: winner none, noResult true). */
function abandonedPage(forSeriesId: string) {
  const recordedAt = new Date().toISOString();
  return {
    version: 1,
    tenant: TENANT,
    nextCursor: recordedAt,
    hasMore: false,
    fixtures: [
      {
        ref: `smartclub:${TENANT}:fixture:${forSeriesId}:f1`,
        syncStamp: recordedAt,
        schedule: {
          scheduledTime: `${MATCH_DATE}T09:00:00+02:00`,
          timeTbc: false,
          dateTbc: false,
          venue: null,
          postponed: false,
          cancelled: false,
          changedAt: '1970-01-01T00:00:00.000Z',
        },
        teams: { homeRef: null, awayRef: null },
        result: {
          homeScore: null,
          awayScore: null,
          summary: 'Abandoned',
          winner: 'none',
          method: 'abandoned',
          noResult: true,
          source: 'manual',
          recordedAt,
          scoringSide: null,
          captainRef: null,
          medicoachMatchUrl: null,
        },
        resultClearedAt: null,
      },
    ],
  };
}

type Counts = { deferred: number; opened: number; notified: number; failed: number };
type SyncSummary = {
  status: string;
  reportNotices?: Counts;
  matchDay?: Counts & { fixtures: number; skipped: number; windowClosed?: boolean };
};

async function openSyncPage(browser: Page): Promise<void> {
  await browser.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  // The sync controls live on the "Sync health" tab (the page opens on the Action board).
  await browser.getByRole('tab', { name: /Sync health/ }).click();
  await expect(browser.getByRole('heading', { name: /Medicoach sync/ })).toBeVisible();
}

/** Click "Sync now" on the admin's Medicoach sync page; returns the run summary. */
async function syncNowInUi(browser: Page): Promise<SyncSummary> {
  const [res] = await Promise.all([
    browser.waitForResponse(
      (r) =>
        r.url().includes('/integrations/medicoach/sync-now') && r.request().method() === 'POST',
    ),
    browser.getByRole('button', { name: 'Sync now' }).click(),
  ]);
  expect(res.ok(), `sync-now → ${res.status()}`).toBeTruthy();
  return (await res.json()) as SyncSummary;
}

/** The Pending chip's count on the admin Captain's reports page (read once its list shows). */
async function pendingChipCount(browser: Page): Promise<number> {
  const chip = browser.getByRole('button', { name: /^Pending/ });
  await expect(chip).toBeVisible();
  return Number(await chip.locator('.cr-chip-n').innerText());
}

const openReportsPage = (browser: Page) =>
  browser.locator('aside.nav .nav-item', { hasText: "Captain's reports" }).click();

type Report = {
  seriesId: string;
  clubId: string;
  status: string;
  voidReason?: string;
  recipient: { kind: string };
};

async function reportsOf(request: APIRequestContext, sid: string): Promise<Report[]> {
  const list = await request.get(`${API_BASE}/captains-reports`, { headers: admin() });
  expect(list.ok(), `GET /captains-reports → ${list.status()}`).toBeTruthy();
  return ((await list.json()) as Report[]).filter((r) => r.seriesId === sid);
}

/** Mint the chair's link exactly as captains-reports.ts does (test-only). */
async function mintLink(clubId: string): Promise<string> {
  const { DynamoDBClient, GetItemCommand } = createRequire(
    path.resolve('packages/api/package.json'),
  )('@aws-sdk/client-dynamodb') as typeof import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({
    endpoint: 'http://localhost:4567',
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const item = await ddb.send(
    new GetItemCommand({
      TableName: 'SmartClubLocal',
      Key: {
        pk: { S: `TENANT#${TENANT}#CAPREPORT` },
        sk: { S: `CAPREPORT#${seriesId}#f1#${clubId}` },
      },
    }),
  );
  const memberId = item.Item?.recipient?.M?.memberId?.S;
  const stored = item.Item?.linkExpiresAt?.S;
  expect(memberId, 'the report has a recipient id').toBeTruthy();
  expect(stored, 'the report has a link expiry').toBeTruthy();
  const payload = Buffer.from(
    JSON.stringify({
      t: TENANT,
      r: `${seriesId}~f1~${clubId}`,
      m: memberId,
      e: Math.floor(Date.parse(stored!) / 1000),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET)
    .update(`capreport-link.v1.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await setReportNoticeWindow(request, 'open');
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
  // Window first: a hung stub close must not leak the forced override to later specs.
  await setReportNoticeWindow(request, 'real');
  await new Promise<void>((r) => stub.close(() => r()));
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures, integrations: priorIntegrations },
  });
});

test('a match recorded abandoned after its notice voids both pending reports', async ({
  page: browser,
  browser: pw,
  request,
}) => {
  const s = await createSeries(request, {
    name: SERIES_NAME,
    // Not 'premier': the seeded premier league defers card-less match-day opens.
    leagueKey: 'promotion',
    fixtures: [
      fixture({
        id: 'f1',
        date: MATCH_DATE,
        time: '09:00',
        home: HOME,
        away: AWAY,
        venueOverride: ground('abandoned'),
      }),
    ],
  });
  seriesId = s.id;
  await approveAndRelease(request, seriesId);
  stubPage = emptyPage();

  await signInAsAdmin(browser);
  await openSyncPage(browser);

  // (a) Match day, no result yet: one pending report per side.
  const first = await syncNowInUi(browser);
  test.skip(
    first.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  expect(first.matchDay?.opened).toBeGreaterThanOrEqual(2);
  const opened = await reportsOf(request, seriesId);
  expect(opened.map((r) => r.clubId).sort()).toEqual([AWAY, HOME].sort());
  expect(opened.map((r) => r.status)).toEqual(['pending', 'pending']);
  const chairLink = await mintLink(HOME);

  // The chip counts are read only once this series' rows show (the list has loaded).
  await openReportsPage(browser);
  const rows = browser.getByRole('row', { name: new RegExp(SERIES_NAME) });
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) await expect(row.getByText('Pending')).toBeVisible();
  const pendingBefore = await pendingChipCount(browser);

  // (b) Medicoach records the match abandoned: the next sync voids both pending reports.
  stubPage = abandonedPage(seriesId);
  await openSyncPage(browser);
  const second = await syncNowInUi(browser);
  expect(second.status).not.toBe('dry-run');
  expect(second.reportNotices?.opened ?? 0).toBe(0);
  const voided = await reportsOf(request, seriesId);
  expect(voided).toHaveLength(2);
  expect(voided.map((r) => r.status)).toEqual(['void', 'void']);
  expect(voided.map((r) => r.voidReason)).toEqual([
    'match abandoned in medicoach',
    'match abandoned in medicoach',
  ]);

  await openReportsPage(browser);
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.getByText('Void', { exact: true })).toBeVisible();
    await expect(row.getByText('Match abandoned', { exact: true })).toBeVisible();
  }
  expect(await pendingChipCount(browser)).toBe(pendingBefore - 2);

  // The chair's link from the notice is dead.
  const ctx = await pw.newContext();
  const p = await ctx.newPage();
  await p.goto(`/r/${chairLink}`);
  await expect(p.getByText('This report is closed')).toBeVisible();
  await expect(p.getByText('This link is no longer valid.')).toBeVisible();
  await ctx.close();

  // Another sync does not bring them back.
  await openSyncPage(browser);
  await syncNowInUi(browser);
  expect((await reportsOf(request, seriesId)).map((r) => r.status)).toEqual(['void', 'void']);
});

test('a match recorded abandoned before any notice never gets a report', async ({
  page: browser,
  request,
}) => {
  const s = await createSeries(request, {
    name: EARLY_SERIES_NAME,
    leagueKey: 'promotion',
    fixtures: [
      fixture({
        id: 'f1',
        date: MATCH_DATE,
        time: '09:00',
        home: EARLY_HOME,
        away: EARLY_AWAY,
        venueOverride: ground('abandoned-early'),
      }),
    ],
  });
  await approveAndRelease(request, s.id);
  // (c) The abandonment is already in medicoach by the first sync after release.
  stubPage = abandonedPage(s.id);

  await signInAsAdmin(browser);
  await openSyncPage(browser);
  const first = await syncNowInUi(browser);
  test.skip(
    first.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  expect(await reportsOf(request, s.id)).toEqual([]);

  // Run after run: the stored abandoned result keeps the match-day opener away.
  stubPage = emptyPage();
  await syncNowInUi(browser);
  expect(await reportsOf(request, s.id)).toEqual([]);

  // The admin list has loaded (the first test's rows show) and has none for this match.
  await openReportsPage(browser);
  await expect(browser.getByRole('row', { name: new RegExp(SERIES_NAME) }).first()).toBeVisible();
  await expect(browser.getByRole('row', { name: new RegExp(EARLY_SERIES_NAME) })).toHaveCount(0);
});
