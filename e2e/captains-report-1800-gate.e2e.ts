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

/**
 * Captain's report notices go out from 18:00 SAST only, and never twice, end to end:
 *  - window CLOSED: "Sync now" stores the pulled result but opens no report and sends nothing;
 *    the admin is told the reports are queued for 18:00.
 *  - window OPEN: the next "Sync now" drains the queue — one report per side, one notice each.
 *  - a third "Sync now" sends nothing new.
 *
 * The window is forced through the local stack's test hook (local/server.ts, never in the
 * Lambda) and restored to the real clock in afterAll. Same STUB medicoach harness as
 * captains-report.e2e.ts (:4799, HMAC-checked); a stack reused without the sync env answers
 * "Sync now" with a dry run, and the spec skips. Notices are counted from the delivery
 * records on each report (the local stack sends nothing for real).
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const HOME = 'verulam';
const AWAY = 'tongaat';
const SERIES_ID = `s-e2e-capgate-${RUN}`;

const isoDay = (offset: number) =>
  new Date(Date.now() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
// Not the other report specs' day (-1), so no shared ground is double-booked at release.
const MATCH_DATE = isoDay(-3);

let stub: Server;
let stubPage: unknown = null;
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

async function seedFixture(request: APIRequestContext) {
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: SERIES_ID,
      name: `Captain's report gate E2E ${RUN}`,
      startDate: MATCH_DATE,
      leagueKey: 'premier',
      teams: [HOME, AWAY],
      participants: [
        { teamId: HOME, clubId: HOME, name: 'Verulam' },
        { teamId: AWAY, clubId: AWAY, name: 'Tongaat' },
      ],
      fixtures: [{ id: 'f1', round: 1, date: MATCH_DATE, time: '09:00', home: HOME, away: AWAY }],
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

/** A manual result (no captain) → both sides' reports go to the chairs. */
function resultPage() {
  const recordedAt = new Date().toISOString();
  return {
    version: 1,
    tenant: TENANT,
    nextCursor: recordedAt,
    hasMore: false,
    fixtures: [
      {
        ref: `smartclub:${TENANT}:fixture:${SERIES_ID}:f1`,
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
          homeScore: '150/6',
          awayScore: '149/9',
          summary: 'Verulam won by 4 wickets',
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

type SyncSummary = {
  status: string;
  reportsMessage?: string;
  reportNotices?: { deferred: number; opened: number; notified: number; failed: number };
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
  deliveries?: Array<{ purpose: string; at: string; channel: string }>;
};

async function seriesReports(request: APIRequestContext): Promise<Report[]> {
  const list = await request.get(`${API_BASE}/captains-reports`, { headers: admin() });
  expect(list.ok(), `GET /captains-reports → ${list.status()}`).toBeTruthy();
  return ((await list.json()) as Report[]).filter((r) => r.seriesId === SERIES_ID);
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

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
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
  // Window first: a hung stub close must not leak the forced override to later specs.
  await setReportNoticeWindow(request, 'real');
  await new Promise<void>((r) => stub.close(() => r()));
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures, integrations: priorIntegrations },
  });
});

test('report notices wait for 18:00, then go out once per side — never twice', async ({
  page: browser,
  request,
}) => {
  await seedFixture(request);
  stubPage = resultPage();

  await signInAsAdmin(browser);
  await browser.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  await expect(browser.getByRole('heading', { name: /Medicoach sync/ })).toBeVisible();

  // 1. Before 18:00: the result is stored, the reports are queued, nothing is sent.
  const closed = await syncNowInUi(browser);
  test.skip(
    closed.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  expect(closed.reportsMessage).toBe("Captain's reports queued — sent from 18:00");
  await expect(
    browser.getByText("Sync finished. Captain's reports queued — sent from 18:00."),
  ).toBeVisible();
  expect(closed.reportNotices).toMatchObject({ opened: 0, notified: 0, failed: 0 });
  expect(closed.reportNotices!.deferred).toBeGreaterThan(0);
  expect(await seriesReports(request)).toEqual([]);

  // 2. From 18:00: the next sync opens one report per side and notifies each exactly once.
  await setReportNoticeWindow(request, 'open');
  const open = await syncNowInUi(browser);
  expect(open.reportsMessage).toBeUndefined();
  expect(open.reportNotices?.opened).toBe(2);
  const after = await seriesReports(request);
  expect(after.map((r) => r.clubId).sort()).toEqual([AWAY, HOME].sort());
  expect(openingSends(after)).toEqual({ [HOME]: 1, [AWAY]: 1 });

  // The union office sees the reports, each with its notice.
  await browser.locator('aside.nav .nav-item', { hasText: "Captain's reports" }).click();
  // Its own clubs (not the other report specs'), so those specs' row counts stay exact.
  await expect(browser.getByRole('row', { name: /Verulam v Tongaat/ })).toHaveCount(2);
  await expect(browser.getByRole('columnheader', { name: 'Notice' })).toBeVisible();

  // 3. Another sync in the window: nothing new is opened or sent.
  await browser.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  const again = await syncNowInUi(browser);
  expect(again.reportNotices).toMatchObject({ deferred: 0, opened: 0, notified: 0, failed: 0 });
  const final = await seriesReports(request);
  expect(final).toHaveLength(2);
  expect(openingSends(final)).toEqual({ [HOME]: 1, [AWAY]: 1 });
});
