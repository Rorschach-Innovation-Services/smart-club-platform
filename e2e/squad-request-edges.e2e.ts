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
  repAuthHeader,
  setReportNoticeWindow,
} from './helpers';

/**
 * Captain squad links — edge cases and failure modes, end to end through the real local
 * stack (HTTP + the /sq/ page + the sync run + a scripted stub medicoach on :4799).
 *
 * The stub records every §8 squad push (`POST /integrations/smartclub/fixture-squad`) and
 * answers from a per-(fixtureRef, side) script, defaulting to `applied`. The pull answers
 * `pullFixtures` (empty unless a test needs a result). It can be stopped and restarted to
 * model medicoach being down.
 *
 * Isolation: every test seeds its own run-unique series; clubs whose captain state a test
 * changes (phoenix, rhythm, spartan, tongaat) are used by that test only, and their
 * TEAMCAPTAIN# / TEAMLASTCAPT# rows are removed in afterAll — ukzn/crusaders (the other
 * squad spec's chairs-only clubs) are never touched. No other test names a captain, so no
 * other team learns a last captain.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const LINK_SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback
// medicoach-sync/squads.ts SQUAD_PUSH_MAX_ATTEMPTS (importing it drags the API module graph in).
const SQUAD_PUSH_MAX_ATTEMPTS = 8;
const SQUAD_PATH = '/integrations/smartclub/fixture-squad';

const sastDay = (offset: number) =>
  new Date(Date.now() + 2 * 3600 * 1000 + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
const TOMORROW = sastDay(1);
const TODAY = sastDay(0);
const YESTERDAY = sastDay(-1);
// Run-unique kick-off minutes: a reused stack keeps earlier runs' released series, and the
// release gate refuses the same ground at the same date + time (venue_clash).
const MIN = String(parseInt(RUN.slice(-4), 36) % 60).padStart(2, '0');
const at = (hour: string) => `${hour}:${MIN}`;

// ───────────────────────── stub medicoach ─────────────────────────

type SquadAnswer = 'applied' | 'unmapped' | 'http500';
interface SquadPush {
  op: 'upsert' | 'void';
  fixtureRef: string;
  side: 'home' | 'away';
  submittedAt: string;
  players: Array<{ ref: string; name: string }>;
  guests: Array<{ name: string }>;
}

let stub: Server | null = null;
let pullFixtures: unknown[] = [];
const pushes: SquadPush[] = [];
/** fixtureRef|side → answers consumed in order; `always` repeats forever. */
const scripts = new Map<string, { queue: SquadAnswer[]; always?: SquadAnswer }>();

const pushKey = (fixtureRef: string, side: string) => `${fixtureRef}|${side}`;
const fixtureRefOf = (seriesId: string, fixtureId = 'f1') =>
  `smartclub:${TENANT}:fixture:${seriesId}:${fixtureId}`;
const pushesFor = (seriesId: string, side?: 'home' | 'away', fixtureId = 'f1') =>
  pushes.filter(
    (p) => p.fixtureRef === fixtureRefOf(seriesId, fixtureId) && (!side || p.side === side),
  );

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
      const json = (status: number, v: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (req.method === 'GET') {
        json(200, {
          version: 1,
          tenant: TENANT,
          nextCursor: new Date().toISOString(),
          hasMore: false,
          fixtures: pullFixtures,
        });
        return;
      }
      if (req.url === SQUAD_PATH) {
        const p = JSON.parse(body) as SquadPush;
        pushes.push(p);
        const s = scripts.get(pushKey(p.fixtureRef, p.side));
        const answer: SquadAnswer = s?.queue.shift() ?? s?.always ?? 'applied';
        if (answer === 'http500') return json(500, { error: 'boom' });
        if (answer === 'unmapped')
          return json(200, {
            applied: false,
            reason: 'fixture-unmapped',
            mappedPlayers: 0,
            unmappedAsGuest: 0,
            guests: 0,
          });
        return json(200, {
          applied: true,
          mappedPlayers: p.players.length,
          unmappedAsGuest: 0,
          guests: p.guests.length,
        });
      }
      json(200, { ok: true });
    });
  });
  return new Promise((resolve) => stub!.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}

function stopStub(): Promise<void> {
  const s = stub;
  stub = null;
  if (!s) return Promise.resolve();
  s.closeAllConnections?.();
  return new Promise((r) => s.close(() => r()));
}

// ───────────────────────── helpers ─────────────────────────

const operator = () => apiHeaders(operatorAuth());
const admin = () => apiHeaders(adminAuthHeader());

