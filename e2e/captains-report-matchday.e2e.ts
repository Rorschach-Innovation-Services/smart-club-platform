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
 * Captain's reports open on match day, result or not, end to end:
 *  - a released fixture dated today, with NO result in medicoach; window forced OPEN;
 *    "Sync now" opens one report per side, both to the chairs (no scoring side to name a
 *    captain), one opening notice each — reported under `matchDay`, never `reportNotices`.
 *  - the form says "From the fixture list." with no result row and no scorecard section.
 *  - the result lands later: the next sync fills in the summary silently — still exactly one
 *    opening notice per side.
 *
 * Same STUB medicoach harness as captains-report.e2e.ts (:4799, HMAC-checked); a stack reused
 * without the sync env answers "Sync now" with a dry run, and the spec skips. Its own clubs
 * (Rhythm v Warriors, not the other report specs') and a RUN-unique series/ground, so the
 * shared in-memory DB's other report rows and counts are untouched. The window is restored to
 * the real clock in afterAll.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
const HOME = 'rhythm';
const AWAY = 'warriors';

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

/** A manual result (no captain) for the seeded fixture. */
function resultPage() {
  const recordedAt = new Date().toISOString();
  return {
    version: 1,
    tenant: TENANT,
    nextCursor: recordedAt,
    hasMore: false,
    fixtures: [
      {
        ref: `smartclub:${TENANT}:fixture:${seriesId}:f1`,
        syncStamp: recordedAt,
        schedule: {
          scheduledTime: `${MATCH_DATE}T09:00:00+02:00`,
          timeTbc: false,
          dateTbc: false,
          venue: null,
          postponed: false,
          cancelled: false,
          changedAt: '2026-09-01T00:00:00.000Z',
        },
        teams: { homeRef: null, awayRef: null },
        result: {
          homeScore: '201/7',
          awayScore: '180',
          summary: 'Rhythm DHSOB won by 21 runs',
          winner: 'home',
          method: 'normal',
          noResult: false,
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

type Report = {
  seriesId: string;
  clubId: string;
  resultSummary?: string | null;
  recipient: { kind: string; memberId?: string };
  deliveries?: Array<{ purpose: string; at: string; channel: string }>;
};

async function seriesReports(request: APIRequestContext): Promise<Report[]> {
  const list = await request.get(`${API_BASE}/captains-reports`, { headers: admin() });
  expect(list.ok(), `GET /captains-reports → ${list.status()}`).toBeTruthy();
  return ((await list.json()) as Report[]).filter((r) => r.seriesId === seriesId);
}

/** Opening-notice sends per club: each send records one delivery per channel at one instant. */
function openingSends(reports: Report[]): Record<string, number> {
  return Object.fromEntries(
    reports.map((r) => [
      r.clubId,
      new Set((r.deliveries ?? []).filter((d) => d.purpose === 'opened').map((d) => d.at)).size,
    ]),
  );
}

/** Mint the home chair's link exactly as captains-reports.ts does (test-only). */
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

test('match-day reports open to the chairs without a result, and gain it later without a second notice', async ({
  page: browser,
  browser: pw,
  request,
}) => {
  const s = await createSeries(request, {
    name: `Captain's report match day E2E ${RUN}`,
    // Not 'premier': the seeded premier league defers card-less match-day opens to the
    // Monday-noon fallback (captainsReport.deferMatchDayNotices), so nothing would open today.
    leagueKey: 'promotion',
    fixtures: [
      fixture({
        id: 'f1',
        date: MATCH_DATE,
        time: '09:00',
        home: HOME,
        away: AWAY,
        venueOverride: ground('matchday'),
      }),
    ],
  });
  seriesId = s.id;
  await approveAndRelease(request, seriesId);
  stubPage = emptyPage();

  await signInAsAdmin(browser);
  await browser.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  // The sync controls live on the "Sync health" tab (the page opens on the Action board).
  await browser.getByRole('tab', { name: /Sync health/ }).click();
  await expect(browser.getByRole('heading', { name: /Medicoach sync/ })).toBeVisible();

  // 1. Match day, no result: one report per side, both to the chairs, one notice each.
  const first = await syncNowInUi(browser);
  test.skip(
    first.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  // Match-day opens are counted on their own, never in the result-driven tally.
  expect(first.matchDay?.opened).toBeGreaterThanOrEqual(2);
  expect(first.reportNotices?.opened ?? 0).toBe(0);
  const opened = await seriesReports(request);
  expect(opened.map((r) => r.clubId).sort()).toEqual([AWAY, HOME].sort());
  expect(opened.map((r) => r.recipient.kind)).toEqual(['chair', 'chair']);
  expect(opened.every((r) => !r.resultSummary)).toBe(true);
  expect(openingSends(opened)).toEqual({ [HOME]: 1, [AWAY]: 1 });

  // 2. The chair's form: fixture facts only — no result row, no scorecard section.
  const ctx = await pw.newContext();
  const p = await ctx.newPage();
  await p.goto(`/r/${await mintLink(HOME)}`);
  await expect(p.getByText('From the fixture list.', { exact: true })).toBeVisible();
  await expect(p.locator('.cr-facts dt', { hasText: 'Result' })).toHaveCount(0);
  await expect(p.locator('.sc-report')).toHaveCount(0);
  await ctx.close();

  // 3. The result lands: the summary fills in silently, still one opening notice per side.
  stubPage = resultPage();
  const second = await syncNowInUi(browser);
  expect(second.status).not.toBe('dry-run');
  const after = await seriesReports(request);
  expect(after).toHaveLength(2);
  expect(after.map((r) => r.resultSummary)).toEqual([
    'Rhythm DHSOB won by 21 runs',
    'Rhythm DHSOB won by 21 runs',
  ]);
  expect(after.map((r) => r.recipient.kind)).toEqual(['chair', 'chair']);
  expect(openingSends(after)).toEqual({ [HOME]: 1, [AWAY]: 1 });

  const ctx2 = await pw.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`/r/${await mintLink(HOME)}`);
  await expect(
    p2.locator('.cr-facts dd', { hasText: 'Rhythm DHSOB won by 21 runs' }),
  ).toBeVisible();
  await ctx2.close();
});
