import { test, expect, type APIRequestContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { verifySignature } from '../packages/api/src/medicoach-sync-contract';
import {
  API_BASE,
  TENANT,
  RUN,
  adminAuthHeader,
  apiHeaders,
  operatorAuth,
  signInAsAdmin,
} from './helpers';

/**
 * The admin "Medicoach sync" page (ADR 0016, Slices 3–4) end to end: a STUB medicoach on :4799
 * (the port playwright.config.ts points the stack's MEDICOACH_SYNC_URL at) proposes a
 * reschedule that would double-book a ground. "Sync now" holds it in the conflict inbox; Accept
 * is refused while it still clashes; Keep keeps smart club's schedule and queues it for
 * medicoach; the next "Sync now" pushes it (signed) and the outbox empties.
 *
 * A stack reused without the sync env answers "Sync now" with a dry run, and the spec skips.
 * Tenant features are restored in afterAll; the seeded series/venues stay as run-unique residue.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const SERIES_ID = `s-e2e-mcsync-${RUN}`;
const OVAL = `E2E Oval ${RUN}`;
const PARK = `E2E Park ${RUN}`;
const DATE = '2027-02-13';
const REF_F2 = `smartclub:${TENANT}:fixture:${SERIES_ID}:f2`;

let stub: Server;
let page: unknown = null;
const pushes: Array<{ verified: boolean; refs: string[] }> = [];
let priorFeatures: Record<string, boolean> | undefined;

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
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
      if (req.method === 'POST') {
        const body = JSON.parse(raw) as { changes: Array<{ ref: string }> };
        pushes.push({ verified: check.ok, refs: body.changes.map((c) => c.ref) });
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            version: 1,
            results: body.changes.map((c) => ({ ref: c.ref, status: 'applied' })),
          }),
        );
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

async function seed(request: APIRequestContext) {
  for (const name of [OVAL, PARK]) {
    const id = `v-e2e-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const res = await request.put(`${API_BASE}/venues/${id}`, {
      headers: admin(),
      data: { id, name },
    });
    expect(res.ok(), `PUT venue → ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  const fixture = (id: string, time: string, venueName: string) => ({
    id,
    round: 1,
    date: DATE,
    time,
    home: 'ukzn',
    away: 'crusaders',
    venueName,
  });
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: SERIES_ID,
      name: `Medicoach sync E2E ${RUN}`,
      startDate: DATE,
      leagueKey: 'premier',
      teams: ['ukzn', 'crusaders'],
      participants: [
        { teamId: 'ukzn', clubId: 'ukzn', name: 'UKZN' },
        { teamId: 'crusaders', clubId: 'crusaders', name: 'Crusaders' },
      ],
      fixtures: [fixture('f1', '13:30', OVAL), fixture('f2', '09:00', PARK)],
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

/** Medicoach moves f2 onto the Oval at 13:30 — where f1 already plays. */
function clashPage() {
  const at = new Date(Date.now() - 3600_000).toISOString();
  return {
    version: 1,
    tenant: TENANT,
    nextCursor: new Date().toISOString(),
    hasMore: false,
    fixtures: [
      {
        ref: REF_F2,
        syncStamp: at,
        schedule: {
          scheduledTime: `${DATE}T13:30:00+02:00`,
          timeTbc: false,
          dateTbc: false,
          venue: OVAL,
          postponed: false,
          cancelled: false,
          changedAt: at,
        },
        teams: { homeRef: null, awayRef: null },
        result: null,
        resultClearedAt: null,
      },
    ],
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await startStub();
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  priorFeatures = ((await cfg.json()) as { features?: Record<string, boolean> }).features ?? {};
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: { ...priorFeatures, medicoachSync: true } },
  });
  expect(put.ok(), `enable sync → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await new Promise<void>((r) => stub.close(() => r()));
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures },
  });
});

test('a clashing medicoach reschedule is held, refused on Apply, discarded and pushed back', async ({
  page: browser,
  request,
}) => {
  await seed(request);
  page = clashPage();
  const sync = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
    headers: admin(),
  });
  expect(sync.ok(), `sync-now → ${sync.status()} ${await sync.text()}`).toBeTruthy();
  const summary = (await sync.json()) as { status: string; counts: { scheduleConflicts: number } };
  test.skip(
    summary.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  expect(summary.counts.scheduleConflicts).toBe(1);

  await signInAsAdmin(browser);
  await browser.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  await expect(browser.getByRole('heading', { name: /Medicoach sync/ })).toBeVisible();
  const row = browser
    .getByTestId('mcs-conflicts')
    .getByRole('article', { name: /UKZN v Crusaders/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Would double-book a ground');
  // Both versions side by side: smart club's 09:00 at the Park, medicoach's 13:30 at the Oval.
  const time = row.getByRole('row', { name: /Time/ });
  await expect(time).toContainText('09:00');
  await expect(time).toContainText('13:30');
  await expect(row.getByRole('row', { name: /Venue/ })).toContainText(OVAL);
  await expect(browser.getByText(/Last successful sync/)).toBeVisible();

  // Accept re-runs the clash gate: still clashing → refused, still held.
  await row.getByRole('button', { name: "Accept medicoach's change" }).click();
  await expect(browser.getByText(/Not accepted: Change blocked/)).toBeVisible();
  await expect(row).toHaveCount(1);

  // Keep: smart club's schedule stands and is queued for medicoach.
  await row.getByRole('button', { name: "Keep smart club's version" }).click();
  await expect(browser.getByText(/Nothing to review/)).toBeVisible();
  const waiting = browser
    .locator('.mcs-stat', { hasText: 'Waiting to send' })
    .locator('.mcs-stat-value');
  await expect(waiting).not.toHaveText('0');

  // Sync now: the outbox goes out first (signed), then the pull finds the proposal stale.
  await browser.getByRole('button', { name: 'Sync now' }).click();
  await expect(waiting).toHaveText('0');
  const pushed = pushes.flatMap((p) => p.refs);
  expect(pushed).toContain(REF_F2);
  expect(pushes.every((p) => p.verified)).toBe(true);
  await expect(browser.getByText(/Nothing to review/)).toBeVisible();

  // The fixture kept smart club's schedule.
  const series = await request.get(`${API_BASE}/series`, { headers: admin() });
  const f2 = (
    (await series.json()) as Array<{ id: string; fixtures: Array<Record<string, unknown>> }>
  )
    .find((s) => s.id === SERIES_ID)!
    .fixtures.find((f) => f.id === 'f2')!;
  expect([f2.time, f2.venueName]).toEqual(['09:00', PARK]);
});