function ddbModule() {
  return createRequire(path.resolve('packages/api/package.json'))(
    '@aws-sdk/client-dynamodb',
  ) as typeof import('@aws-sdk/client-dynamodb');
}
function ddbClient() {
  const { DynamoDBClient } = ddbModule();
  return new DynamoDBClient({
    endpoint: 'http://localhost:4567',
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}
async function getItem(pk: string, sk: string) {
  const { GetItemCommand } = ddbModule();
  const out = await ddbClient().send(
    new GetItemCommand({ TableName: 'SmartClubLocal', Key: { pk: { S: pk }, sk: { S: sk } } }),
  );
  return out.Item;
}
async function deleteItem(pk: string, sk: string) {
  const { DeleteItemCommand } = ddbModule();
  await ddbClient().send(
    new DeleteItemCommand({ TableName: 'SmartClubLocal', Key: { pk: { S: pk }, sk: { S: sk } } }),
  );
}
const CAPREPORT_PK = `TENANT#${TENANT}#CAPREPORT`;

/** Sign a squad link exactly as squad-requests.ts does (test-only). */
function signSquad(payload: object): string {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET).update(`squad-link.v1.${p}`).digest('base64url');
  return `${p}.${sig}`;
}

/** Mint the CURRENT link of one side's squad request from its stored recipient id. */
async function mintSquadLink(
  seriesId: string,
  teamId: string,
  over: { e?: number; t?: string; fixtureId?: string } = {},
): Promise<string> {
  const fixtureId = over.fixtureId ?? 'f1';
  const item = await getItem(CAPREPORT_PK, `SQUADREQ#${seriesId}#${fixtureId}#${teamId}`);
  const memberId = item?.recipient?.M?.memberId?.S;
  expect(memberId, `squad request ${seriesId}/${teamId} has a recipient id`).toBeTruthy();
  const expires = item?.linkExpiresAt?.S;
  return signSquad({
    t: over.t ?? TENANT,
    r: memberId,
    q: `${seriesId}~${fixtureId}~${teamId}`,
    e: over.e ?? Math.floor(Date.parse(expires!) / 1000),
  });
}

/** Mint a captain's-report link exactly as captains-reports.ts does (test-only). */
async function mintReportLink(seriesId: string, clubId: string, fixtureId = 'f1') {
  const item = await getItem(CAPREPORT_PK, `CAPREPORT#${seriesId}#${fixtureId}#${clubId}`);
  const memberId = item?.recipient?.M?.memberId?.S;
  expect(memberId, 'the report has a recipient id').toBeTruthy();
  const p = Buffer.from(
    JSON.stringify({
      t: TENANT,
      r: `${seriesId}~${fixtureId}~${clubId}`,
      m: memberId,
      e: Math.floor(Date.parse(item!.linkExpiresAt!.S!) / 1000),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', LINK_SECRET)
    .update(`capreport-link.v1.${p}`)
    .digest('base64url');
  return `${p}.${sig}`;
}

async function pendingSquadSync(seriesId: string, teamId: string, fixtureId = 'f1') {
  const item = await getItem(
    `TENANT#${TENANT}#SYNC`,
    `PENDINGSQUADSYNC#${seriesId}~${fixtureId}~${teamId}`,
  );
  if (!item) return null;
  return {
    op: item.op?.S,
    attempts: Number(item.attempts?.N ?? 0),
    lastError: item.lastError?.S,
  };
}

interface Fx {
  id: string;
  date: string;
  time: string;
  home: string;
  away: string;
}

/** Create + approve + release a series; returns its current version. */
async function seedSeries(
  request: APIRequestContext,
  seriesId: string,
  fixtures: Fx[],
): Promise<number> {
  const clubs = [...new Set(fixtures.flatMap((f) => [f.home, f.away]))];
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: seriesId,
      name: `Squad edges ${seriesId}`,
      startDate: [...fixtures.map((f) => f.date)].sort()[0],
      leagueKey: 'premier',
      teams: clubs,
      participants: clubs.map((c) => ({ teamId: c, clubId: c, name: c })),
      fixtures: fixtures.map((f) => ({ ...f, round: 1 })),
    },
  });
  expect(create.ok(), `POST /series → ${create.status()} ${await create.text()}`).toBeTruthy();
  let version = ((await create.json()) as { version: number }).version;
  for (const patch of [{ approved: true }, { released: true }]) {
    const res = await request.patch(`${API_BASE}/series/${seriesId}`, {
      headers: admin(),
      data: { ...patch, version },
    });
    expect(res.ok(), `PATCH series → ${res.status()} ${await res.text()}`).toBeTruthy();
    version = ((await res.json()) as { version: number }).version;
  }
  return version;
}

interface SyncSummary {
  status: string;
  squads?: { open?: { windowClosed?: true; disabled?: true; opened: number } };
}
async function syncNow(request: APIRequestContext): Promise<SyncSummary> {
  const sync = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
    headers: admin(),
  });
  expect(sync.ok(), `sync-now → ${sync.status()} ${await sync.text()}`).toBeTruthy();
  const summary = (await sync.json()) as SyncSummary;
  test.skip(
    summary.status === 'dry-run',
    'the running stack has no MEDICOACH_SYNC_URL/SECRET (reused without the config env)',
  );
  return summary;
}

