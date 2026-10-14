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
 * Match monitor (admin → Medicoach sync → Action board / Every game): failure modes and edge
 * cases, driven through the REAL UI against a STUB medicoach.
 *
 * The stub listens on :4799 with the suite's sync secret (playwright.config.ts points the
 * stack's MEDICOACH_SYNC_URL/SECRET at it) and answers the signed `GET /live` for this run's
 * own released series, one live match per fixture. Each test flips the stub (`mode`) to
 * arrange a scenario: a malformed match, a wrong signing secret, the stub down altogether.
 *
 * The API caches a GOOD day's answer for 15 s (RESPONSE_TTL_MS) and never a failure, so a
 * change at the stub shows on the page within one cache window: the spec clicks Refresh until
 * it does, never sleeps for it. The one deliberate wait is the polling check (a 30 s poll can
 * only be proven by watching for one).
 *
 * Dry run: when the running stack has no sync URL/secret, the route answers `dryRun: true`.
 * That test runs ONLY against such a stack (start it with MEDICOACH_SYNC_URL= ) and every
 * other test skips there, so one spec covers both boots.
 */

const STUB_PORT = 4799;
const SYNC_SECRET = 'e2e-medicoach-sync-secret';
const SERIES_ID = `s-e2e-mmfail-${RUN}`;
const SERIES_NAME = `Monitor failures E2E ${RUN}`;
const MIN = 60_000;

const admin = () => apiHeaders(adminAuthHeader());
const operator = () => apiHeaders(operatorAuth());

/* ── The day's fixtures, placed around now (SAST) ── */
const SAST = 2 * 60 * MIN;
const NOW = Date.now();
const TODAY = new Date(NOW + SAST).toISOString().slice(0, 10);
const shiftDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const YESTERDAY = shiftDay(TODAY, -1);
const TOMORROW = shiftDay(TODAY, 1);
/** "HH:MM" SAST `offsetMin` from now, clamped inside today so the game stays on TODAY. */
function todayAt(offsetMin: number): string {
  const sastMinOfDay = Math.floor(((NOW + SAST) % 86_400_000) / MIN);
  const m = Math.max(5, Math.min(23 * 60 + 55, sastMinOfDay + offsetMin));
  const r = m - (m % 5);
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}

type Kind =
  | 'finished'
  | 'quiet'
  | 'break'
  | 'abandoned'
  | 'late-not-started'
  | 'upcoming'
  | 'yesterday'
  | 'tomorrow';
interface Fx {
  id: string;
  kind: Kind;
  home: string;
  away: string;
  homeName: string;
  awayName: string;
  date: string;
  time: string;
}
let FIXTURES: Fx[] = [];
const fx = (k: Kind) => FIXTURES.find((f) => f.kind === k)!;
/** fixtureSyncRef for a fixture with no stored syncRef (fixture-identity.ts). */
const ref = (f: Fx) => `smartclub:${TENANT}:fixture:${SERIES_ID}:${f.id}`;
const gameLabel = (f: Fx) => `${f.homeName} v ${f.awayName}`;

/** A registered player (created in beforeAll) and the club they are registered at. */
let registered: { clubId: string; naturalKey: string; name: string };

/* ── The stub ── */
let stub: Server | null = null;
let mode: { badMatch: boolean; wrongSecret: boolean } = { badMatch: false, wrongSecret: false };
/** Every /live request the stub received, by date (proves polling / no fetches). */
const liveCalls: string[] = [];

const iso = (ms: number) => new Date(ms).toISOString();
const player = (
  side: 'home' | 'away',
  name: string,
  extra: Partial<{ ref: string | null; addedDuringMatch: boolean; addedAt: string | null }> = {},
) => ({ side, name, ref: null, addedDuringMatch: false, addedAt: null, ...extra });
const inn = (
  n: number,
  side: 'home' | 'away',
  runs: number,
  start: number,
  end: number | null,
) => ({
  number: n,
  battingSide: side,
  runs,
  wickets: 4,
  overs: end ? '20.0' : '11.2',
  startedAt: iso(start),
  endedAt: end ? iso(end) : null,
});

