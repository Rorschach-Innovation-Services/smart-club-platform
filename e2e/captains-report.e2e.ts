import { test, expect, type APIRequestContext } from '@playwright/test';
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
  createActivePlayer,
  operatorAuth,
  signInAsAdmin,
  signInAsRep,
  dismissOnboarding,
} from './helpers';

/**
 * Captain's reports end to end (ADR 0016, Slice 2): a result pulled from a STUB medicoach
 * opens one report per side; the home club files its report in the portal, the away side's
 * chair files through the public submit-once link, and the union office sees both — with the
 * umpire rating averages on the Umpires page.
 *
 * The stub listens on :4799 and checks every request's HMAC with the shared contract helper.
 * playwright.config.ts boots the stack with MEDICOACH_SYNC_URL/SECRET pointing at it; a reused
 * stack started without them answers "Sync now" with a dry run, and the spec skips.
 *
 * The link token is never logged or stored (by design), so the spec mints the away chair's
 * link the way the API does: read the report's opaque recipient id from the local stack's
 * dynalite table and sign with the local-only fallback key (LOCAL_AUTH). Tenant settings the
 * spec changes are restored in afterAll; the seeded series/umpires/reports stay as run-unique
 * residue in the in-memory DB.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
const HOME = 'ukzn';
const AWAY = 'crusaders';
const SERIES_ID = `s-e2e-capreport-${RUN}`;
const UMP_A = `A.Ump${RUN}`;
const UMP_B = `B.Ump${RUN}`;

const isoDay = (offset: number) =>
  new Date(Date.now() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
const MATCH_DATE = isoDay(-1);

let stub: Server;
let page: unknown = null;
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
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

async function createUmpire(request: APIRequestContext, displayName: string): Promise<string> {
  const res = await request.post(`${API_BASE}/umpires`, {
    headers: admin(),
    data: { displayName },
  });
  expect(res.ok(), `POST /umpires → ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function seedFixture(request: APIRequestContext, umpireIds: string[]) {
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: SERIES_ID,
      name: `Captain's report E2E ${RUN}`,
      startDate: MATCH_DATE,
      leagueKey: 'premier',
      teams: [HOME, AWAY],
      participants: [
        { teamId: HOME, clubId: HOME, name: 'UKZN' },
        { teamId: AWAY, clubId: AWAY, name: 'Crusaders' },
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
  const officials = await request.put(`${API_BASE}/series/${SERIES_ID}/fixtures/f1/officials`, {
    headers: admin(),
    data: { umpires: umpireIds.map((umpireId) => ({ umpireId })) },
  });
  expect(officials.ok(), `PUT officials → ${officials.status()}`).toBeTruthy();
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

/** Mint the away chair's link exactly as captains-reports.ts does (test-only). */
async function mintLink(clubId: string): Promise<string> {
  // The DynamoDB SDK is a dependency of the API package only (not hoisted to the root);
  // loaded lazily so test collection never touches it.
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
        sk: { S: `CAPREPORT#${SERIES_ID}#f1#${clubId}` },
      },
    }),
  );
  const memberId = item.Item?.recipient?.M?.memberId?.S;
  expect(memberId, 'the report has a recipient id').toBeTruthy();
  const stored = item.Item?.linkExpiresAt?.S;
  const payload = Buffer.from(
    JSON.stringify({
      t: TENANT,
      r: `${SERIES_ID}~f1~${clubId}`,
      m: memberId,
      // The report's stored expiry (captains-reports.ts reportLinkExpiry), else the
      // match rule: 23:59:59 SAST seven days after the match.
      e: stored
        ? Math.floor(Date.parse(stored) / 1000)
        : Math.floor(
            (Date.parse(`${MATCH_DATE}T23:59:59Z`) - 2 * 3600 * 1000 + 7 * 24 * 3600 * 1000) / 1000,
          ),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET)
    .update(`capreport-link.v1.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
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
  await new Promise<void>((r) => stub.close(() => r()));
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures, integrations: priorIntegrations },
  });
});

test('a pulled result opens a report per side', async ({ request }) => {
  const a = await createUmpire(request, UMP_A);
  const b = await createUmpire(request, UMP_B);
  await seedFixture(request, [a, b]);
  page = resultPage();
  const sync = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
    headers: admin(),
  });
  expect(sync.ok(), `sync-now → ${sync.status()} ${await sync.text()}`).toBeTruthy();
  const summary = (await sync.json()) as { status: string; counts: { resultsStored: number } };
  test.skip(
    summary.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  expect(summary.counts.resultsStored).toBe(1);

  const list = await request.get(`${API_BASE}/captains-reports?status=pending`, {
    headers: admin(),
  });
  const mine = ((await list.json()) as Array<{ seriesId: string; recipient: { kind: string } }>)
    .filter((r) => r.seriesId === SERIES_ID)
    .map((r) => r.recipient.kind);
  expect(mine).toEqual(['chair', 'chair']);
});

test('the home club files its report in the portal', async ({ page: browser }) => {
  await signInAsRep(browser, HOME);
  await dismissOnboarding(browser);
  await browser.locator('aside.nav .nav-item', { hasText: "Captain's Report" }).click();
  await browser
    .getByRole('button', { name: /UKZN v Crusaders/ })
    .first()
    .click();

  // Two appointed → each card is a dropdown limited to the pair.
  await expect(browser.getByRole('combobox', { name: 'Umpire 1' })).toHaveValue(/.+/);
  await expect(browser.getByRole('combobox', { name: 'Umpire 1' }).getByRole('option')).toHaveText([
    `${UMP_A} (appointed)`,
    'A different umpire stood',
  ]);

  for (const card of [1, 2]) {
    const groups = browser.getByTestId(`umpire-card-${card}`).getByRole('radiogroup');
    for (let i = 0; i < 5; i++)
      await groups
        .nth(i)
        .getByRole('radio', { name: card === 1 && i === 0 ? '2' : '4' })
        .click();
  }
  await browser.getByRole('combobox', { name: "Captain's name" }).fill(`Captain ${RUN}`);
  await browser.getByRole('checkbox').check();
  await browser.getByRole('button', { name: 'Submit report' }).first().click();
  await expect(browser.getByText('Report submitted')).toBeVisible();
  await expect(browser.getByText(/^CR-\d{4}-\d{4}$/)).toBeVisible();
});

test("the away chair sends the report on to a captain from the link; the chair's link keeps working", async ({
  browser,
  request,
}) => {
  // createActivePlayer registers "Test <name>" (first name Test).
  const captain = `Test Fwd${RUN}`;
  await createActivePlayer(request, AWAY, { name: `Fwd${RUN}` });
  const token = await mintLink(AWAY);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/r/${token}`);
  await expect(p.getByText("Crusaders / Captain's Report")).toBeVisible();
  await expect(p.getByText(/Link expires \w+, \d{1,2} \w{3}\./)).toBeVisible();
  await p.getByRole('button', { name: 'Send to captain' }).click();
  const picker = p.getByRole('combobox', { name: 'Captain', exact: true });
  await expect(picker.getByRole('option', { name: captain, exact: true })).toHaveCount(1);
  await picker.selectOption({ label: captain });
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(p.getByText(`Sent to ${captain}. They will get their own link.`)).toBeVisible();
  // The report is now addressed to the captain…
  const list = await request.get(`${API_BASE}/captains-reports?status=pending`, {
    headers: admin(),
  });
  const away = (
    (await list.json()) as Array<{
      seriesId: string;
      clubId: string;
      recipient: { kind: string; name: string; forwardedBy?: { via: string } };
    }>
  ).find((r) => r.seriesId === SERIES_ID && r.clubId === AWAY)!;
  expect(away.recipient).toMatchObject({ kind: 'captain', name: captain });
  expect(away.recipient.forwardedBy?.via).toBe('link');
  // …and the chair's own link still opens it (first submit wins — the next test files it).
  await p.reload();
  await expect(p.getByText("Crusaders / Captain's Report")).toBeVisible();
  await ctx.close();
});