interface AdminSquadRow {
  seriesId: string;
  fixtureId: string;
  teamId: string;
  status: string;
  matchDate: string;
  recipient: { kind: string; name: string };
  pushOutcome?: { applied: boolean; reason?: string };
  selection?: { players: Array<{ name: string }> };
}
async function adminRows(request: APIRequestContext, seriesId: string) {
  const res = await request.get(`${API_BASE}/admin/squad-requests`, { headers: admin() });
  expect(res.ok(), `GET /admin/squad-requests → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as AdminSquadRow[]).filter((r) => r.seriesId === seriesId);
}
async function adminRow(request: APIRequestContext, seriesId: string, teamId: string) {
  const row = (await adminRows(request, seriesId)).find((r) => r.teamId === teamId);
  expect(row, `squad request ${seriesId}/${teamId}`).toBeTruthy();
  return row!;
}

interface LinkPayload {
  request: { modified: string; status: string };
  roster: Array<{ id: string; name: string }>;
}
async function loadLink(request: APIRequestContext, token: string) {
  return request.get(`${API_BASE}/squad-link/${token}`);
}
/** Submit (or draft) a squad through the API: the named roster players, no captain. */
async function putSquad(
  request: APIRequestContext,
  token: string,
  names: string[],
  opts: { submit?: boolean; expectedModified?: string } = {},
) {
  const got = await loadLink(request, token);
  expect(got.ok(), `GET squad link → ${got.status()} ${await got.text()}`).toBeTruthy();
  const data = (await got.json()) as LinkPayload;
  const ids = names.map((n) => {
    const e = data.roster.find((r) => r.name === n);
    expect(e, `${n} is on the roster`).toBeTruthy();
    return e!.id;
  });
  return request.put(`${API_BASE}/squad-link/${token}`, {
    headers: { 'content-type': 'application/json' },
    data: {
      players: ids,
      guests: [],
      submit: opts.submit ?? true,
      expectedModified: opts.expectedModified ?? data.request.modified,
    },
  });
}

async function putTenant(request: APIRequestContext, features: Record<string, boolean>) {
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features },
  });
  expect(put.ok(), `PUT tenant → ${put.status()} ${await put.text()}`).toBeTruthy();
}

/** A pulled manual result for a fixture (the captains-report.e2e.ts shape). */
function resultFixture(
  seriesId: string,
  matchDate: string,
  opts: { scoringSide?: 'home' | 'away'; captainRef?: string } = {},
) {
  const recordedAt = new Date().toISOString();
  return {
    ref: fixtureRefOf(seriesId),
    syncStamp: recordedAt,
    schedule: {
      scheduledTime: `${matchDate}T09:00:00+02:00`,
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
      summary: 'Home won by 4 wickets',
      winner: 'home',
      method: 'normal',
      noResult: false,
      source: opts.captainRef ? 'live' : 'manual',
      recordedAt,
      scoringSide: opts.scoringSide ?? null,
      captainRef: opts.captainRef ?? null,
      medicoachMatchUrl: null,
    },
    resultClearedAt: null,
  };
}

async function reportsFor(request: APIRequestContext, seriesId: string) {
  const list = await request.get(`${API_BASE}/captains-reports`, { headers: admin() });
  expect(list.ok()).toBeTruthy();
  return (
    (await list.json()) as Array<{
      seriesId: string;
      clubId: string;
      fixtureId: string;
      recipient: { kind: string; name: string };
    }>
  ).filter((r) => r.seriesId === seriesId);
}

// ───────────────────────── lifecycle ─────────────────────────

let priorFeatures: Record<string, boolean> | undefined;
let priorIntegrations: unknown;
let features: Record<string, boolean> = {};
const LADDER_CLUBS = ['phoenix', 'rhythm', 'spartan', 'tongaat'];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await setReportNoticeWindow(request, 'open');
  await startStub();
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  const body = (await cfg.json()) as { features?: Record<string, boolean>; integrations?: unknown };
  priorFeatures = body.features ?? {};
  priorIntegrations = body.integrations ?? {};
  features = {
    ...priorFeatures,
    medicoachSync: true,
    preMatchSquadLinks: true,
    captainsReports: true,
  };
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features, integrations: { medicoach: { goLiveDate: sastDay(-30) } } },
  });
  expect(put.ok(), `enable squad links → ${put.status()} ${await put.text()}`).toBeTruthy();
});

test.beforeEach(() => {
  pullFixtures = [];
});

test.afterAll(async ({ request }) => {
  await setReportNoticeWindow(request, 'real');
  await stopStub();
  for (const c of LADDER_CLUBS) {
    await deleteItem(CAPREPORT_PK, `TEAMCAPTAIN#${c}#${c}`).catch(() => {});
    await deleteItem(CAPREPORT_PK, `TEAMLASTCAPT#${c}#${c}`).catch(() => {});
  }
  if (!priorFeatures) return;
  await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: priorFeatures, integrations: priorIntegrations },
  });
});

