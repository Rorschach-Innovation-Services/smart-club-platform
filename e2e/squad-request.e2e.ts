import { test, expect } from '@playwright/test';
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
  setReportNoticeWindow,
} from './helpers';

/**
 * Pre-match captain squad links end to end: a sync run on the morning of the day before a match opens
 * one squad request per side of tomorrow's fixture (the window is forced open). Neither side
 * has a designated or last captain, so both links go to the chairs. The home chair picks two
 * registered players from the roster, adds a guest past the guard, names a captain and
 * submits; the submitted squad reopens and is edited and resubmitted (links stay editable
 * until expiry). The away chair sends the link on to a player. The union office sees both.
 *
 * Same stub medicoach + local link-secret technique as captains-report.e2e.ts: the token is
 * never logged or stored, so the spec reads the request's opaque recipient id from dynalite
 * and signs it the way squad-requests.ts does. Tenant settings are restored in afterAll.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
const HOME = 'ukzn';
const AWAY = 'crusaders';
const SERIES_ID = `s-e2e-squad-${RUN}`;

// "Tomorrow" is the tenant's (SAST, UTC+2) civil tomorrow, not the runner's.
const sastDay = (offset: number) =>
  new Date(Date.now() + 2 * 3600 * 1000 + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
const MATCH_DATE = sastDay(1);
// Run-unique kick-off minute: a reused stack keeps earlier runs' released series, and the
// release gate refuses the same ground at the same date + time (venue_clash).
const MIN = String(parseInt(RUN.slice(-4), 36) % 60).padStart(2, '0');
const CAPREPORT_PK = `TENANT#${TENANT}#CAPREPORT`;

let stub: Server;
let priorFeatures: Record<string, boolean> | undefined;
let priorIntegrations: unknown;

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
      // An empty result page for the pull; anything else (pushes) is simply acknowledged.
      const now = new Date().toISOString();
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            req.method === 'GET'
              ? { version: 1, tenant: TENANT, nextCursor: now, hasMore: false, fixtures: [] }
              : { ok: true },
          ),
        );
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

/** Mint a side's squad link exactly as squad-requests.ts does (test-only). */
async function mintSquadLink(teamId: string): Promise<string> {
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
        sk: { S: `SQUADREQ#${SERIES_ID}#f1#${teamId}` },
      },
    }),
  );
  const memberId = item.Item?.recipient?.M?.memberId?.S;
  expect(memberId, 'the squad request has a recipient id').toBeTruthy();
  const expires = item.Item?.linkExpiresAt?.S;
  expect(expires, 'the squad request has an expiry').toBeTruthy();
  const payload = Buffer.from(
    JSON.stringify({
      t: TENANT,
      r: memberId,
      q: `${SERIES_ID}~f1~${teamId}`,
      e: Math.floor(Date.parse(expires!) / 1000),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET)
    .update(`squad-link.v1.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

/** Remove one dynalite row (afterAll cleanup of the captain state this spec leaves). */
async function deleteItem(pk: string, sk: string) {
  const { DynamoDBClient, DeleteItemCommand } = createRequire(
    path.resolve('packages/api/package.json'),
  )('@aws-sdk/client-dynamodb') as typeof import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({
    endpoint: 'http://localhost:4567',
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await ddb.send(
    new DeleteItemCommand({ TableName: 'SmartClubLocal', Key: { pk: { S: pk }, sk: { S: sk } } }),
  );
}

interface AdminSquadRow {
  seriesId: string;
  teamId: string;
  status: string;
  recipient: { kind: string; name: string; forwardedBy?: { via: string } };
  selection?: {
    players: Array<{ name: string }>;
    guests: Array<{ name: string }>;
    captainName?: string;
  };
}

async function adminRows(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get(`${API_BASE}/admin/squad-requests`, { headers: admin() });
  expect(res.ok(), `GET /admin/squad-requests → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as AdminSquadRow[]).filter((r) => r.seriesId === SERIES_ID);
}

test.describe.configure({ mode: 'serial' });

const P1 = `Sq1${RUN}`;
const P2 = `Sq2${RUN}`;
const P3 = `Sq3${RUN}`;
const GUEST = `Guest Visitor ${RUN}`;

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
  expect(put.ok(), `enable squad links → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await setReportNoticeWindow(request, 'real');
  await new Promise<void>((r) => stub.close(() => r()));
  // The submitted squad's captain becomes the team's last captain: left behind, a rerun's
  // opener would address ukzn to that captain instead of the chair.
  for (const c of [HOME, AWAY]) {
    // Captain rows are scoped per competition (`league:<leagueKey>`); this spec's is premier.
    await deleteItem(CAPREPORT_PK, `TEAMCAPTAIN#${c}#${c}#league:premier`).catch(() => {});
    await deleteItem(CAPREPORT_PK, `TEAMLASTCAPT#${c}#${c}#league:premier`).catch(() => {});
  }
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures, integrations: priorIntegrations },
  });
});