function liveFor(f: Fx, now: number) {
  const base = {
    ref: ref(f),
    oversPerSide: 20,
    deliveries: 120,
    medianGapSec: 35,
    longGaps: [] as unknown[],
    medicoachMatchUrl: null,
    players: [] as unknown[],
  };
  switch (f.kind) {
    case 'finished':
    case 'yesterday':
      return {
        ...base,
        status: 'completed',
        startedAt: iso(now - 240 * MIN),
        endedAt: iso(now - 30 * MIN),
        lastInputAt: iso(now - 30 * MIN),
        innings: [
          inn(1, 'home', 151, now - 240 * MIN, now - 150 * MIN),
          inn(2, 'away', 140, now - 125 * MIN, now - 30 * MIN),
        ],
        undoCount: 7,
        undoCountExact: true,
        // A malformed match (a name over 120 chars) fails the contract and is left out.
        ...(mode.badMatch && f.kind === 'finished'
          ? { players: [player('home', 'X'.repeat(121))] }
          : {}),
      };
    case 'quiet':
      return {
        ...base,
        status: 'in_progress',
        startedAt: iso(now - 60 * MIN),
        endedAt: null,
        lastInputAt: iso(now - 12 * MIN),
        innings: [inn(1, 'home', 88, now - 60 * MIN, null)],
        undoCount: 6,
        undoCountExact: false,
        players: [
          player('home', registered.name, {
            ref: `smartclub:${TENANT}:player:${registered.naturalKey}`,
            addedDuringMatch: true,
            addedAt: iso(now - 40 * MIN),
          }),
        ],
      };
    case 'break':
      return {
        ...base,
        status: 'innings_break',
        startedAt: iso(now - 100 * MIN),
        endedAt: null,
        lastInputAt: iso(now - 5 * MIN),
        innings: [inn(1, 'away', 162, now - 100 * MIN, now - 5 * MIN)],
        undoCount: null,
        undoCountExact: null,
        players: [
          player('away', `Zed Unknown ${RUN}`, {
            addedDuringMatch: true,
            addedAt: iso(now - 50 * MIN),
          }),
        ],
      };
    case 'abandoned':
      return {
        ...base,
        status: 'abandoned',
        startedAt: iso(now - 90 * MIN),
        endedAt: iso(now - 20 * MIN),
        lastInputAt: iso(now - 20 * MIN),
        innings: [inn(1, 'home', 40, now - 90 * MIN, null)],
        undoCount: 0,
        undoCountExact: true,
      };
    case 'late-not-started':
    case 'upcoming':
    case 'tomorrow':
      return {
        ...base,
        status: 'not_started',
        startedAt: null,
        endedAt: null,
        lastInputAt: null,
        innings: [],
        deliveries: 0,
        medianGapSec: null,
        undoCount: 0,
        undoCountExact: true,
      };
  }
}

function startStub(): Promise<void> {
  const server = createServer((req, res) => {
    const check = verifySignature({
      secret: mode.wrongSecret ? 'not-the-shared-secret' : SYNC_SECRET,
      method: req.method ?? 'GET',
      pathAndQuery: req.url ?? '',
      body: '',
      timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
      signatureHeader: req.headers['x-sync-signature'] as string | undefined,
    });
    const url = new URL(req.url ?? '/', 'http://stub');
    const date = url.searchParams.get('date') ?? '';
    if (url.pathname === '/integrations/smartclub/live') liveCalls.push(date);
    if (!check.ok) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad signature"}');
      return;
    }
    if (url.pathname !== '/integrations/smartclub/live') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const now = Date.now();
    const matches = FIXTURES.filter((f) => f.date === date).map((f) => liveFor(f, now));
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ version: 1, tenant: TENANT, date, generatedAt: iso(now), matches }));
  });
  stub = server;
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve()));
}
async function stopStub() {
  const s = stub;
  stub = null;
  if (!s) return;
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
}