// ───────────────────────── tests ─────────────────────────

test('window gating: outside the 08:00 squad window a sync run opens nothing', async ({
  request,
}) => {
  const S = `s-sqe-win-${RUN}`;
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('08'), home: 'berea', away: 'chatsworth' },
  ]);
  await setReportNoticeWindow(request, 'closed');
  try {
    const summary = await syncNow(request);
    expect(summary.squads?.open?.windowClosed).toBe(true);
    expect(await adminRows(request, S)).toEqual([]);
  } finally {
    await setReportNoticeWindow(request, 'open');
  }
  // The same run inside the window opens both sides — the gate was the only difference.
  await syncNow(request);
  expect((await adminRows(request, S)).map((r) => r.status)).toEqual(['pending', 'pending']);
});

test('expired link: the page shows the closed state and a save is refused (410)', async ({
  browser,
  request,
}) => {
  const S = `s-sqe-exp-${RUN}`;
  await createActivePlayer(request, 'clares', { name: `SqeExp${RUN}` });
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('08'), home: 'clares', away: 'harlequins' },
  ]);
  await syncNow(request);
  const live = await mintSquadLink(S, 'clares');
  const roster = ((await (await loadLink(request, live)).json()) as LinkPayload).roster;
  const modified = ((await (await loadLink(request, live)).json()) as LinkPayload).request.modified;

  const expired = await mintSquadLink(S, 'clares', { e: Math.floor(Date.now() / 1000) - 60 });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/sq/${expired}`);
  await expect(p.getByText('This squad link is closed')).toBeVisible();
  await expect(p.getByText('This squad link has expired.')).toBeVisible();
  await ctx.close();

  const put = await request.put(`${API_BASE}/squad-link/${expired}`, {
    headers: { 'content-type': 'application/json' },
    data: { players: [roster[0]!.id], guests: [], submit: true, expectedModified: modified },
  });
  expect(put.status()).toBe(410);
  // Nothing was written by the refused save.
  expect((await adminRow(request, S, 'clares')).status).toBe('pending');
});

test('fixture rescheduled after send: link 410s and voids, the sweep pushes §8 void; moved back, the sweep self-heals the same links', async ({
  browser,
  request,
}) => {
  const S = `s-sqe-move-${RUN}`;
  const H = `SqeMvH${RUN}`;
  const A = `SqeMvA${RUN}`;
  await createActivePlayer(request, 'ilembe', { name: H });
  await createActivePlayer(request, 'verulam', { name: A });
  const fx = { id: 'f1', date: TOMORROW, time: at('08'), home: 'ilembe', away: 'verulam' };
  let version = await seedSeries(request, S, [fx]);
  await syncNow(request);
  const homeToken = await mintSquadLink(S, 'ilembe');
  const awayToken = await mintSquadLink(S, 'verulam');
  for (const [t, n] of [
    [homeToken, H],
    [awayToken, A],
  ] as const) {
    const put = await putSquad(request, t, [`Test ${n}`]);
    expect(put.ok(), `submit → ${put.status()} ${await put.text()}`).toBeTruthy();
  }
  await expect.poll(() => pushesFor(S).filter((p) => p.op === 'upsert').length).toBe(2);

  // Move the fixture two days out.
  const move = async (date: string) => {
    const res = await request.patch(`${API_BASE}/series/${S}`, {
      headers: admin(),
      data: { fixtures: [{ ...fx, round: 1, date }], version },
    });
    expect(res.ok(), `move fixture → ${res.status()} ${await res.text()}`).toBeTruthy();
    version = ((await res.json()) as { version: number }).version;
  };
  await move(sastDay(2));

  // (a) The home link: 410 "fixture changed", and the request is voided by the load.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/sq/${homeToken}`);
  await expect(p.getByText('This squad link is closed')).toBeVisible();
  await expect(p.getByText(/Fixture changed — this squad link is no longer valid/)).toBeVisible();
  await ctx.close();
  expect((await adminRow(request, S, 'ilembe')).status).toBe('void');
  // The away side was not loaded: only the sync run's sweep can void it.
  expect((await adminRow(request, S, 'verulam')).status).toBe('submitted');

  // (b) The sync run voids the away side and pushes §8 void for BOTH (no names on a void).
  await syncNow(request);
  expect((await adminRow(request, S, 'verulam')).status).toBe('void');
  const voids = pushesFor(S).filter((x) => x.op === 'void');
  expect(voids.map((v) => v.side).sort()).toEqual(['away', 'home']);
  for (const v of voids) expect(v.players).toEqual([]);
  expect(await pendingSquadSync(S, 'ilembe')).toBeNull();
  expect(await pendingSquadSync(S, 'verulam')).toBeNull();

  // (c) The fixture lands back on its ORIGINAL date: the sync run's sweep self-heals both
  // requests in place (same recipient ids, selection kept, no re-notice) — the links already
  // sent work again — and re-pushes each submitted squad as a §8 upsert over the void.
  const upsertsBefore = pushesFor(S).filter((x) => x.op === 'upsert').length;
  await move(TOMORROW);
  await syncNow(request);
  const rows = await adminRows(request, S);
  expect(rows.map((r) => `${r.teamId}:${r.status}`).sort()).toEqual([
    'ilembe:submitted',
    'verulam:submitted',
  ]);
  expect(rows.every((r) => !!r.selection)).toBe(true);
  const healed = await loadLink(request, homeToken);
  expect(healed.ok(), `healed link → ${healed.status()}`).toBeTruthy();
  expect(((await healed.json()) as LinkPayload).request.status).toBe('submitted');
  await expect
    .poll(() => pushesFor(S).filter((x) => x.op === 'upsert').length)
    .toBe(upsertsBefore + 2);
});

