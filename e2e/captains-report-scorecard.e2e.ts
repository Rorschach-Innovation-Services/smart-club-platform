import { test, expect, type APIRequestContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MATCHES_PATH, verifySignature } from '../packages/api/src/medicoach-sync-contract';
import {
  API_BASE,
  TENANT,
  RUN,
  adminAuthHeader,
  apiHeaders,
  dismissOnboarding,
  operatorAuth,
  signInAsRep,
} from './helpers';

/**
 * Scorecard confirmation inside the captain's report, end to end: a result pulled from a STUB
 * medicoach (with its full scorecard) opens a report per side with the scorecard attached.
 *
 *  - HOME side, public `/r/` link on a phone: the scorecard renders (its tables scroll inside
 *    their own wrappers, never the page), the answer is required — submit stays blocked until
 *    it is given — and the confirmation locks in with the report.
 *  - AWAY side, club portal (the chair's path: the form is fed by the report DETAIL route, the
 *    only response carrying the scorecard): a correction with blank text is blocked, then one
 *    with text submits.
 *  - Operator console: the fixture's row pairs home "Confirmed" with away "Correction
 *    requested", and the correction text opens on demand.
 *
 * Same harness as captains-report.e2e.ts: the stub listens on :4799 (playwright.config.ts
 * points MEDICOACH_SYNC_URL/SECRET at it) and checks every request's HMAC; a reused stack
 * started without that env answers "Sync now" with a dry run, and the spec skips. Link tokens
 * are never logged or stored, so the spec mints the home chair's link the way the API does:
 * the report's opaque recipient id from the local dynalite table, signed with the local-only
 * fallback key. Tenant settings the spec changes are restored in afterAll; the series, result
 * and reports stay as run-unique residue in the in-memory DB.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
const HOME = 'clares';
const AWAY = 'chatsworth';
const SERIES_ID = `s-e2e-crscorecard-${RUN}`;
const SERIES_NAME = `Report scorecard E2E ${RUN}`;
const MATCH_ID = `pma-cr-${RUN}`;
const TOURNAMENT_ID = `tour-cr-${RUN}`;
const UMP_A = `A.Card${RUN}`;
const UMP_B = `B.Card${RUN}`;
const FEEDBACK = `Bowler ${RUN} took 3 wickets, not 2.`;

const isoDay = (offset: number) =>
  new Date(Date.now() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
const MATCH_DATE = isoDay(-1);

let stub: Server;
let changes: unknown = null;
let prior: { features?: Record<string, boolean>; integrations?: unknown } | null = null;

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
    const url = req.url ?? '';
    const isOurScorecard = url.startsWith(
      `${MATCHES_PATH}/${encodeURIComponent(MATCH_ID)}/scorecard`,
    );
    // Other runs' matches (a reused stack) have no card here.
    if (!isOurScorecard && url.startsWith(`${MATCHES_PATH}/`)) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(isOurScorecard ? SCORECARD : changes));
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
      name: SERIES_NAME,
      startDate: MATCH_DATE,
      leagueKey: 'premier',
      teams: [HOME, AWAY],
      participants: [
        { teamId: HOME, clubId: HOME, name: 'Clares' },
        { teamId: AWAY, clubId: AWAY, name: 'Chatsworth' },
      ],
      // A RUN-unique custom ground (fixtures-helpers.ts convention): a re-run against a
      // reused stack would otherwise clash with the previous run's fixture at Clares' ground.
      fixtures: [
        {
          id: 'f1',
          round: 1,
          date: MATCH_DATE,
          time: '09:00',
          home: HOME,
          away: AWAY,
          venueOverride: `E2E Report scorecard ground ${RUN}`,
        },
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
  const officials = await request.put(`${API_BASE}/series/${SERIES_ID}/fixtures/f1/officials`, {
    headers: admin(),
    data: { umpires: umpireIds.map((umpireId) => ({ umpireId })) },
  });
  expect(officials.ok(), `PUT officials → ${officials.status()}`).toBeTruthy();
}

/** A live result with both medicoach ids (so the puller fetches its scorecard), no captain. */
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