/* ── Seeding ── */
/** A valid-format (Luhn) RSA ID for a fictional adult, unique enough per run. */
function idNumber(): string {
  const seq = Math.floor(Math.random() * 4999);
  const body = `9${(seq % 9) + 1}0${(seq % 9) + 1}1${(seq % 9) + 1}${String(5000 + seq).padStart(4, '0')}08`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let d = Number(body[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

async function seedPlayer(request: APIRequestContext, clubId: string) {
  const firstName = 'Regina';
  const lastName = `Addedplayer${RUN.replace(/[^a-z]/g, '')}`;
  const res = await request.post(`${API_BASE}/clubs/${clubId}/players`, {
    headers: admin(),
    data: {
      firstName,
      lastName,
      idNumber: idNumber(),
      race: 'Prefer not to say',
      gender: 'Female',
      nationality: 'South African',
      cell: '0600000999',
      team: 'premier',
      district: 'Demo',
    },
  });
  expect(res.ok(), `POST player → ${res.status()} ${await res.text()}`).toBeTruthy();
  const rows = (await (
    await request.get(`${API_BASE}/clubs/${clubId}/players`, { headers: admin() })
  ).json()) as Array<{ naturalKey: string; firstName: string; lastName: string; status?: string }>;
  const row = rows.find((r) => r.firstName === firstName && r.lastName === lastName)!;
  expect(row, 'seeded player is on the roster').toBeTruthy();
  registered = { clubId, naturalKey: row.naturalKey, name: `${firstName} ${lastName}` };
}

async function seedSeries(request: APIRequestContext) {
  const clubs = (
    (await (await request.get(`${API_BASE}/clubs`, { headers: admin() })).json()) as Array<{
      id: string;
    }>
  )
    .map((c) => c.id)
    .sort();
  expect(clubs.length, 'the demo seed has at least 12 clubs').toBeGreaterThanOrEqual(12);
  const plan: Array<[Kind, string, string]> = [
    ['finished', TODAY, todayAt(-240)],
    ['quiet', TODAY, todayAt(-65)],
    ['break', TODAY, todayAt(-100)],
    ['abandoned', TODAY, todayAt(-90)],
    ['late-not-started', TODAY, todayAt(-40)],
    ['upcoming', TODAY, todayAt(90)],
    ['yesterday', YESTERDAY, '14:00'],
    ['tomorrow', TOMORROW, '10:00'],
  ];
  FIXTURES = plan.map(([kind, date, time], i) => {
    // Today's six games use twelve distinct clubs; the other days reuse the first pairs.
    const j = (i % 6) * 2;
    return {
      id: `f${i + 1}`,
      kind,
      home: clubs[j],
      away: clubs[j + 1],
      homeName: `${kind} H ${RUN}`,
      awayName: `${kind} A ${RUN}`,
      date,
      time,
    };
  });
  // The registered player plays for the quiet game's home club.
  await seedPlayer(request, fx('quiet').home);

  const teamOf = (f: Fx, side: 'home' | 'away') => `${f.id}-${side}`;
  const create = await request.post(`${API_BASE}/series`, {
    headers: admin(),
    data: {
      id: SERIES_ID,
      name: SERIES_NAME,
      startDate: YESTERDAY,
      leagueKey: 'premier',
      teams: FIXTURES.flatMap((f) => [teamOf(f, 'home'), teamOf(f, 'away')]),
      participants: FIXTURES.flatMap((f) => [
        { teamId: teamOf(f, 'home'), clubId: f.home, name: f.homeName },
        { teamId: teamOf(f, 'away'), clubId: f.away, name: f.awayName },
      ]),
      fixtures: FIXTURES.map((f, i) => ({
        id: f.id,
        round: i + 1,
        date: f.date,
        time: f.time,
        home: teamOf(f, 'home'),
        away: teamOf(f, 'away'),
        venueOverride: `E2E monitor ground ${RUN} ${f.id}`,
      })),
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

/* ── Page helpers ── */
async function openMonitor(page: Page, tab: 'Action board' | 'Every game') {
  await signInAsAdmin(page);
  await page.locator('aside.nav .nav-item', { hasText: 'Medicoach sync' }).click();
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
  await expect(page.getByTestId('match-monitor')).toBeVisible();
}
const gameRow = (page: Page, f: Fx) =>
  page.getByRole('table', { name: 'Games' }).locator('tr', {
    has: page.getByRole('button', { name: `${gameLabel(f)}: open the match timeline` }),
  });
/** Click Refresh until `check` passes: the API's 15 s good-answer cache can hide a change. */
async function refreshUntil(page: Page, check: () => Promise<void>, timeout = 45_000) {
  await expect(async () => {
    const btn = page.getByRole('button', { name: 'Refresh', exact: true });
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(btn).toBeEnabled();
    await check();
  }).toPass({ timeout, intervals: [2_000, 3_000, 5_000] });
}

let dryRun = false;
let priorFeatures: Record<string, boolean> | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const cfg = await request.get(`${API_BASE}/platform/tenants/${TENANT}`, { headers: operator() });
  expect(cfg.ok()).toBeTruthy();
  priorFeatures = ((await cfg.json()) as { features?: Record<string, boolean> }).features ?? {};
  const put = await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
    headers: operator(),
    data: { features: { ...priorFeatures, medicoachSync: true } },
  });
  expect(put.ok(), `enable sync → ${put.status()} ${await put.text()}`).toBeTruthy();
  await startStub();
  await seedSeries(request);
  const probe = await request.get(`${API_BASE}/integrations/medicoach/live?date=${TODAY}`, {
    headers: admin(),
  });
  expect(probe.ok(), `GET live → ${probe.status()}`).toBeTruthy();
  dryRun = ((await probe.json()) as { dryRun: boolean }).dryRun;
});

test.afterAll(async ({ request }) => {
  await stopStub();
  if (priorFeatures)
    await request.put(`${API_BASE}/platform/tenants/${TENANT}`, {
      headers: operator(),
      data: { features: priorFeatures },
    });
});

test.beforeEach(async () => {
  mode = { badMatch: false, wrongSecret: false };
  if (!stub) await startStub();
});

const needsLive = () =>
  test.skip(dryRun, 'the running stack has no MEDICOACH_SYNC_URL/SECRET (dry run)');

test('Every game: statuses, approximate undo, added players and the day summary', async ({
  page,
}) => {
  needsLive();
  await openMonitor(page, 'Every game');
  const pill = (f: Fx) => gameRow(page, f).locator('td[data-label="Score now"]');
  const scorer = (f: Fx) => gameRow(page, f).locator('td[data-label="Scorer"]');
  const flagsCell = (f: Fx) => gameRow(page, f).locator('td[data-label="Flags"]');

  // Edge statuses → their badge.
  await expect(pill(fx('finished'))).toContainText('Finished');
  await expect(pill(fx('quiet'))).toContainText('Live');
  await expect(pill(fx('break'))).toContainText('Innings break');
  await expect(pill(fx('abandoned'))).toContainText('Abandoned');
  await expect(pill(fx('late-not-started'))).toContainText('Awaiting start');
  await expect(flagsCell(fx('late-not-started'))).toContainText(/Not started · \d+ min past start/);
  await expect(pill(fx('upcoming'))).toContainText('Upcoming');
  await expect(flagsCell(fx('upcoming'))).toHaveText('—');

  // Undo: exact "7", approximate "~6", not reported "Undo —" (and no undo flag for it).
  await expect(scorer(fx('finished'))).toContainText('7 undos');
  await expect(scorer(fx('quiet'))).toContainText('~6 undos');
  await expect(scorer(fx('break'))).toContainText('Undo —');
  await expect(flagsCell(fx('finished'))).toContainText('Undo used 7 times');
  await expect(flagsCell(fx('quiet'))).toContainText('Undo used ~6 times');
  await expect(flagsCell(fx('break'))).not.toContainText('Undo used');

  // Added players: registered (warn only) vs unregistered (alert too).
  await expect(scorer(fx('quiet'))).toContainText('1 added');
  await expect(scorer(fx('quiet'))).not.toContainText('unregistered');
  await expect(scorer(fx('break'))).toContainText('1 added · 1 unregistered');
  await expect(flagsCell(fx('quiet'))).not.toContainText('not registered to play');
  await expect(flagsCell(fx('break'))).toContainText(
    `Zed Unknown ${RUN} is not registered to play`,
  );

  // The day summary: any approximate count makes the total approximate (7 + ~6 + 0 = ~13).
  const kpis = page.getByTestId('mm-kpis');
  await expect(kpis).toContainText('~13 undos');
  await expect(kpis).toContainText('1 unregistered player');

  // The action board shows the same split: Act now for unregistered, Watch for the registered add.
  await page.getByRole('tab', { name: /^Action board/ }).click();
  const quietAdded = page.locator('.mm-flagcard[data-flag="added"]', {
    hasText: gameLabel(fx('quiet')),
  });
  await expect(quietAdded).toContainText('Watch · Players added');
  await expect(quietAdded).toContainText(`${registered.name} (${fx('quiet').homeName})`);
  await expect(quietAdded).toContainText('— registered');
  const unreg = page.locator('.mm-flagcard[data-flag="unregistered"]', {
    hasText: gameLabel(fx('break')),
  });
  await expect(unreg).toContainText('Act now · Not registered');
  const breakAdded = page.locator('.mm-flagcard[data-flag="added"]', {
    hasText: gameLabel(fx('break')),
  });
  await expect(breakAdded).toContainText('NOT registered');
  await expect(
    page.locator('.mm-flagcard[data-flag="undo"]', { hasText: gameLabel(fx('quiet')) }),
  ).toContainText('Undo used ~6 times');
  await expect(
    page.locator('.mm-flagcard[data-flag="undo"]', { hasText: gameLabel(fx('finished')) }),
  ).toContainText('Undo used 7 times');
  await expect(
    page.locator('.mm-flagcard[data-flag="undo"]', { hasText: gameLabel(fx('break')) }),
  ).toHaveCount(0);
});

test('a flag threshold hides and restores a flag, and persists across a reload', async ({
  page,
}) => {
  needsLive();
  await openMonitor(page, 'Action board');
  const quiet = page.locator('.mm-flagcard[data-flag="quiet"]', {
    hasText: gameLabel(fx('quiet')),
  });
  // Silent 12 min: over the default 10.
  await expect(quiet).toContainText(/No input for 1[23] min/);
  const select = page.getByLabel('No scorer input for');
  await page.getByText('Flag thresholds').click();
  await expect(select.locator('option')).toHaveText([
    '5 min',
    '10 min',
    '15 min',
    '20 min',
    '30 min',
    '45 min',
  ]);
  await select.selectOption('15');
  await expect(quiet).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('match-monitor')).toBeVisible();
  await expect(page.locator('.mm-flagcard').first()).toBeVisible();
  await expect(quiet).toHaveCount(0);
  await page.getByText('Flag thresholds').click();
  await expect(page.getByLabel('No scorer input for')).toHaveValue('15');

  await page.getByLabel('No scorer input for').selectOption('10');
  await expect(quiet).toHaveCount(1);
});

test('mark seen: the flag moves to Seen, survives a reload, and is per day', async ({ page }) => {
  needsLive();
  await openMonitor(page, 'Action board');
  const undo = page.locator('.mm-flagcards .mm-flagcard[data-flag="undo"]', {
    hasText: gameLabel(fx('finished')),
  });
  await expect(undo).toHaveCount(1);
  await undo.getByRole('button', { name: 'Mark seen: Undo used 7 times' }).click();
  await expect(undo).toHaveCount(0);
  const seen = page.locator('details.mm-seen');
  await expect(seen.locator('summary')).toHaveText(/Seen \(1\)/);
  await seen.locator('summary').click();
  await expect(seen).toContainText('Undo used 7 times');
  await expect(seen).toContainText(gameLabel(fx('finished')));

  await page.reload();
  await expect(page.locator('.mm-flagcard').first()).toBeVisible();
  await expect(undo).toHaveCount(0);
  await expect(page.locator('details.mm-seen summary')).toHaveText(/Seen \(1\)/);

  // Another day has its own marks: yesterday's finished game keeps its undo flag.
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.getByText(/^Yesterday ·/)).toBeVisible();
  await expect(
    page.locator('.mm-flagcards .mm-flagcard[data-flag="undo"]', {
      hasText: gameLabel(fx('yesterday')),
    }),
  ).toHaveCount(1);
  await expect(page.locator('details.mm-seen')).toHaveCount(0);

  // Back to today: still seen; Put back restores it.
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('details.mm-seen summary')).toHaveText(/Seen \(1\)/);
  await page.locator('details.mm-seen summary').click();
  await page.getByRole('button', { name: 'Put back' }).click();
  await expect(undo).toHaveCount(1);
  await expect(page.locator('details.mm-seen')).toHaveCount(0);
});