test('recipient ladder: designated → last captain (learned from a captain’s report) → chair; a minor designee falls through', async ({
  request,
}) => {
  const designee = await createActivePlayer(request, 'phoenix', { name: `SqeDes${RUN}` });
  const last = await createActivePlayer(request, 'rhythm', { name: `SqeLast${RUN}` });

  // Opaque candidate id by (run-unique) name: the picker never sees a natural key.
  const candidateId = async (clubId: string, nameToken: string) => {
    const res = await request.get(
      `${API_BASE}/clubs/${clubId}/teams/${clubId}/captain-candidates`,
      {
        headers: apiHeaders(repAuthHeader(clubId)),
      },
    );
    expect(res.ok(), `candidates → ${res.status()}`).toBeTruthy();
    const text = await res.text();
    const body = JSON.parse(text) as { candidates: Array<{ id: string; name: string }> };
    const hit = body.candidates.find((c) => c.name.includes(nameToken));
    expect(hit, `candidate ${nameToken} at ${clubId}`).toBeTruthy();
    return { id: hit!.id, text };
  };

  // Designate phoenix's captain through the portal API (the club's own rep).
  const desCand = await candidateId('phoenix', `SqeDes${RUN}`);
  expect(desCand.text).not.toContain(designee.naturalKey);
  const des = await request.put(`${API_BASE}/clubs/phoenix/teams/phoenix/captain`, {
    headers: apiHeaders(repAuthHeader('phoenix')),
    data: { candidateId: desCand.id },
  });
  expect(des.ok(), `designate → ${des.status()} ${await des.text()}`).toBeTruthy();

  // A minor designee at spartan (POPIA: never a recipient) → falls through to the chair.
  const minorRes = await request.post(`${API_BASE}/clubs/spartan/players`, {
    headers: admin(),
    data: {
      firstName: 'Test',
      lastName: `SqeMinor${RUN}`,
      idType: 'passport',
      idNumber: `MN${RUN}`.toUpperCase().slice(0, 14),
      dob: '2013-06-15',
      race: 'African',
      gender: 'Male',
      nationality: 'Zimbabwean',
      cell: '0821234567',
      guardianName: 'G Guardian',
      guardianCell: '0821234568',
      guardianConsent: true,
      team: 'premier',
      district: 'Durban Central',
      idDocMeta: {
        objectKey: `local/${TENANT}/minor-${RUN}.png`,
        size: 100,
        contentType: 'image/png',
      },
    },
  });
  expect(minorRes.ok(), `minor → ${minorRes.status()} ${await minorRes.text()}`).toBeTruthy();
  const minor = (await minorRes.json()) as { naturalKey: string; isMinor?: boolean };
  expect(minor.isMinor).toBe(true);
  const desMinor = await request.put(`${API_BASE}/clubs/spartan/teams/spartan/captain`, {
    headers: apiHeaders(repAuthHeader('spartan')),
    data: { candidateId: (await candidateId('spartan', `SqeMinor${RUN}`)).id },
  });
  expect(desMinor.ok(), `designate minor → ${desMinor.status()}`).toBeTruthy();

  // rhythm learns its last captain from yesterday's captain's report (scoring side's captain).
  const LR = `s-sqe-lastcap-${RUN}`;
  await seedSeries(request, LR, [
    { id: 'f1', date: YESTERDAY, time: at('10'), home: 'rhythm', away: 'umlazi' },
  ]);
  pullFixtures = [
    resultFixture(LR, YESTERDAY, {
      scoringSide: 'home',
      captainRef: `smartclub:${TENANT}:player:${last.naturalKey}`,
    }),
  ];
  await syncNow(request);
  pullFixtures = [];
  const rhythmReport = (await reportsFor(request, LR)).find((r) => r.clubId === 'rhythm');
  expect(rhythmReport?.recipient).toMatchObject({ kind: 'captain', name: `Test SqeLast${RUN}` });

  // Tomorrow: phoenix v rhythm, spartan v tongaat.
  const S = `s-sqe-ladder-${RUN}`;
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('10'), home: 'phoenix', away: 'rhythm' },
    { id: 'f2', date: TOMORROW, time: at('10'), home: 'spartan', away: 'tongaat' },
  ]);
  await syncNow(request);
  const rows = await adminRows(request, S);
  const by = (t: string) => rows.find((r) => r.teamId === t)?.recipient;
  expect(by('phoenix')).toMatchObject({ kind: 'captain', name: `Test SqeDes${RUN}` });
  expect(by('rhythm')).toMatchObject({ kind: 'captain', name: `Test SqeLast${RUN}` });
  expect(by('spartan')?.kind).toBe('chair');
  expect(by('tongaat')?.kind).toBe('chair');
});