test('the away chair files through the submit-once link, which then closes', async ({
  browser,
}) => {
  const token = await mintLink(AWAY);
  // A fresh, signed-out context: the link needs no account.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/r/${token}`);
  await expect(p.getByText("Crusaders / Captain's Report")).toBeVisible();
  await expect(p.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  for (const card of [1, 2]) {
    const groups = p.getByTestId(`umpire-card-${card}`).getByRole('radiogroup');
    for (let i = 0; i < 5; i++) await groups.nth(i).getByRole('radio', { name: '5' }).click();
  }
  await p.getByRole('combobox', { name: "Captain's name" }).fill(`Away captain ${RUN}`);
  await p.getByRole('checkbox').check();
  await p.getByRole('button', { name: 'Submit report' }).first().click();
  await expect(p.getByText('Report submitted')).toBeVisible();
  await p.reload();
  await expect(p.getByText('This report is closed')).toBeVisible();
  await ctx.close();
});

test("the home club reports a match that isn't in the fixture list", async ({ page: browser }) => {
  await signInAsRep(browser, HOME);
  await dismissOnboarding(browser);
  await browser.locator('aside.nav .nav-item', { hasText: "Captain's Report" }).click();
  await browser.getByRole('button', { name: "Report a match that isn't listed" }).click();
  await browser.getByLabel('Opponent').fill(`Friendly XI ${RUN}`);
  await browser.getByLabel('Match date').fill(isoDay(-2));
  await browser.getByLabel('Competition').fill('Friendly');
  await browser.getByRole('button', { name: 'Continue to the umpires' }).click();
  // No appointment → two registry pickers (type-ahead; an exact name is the registry umpire).
  await browser.getByRole('combobox', { name: 'Umpire 1' }).fill(UMP_A);
  await browser.getByRole('combobox', { name: 'Umpire 2' }).fill(UMP_B);
  for (const card of [1, 2]) {
    const groups = browser.getByTestId(`umpire-card-${card}`).getByRole('radiogroup');
    for (let i = 0; i < 5; i++) await groups.nth(i).getByRole('radio', { name: '3' }).click();
  }
  await browser.getByRole('combobox', { name: "Captain's name" }).fill(`Captain ${RUN}`);
  await browser.getByRole('checkbox').check();
  await browser.getByRole('button', { name: 'Submit report' }).first().click();
  await expect(browser.getByText('Report submitted')).toBeVisible();
});

test('the union office sees both reports and the umpire averages', async ({ page: browser }) => {
  await signInAsAdmin(browser);
  await browser.locator('aside.nav .nav-item', { hasText: "Captain's reports" }).click();
  const rows = browser.getByRole('row', { name: /UKZN v Crusaders/ });
  await expect(rows).toHaveCount(2);
  // Each row says what happened to its notice, never just who it was "sent to".
  await expect(browser.getByRole('columnheader', { name: 'Notice' })).toBeVisible();
  await expect(rows.first().getByText(/^Email/)).toBeVisible();
  const unlisted = browser.getByRole('row', { name: new RegExp(`Friendly XI ${RUN}`) });
  await expect(unlisted.getByText('Not in the fixture list')).toBeVisible();
  await browser.getByRole('button', { name: /low ratings/i }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole('button', { name: 'View' }).click();
  await expect(browser.getByText(`Umpire 1: ${UMP_A}`)).toBeVisible();

  await browser.locator('aside.nav .nav-item', { hasText: 'Umpires' }).click();
  // UMP_A: (2+4+4+4+4)/5 = 3.6 from UKZN, 5.0 from Crusaders and 3.0 from the unlisted
  // friendly → 3.9 over 3 reports.
  const row = browser.getByRole('row', { name: new RegExp(UMP_A.replace('.', '\\.')) });
  await expect(row.getByText('3.9')).toBeVisible();
  await expect(row.getByText(/3 reports/)).toBeVisible();
});