test('a malformed match is left out with a note; the rest of the day still shows', async ({
  page,
}) => {
  needsLive();
  await openMonitor(page, 'Every game');
  await expect(gameRow(page, fx('finished')).locator('td[data-label="Score now"]')).toContainText(
    'Finished',
  );
  mode.badMatch = true;
  const note = page.getByText("1 game(s) from medicoach couldn't be read and are left out");
  await refreshUntil(page, () => expect(note).toBeVisible());
  // Only that game lost its live data; it is still listed, as a fixture with no scoring.
  const bad = gameRow(page, fx('finished'));
  await expect(bad).toHaveCount(1);
  await expect(bad.locator('td[data-label="Start"]')).toContainText('No ball yet');
  await expect(bad.locator('td[data-label="Score now"]')).not.toContainText('Finished');
  await expect(gameRow(page, fx('quiet')).locator('td[data-label="Score now"]')).toContainText(
    'Live',
  );
  await expect(gameRow(page, fx('abandoned')).locator('td[data-label="Score now"]')).toContainText(
    'Abandoned',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);

  mode.badMatch = false;
  await refreshUntil(page, () => expect(note).toHaveCount(0));
  await expect(bad.locator('td[data-label="Score now"]')).toContainText('Finished');
});

test('medicoach down: plain-language error, fixtures still listed, recovers', async ({ page }) => {
  needsLive();
  await openMonitor(page, 'Every game');
  await expect(gameRow(page, fx('quiet')).locator('td[data-label="Score now"]')).toContainText(
    'Live',
  );

  await stopStub();
  const banner = page.getByRole('alert').filter({ hasText: 'Live scoring unavailable.' });
  await refreshUntil(page, () => expect(banner).toBeVisible());
  await expect(banner).toContainText("Couldn't reach medicoach — the connection failed.");
  await expect(banner).toContainText('The monitor keeps trying while this page is open.');
  await expect(page.getByText("Couldn't load the match monitor")).toHaveCount(0);
  for (const k of ['finished', 'quiet', 'break', 'abandoned', 'upcoming'] as const)
    await expect(gameRow(page, fx(k))).toHaveCount(1);
  await expect(gameRow(page, fx('quiet')).locator('td[data-label="Start"]')).toContainText(
    'No ball yet',
  );

  await startStub();
  await refreshUntil(page, () => expect(banner).toHaveCount(0));
  await expect(gameRow(page, fx('quiet')).locator('td[data-label="Score now"]')).toContainText(
    'Live',
  );
});