test("a sync run opens a squad request per side of tomorrow's fixture", async ({ request }) => {
  for (const name of [P1, P2, P3]) await createActivePlayer(request, HOME, { name });
  await createActivePlayer(request, AWAY, { name: `SqFwd${RUN}` });

  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: SERIES_ID,
      name: `Squad E2E ${RUN}`,
      startDate: MATCH_DATE,
      leagueKey: 'premier',
      teams: [HOME, AWAY],
      participants: [
        { teamId: HOME, clubId: HOME, name: 'UKZN' },
        { teamId: AWAY, clubId: AWAY, name: 'Crusaders' },
      ],
      fixtures: [
        { id: 'f1', round: 1, date: MATCH_DATE, time: `09:${MIN}`, home: HOME, away: AWAY },
      ],
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

  const sync = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
    headers: admin(),
  });
  expect(sync.ok(), `sync-now → ${sync.status()} ${await sync.text()}`).toBeTruthy();
  const summary = (await sync.json()) as { status: string };
  test.skip(
    summary.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  const rows = await adminRows(request);
  expect(rows.map((r) => `${r.teamId}:${r.status}:${r.recipient.kind}`).sort()).toEqual([
    `${AWAY}:pending:chair`,
    `${HOME}:pending:chair`,
  ]);
});

test('the home chair picks the squad, adds a guest past the guard, submits, then edits', async ({
  browser,
  request,
}) => {
  const token = await mintSquadLink(HOME);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/sq/${token}`);
  await expect(p.getByText(/^UKZN.* \/ Squad selection$/)).toBeVisible();
  await expect(p.getByText(/Link expires/)).toBeVisible();

  const search = p.getByRole('searchbox', { name: 'Search players' });
  for (const name of [P1, P2]) {
    await search.fill(name);
    await p.getByRole('checkbox', { name: `Test ${name}` }).check();
  }
  // A search that matches a roster player never offers the guest path.
  await search.fill(P3);
  await expect(p.getByRole('checkbox', { name: `Test ${P3}` })).toBeVisible();
  await expect(p.getByRole('button', { name: /Add as guest/ })).toHaveCount(0);
  // Nobody matches → the guarded guest add, with its confirm step.
  await search.fill(GUEST);
  await p.getByRole('button', { name: 'Not finding them? Add as guest' }).click();
  const ask = p.getByRole('alertdialog', { name: `Add ${GUEST} as a guest` });
  await expect(ask).toContainText("Guests aren't linked to player records");
  await ask.getByRole('button', { name: 'Add guest' }).click();
  await p.getByRole('combobox', { name: 'Captain' }).selectOption({ label: `Test ${P2}` });
  await p.getByRole('button', { name: 'Submit squad' }).click();
  const done = p.getByLabel('Submitted squad');
  await expect(done.getByText('Squad submitted')).toBeVisible();
  await expect(done.getByText(`Test ${P2} (captain)`)).toBeVisible();
  await expect(done.getByText(`${GUEST} (guest)`)).toBeVisible();

  let home = (await adminRows(request)).find((r) => r.teamId === HOME)!;
  expect(home.status).toBe('submitted');
  expect(home.selection?.players.map((x) => x.name).sort()).toEqual([`Test ${P1}`, `Test ${P2}`]);
  expect(home.selection?.guests).toEqual([{ name: GUEST }]);
  expect(home.selection?.captainName).toBe(`Test ${P2}`);

  // Re-open: the submitted squad loads, editable (not a closed / read-only page).
  await p.reload();
  await expect(p.getByLabel('Submitted squad')).toBeVisible();
  await p.getByRole('button', { name: 'Edit squad' }).click();
  await search.fill(P1);
  await p.getByRole('checkbox', { name: `Test ${P1}` }).uncheck();
  await search.fill(P3);
  await p.getByRole('checkbox', { name: `Test ${P3}` }).check();
  await p.getByRole('button', { name: 'Submit squad' }).click();
  await expect(p.getByLabel('Submitted squad').getByText(`Test ${P3}`)).toBeVisible();

  home = (await adminRows(request)).find((r) => r.teamId === HOME)!;
  expect(home.selection?.players.map((x) => x.name).sort()).toEqual([`Test ${P2}`, `Test ${P3}`]);
  await ctx.close();
});

test('the away chair sends the squad link on to a player; the chair link keeps working', async ({
  browser,
  request,
}) => {
  const captain = `Test SqFwd${RUN}`;
  const token = await mintSquadLink(AWAY);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/sq/${token}`);
  await expect(p.getByText(/^Crusaders.* \/ Squad selection$/)).toBeVisible();
  await p.getByRole('button', { name: 'Send to captain' }).click();
  const picker = p.getByRole('combobox', { name: 'Send to player' });
  await expect(picker.getByRole('option', { name: captain, exact: true })).toHaveCount(1);
  await picker.selectOption({ label: captain });
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(p.getByText(`Sent to ${captain}. They will get their own link.`)).toBeVisible();
  const away = (await adminRows(request)).find((r) => r.teamId === AWAY)!;
  expect(away.recipient).toMatchObject({ kind: 'captain', name: captain });
  expect(away.recipient.forwardedBy?.via).toBe('link');
  await p.reload();
  await expect(p.getByText(/^Crusaders.* \/ Squad selection$/)).toBeVisible();
  await ctx.close();
});

test('the union office sees both squad requests', async ({ page }) => {
  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Squad requests' }).click();
  // Scoped to this run's series (the competition line): a reused stack keeps earlier runs' rows.
  const rows = page.getByRole('row', { name: new RegExp(`UKZN v Crusaders.*Squad E2E ${RUN}`) });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Submitted' })).toHaveCount(1);
});
