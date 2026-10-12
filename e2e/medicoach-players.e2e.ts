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
  signInAsAdmin,
} from './helpers';

/**
 * The admin "Medicoach sync" page's Players panel (ADR 0019) end to end: a STUB medicoach on
 * :4799 (the port playwright.config.ts points the stack's MEDICOACH_SYNC_URL at) answers the
 * player push per player (scripted by the run-unique last name). Players are registered through
 * the real chair route, so the repo hooks queue them; "Sync now" pushes them (signed):
 *
 *  - pending, then parked (unmapped-team) and review counts render;
 *  - medicoach `needs-review` reviews: Link (a candidate is required) and Create (every
 *    candidate must be acknowledged) ride on the next push as `resolution`;
 *  - smart club's own possible duplicate (same name + dob, two IDs): neither is pushed;
 *    "They are different people" pushes both;
 *  - Dismiss drops a review and pushes nothing;
 *  - an `out-of-tenant-identity-conflict` review (no candidates) offers Dismiss only;
 *  - "Retry waiting players" re-queues the parked row and the next sync sends it.
 *
 * A stack reused without the sync env answers "Sync now" with a dry run, and the spec skips.
 * Tenant features/integrations are restored in afterAll; seeded players stay as run-unique
 * residue (the player sync is switched off again, so they are never pushed later).
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';

const NAME = {
  link: `Link${RUN}`,
  create: `Create${RUN}`,
  dismiss: `Dismiss${RUN}`,
  conflict: `Conflict${RUN}`,
  parked: `Parked${RUN}`,
  twin: `Twin${RUN}`,
};

interface Entry {
  ref: string;
  op: string;
  lastName?: string;
  resolution?: { action: string; playerId?: string; acknowledgedCandidates?: string[] };
}
let stub: Server;
const pushes: Array<{ verified: boolean; players: Entry[] }> = [];
let parkedTeamExists = false;

const candidate = (playerId: string, name: string) => ({
  playerId,
  name,
  dob: '1995-06-15',
  institutionName: 'Medicoach CC',
});

/** How the stub medicoach answers one pushed player. */
function answerFor(e: Entry): Record<string, unknown> {
  if (e.resolution?.action === 'link') return { status: 'linked' };
  if (e.resolution?.action === 'create') return { status: 'created' };
  switch (e.lastName) {
    case NAME.link:
      return {
        status: 'needs-review',
        message: 'name+dob match at a different institution',
        candidates: [candidate('pl_link_a', 'Test Link A'), candidate('pl_link_b', 'Test Link B')],
      };
    case NAME.create:
      return { status: 'needs-review', candidates: [candidate('pl_create', 'Test Create')] };
    case NAME.dismiss:
      return { status: 'needs-review', candidates: [candidate('pl_dismiss', 'Test Dismiss')] };
    case NAME.conflict:
      return { status: 'needs-review', message: 'out-of-tenant-identity-conflict', candidates: [] };
    case NAME.parked:
      return parkedTeamExists
        ? { status: 'created' }
        : { status: 'unmapped-team', missingTeamRefs: [`smartclub:${TENANT}:team:premier:e2e`] };
    default:
      return { status: 'created' };
  }
}

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
      const json = (body: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.method === 'GET')
        return void json({
          version: 1,
          tenant: TENANT,
          nextCursor: new Date().toISOString(),
          hasMore: false,
          fixtures: [],
        });
      if (req.url === '/integrations/smartclub/players') {
        const body = JSON.parse(raw) as { players: Entry[] };
        pushes.push({ verified: check.ok, players: body.players });
        return void json({
          version: 1,
          results: body.players.map((e) => ({ ref: e.ref, ...answerFor(e) })),
        });
      }
      const body = JSON.parse(raw) as { changes?: Array<{ ref: string }> };
      json({
        version: 1,
        results: (body.changes ?? []).map((c) => ({ ref: c.ref, status: 'applied' })),
      });
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

