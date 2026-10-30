import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
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
  signInAsAdmin,
  setReportNoticeWindow,
} from './helpers';

/**
 * Admin "Copy link": the union office copies a pending squad request's / captain's report's
 * current signed link from the console (fetched on click, written to the clipboard) and the
 * copied URL opens the right public form. One sync run against a STUB medicoach opens both:
 * a squad request per side of tomorrow's fixture and a report per side of yesterday's pulled
 * result. Same stub + forced-open notice window as squad-request.e2e.ts and
 * captains-report.e2e.ts; tenant settings are restored in afterAll.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const HOME = 'ukzn';
const AWAY = 'crusaders';
const SQUAD_SERIES = `s-e2e-copysq-${RUN}`;
const REPORT_SERIES = `s-e2e-copycr-${RUN}`;
// Run-unique kick-off minute: a reused stack keeps earlier runs' released series (venue_clash).
// Offset by 7 so this spec never clashes with captains-report.e2e.ts, which seeds the same
// ukzn v crusaders fixture at the same ground from the same shared RUN.
const MIN = String((parseInt(RUN.slice(-4), 36) + 7) % 60).padStart(2, '0');

// The tenant's (SAST, UTC+2) civil days, not the runner's.
const sastDay = (offset: number) =>
  new Date(Date.now() + 2 * 3600 * 1000 + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
const TOMORROW = sastDay(1);
const YESTERDAY = sastDay(-1);

let stub: Server;
// False when the reused stack has no MEDICOACH_SYNC_URL/SECRET: no result is pulled, so no report.
let pulled = false;
let priorFeatures: Record<string, boolean> | undefined;
let priorIntegrations: unknown;

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

/** The pull returns yesterday's manual result (no captain → both reports go to the chairs). */
function resultPage() {
  const recordedAt = new Date().toISOString();
  return {
    version: 1,
    tenant: TENANT,
    nextCursor: recordedAt,
    hasMore: false,
    fixtures: [
      {
        ref: `smartclub:${TENANT}:fixture:${REPORT_SERIES}:f1`,
        syncStamp: recordedAt,
        schedule: {
          scheduledTime: `${YESTERDAY}T09:${MIN}:00+02:00`,
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
          summary: 'UKZN won by 4 wickets',
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

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const check = verifySignature({
        secret: SYNC_SECRET,
        method: req.method ?? 'GET',
        pathAndQuery: req.url ?? '',
        body,
        timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
        signatureHeader: req.headers['x-sync-signature'] as string | undefined,
      });
      if (!check.ok) {
        res.writeHead(401).end('{"error":"bad signature"}');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(req.method === 'GET' ? resultPage() : { ok: true }));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

async function seedSeries(request: APIRequestContext, id: string, date: string, name: string) {
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id,
      name,
      startDate: date,
      leagueKey: 'premier',
      teams: [HOME, AWAY],
      participants: [
        { teamId: HOME, clubId: HOME, name: 'UKZN' },
        { teamId: AWAY, clubId: AWAY, name: 'Crusaders' },
      ],
      fixtures: [{ id: 'f1', round: 1, date, time: `09:${MIN}`, home: HOME, away: AWAY }],
    },
  });
  expect(create.ok(), `POST /series → ${create.status()} ${await create.text()}`).toBeTruthy();
  let version = ((await create.json()) as { version: number }).version;
  for (const patch of [{ approved: true }, { released: true }]) {
    const res = await request.patch(`${API_BASE}/series/${id}`, {
      headers: admin(),
      data: { ...patch, version },
    });
    expect(res.ok(), `PATCH series → ${res.status()} ${await res.text()}`).toBeTruthy();
    version = ((await res.json()) as { version: number }).version;
  }
}

async function squadRows(request: APIRequestContext) {
  const res = await request.get(`${API_BASE}/admin/squad-requests`, { headers: admin() });
  expect(res.ok(), `GET /admin/squad-requests → ${res.status()}`).toBeTruthy();
  return (
    (await res.json()) as Array<{ id: string; seriesId: string; teamId: string; status: string }>
  ).filter((r) => r.seriesId === SQUAD_SERIES);
}

/**
 * Click a row's Copy link and return the copied URL's path. Engine-tolerant: where the
 * clipboard accepts the write the toast shows and the URL is read back (from the clipboard,
 * or on WebKit from clipboardContext's write recorder); where it refuses, the fallback dialog
 * shows the URL instead.
 */
async function copyFrom(page: Page, button: import('@playwright/test').Locator) {
  await button.click();
  const toast = page.getByText(/^Link copied\./);
  const dialog = page.getByRole('dialog', { name: 'Copy this link' });
  await expect(toast.or(dialog)).toBeVisible();
  let url: string | null = null;
  if (await dialog.isVisible())
    url = await dialog.getByRole('textbox', { name: 'Link' }).inputValue();
  else
    url = await page.evaluate(
      async () =>
        (window as unknown as { __copied?: string }).__copied ??
        (await navigator.clipboard.readText()),
    );
  expect(url, 'a copied link, from the clipboard or the fallback dialog').toMatch(/^https?:\/\//);
  // The link base is the stack's configured public origin (locally :5173, not the e2e vite
  // :3201), so open the copied path on this app.
  return new URL(url!).pathname;
}

/**
 * A context whose clipboard is readable/writable where the engine supports the grant. WebKit
 * rejects these permission names (lazily, at newPage), so it gets no grant and a write
 * recorder instead; copyFrom still accepts the fallback dialog if the write is refused.
 */
async function clipboardContext(browser: import('@playwright/test').Browser) {
  const ctx = await browser.newContext();
  if (browser.browserType().name() === 'webkit') {
    // WebKit accepts the write but blocks readText without a real paste gesture: record what
    // the page writes (pass-through to the real clipboard) so copyFrom can read it back.
    await ctx.addInitScript(() => {
      const clip = navigator.clipboard;
      if (!clip) return;
      const w = window as unknown as { __copied?: string };
      const write = clip.write.bind(clip);
      const writeText = clip.writeText.bind(clip);
      clip.write = async (items: ClipboardItem[]) => {
        await write(items);
        w.__copied = await (await items[0].getType('text/plain')).text();
      };
      clip.writeText = async (text: string) => {
        await writeText(text);
        w.__copied = text;
      };
    });
    return ctx;
  }
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch (err) {
    console.warn('[copy-link e2e] clipboard permissions not granted; expecting the dialog', err);
  }
  return ctx;
}

const dynamo = async () => {
  const sdk = createRequire(path.resolve('packages/api/package.json'))(
    '@aws-sdk/client-dynamodb',
  ) as typeof import('@aws-sdk/client-dynamodb');
  const ddb = new sdk.DynamoDBClient({
    endpoint: 'http://localhost:4567',
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  return { sdk, ddb };
};

/** Move a squad request's stored link expiry into the past (dynalite, test-only). */
async function expireSquadRequest(teamId: string) {
  const { sdk, ddb } = await dynamo();
  await ddb.send(
    new sdk.UpdateItemCommand({
      TableName: 'SmartClubLocal',
      Key: {
        pk: { S: `TENANT#${TENANT}#CAPREPORT` },
        sk: { S: `SQUADREQ#${SQUAD_SERIES}#f1#${teamId}` },
      },
      UpdateExpression: 'SET linkExpiresAt = :e',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':e': { S: new Date(Date.now() - 3600 * 1000).toISOString() } },
    }),
  );
}

async function openSquadRequestsPage(page: Page) {
  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Squad requests' }).click();
  return page.getByRole('row', { name: new RegExp(`UKZN v Crusaders.*Copy squad E2E ${RUN}`) });
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
      features: { ...priorFeatures, medicoachSync: true, preMatchSquadLinks: true },
      integrations: { medicoach: { goLiveDate: sastDay(-30) } },
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

test('a sync run opens squad requests and captain reports to copy', async ({ request }) => {
  await seedSeries(request, SQUAD_SERIES, TOMORROW, `Copy squad E2E ${RUN}`);
  await seedSeries(request, REPORT_SERIES, YESTERDAY, `Copy report E2E ${RUN}`);
  const sync = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
    headers: admin(),
  });
  expect(sync.ok(), `sync-now → ${sync.status()} ${await sync.text()}`).toBeTruthy();
  const summary = (await sync.json()) as { status: string };
  pulled = summary.status !== 'dry-run';
  // The squad opener runs even on a dry run; only the result pull (→ reports) needs the stub.
  expect((await squadRows(request)).map((r) => r.status)).toEqual(['pending', 'pending']);
});

test('Copy link on a pending squad request copies a link that opens the squad form', async ({
  browser,
}) => {
  const ctx = await clipboardContext(browser);
  const page = await ctx.newPage();
  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Squad requests' }).click();
  const row = page
    .getByRole('row', { name: new RegExp(`UKZN v Crusaders.*Copy squad E2E ${RUN}`) })
    .first();
  const url = await copyFrom(page, row.getByRole('button', { name: /^Copy link/ }));
  expect(url).toMatch(/^\/sq\/[\w-]+\.[\w-]+$/);

  const p = await ctx.newPage();
  await p.goto(url);
  await expect(p.getByText(/ \/ Squad selection$/)).toBeVisible();
  await expect(p.getByRole('searchbox', { name: 'Search players' })).toBeVisible();
  await ctx.close();
});

test('a refused clipboard shows the link in a dialog; its Copy says when copying is blocked', async ({
  browser,
}) => {
  // No permissions, and both clipboard writes reject: deterministic on every engine.
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const refuse = () => Promise.reject(new DOMException('blocked by test', 'NotAllowedError'));
    const clip = navigator.clipboard ?? ({} as Clipboard);
    Object.defineProperty(clip, 'write', { value: refuse, configurable: true });
    Object.defineProperty(clip, 'writeText', { value: refuse, configurable: true });
    if (!navigator.clipboard)
      Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
  });
  const page = await ctx.newPage();
  const rows = await openSquadRequestsPage(page);
  // ClipboardItem stays: the hook takes its write() path, which the init script refuses.
  expect(await page.evaluate(() => typeof ClipboardItem)).toBe('function');
  await rows
    .first()
    .getByRole('button', { name: /^Copy link/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Copy this link' });
  await expect(dialog).toBeVisible();
  const url = await dialog.getByRole('textbox', { name: 'Link' }).inputValue();
  expect(url).toMatch(/^https?:\/\/.+\/sq\/[\w-]+\.[\w-]+$/);

  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByText(/^Copying is blocked here/)).toBeVisible();
  await expect(dialog).toBeVisible();

  const p = await ctx.newPage();
  await p.goto(new URL(url).pathname);
  await expect(p.getByText(/ \/ Squad selection$/)).toBeVisible();
  await ctx.close();
});

test("Copy link on a pending captain's report copies a link that opens the report form", async ({
  browser,
}) => {
  test.skip(!pulled, 'the running stack has no MEDICOACH_SYNC_URL/SECRET (no report pulled)');
  const ctx = await clipboardContext(browser);
  const page = await ctx.newPage();
  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: "Captain's reports" }).click();
  const row = page
    .getByRole('row', { name: new RegExp(`UKZN v Crusaders.*Copy report E2E ${RUN}`) })
    .first();
  const url = await copyFrom(page, row.getByRole('button', { name: /^Copy link/ }));
  expect(url).toMatch(/^\/r\/[\w-]+\.[\w-]+$/);

  const p = await ctx.newPage();
  await p.goto(url);
  await expect(p.getByText(/(UKZN|Crusaders) \/ Captain's Report/)).toBeVisible();
  await expect(p.getByRole('button', { name: 'Submit report' }).first()).toBeVisible();
  await ctx.close();
});

test('the squad link endpoint refuses a voided request (409)', async ({ request }) => {
  const away = (await squadRows(request)).find((r) => r.teamId === AWAY)!;
  const id = encodeURIComponent(away.id);
  const voided = await request.post(`${API_BASE}/admin/squad-requests/${id}/void`, {
    headers: admin(),
  });
  expect(voided.ok(), `void → ${voided.status()} ${await voided.text()}`).toBeTruthy();
  const link = await request.get(`${API_BASE}/admin/squad-requests/${id}/link`, {
    headers: admin(),
  });
  expect(link.status()).toBe(409);
});

test('Resend kills a previously copied squad link', async ({ request, page }) => {
  const home = (await squadRows(request)).find((r) => r.teamId === HOME)!;
  const id = encodeURIComponent(home.id);
  const link = await request.get(`${API_BASE}/admin/squad-requests/${id}/link`, {
    headers: admin(),
  });
  expect(link.ok(), `link → ${link.status()}`).toBeTruthy();
  const old = new URL(((await link.json()) as { url: string }).url).pathname;
  const token = old.split('/sq/')[1];
  expect((await request.get(`${API_BASE}/squad-link/${token}`)).status()).toBe(200);

  const resend = await request.post(`${API_BASE}/admin/squad-requests/${id}/resend`, {
    headers: admin(),
  });
  expect(resend.ok(), `resend → ${resend.status()} ${await resend.text()}`).toBeTruthy();

  expect((await request.get(`${API_BASE}/squad-link/${token}`)).status()).toBe(410);
  await page.goto(old);
  await expect(page.getByText('This squad link is closed')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search players' })).toHaveCount(0);
  // The fresh link still works.
  const fresh = await request.get(`${API_BASE}/admin/squad-requests/${id}/link`, {
    headers: admin(),
  });
  expect(fresh.ok()).toBeTruthy();
  expect(new URL(((await fresh.json()) as { url: string }).url).pathname).not.toBe(old);
});

// Last: leaves this run's home request expired (the away one is voided above).
test('an expired squad request disables Copy link and the endpoint refuses it (409)', async ({
  request,
  page,
}) => {
  const home = (await squadRows(request)).find((r) => r.teamId === HOME)!;
  await expireSquadRequest(HOME);
  const link = await request.get(
    `${API_BASE}/admin/squad-requests/${encodeURIComponent(home.id)}/link`,
    { headers: admin() },
  );
  expect(link.status()).toBe(409);
  expect(await link.text()).toMatch(/expired/);

  const rows = await openSquadRequestsPage(page);
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all())
    await expect(row.getByRole('button', { name: /^Copy link/ })).toBeDisabled();
});
