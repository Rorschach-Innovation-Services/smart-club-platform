import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MATCHES_PATH, verifySignature } from '../packages/api/src/medicoach-sync-contract';
import { API_BASE, TENANT, RUN, adminAuthHeader, apiHeaders, operatorAuth } from './helpers';

/**
 * Chair scorecard confirmation end to end: a result pulled from a STUB medicoach (with its
 * ball-by-ball scorecard) lands in last week's digest when the operator runs the Monday job;
 * each club's chair opens their public `/sc/` link — the home chair confirms the scorecard,
 * the away chair requests a correction — and the operator console shows both answers side by
 * side with the correction text.
 *
 * Same harness as captains-report.e2e.ts: the stub listens on :4799 (playwright.config.ts
 * points MEDICOACH_SYNC_URL/SECRET at it) and checks every request's HMAC; a reused stack
 * started without that env answers "Sync now" with a dry run, and the spec skips. Link tokens
 * are never logged or stored, so the spec mints each chair's link the way the API does: the
 * digest's opaque memberId + expiry read from the local dynalite table, signed with the
 * local-only fallback key under the digest's own context.
 *
 * The match is dated the Saturday of the last COMPLETED Mon–Sun week (SAST) so the run's
 * default week picks it up. Tenant settings the spec changes are restored in afterAll; the
 * series, result and digests stay as run-unique residue in the in-memory DB.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
const HOME = 'clares';
const AWAY = 'chatsworth';
const SERIES_ID = `s-e2e-scoreconf-${RUN}`;
const SERIES_NAME = `Scorecard E2E ${RUN}`;
const MATCH_ID = `pma-${RUN}`;
const TOURNAMENT_ID = `tour-${RUN}`;
const FEEDBACK = `Bowler ${RUN} took 3 wickets, not 2.`;

const DAY_MS = 24 * 3600 * 1000;
const isoDay = (offset: number) =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

/** The API's lastCompletedWeekKey: the Sunday closing the last finished Mon–Sun week, SAST. */
function lastCompletedWeekKey(): string {
  const sast = new Date(Date.now() + 2 * 3600 * 1000);
  const day = sast.toISOString().slice(0, 10);
  const closing = Date.parse(`${day}T00:00:00Z`) + ((7 - sast.getUTCDay()) % 7) * DAY_MS;
  return new Date(closing - 7 * DAY_MS).toISOString().slice(0, 10);
}
const WEEK_KEY = lastCompletedWeekKey();
const MATCH_DATE = new Date(Date.parse(`${WEEK_KEY}T00:00:00Z`) - DAY_MS)
  .toISOString()
  .slice(0, 10);

let stub: Server;
let changes: unknown = null;
let prior: {
  features?: Record<string, boolean>;
  integrations?: unknown;
  scorecardConfirmations?: { enabled: boolean };
} | null = null;

const SCORECARD = {
  available: true,
  matchId: MATCH_ID,
  matchState: 'completed',
  innings: [
    {
      battingTeamName: 'Clares',
      totalRuns: 152,
      wickets: 6,
      overs: '20.0',
      extras: { byes: 0, legByes: 1, wides: 4, noBalls: 1, penalties: 0, total: 6 },
      batters: [
        {
          order: 1,
          name: `Opener ${RUN}`,
          runs: 71,
          ballsFaced: 50,
          fours: 8,
          sixes: 2,
          strikeRate: 142,
          howOut: 'c Keeper b Seamer',
        },
      ],
      bowlers: [
        {
          order: 1,
          name: `Bowler ${RUN}`,
          overs: '4.0',
          maidens: 0,
          runsConceded: 31,
          wickets: 2,
          economy: 7.75,
          wides: 2,
          noBalls: 0,
        },
      ],
      fallOfWickets: [{ wicket: 1, runs: 44, overs: '5.3', batterName: `Opener ${RUN}` }],
    },
  ],
};

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
    const isScorecard = (req.url ?? '').startsWith(
      `${MATCHES_PATH}/${encodeURIComponent(MATCH_ID)}/scorecard`,
    );
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(isScorecard ? SCORECARD : changes));
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
      name: SERIES_NAME,
      startDate: MATCH_DATE,
      leagueKey: 'premier',
      teams: [HOME, AWAY],
      participants: [
        { teamId: HOME, clubId: HOME, name: 'Clares' },
        { teamId: AWAY, clubId: AWAY, name: 'Chatsworth' },
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

/** A live result carrying both medicoach ids, so the puller fetches its scorecard. */
function changesPage() {
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
          homeScore: '152/6',
          awayScore: '140/9',
          summary: 'Clares won by 12 runs',
          winner: 'home',
          method: 'normal',
          noResult: false,
          source: 'live',
          recordedAt,
          scoringSide: 'home',
          captainRef: null,
          medicoachMatchUrl: null,
          medicoachMatchId: MATCH_ID,
          medicoachTournamentId: TOURNAMENT_ID,
        },
        resultClearedAt: null,
      },
    ],
  };
}