test('kill switch: captainsReports off stops report opens but not squad links; an issued report link still loads', async ({
  request,
}) => {
  // Flag on: a fixture played today opens its match-day reports.
  const K1 = `s-sqe-k1-${RUN}`;
  await seedSeries(request, K1, [
    { id: 'f1', date: TODAY, time: at('09'), home: 'harlequins', away: 'ilembe' },
  ]);
  await syncNow(request);
  expect((await reportsFor(request, K1)).length).toBe(2);
  const issued = await mintReportLink(K1, 'harlequins');

  // The EMCU combination: captainsReports OFF, preMatchSquadLinks ON.
  await putTenant(request, { ...features, captainsReports: false });
  try {
    const K2 = `s-sqe-k2-${RUN}`;
    await seedSeries(request, K2, [
      { id: 'f1', date: YESTERDAY, time: at('09'), home: 'verulam', away: 'warriors' },
      { id: 'f2', date: TODAY, time: at('11'), home: 'verulam', away: 'warriors' },
    ]);
    const K3 = `s-sqe-k3-${RUN}`;
    await seedSeries(request, K3, [
      { id: 'f1', date: TOMORROW, time: at('08'), home: 'umlazi', away: 'warriors' },
    ]);
    pullFixtures = [resultFixture(K2, YESTERDAY)];
    await syncNow(request);
    pullFixtures = [];
    // Neither the pulled result nor the match-day trigger opened a report.
    expect(await reportsFor(request, K2)).toEqual([]);
    // Squad links are independent of the report switch.
    expect((await adminRows(request, K3)).map((r) => `${r.teamId}:${r.status}`).sort()).toEqual([
      'umlazi:pending',
      'warriors:pending',
    ]);
    // A report link issued while the switch was on still loads.
    const res = await request.get(`${API_BASE}/captains-report-link/${issued}`);
    expect(res.status(), await res.text()).toBe(200);
  } finally {
    await putTenant(request, features);
  }
});