let seq = 0;
/** Register one player through the real chair route; returns its natural key. */
async function register(
  request: APIRequestContext,
  lastName: string,
  club = 'ukzn',
): Promise<string> {
  seq += 1;
  const res = await request.post(`${API_BASE}/clubs/${club}/players`, {
    headers: admin(),
    data: {
      firstName: 'Test',
      lastName,
      idType: 'passport',
      idNumber: `MCP${RUN}${seq}`.toUpperCase(),
      dob: '1995-06-15',
      race: 'African',
      gender: 'Male',
      nationality: 'Zimbabwean',
      cell: '0821234567',
      team: 'premier',
      district: 'Durban Central',
    },
  });
  expect(
    res.ok(),
    `POST /clubs/${club}/players → ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  return ((await res.json()) as { naturalKey: string }).naturalKey;
}

interface PlayersStatus {
  enabled: boolean;
  pending: number;
  queued?: number;
  parked: number;
  stuck: number;
  reviews: number;
}
async function playersStatus(request: APIRequestContext): Promise<PlayersStatus> {
  const res = await request.get(`${API_BASE}/integrations/medicoach/status`, { headers: admin() });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { players: PlayersStatus }).players;
}

async function syncNow(request: APIRequestContext) {
  const res = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
    headers: admin(),
  });
  expect(res.ok(), `sync-now → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { status: string; playerPush?: { status: string } };
}

const pushedEntries = () => pushes.flatMap((p) => p.players);
const pushedNames = () => pushedEntries().map((e) => e.lastName);
const stat = (page: Page, label: string) =>
  page
    .getByTestId('mcs-players')
    .locator('.mcs-stat', { hasText: label })
    .locator('.mcs-stat-value');
const card = (page: Page, lastName: string) =>
  page.getByTestId('mcs-player-reviews').getByRole('article', { name: new RegExp(lastName) });

let priorFeatures: Record<string, boolean> = {};
let priorMedicoach: Record<string, unknown> = {};
const keys: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await startStub();
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  const current = (await cfg.json()) as {
    features?: Record<string, boolean>;
    integrations?: { medicoach?: Record<string, unknown> };
  };
  priorFeatures = current.features ?? {};
  priorMedicoach = current.integrations?.medicoach ?? {};
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: {
      features: { ...priorFeatures, medicoachSync: true },
      integrations: { medicoach: { ...priorMedicoach, playerSync: true } },
    },
  });
  expect(put.ok(), `enable player sync → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await new Promise<void>((r) => stub.close(() => r()));
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: {
      features: priorFeatures,
      integrations: { medicoach: { ...priorMedicoach, playerSync: false } },
    },
  });
});

test('registrations queue, sync, and land in the Players panel as counts and reviews', async ({
  page,
  request,
}) => {
  for (const [k, name] of Object.entries(NAME).filter(([k]) => k !== 'twin'))
    keys[k] = await register(request, name);
  // Same name + dob under two IDs at two clubs: smart club's own possible-duplicate guard.
  keys.twinA = await register(request, NAME.twin, 'ukzn');
  keys.twinB = await register(request, NAME.twin, 'crusaders');

  const before = await playersStatus(request);
  expect(before.enabled).toBe(true);
  expect(before.pending).toBeGreaterThanOrEqual(7);

  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  await expect(page.getByTestId('mcs-players')).toBeVisible();
  await expect(stat(page, 'Waiting to send')).toHaveText(String(before.pending));

  const summary = await syncNow(request);
  test.skip(
    summary.status === 'dry-run' || summary.playerPush?.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  expect(pushes.every((p) => p.verified)).toBe(true);
  // The twins were held by smart club's guard, never sent.
  expect(pushedNames()).not.toContain(NAME.twin);
  expect(pushedNames()).toEqual(
    expect.arrayContaining([NAME.link, NAME.create, NAME.dismiss, NAME.conflict, NAME.parked]),
  );

  const after = await playersStatus(request);
  expect(after.parked).toBeGreaterThanOrEqual(1);
  expect(after.reviews).toBeGreaterThanOrEqual(6);
  await page.reload();
  await expect(stat(page, 'Waiting for a team')).toHaveText(String(after.parked));
  await expect(stat(page, 'For your review')).toHaveText(String(after.reviews));
  for (const name of [NAME.link, NAME.create, NAME.dismiss, NAME.conflict])
    await expect(card(page, name)).toContainText('medicoach found a possible match');
  await expect(card(page, NAME.twin)).toHaveCount(2);
  await expect(card(page, NAME.twin).first()).toContainText(
    'Same name and date of birth under another ID here',
  );
});

test('link needs a candidate, create must acknowledge every candidate; each is sent at once', async ({
  page,
  request,
}) => {
  const resolve = (nk: string, data: unknown) =>
    request.post(`${API_BASE}/integrations/medicoach/player-reviews/${nk}/resolve`, {
      headers: admin(),
      data,
    });
  expect(
    (await resolve(keys.link, { action: 'link', medicoachPlayerId: 'pl_other' })).status(),
  ).toBe(400);
  expect((await resolve(keys.link, { action: 'link' })).status()).toBe(400);
  expect(
    (await resolve(keys.create, { action: 'create', acknowledgedCandidates: [] })).status(),
  ).toBe(400);

  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  pushes.length = 0;
  const link = card(page, NAME.link);
  await expect(link.getByRole('button', { name: 'Link to this player' })).toHaveCount(2);
  await link.getByRole('button', { name: 'Link to this player' }).first().click();
  // The decision goes to medicoach right away (only this player), not on the next cron.
  await expect(page.getByText('Linked — sent to medicoach')).toBeVisible();
  await expect(link).toHaveCount(0);

  const create = card(page, NAME.create);
  await create.getByRole('button', { name: 'None of these — create new' }).click();
  await expect(page.getByText('New player — sent to medicoach')).toBeVisible();
  await expect(create).toHaveCount(0);

  const sent = pushedEntries();
  expect(pushes.every((p) => p.players.length === 1)).toBe(true);
  expect(sent.find((e) => e.lastName === NAME.link)?.resolution).toEqual({
    action: 'link',
    playerId: 'pl_link_a',
  });
  expect(sent.find((e) => e.lastName === NAME.create)?.resolution).toEqual({
    action: 'create',
    acknowledgedCandidates: ['pl_create'],
  });
});

test('different people, dismiss, and a no-candidate identity conflict offers Dismiss only', async ({
  page,
  request,
}) => {
  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  pushes.length = 0;

  // Smart club's possible duplicate: confirming them distinct settles BOTH reviews.
  await card(page, NAME.twin)
    .first()
    .getByRole('button', { name: 'They are different people' })
    .click();
  await expect(page.getByText('Marked as different people — sent to medicoach')).toBeVisible();
  await expect(card(page, NAME.twin)).toHaveCount(0);

  // The out-of-tenant conflict: medicoach's message, no Link/Create.
  const conflict = card(page, NAME.conflict);
  await expect(conflict).toContainText('out-of-tenant-identity-conflict');
  await expect(conflict.getByRole('button')).toHaveText(['Dismiss']);
  await conflict.getByRole('button', { name: 'Dismiss' }).click();
  await expect(conflict).toHaveCount(0);

  await card(page, NAME.dismiss).getByRole('button', { name: 'Dismiss' }).click();
  await expect(card(page, NAME.dismiss)).toHaveCount(0);

  // Both twins went out with the decision; dismissed reviews send nothing, now or later.
  await syncNow(request);
  const names = pushedNames();
  expect(names.filter((n) => n === NAME.twin)).toHaveLength(2);
  expect(names).not.toContain(NAME.dismiss);
  expect(names).not.toContain(NAME.conflict);
});

test('retry re-queues the parked player: queued, then sent and gone on the next sync', async ({
  page,
  request,
}) => {
  const parked = (await playersStatus(request)).parked;
  expect(parked).toBeGreaterThanOrEqual(1);
  // A second sync never resends a parked row.
  pushes.length = 0;
  await syncNow(request);
  expect(pushedNames()).not.toContain(NAME.parked);

  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  await expect(stat(page, 'Waiting for a team')).toHaveText(String(parked));
  await page.getByRole('button', { name: 'Retry waiting players' }).click();
  await expect(page.getByText(`${parked} player(s) will be sent on the next sync`)).toBeVisible();

  // Retry moves it from "waiting for a team" to a visible QUEUED state — never into nothing.
  await expect(stat(page, 'Waiting for a team')).toHaveText('0');
  const queued = page.getByTestId('mcs-players-queued');
  await expect(queued).toContainText('Queued');
  await expect(queued).toContainText(`${parked} player(s) you retried or decided on are queued`);
  expect((await playersStatus(request)).queued).toBe(parked);

  parkedTeamExists = true; // the bundle top-up landed in medicoach
  pushes.length = 0;
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Sync finished')).toBeVisible();
  await expect.poll(() => pushedNames()).toContain(NAME.parked);
  // Accepted: the queued state clears and nothing is waiting for a team.
  await expect(queued).toHaveCount(0);
  await expect(stat(page, 'Waiting for a team')).toHaveText('0');
});
