/**
 * The operator console for scorecard answers in captains reports —
 * GET /platform/captains-report-scorecards — against an in-process dynalite table (real repo,
 * real Hono app):
 *
 *  - operators only (admins and reps get 403);
 *  - one row per fixture, home and away paired, newest match first, tenants by name;
 *  - every status: n/a (no available card, incl. an `available: false` stub), pending (open +
 *    card; a draft answer does not count), not-asked (submitted / void without an answer while
 *    a card exists), confirmed, correction (with its text), stale (wins over the answer);
 *  - unlisted matches are left out; the `days` window (default 14, capped at 60) and the
 *    `status` filter (either side matches); the row cap with `truncated`;
 *  - the `tenant` scope (only that tenant read; 400 for an unknown one), per-status counts taken
 *    before the status filter, and the tenant picker's options.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { CaptainsReport, StoredFixtureScorecard, TenantConfig } from '../src/types.js';
import type { ScorecardConsolePayload, ScorecardConsoleRow } from '../src/captains-reports.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4709;
const TABLE = 'SmartClubPlatformCaptainsReportScorecards';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const DAY = 24 * 3600 * 1000;

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let cr: typeof import('../src/captains-reports.js');
let tenantDate: (typeof import('../src/tenant-time.js'))['tenantDate'];

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const OPERATOR = devAuth('op-1', 'ops@platform.test', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);
const ADMIN = devAuth('adm', 'admin@union.test', [
  { tenantId: 'dolphins', role: 'admin', clubIds: [] },
]);
const REP = devAuth('rep', 'rep@club.test', [
  { tenantId: 'dolphins', role: 'rep', clubIds: ['home-a'] },
]);

const daysAgo = (n: number) => tenantDate(new Date(Date.now() - n * DAY));

function report(
  tenant: string,
  fixtureId: string,
  side: 'home' | 'away',
  matchDate: string,
  over: Partial<CaptainsReport> = {},
): CaptainsReport {
  const clubId = `${side}-${fixtureId}`;
  const homeName = `${tenant} Home ${fixtureId}`;
  const awayName = `${tenant} Away ${fixtureId}`;
  return {
    id: `s-1~${fixtureId}~${clubId}`,
    seriesId: 's-1',
    fixtureId,
    clubId,
    status: 'pending',
    source: 'auto',
    matchDate,
    side,
    clubName: side === 'home' ? homeName : awayName,
    opponentName: side === 'home' ? awayName : homeName,
    competition: 'Premier T20',
    umpiresSnapshot: [],
    recipient: { kind: 'chair', memberId: `m-${clubId}`, name: 'Chair' },
    captainName: '',
    umpires: [],
    general: '',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

const submitted = (ref: string, over: Partial<CaptainsReport> = {}): Partial<CaptainsReport> => ({
  status: 'submitted',
  ref,
  submittedAt: '2026-10-05T09:00:00.000Z',
  submittedVia: 'link',
  captainName: 'S. Captain',
  declaration: true,
  ...over,
});

const card = (fixtureId: string, available = true): StoredFixtureScorecard => ({
  seriesId: 's-1',
  fixtureId,
  medicoachMatchId: `pma-${fixtureId}`,
  medicoachTournamentId: 'tour-1',
  schemaVersion: 1,
  fetchedAt: '2026-10-05T08:00:00.000Z',
  available,
  ...(available ? { matchState: 'Home won', innings: [] } : {}),
});

async function seed() {
  for (const [tenant, name] of [
    ['dolphins', 'Dolphins Cricket'],
    ['titans', 'Titans Cricket'],
  ] as const)
    await repo.putTenantConfig({
      tenant,
      branding: { name, title: name, logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-01',
      knownClubs: [],
    } as unknown as TenantConfig);

  const D = 'dolphins';
  const reports: CaptainsReport[] = [
    // f1: both answered.
    report(
      D,
      'f1',
      'home',
      daysAgo(1),
      submitted('CR-2026-0001', {
        scorecard: { action: 'confirmed', againstFetchedAt: '2026-10-05T08:00:00.000Z' },
      }),
    ),
    report(
      D,
      'f1',
      'away',
      daysAgo(1),
      submitted('CR-2026-0002', {
        scorecard: {
          action: 'correction',
          feedback: 'The bowling figures for C Bowler are wrong.',
          againstFetchedAt: '2026-10-05T08:00:00.000Z',
        },
      }),
    ),
    // f2: home still open (its saved DRAFT answer does not count), away closed unanswered.
    report(D, 'f2', 'home', daysAgo(2), { scorecard: { action: 'confirmed' } }),
    report(D, 'f2', 'away', daysAgo(2), submitted('CR-2026-0003')),
    // f3: no card at all.
    report(D, 'f3', 'home', daysAgo(3)),
    report(D, 'f3', 'away', daysAgo(3), submitted('CR-2026-0004')),
    // f4: a stale confirmation; the away report was voided with a card stored.
    report(
      D,
      'f4',
      'home',
      daysAgo(4),
      submitted('CR-2026-0005', {
        scorecard: {
          action: 'confirmed',
          againstFetchedAt: '2026-10-01T00:00:00.000Z',
          stale: true,
        },
      }),
    ),
    report(D, 'f4', 'away', daysAgo(4), { status: 'void', voidedAt: '2026-10-05T00:00:00.000Z' }),
    // f6: an `available: false` stub is no card; one side only.
    report(D, 'f6', 'home', daysAgo(5)),
    // f5: outside the default window.
    report(
      D,
      'f5',
      'home',
      daysAgo(30),
      submitted('CR-2026-0006', {
        scorecard: { action: 'confirmed', againstFetchedAt: '2026-10-05T08:00:00.000Z' },
      }),
    ),
    // An unlisted match: never on the console.
    report(D, 'u1', 'home', daysAgo(1), {
      seriesId: 'unlisted',
      source: 'manual-unlisted',
      id: 'unlisted~u1~home-u1',
      ...submitted('CR-2026-0007'),
    }),
    // Titans: one side only, confirmed.
    report(
      'titans',
      'f1',
      'home',
      daysAgo(1),
      submitted('CR-2026-0001', {
        scorecard: { action: 'confirmed', againstFetchedAt: '2026-10-05T08:00:00.000Z' },
      }),
    ),
  ];
  for (const r of reports) {
    const tenant = r.clubName.startsWith('titans') ? 'titans' : 'dolphins';
    assert.ok(await repo.openCaptainsReportIfAbsent(tenant, r));
  }
  for (const f of ['f1', 'f2', 'f4', 'f5']) await repo.putFixtureScorecard(D, card(f));
  await repo.putFixtureScorecard(D, card('f6', false));
  await repo.putFixtureScorecard('titans', card('f1'));
}

const get = async (query = '', auth = OPERATOR) =>
  app.request(`/platform/captains-report-scorecards${query}`, {
    headers: { 'x-dev-auth': auth, 'content-type': 'application/json' },
  });
const load = async (query = '') => {
  const res = await get(query);
  assert.equal(res.status, 200);
  return (await res.json()) as ScorecardConsolePayload;
};
const rowsOf = (p: ScorecardConsolePayload, tenant: string) =>
  p.tenants.find((t) => t.tenant === tenant)?.rows ?? [];
const statuses = (rows: ScorecardConsoleRow[]) =>
  Object.fromEntries(
    rows.map((r) => [
      r.fixtureId,
      [r.home?.scorecardStatus ?? '-', r.away?.scorecardStatus ?? '-'],
    ]),
  );

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  cr = await import('../src/captains-reports.js');
  tenantDate = (await import('../src/tenant-time.js')).tenantDate;
  await seed();
});

after(async () => {
  await stopDynalite(ddb);
});

describe('the operator gate', () => {
  test('admins and reps get 403; no auth 401', async () => {
    assert.equal((await get('', ADMIN)).status, 403);
    assert.equal((await get('', REP)).status, 403);
    const anon = await app.request('/platform/captains-report-scorecards');
    assert.equal(anon.status, 401);
  });
});

describe('pairing and statuses', () => {
  test('one row per fixture, both sides paired, newest first, tenants by name', async () => {
    const p = await load();
    assert.equal(p.days, 14);
    assert.equal(p.status, 'all');
    assert.equal(p.since, daysAgo(14));
    assert.equal(p.truncated, false);
    assert.equal(p.total, 6);
    assert.deepEqual(
      p.tenants.map((t) => [t.tenant, t.tenantName]),
      [
        ['dolphins', 'Dolphins Cricket'],
        ['titans', 'Titans Cricket'],
      ],
    );
    const d = rowsOf(p, 'dolphins');
    assert.deepEqual(
      d.map((r) => r.fixtureId),
      ['f1', 'f2', 'f3', 'f4', 'f6'],
    );
    assert.deepEqual(statuses(d), {
      f1: ['confirmed', 'correction'],
      f2: ['pending', 'not-asked'],
      f3: ['n/a', 'n/a'],
      f4: ['stale', 'not-asked'],
      f6: ['n/a', '-'],
    });
    assert.deepEqual(statuses(rowsOf(p, 'titans')), { f1: ['confirmed', '-'] });
  });

  test('cells carry the report, the club and a correction’s text', async () => {
    const f1 = rowsOf(await load(), 'dolphins').find((r) => r.fixtureId === 'f1')!;
    assert.equal(f1.homeTeamName, 'dolphins Home f1');
    assert.equal(f1.awayTeamName, 'dolphins Away f1');
    assert.equal(f1.matchDate, daysAgo(1));
    assert.equal(f1.competition, 'Premier T20');
    assert.deepEqual(f1.home, {
      reportId: 's-1~f1~home-f1',
      reportRef: 'CR-2026-0001',
      clubId: 'home-f1',
      clubName: 'dolphins Home f1',
      reportStatus: 'submitted',
      scorecardStatus: 'confirmed',
      submittedAt: '2026-10-05T09:00:00.000Z',
    });
    assert.equal(f1.away?.scorecardStatus, 'correction');
    assert.equal(f1.away?.feedback, 'The bowling figures for C Bowler are wrong.');
    assert.equal(f1.away?.reportRef, 'CR-2026-0002');
  });

  test('stale names the answer it overrode; an open report has no ref and no answer', async () => {
    const d = rowsOf(await load(), 'dolphins');
    const f4 = d.find((r) => r.fixtureId === 'f4')!;
    assert.equal(f4.home?.scorecardStatus, 'stale');
    assert.equal(f4.home?.answeredAction, 'confirmed');
    assert.equal(f4.away?.reportStatus, 'void');
    const f2 = d.find((r) => r.fixtureId === 'f2')!;
    assert.equal(f2.home?.reportStatus, 'pending');
    assert.equal(f2.home?.reportRef, undefined);
    assert.equal(f2.home?.answeredAction, undefined);
  });
});

describe('filters', () => {
  test('days widens the window, is capped at 60, and must be a positive whole number', async () => {
    const wide = await load('?days=60');
    assert.deepEqual(
      rowsOf(wide, 'dolphins').map((r) => r.fixtureId),
      ['f1', 'f2', 'f3', 'f4', 'f6', 'f5'],
    );
    const capped = await load('?days=365');
    assert.equal(capped.days, 60);
    assert.equal(capped.since, daysAgo(60));
    const narrow = await load('?days=2');
    assert.deepEqual(
      rowsOf(narrow, 'dolphins').map((r) => r.fixtureId),
      ['f1', 'f2'],
    );
    for (const bad of ['0', '-3', '1.5', 'abc'])
      assert.equal((await get(`?days=${bad}`)).status, 400);
  });

  test('status keeps rows where EITHER side matches', async () => {
    const ids = async (status: string) =>
      Object.fromEntries(
        (await load(`?status=${status}`)).tenants.map((t) => [
          t.tenant,
          t.rows.map((r) => r.fixtureId),
        ]),
      );
    assert.deepEqual(await ids('correction'), { dolphins: ['f1'] });
    assert.deepEqual(await ids('confirmed'), { dolphins: ['f1'], titans: ['f1'] });
    assert.deepEqual(await ids('pending'), { dolphins: ['f2'] });
    assert.deepEqual(await ids('not-asked'), { dolphins: ['f2', 'f4'] });
    assert.deepEqual(await ids('stale'), { dolphins: ['f4'] });
    assert.equal((await load('?status=stale')).total, 1);
    assert.equal((await get('?status=n/a')).status, 400);
    assert.equal((await get('?status=bogus')).status, 400);
  });
});

describe('tenant scope, counts and options', () => {
  const ALL_COUNTS = {
    all: 6,
    pending: 1,
    confirmed: 2,
    correction: 1,
    stale: 1,
    'not-asked': 2,
  };

  test('counts every status filter before the status filter, whichever is active', async () => {
    assert.deepEqual((await load()).counts, ALL_COUNTS);
    // A status filter narrows the rows, never the counts.
    const correction = await load('?status=correction');
    assert.equal(correction.total, 1);
    assert.deepEqual(correction.counts, ALL_COUNTS);
    // The window does move them: two days back holds f1 (+ titans f1) and f2.
    assert.deepEqual((await load('?days=2')).counts, {
      all: 3,
      pending: 1,
      confirmed: 2,
      correction: 1,
      stale: 0,
      'not-asked': 1,
    });
  });

  test('lists every tenant for the picker, by name, scoped or not', async () => {
    const expected = [
      { tenant: 'dolphins', tenantName: 'Dolphins Cricket' },
      { tenant: 'titans', tenantName: 'Titans Cricket' },
    ];
    assert.deepEqual((await load()).tenantOptions, expected);
    assert.deepEqual((await load('?tenant=titans')).tenantOptions, expected);
  });

  test('tenant= reads only that tenant: its rows, total and counts', async () => {
    const t = await load('?tenant=titans');
    assert.equal(t.tenant, 'titans');
    assert.deepEqual(
      t.tenants.map((x) => x.tenant),
      ['titans'],
    );
    assert.equal(t.total, 1);
    assert.deepEqual(t.counts, {
      all: 1,
      pending: 0,
      confirmed: 1,
      correction: 0,
      stale: 0,
      'not-asked': 0,
    });
    const d = await load('?tenant=dolphins&status=not-asked');
    assert.deepEqual(
      d.tenants.map((x) => [x.tenant, x.rows.map((r) => r.fixtureId)]),
      [['dolphins', ['f2', 'f4']]],
    );
    assert.equal(d.counts.all, 5);
    assert.equal(d.counts.confirmed, 1);
    // Unscoped responses carry no tenant.
    assert.equal((await load()).tenant, undefined);
  });

  test('an unknown tenant is a 400', async () => {
    const res = await get('?tenant=nope');
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /unknown tenant/);
  });
});

describe('the row cap', () => {
  test('keeps the newest rows across tenants and says it was truncated', async () => {
    const p = await cr.loadScorecardConsole(repo, {
      days: 14,
      status: 'all',
      now: new Date(),
      rowCap: 2,
    });
    assert.equal(p.total, 6);
    assert.equal(p.truncated, true);
    assert.deepEqual(
      p.tenants.map((t) => [t.tenant, t.rows.map((r) => r.fixtureId)]),
      [
        ['dolphins', ['f1']],
        ['titans', ['f1']],
      ],
    );
  });
});

describe('a cleared result', () => {
  const answered = (over: Partial<CaptainsReport> = {}) =>
    report(
      'dolphins',
      'fx',
      'home',
      daysAgo(1),
      submitted('CR-2026-0099', {
        scorecard: {
          action: 'correction',
          feedback: 'Wrong total.',
          againstFetchedAt: '2026-10-05T08:00:00.000Z',
        },
        ...over,
      }),
    );

  test('a flagged report (result withdrawn) maps its answer to stale, answer kept', () => {
    const r = answered({ flagged: { reason: 'result cleared', at: '2026-10-06T00:00:00.000Z' } });
    // Even with a card still stored, the flag says the result behind the answer is gone.
    const cell = cr.scorecardConsoleCell(r, true);
    assert.equal(cell.scorecardStatus, 'stale');
    assert.equal(cell.answeredAction, 'correction');
    assert.equal(cell.feedback, 'Wrong total.');
  });

  test('an answered report whose card is gone maps to stale', () => {
    const cell = cr.scorecardConsoleCell(
      answered({
        scorecard: { action: 'confirmed', againstFetchedAt: '2026-10-05T08:00:00.000Z' },
      }),
      false,
    );
    assert.equal(cell.scorecardStatus, 'stale');
    assert.equal(cell.answeredAction, 'confirmed');
  });

  test('an unanswered report with no card is still n/a; a clean answer with a card is unchanged', () => {
    assert.equal(cr.scorecardConsoleStatus(answered({ scorecard: undefined }), false), 'n/a');
    assert.equal(cr.scorecardConsoleStatus(answered(), true), 'correction');
  });
});