test('medicoach down: the submit still succeeds, the outbox keeps the push, the next sync delivers it', async ({
  browser,
  request,
}) => {
  const S = `s-sqe-down-${RUN}`;
  const N = `SqeDown${RUN}`;
  await createActivePlayer(request, 'berea', { name: N });
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('11'), home: 'berea', away: 'chatsworth' },
  ]);
  await syncNow(request);
  const token = await mintSquadLink(S, 'berea');

  await stopStub();
  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`/sq/${token}`);
    await p.getByRole('searchbox', { name: 'Search players' }).fill(N);
    await p.getByRole('checkbox', { name: `Test ${N}` }).check();
    await p.getByRole('button', { name: 'Submit squad' }).click();
    // The immediate push failed, but the submit did not.
    await expect(p.getByLabel('Submitted squad').getByText('Squad submitted')).toBeVisible();
    await ctx.close();

    const row = await adminRow(request, S, 'berea');
    expect(row.status).toBe('submitted');
    expect(row.pushOutcome).toBeUndefined();
    const pending = await pendingSquadSync(S, 'berea');
    expect(pending).toMatchObject({ op: 'upsert', attempts: 1 });
    expect(pending?.lastError).toMatch(/unreachable/);

    // A cron run while medicoach is still down: the pull fails the run (502), the squad
    // flush still ran first and counted another attempt; the row is kept.
    const down = await request.post(`${API_BASE}/integrations/medicoach/sync-now`, {
      headers: admin(),
    });
    expect(down.status()).toBe(502);
    expect(await pendingSquadSync(S, 'berea')).toMatchObject({ op: 'upsert', attempts: 2 });
  } finally {
    await startStub();
  }

  await syncNow(request);
  const sent = pushesFor(S, 'home');
  expect(sent.map((x) => x.op)).toEqual(['upsert']);
  expect(sent[0]!.players.map((x) => x.name)).toEqual([`Test ${N}`]);
  expect((await adminRow(request, S, 'berea')).pushOutcome).toMatchObject({ applied: true });
  expect(await pendingSquadSync(S, 'berea')).toBeNull();
});

test('fixture-unmapped is retried, not dropped; persistently unmapped gives up after the cap', async ({
  request,
}) => {
  const S = `s-sqe-unmap-${RUN}`;
  const H = `SqeUnH${RUN}`;
  const A = `SqeUnA${RUN}`;
  await createActivePlayer(request, 'clares', { name: H });
  await createActivePlayer(request, 'harlequins', { name: A });
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('11'), home: 'clares', away: 'harlequins' },
  ]);
  await syncNow(request);
  const ref = fixtureRefOf(S);
  // Home: unmapped twice (the submit-time flush + one sync), then applied.
  scripts.set(pushKey(ref, 'home'), { queue: ['unmapped', 'unmapped'] });
  // Away: unmapped forever.
  scripts.set(pushKey(ref, 'away'), { queue: [], always: 'unmapped' });

  expect((await putSquad(request, await mintSquadLink(S, 'clares'), [`Test ${H}`])).ok()).toBe(
    true,
  );
  expect((await putSquad(request, await mintSquadLink(S, 'harlequins'), [`Test ${A}`])).ok()).toBe(
    true,
  );
  expect((await adminRow(request, S, 'clares')).pushOutcome).toMatchObject({
    applied: false,
    reason: 'fixture-unmapped',
  });
  expect(await pendingSquadSync(S, 'clares')).toMatchObject({ attempts: 1 });

  await syncNow(request);
  expect(await pendingSquadSync(S, 'clares')).toMatchObject({ attempts: 2 });
  await syncNow(request);
  expect(await pendingSquadSync(S, 'clares')).toBeNull();
  expect((await adminRow(request, S, 'clares')).pushOutcome).toMatchObject({ applied: true });
  expect(pushesFor(S, 'home').length).toBe(3);

  // Away keeps being retried until the cap, then the row drops as gave-up.
  for (let i = 0; i < SQUAD_PUSH_MAX_ATTEMPTS + 2; i++) {
    if (!(await pendingSquadSync(S, 'harlequins'))) break;
    await syncNow(request);
  }
  expect(await pendingSquadSync(S, 'harlequins')).toBeNull();
  expect((await adminRow(request, S, 'harlequins')).pushOutcome).toMatchObject({
    applied: false,
    reason: 'gave-up',
  });
  expect(pushesFor(S, 'away').length).toBe(SQUAD_PUSH_MAX_ATTEMPTS);
  // The squad itself is untouched by a give-up.
  expect((await adminRow(request, S, 'harlequins')).status).toBe('submitted');
});