/** Mint a chair's digest link exactly as scorecard-confirmations.ts does (test-only). */
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
        pk: { S: `TENANT#${TENANT}#SCORECONF` },
        sk: { S: `SCORECONF#${WEEK_KEY}#${clubId}` },
      },
    }),
  );
  const memberId = item.Item?.memberId?.S;
  const expires = item.Item?.linkExpiresAt?.S;
  expect(memberId, `the ${clubId} digest exists`).toBeTruthy();
  const payload = Buffer.from(
    JSON.stringify({
      t: TENANT,
      w: WEEK_KEY,
      c: clubId,
      m: memberId,
      e: Math.floor(Date.parse(expires!) / 1000),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET)
    .update(`scoreconf-link.v1.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

/** This run's match card on a chair's digest page (other runs' matches may share the digest). */
const matchCard = (p: Page) => p.getByRole('region').filter({ hasText: SERIES_NAME });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await startStub();
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  const body = (await cfg.json()) as NonNullable<typeof prior>;
  prior = {
    features: body.features ?? {},
    integrations: body.integrations ?? {},
    scorecardConfirmations: body.scorecardConfirmations ?? { enabled: false },
  };
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: {
      features: { ...prior.features, medicoachSync: true },
      integrations: { medicoach: { goLiveDate: isoDay(-30) } },
      scorecardConfirmations: { enabled: true },
    },
  });
  expect(put.ok(), `enable sync + digest → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await new Promise<void>((r) => stub.close(() => r()));
  if (!prior) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: prior,
  });
});

test('a synced result with its scorecard lands in each club’s digest', async ({ request }) => {
  await seedFixture(request);
  changes = changesPage();
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

  const run = await request.post(`${API_BASE}/platform/scorecard-confirmations/run`, {
    headers: operator(),
    data: {},
  });
  expect(run.ok(), `run → ${run.status()} ${await run.text()}`).toBeTruthy();
  const ran = (await run.json()) as { weekKey: string; errors: number };
  expect(ran.weekKey).toBe(WEEK_KEY);
  expect(ran.errors).toBe(0);
});

test('the home chair sees the full scorecard and confirms it', async ({ browser }) => {
  const token = await mintLink(HOME);
  // A fresh, signed-out context on a phone: the link needs no account.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
  const p = await ctx.newPage();
  await p.goto(`/sc/${token}`);
  await expect(p.getByText(/Clares CC \/ Scorecards · SC-\d{4}-\d{4}/)).toBeVisible();
  const card = matchCard(p);
  await expect(card.getByRole('heading', { name: 'Clares — 152/6 (20.0)' })).toBeVisible();
  const batting = card.getByRole('region', { name: 'Clares batting' });
  await expect(batting.getByRole('row', { name: new RegExp(`Opener ${RUN}`) })).toContainText(
    'c Keeper b Seamer',
  );
  await expect(card.getByText(`1-44 (Opener ${RUN}, 5.3)`)).toBeVisible();

  // Phone width: the scorecard scrolls inside its own wrapper, never the page.
  const pageOverflows = await p.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(pageOverflows).toBe(false);

  await card.getByRole('button', { name: /confirm — stats are correct/i }).click();
  await expect(card.getByText('You confirmed these stats are correct.')).toBeVisible();
  await p.reload();
  await expect(matchCard(p).getByText('You confirmed these stats are correct.')).toBeVisible();
  await expect(matchCard(p).getByRole('button', { name: /confirm/i })).toHaveCount(0);
  await ctx.close();
});

test('the away chair requests a correction', async ({ browser }) => {
  const token = await mintLink(AWAY);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/sc/${token}`);
  await expect(p.getByText(/Chatsworth Sporting CC \/ Scorecards/)).toBeVisible();
  const card = matchCard(p);
  await card.getByRole('button', { name: 'Request correction' }).click();
  await card.getByRole('button', { name: 'Send correction' }).click();
  await expect(card.getByRole('alert')).toHaveText('Tell us what needs correcting.');
  await card.getByRole('textbox', { name: /what needs correcting/i }).fill(FEEDBACK);
  await card.getByRole('button', { name: 'Send correction' }).click();
  await expect(card.getByText('You requested a correction.')).toBeVisible();
  await expect(card.getByLabel('Your correction request')).toHaveText(FEEDBACK);
  await ctx.close();
});

test('the operator console pairs both answers with the correction text', async ({ page }) => {
  await page.goto('/');
  const picker = page.locator('select.field-select').first();
  await expect(picker).toBeVisible();
  await picker.selectOption('operator');
  await page.getByRole('button', { name: 'Enter as operator' }).click();
  await page.locator('aside.nav .nav-item', { hasText: 'Scorecard confirmations' }).click();

  const row = page.getByTestId(`scc-fixture-${TENANT}-${SERIES_ID}-f1`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`scc-side-${HOME}`)).toContainText('Confirmed');
  await expect(row.getByTestId(`scc-side-${AWAY}`)).toContainText('Correction requested');
  await row.getByRole('button', { name: /Show .* feedback/ }).click();
  await expect(row.getByText(FEEDBACK)).toBeVisible();
});