/** Mint a side's report link exactly as captains-reports.ts does (test-only). */
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
  const stored = item.Item?.linkExpiresAt?.S;
  expect(memberId, 'the report has a recipient id').toBeTruthy();
  expect(stored, 'the report has a link expiry').toBeTruthy();
  const payload = Buffer.from(
    JSON.stringify({
      t: TENANT,
      r: `${SERIES_ID}~f1~${clubId}`,
      m: memberId,
      e: Math.floor(Date.parse(stored!) / 1000),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET)
    .update(`capreport-link.v1.${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

/** Rate every appointed umpire `score` on all five criteria. */
async function rateUmpires(p: import('@playwright/test').Page, score: string) {
  for (const card of [1, 2]) {
    const groups = p.getByTestId(`umpire-card-${card}`).getByRole('radiogroup');
    for (let i = 0; i < 5; i++) await groups.nth(i).getByRole('radio', { name: score }).click();
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await startStub();
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  const body = (await cfg.json()) as NonNullable<typeof prior>;
  prior = { features: body.features ?? {}, integrations: body.integrations ?? {} };
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: {
      features: { ...prior.features, medicoachSync: true },
      integrations: { medicoach: { goLiveDate: isoDay(-30) } },
    },
  });
  expect(put.ok(), `enable sync → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await new Promise<void>((r) => stub.close(() => r()));
  if (!prior) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: prior,
  });
});

test('a synced result opens both reports with the scorecard attached', async ({ request }) => {
  const a = await createUmpire(request, UMP_A);
  const b = await createUmpire(request, UMP_B);
  await seedFixture(request, [a, b]);
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

  // Both reports are open, and the home link's payload carries the stored card.
  await expect
    .poll(async () => {
      const list = await request.get(`${API_BASE}/captains-reports?status=pending`, {
        headers: admin(),
      });
      return ((await list.json()) as Array<{ seriesId: string; clubId: string }>)
        .filter((r) => r.seriesId === SERIES_ID)
        .map((r) => r.clubId)
        .sort();
    })
    .toEqual([AWAY, HOME].sort());
  const token = await mintLink(HOME);
  await expect
    .poll(async () => {
      const res = await request.get(`${API_BASE}/captains-report-link/${token}`);
      const body = (await res.json()) as { scorecard?: { innings: unknown[] } };
      return body.scorecard?.innings.length ?? 0;
    })
    .toBe(1);
});