test('CAS through the UI: a stale tab gets the reload message and can then edit the latest', async ({
  browser,
  request,
}) => {
  const S = `s-sqe-cas-${RUN}`;
  const P1 = `SqeCas1${RUN}`;
  const P2 = `SqeCas2${RUN}`;
  for (const n of [P1, P2]) await createActivePlayer(request, 'ilembe', { name: n });
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('13'), home: 'ilembe', away: 'verulam' },
  ]);
  await syncNow(request);
  const token = await mintSquadLink(S, 'ilembe');
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await a.goto(`/sq/${token}`);
  await b.goto(`/sq/${token}`);
  await expect(b.getByRole('button', { name: 'Save draft' })).toBeVisible();

  await a.getByRole('searchbox', { name: 'Search players' }).fill(P1);
  await a.getByRole('checkbox', { name: `Test ${P1}` }).check();
  await a.getByRole('button', { name: 'Submit squad' }).click();
  await expect(a.getByLabel('Submitted squad').getByText(`Test ${P1}`)).toBeVisible();

  // Tab B still holds the pre-submit `modified`.
  await b.getByRole('searchbox', { name: 'Search players' }).fill(P2);
  await b.getByRole('checkbox', { name: `Test ${P2}` }).check();
  await b.getByRole('button', { name: 'Save draft' }).click();
  await expect(b.getByRole('alert')).toContainText('changed somewhere else');
  // B reloaded the latest: A's submitted squad, not its own lost draft.
  const done = b.getByLabel('Submitted squad');
  await expect(done.getByText(`Test ${P1}`)).toBeVisible();
  await expect(done.getByText(`Test ${P2}`)).toHaveCount(0);

  await b.getByRole('button', { name: 'Edit squad' }).click();
  await b.getByRole('searchbox', { name: 'Search players' }).fill(P2);
  await b.getByRole('checkbox', { name: `Test ${P2}` }).check();
  await b.getByRole('button', { name: 'Submit squad' }).click();
  await expect(b.getByLabel('Submitted squad').getByText(`Test ${P2}`)).toBeVisible();
  await ctx.close();
  const row = await adminRow(request, S, 'ilembe');
  expect(row.selection?.players.map((x) => x.name).sort()).toEqual([`Test ${P1}`, `Test ${P2}`]);
});

test('double submit with the same expectedModified: the replay is 409 and medicoach gets one squad', async ({
  request,
}) => {
  const S = `s-sqe-dbl-${RUN}`;
  const N = `SqeDbl${RUN}`;
  await createActivePlayer(request, 'umlazi', { name: N });
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('13'), home: 'umlazi', away: 'warriors' },
  ]);
  await syncNow(request);
  const token = await mintSquadLink(S, 'umlazi');
  const data = (await (await loadLink(request, token)).json()) as LinkPayload;
  const first = await putSquad(request, token, [`Test ${N}`], {
    expectedModified: data.request.modified,
  });
  expect(first.ok()).toBeTruthy();
  const replay = await putSquad(request, token, [`Test ${N}`], {
    expectedModified: data.request.modified,
  });
  expect(replay.status()).toBe(409);
  await syncNow(request);
  const sent = pushesFor(S, 'home');
  expect(sent.length).toBe(1);
  expect(sent[0]!.op).toBe('upsert');
});

test('isolation: a token for another tenant or request does not load; another club’s rep cannot designate', async ({
  request,
}) => {
  const S = `s-sqe-iso-${RUN}`;
  await seedSeries(request, S, [
    { id: 'f1', date: TOMORROW, time: at('14'), home: 'berea', away: 'chatsworth' },
  ]);
  await syncNow(request);
  // Same request + recipient id, signed for another tenant → not found there.
  const other = await mintSquadLink(S, 'berea', { t: 'kzncu' });
  expect((await loadLink(request, other)).status()).toBe(404);
  // berea's recipient id aimed at chatsworth's request → refused (410), not loaded.
  const bereaItem = await getItem(CAPREPORT_PK, `SQUADREQ#${S}#f1#berea`);
  const crossed = signSquad({
    t: TENANT,
    r: bereaItem!.recipient!.M!.memberId!.S,
    q: `${S}~f1~chatsworth`,
    e: Math.floor(Date.now() / 1000) + 3600,
  });
  expect((await loadLink(request, crossed)).status()).toBe(410);
  // A tampered signature is 404.
  const good = await mintSquadLink(S, 'berea');
  expect((await loadLink(request, `${good.slice(0, -2)}xx`)).status()).toBe(404);

  // Designation: another club's rep is 403 (read and write); a team the club doesn't own is 404.
  const asBerea = apiHeaders(repAuthHeader('berea'));
  expect(
    (
      await request.get(`${API_BASE}/clubs/phoenix/teams/phoenix/captain`, { headers: asBerea })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.put(`${API_BASE}/clubs/phoenix/teams/phoenix/captain`, {
        headers: asBerea,
        data: { candidateId: null },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.put(`${API_BASE}/clubs/berea/teams/chatsworth/captain`, {
        headers: asBerea,
        data: { candidateId: null },
      })
    ).status(),
  ).toBe(404);
});