test('a signature mismatch (medicoach 401) shows as unavailable, and recovers', async ({
  page,
}) => {
  needsLive();
  await openMonitor(page, 'Action board');
  await expect(page.locator('.mm-flagcard').first()).toBeVisible();
  mode.wrongSecret = true;
  const banner = page.getByRole('alert').filter({ hasText: 'Live scoring unavailable.' });
  await refreshUntil(page, () => expect(banner).toBeVisible());
  await expect(banner).toContainText('medicoach rejected our credentials');
  await banner.getByText('Details').click();
  await expect(banner).toContainText('medicoach answered HTTP 401');

  mode.wrongSecret = false;
  await refreshUntil(page, () => expect(banner).toHaveCount(0));
  await expect(
    page.locator('.mm-flagcard[data-flag="undo"]', { hasText: gameLabel(fx('finished')) }),
  ).toHaveCount(1);
});

test('day navigation: yesterday polls, tomorrow does not, an empty day says so', async ({
  page,
}) => {
  test.setTimeout(150_000);
  needsLive();
  await openMonitor(page, 'Every game');
  const refreshText = page.locator('.mm-refresh');

  // Yesterday: still a live day (evening games run past midnight) → it polls.
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.getByText(/^Yesterday ·/)).toBeVisible();
  await expect(gameRow(page, fx('yesterday')).locator('td[data-label="Score now"]')).toContainText(
    'Finished',
  );
  await expect(refreshText).toContainText('refreshes every 30 s');
  const before = liveCalls.filter((d) => d === YESTERDAY).length;
  // The API caches 15 s, so a poll may be answered from cache: watch the page's own requests.
  let pagePolls = 0;
  const onReq = (r: { url(): string }) => {
    if (r.url().includes(`/integrations/medicoach/live?date=${YESTERDAY}`)) pagePolls++;
  };
  page.on('request', onReq);
  await page.waitForTimeout(33_000);
  page.off('request', onReq);
  expect(pagePolls, 'yesterday is re-fetched on the 30 s poll').toBeGreaterThanOrEqual(1);
  expect(liveCalls.filter((d) => d === YESTERDAY).length).toBeGreaterThanOrEqual(before);

  // Tomorrow: shows the upcoming game, no polling.
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page.getByText(/^Tomorrow ·/)).toBeVisible();
  await expect(gameRow(page, fx('tomorrow')).locator('td[data-label="Score now"]')).toContainText(
    'Upcoming',
  );
  await expect(refreshText).not.toContainText('refreshes every 30 s');
  let tomorrowPolls = 0;
  const onReq2 = (r: { url(): string }) => {
    if (r.url().includes(`/integrations/medicoach/live?date=${TOMORROW}`)) tomorrowPolls++;
  };
  page.on('request', onReq2);
  await page.waitForTimeout(33_000);
  page.off('request', onReq2);
  expect(tomorrowPolls, 'tomorrow is not polled').toBe(0);

  // An empty past day.
  await page.locator('.mm-date input[type="date"]').fill('2001-01-01');
  await expect(page.getByText('No fixtures in a released series on this day.')).toBeVisible();
  await page.getByRole('tab', { name: /^Action board/ }).click();
  await expect(page.getByText('No fixtures in a released series on this day.')).toBeVisible();
});

test('dry run: no sync connection shows the dry-run note and never calls medicoach', async ({
  page,
}) => {
  test.skip(!dryRun, 'only against a stack started with an empty MEDICOACH_SYNC_URL');
  const calls = liveCalls.length;
  await openMonitor(page, 'Every game');
  await expect(page.getByRole('note').filter({ hasText: 'Dry run.' })).toContainText(
    "The sync connection isn't configured",
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The day's fixtures still list, with no live scoring.
  await expect(gameRow(page, fx('quiet')).locator('td[data-label="Start"]')).toContainText(
    'No ball yet',
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  expect(liveCalls.length, 'no request reached medicoach').toBe(calls);
});