test('home, by link on a phone: the scorecard is required, then confirmed', async ({ browser }) => {
  const token = await mintLink(HOME);
  // A fresh, signed-out context on a phone: the link needs no account.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
  const p = await ctx.newPage();
  await p.goto(`/r/${token}`);
  const section = p.getByTestId('report-scorecard');
  await expect(section.getByRole('heading', { name: /^Clares — 152\/6 \(20\.0\)/ })).toBeVisible();
  const batting = section.getByRole('region', { name: 'Clares batting' });
  await expect(batting.getByRole('row', { name: new RegExp(`Opener ${RUN}`) })).toContainText(
    'c Keeper b Seamer',
  );
  await expect(section.getByText(`1-44 (Opener ${RUN}, 5.3)`)).toBeVisible();

  // Phone width: each table scrolls inside its own wrapper, never the page.
  expect(await batting.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
  const pageOverflows = await p.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(pageOverflows).toBe(false);

  // Everything else filled in: submit stays blocked until the scorecard is answered.
  await rateUmpires(p, '4');
  await p.getByRole('combobox', { name: "Captain's name" }).fill(`Home captain ${RUN}`);
  await p.getByRole('checkbox').check();
  const submit = p.getByRole('button', { name: 'Submit report' }).first();
  await expect(submit).toBeDisabled();
  await expect(
    p.getByText('Confirm the scorecard or request a correction.').first(),
  ).toBeAttached();

  await section.getByRole('radio', { name: /Confirm — these stats are correct/ }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(p.getByText('Report submitted')).toBeVisible();
  await expect(p.locator('.cr-summary-row', { hasText: 'Scorecard' })).toContainText('Confirmed');
  await p.reload();
  await expect(p.getByText('This report is closed')).toBeVisible();
  await ctx.close();
});

test('away, in the club portal: a correction needs its text, then submits', async ({ page }) => {
  await signInAsRep(page, AWAY);
  await dismissOnboarding(page);
  await page.locator('aside.nav .nav-item', { hasText: "Captain's Report" }).click();
  await page.getByRole('button', { name: new RegExp(SERIES_NAME) }).click();

  // The form is fed by the report's detail route — the only response with the scorecard.
  const section = page.getByTestId('report-scorecard');
  await expect(section.getByRole('heading', { name: /^Clares — 152\/6 \(20\.0\)/ })).toBeVisible();

  await rateUmpires(page, '5');
  await page.getByRole('combobox', { name: "Captain's name" }).fill(`Away captain ${RUN}`);
  await page.getByRole('checkbox').check();
  const submit = page.getByRole('button', { name: 'Submit report' }).first();

  await section.getByRole('radio', { name: 'Request a correction' }).check();
  const text = section.getByRole('textbox', { name: /what needs correcting/i });
  await expect(text).toBeFocused();
  await text.blur();
  await expect(section.getByRole('alert')).toHaveText('Tell us what needs correcting.');
  await expect(submit).toBeDisabled();

  await text.fill(FEEDBACK);
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText('Report submitted')).toBeVisible();
  await expect(page.locator('.cr-summary-row', { hasText: 'Scorecard' })).toContainText(
    'Correction requested',
  );
  // The success card repeats what was sent, read-only.
  await expect(page.getByLabel('Submitted correction request')).toHaveText(FEEDBACK);
});

test('the operator console pairs both answers with the correction text', async ({ page }) => {
  // A common laptop width: the sides must stack rather than push Date / Match off-canvas.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const picker = page.locator('select.field-select').first();
  await expect(picker).toBeVisible();
  await picker.selectOption('operator');
  await page.getByRole('button', { name: 'Enter as operator' }).click();
  await page.locator('aside.nav .nav-item', { hasText: 'Scorecard answers' }).click();

  const row = page.getByTestId(`scc-fixture-${TENANT}-${SERIES_ID}-f1`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`scc-side-${HOME}`)).toContainText('Confirmed');
  await expect(row.getByTestId(`scc-side-${AWAY}`)).toContainText('Correction requested');
  // Home first.
  await expect(row.locator('.scc-side').first()).toHaveAttribute('data-testid', `scc-side-${HOME}`);
  await expect(row.getByText(FEEDBACK)).toHaveCount(0);
  await row.getByRole('button', { name: /Show .* feedback/ }).click();
  await expect(row.getByText(FEEDBACK)).toBeVisible();
  // Stacked at 1280px (away below home), and the table fits its wrapper — no sideways scroll.
  const homeBox = (await row.getByTestId(`scc-side-${HOME}`).boundingBox())!;
  const awayBox = (await row.getByTestId(`scc-side-${AWAY}`).boundingBox())!;
  expect(awayBox.y).toBeGreaterThan(homeBox.y);
  const scroller = row.locator('xpath=ancestor::div[contains(@class,"scroll-x-inner")]');
  const fits = await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits).toBe(true);

  // The correction filter keeps the row.
  await page
    .getByRole('group', { name: 'Scorecard status' })
    .getByRole('button', {
      name: 'Correction requested',
    })
    .click();
  await expect(page.getByTestId(`scc-fixture-${TENANT}-${SERIES_ID}-f1`)).toBeVisible();
});
