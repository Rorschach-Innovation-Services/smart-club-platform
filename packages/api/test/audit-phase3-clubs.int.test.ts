/**
 * Audit trail Phase 3 (ADR 0023), closing gaps: series un-approval, the match label on a result
 * confirmation and its withdrawal, the series a stage generate creates, and club and team names
 * inside OTHER records' entries (match labels, home / away values, competition teams) reached by
 * club erasure — plus the pointer-row budget those names cost. Through the REAL Hono app on an
 * in-process dynalite, scanning STORED audit rows. Contract: docs/api/audit.md. tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type {
  AuditChange,
  AuditDetail,
  AuditEntry,
  CaptainsReport,
  Club,
  CompetitionStructure,
  SeasonCalendar,
  SquadRequest,
  StoredFixtureResult,
  TenantConfig,
} from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';
import { bindSetup, startRunBody } from './season-run-harness.js';

const DDB_PORT = 4891; // unique
const TABLE = 'SmartClubAuditPhase3ClubsTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const T = 'dolphins';
const DAY = 24 * 3600 * 1000;
const SECRET = 'local-dev-captains-report-link-secret'; // env.ts's LOCAL_AUTH fallback

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const ADMIN = devAuth('sub-admin', 'admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let keys: typeof import('../src/keys.js');
let audit: typeof import('../src/audit.js');
let cr: typeof import('../src/captains-reports.js');

const call = (method: string, p: string, body?: unknown, auth: string | null = ADMIN) =>
  app.request(p, {
    method,
    headers: {
      'x-tenant': T,
      ...(auth ? { 'x-dev-auth': auth } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function json<R>(res: Response | Promise<Response>, status = 200): Promise<R> {
  const r = await res;
  const text = await r.text();
  assert.equal(r.status, status, text);
  return JSON.parse(text) as R;
}

type Page = { items: AuditEntry[]; cursor?: string };
type Entry = { entry: AuditEntry; detail: AuditDetail | null };

const history = (type: string, id: string) =>
  json<Page>(call('GET', `/admin/audit/entity/${type}/${encodeURIComponent(id)}?limit=200`));
/** Every entry concerning a club (its `C#` pointers), as club erasure finds them. */
const clubFeed = (clubId: string): Promise<Page> =>
  repo.listAuditForClub(T, clubId, { limit: 200 });
const entryOf = (e: Pick<AuditEntry, 'at' | 'id'>) =>
  json<Entry>(call('GET', `/admin/audit/entry/${encodeURIComponent(e.at)}/${e.id}`));
const changesOf = (d: AuditDetail | null, type: string, id: string): AuditChange[] =>
  d?.targets.find((t) => t.type === type && t.id === id)?.changes ?? [];
const change = (cs: AuditChange[], field: string) => cs.find((c) => c.field === field);

function latest(page: Page, action: string): AuditEntry {
  const hit = page.items.find((e) => e.action === action);
  assert.ok(hit, `${action} in ${JSON.stringify(page.items.map((e) => e.action))}`);
  return hit;
}

/** Every row of the tenant's current audit month partition. */
async function auditRows(): Promise<Record<string, unknown>[]> {
  const { DynamoDBDocumentClient, QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
  );
  const pk = keys.auditPartitionPk(T, keys.auditMonthOf(new Date().toISOString()));
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  assert.ok(items.length > 0, 'the audit partition holds rows');
  return items;
}
const auditText = async () => JSON.stringify(await auditRows());

const club = (id: string, name: string, leagues: string[] = []): Club =>
  ({
    id,
    name,
    district: 'North',
    sub: '',
    chair: `Chair ${id}`,
    exco: { chair: { name: `Chair ${id}` } },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: { venue: `${name} Oval` },
    leagues,
    version: 1,
  }) as Club;

const X = { id: 'club-x', name: 'Xanadu Strikers' };
const Y = { id: 'club-y', name: 'Yellowwood Rovers' };
const K = { id: 'club-k', name: 'Kestrel Kings' };
const part = (c: { id: string; name: string }) => ({ teamId: c.id, clubId: c.id, name: c.name });
const SID = 's-xy';
const fx = (id: string, date: string, home: string, away: string, round = 1) => ({
  id,
  round,
  date,
  time: '10:00',
  home,
  away,
});

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  keys = await import('../src/keys.js');
  audit = await import('../src/audit.js');
  cr = await import('../src/captains-reports.js');
  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig(T);
  const cfg = (await repo.getTenantConfig(T))!;
  await repo.putTenantConfig({
    ...cfg,
    features: { ...(cfg.features ?? {}), medicoachSync: true },
  } as unknown as TenantConfig);
  for (const c of [X, Y, K]) await repo.createClub(T, club(c.id, c.name));
});

after(() => stopDynalite(ddb));

describe('series un-approval (gap 3)', () => {
  test('approved true → false reads as series.unapprove, with the flag old → new', async () => {
    const created = await json<{ version: number }>(
      call('POST', '/series', {
        id: 's-unapprove',
        name: 'Unapprove League',
        startDate: '2027-02-06',
        teams: [K.id, Y.id],
        participants: [part(K), part(Y)],
        fixtures: [fx('u1', '2027-02-06', K.id, Y.id)],
      }),
      201,
    );
    const approved = await json<{ version: number }>(
      call('PATCH', '/series/s-unapprove', { approved: true, version: created.version }),
    );
    await json(
      call('PATCH', '/series/s-unapprove', { approved: false, version: approved.version }),
    );
    const un = latest(await history('series', 's-unapprove'), 'series.unapprove');
    assert.deepEqual(
      change(changesOf((await entryOf(un)).detail, 'series', 's-unapprove'), 'approved'),
      { field: 'approved', from: true, to: false },
    );
  });

  test('a fixtures edit of an approved draft reads as series.fixtures.edit, approval withdrawn among its changes', async () => {
    const created = await json<{ version: number }>(
      call('POST', '/series', {
        id: 's-edit-approved',
        name: 'Edit Approved League',
        startDate: '2027-03-06',
        teams: [K.id, Y.id],
        participants: [part(K), part(Y)],
        fixtures: [fx('e1', '2027-03-06', K.id, Y.id)],
      }),
      201,
    );
    const approved = await json<{ version: number }>(
      call('PATCH', '/series/s-edit-approved', { approved: true, version: created.version }),
    );
    const edited = await json<{ approved?: boolean }>(
      call('PATCH', '/series/s-edit-approved', {
        version: approved.version,
        fixtures: [fx('e1', '2027-03-07', K.id, Y.id)],
      }),
    );
    assert.notEqual(edited.approved, true, 'precondition: the edit withdrew the approval');
    const page = await history('series', 's-edit-approved');
    const edit = page.items[0];
    assert.equal(edit.action, 'series.fixtures.edit');
    assert.ok(!page.items.some((e) => e.action === 'series.unapprove'));
    assert.deepEqual(
      change(changesOf((await entryOf(edit)).detail, 'series', 's-edit-approved'), 'approved'),
      { field: 'approved', from: true, to: false },
    );
  });
});

describe('seriesPatchAction (unit)', () => {
  test('unapprove only when no fixture was touched; a fixtures edit wins otherwise', async () => {
    const { seriesPatchAction } = await import('../src/audit-records.js');
    const was = { approved: true };
    const now = { approved: false };
    assert.equal(seriesPatchAction({}, was, now, 0), 'series.unapprove');
    assert.equal(seriesPatchAction({}, was, now, 1), 'series.fixtures.edit');
    assert.equal(
      seriesPatchAction({}, { approved: false }, { approved: true }, 0),
      'series.approve',
    );
  });
});

describe('the series a stage generate creates (gap 4)', () => {
  const LEAGUE = 'gen-league';
  const STRUCT: CompetitionStructure = {
    id: 'st-gen',
    name: 'Gen round robin',
    version: 1,
    stages: [
      {
        id: 'league',
        name: 'League',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
    ],
  } as CompetitionStructure;
  const CAL: SeasonCalendar = {
    id: 'cal-gen',
    label: '2026/27',
    blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' }],
  };

  test('each new series is a series target with op create and its label', async () => {
    for (const id of ['gen-a', 'gen-b', 'gen-c', 'gen-d'])
      await repo.putClub(T, club(id, `Gen ${id.slice(4).toUpperCase()} CC`, [LEAGUE]));
    await bindSetup(repo, T, { leagueKey: LEAGUE, structure: STRUCT, calendar: CAL });
    const run = await json<{ id: string; version: number }>(
      call('POST', '/season-runs', startRunBody({ id: 'sr-gen', leagueKey: LEAGUE })),
      201,
    );
    const out = await json<{ series: Array<{ id: string; name: string }> }>(
      call('POST', `/season-runs/${run.id}/stages/league/generate`, { version: run.version }),
    );
    assert.ok(out.series.length > 0, 'precondition: a series was generated');
    const gen = latest(await history('season-run', run.id), 'season-run.generate');
    assert.equal(gen.counts?.series, out.series.length);
    for (const s of out.series) {
      const t = gen.targets.find((x) => x.type === 'series' && x.id === s.id);
      assert.ok(t, `series ${s.id} is a target`);
      assert.equal(t.op, 'create');
      assert.equal(t.label, s.name);
      // In the new series' own history.
      assert.equal(latest(await history('series', s.id), 'season-run.generate').id, gen.id);
    }
    // No per-fixture diffs.
    assert.equal(gen.targets.filter((x) => x.type === 'fixture').length, 0);
  });
});

describe('club and team names inside other records (gaps 2 and 6)', () => {
  const R1 = '2027-01-09T14:00:00.000Z';
  const reportId = `${SID}~f1~${Y.id}`;
  const squadId = `${SID}~f1~${Y.id}`;
  let competitionId = '';
  let editEntry: AuditEntry;
  let confirmEntry: AuditEntry;
  let unconfirmEntry: AuditEntry;
  let reportEntry: AuditEntry;
  let squadEntry: AuditEntry;
  let competitionEntry: AuditEntry;

  test('a fixture edit: X v Y labels name both clubs; home / away values carry refs', async () => {
    const created = await json<{ version: number }>(
      call('POST', '/series', {
        id: SID,
        name: 'XY League',
        startDate: '2027-01-09',
        teams: [X.id, Y.id, K.id],
        participants: [part(X), part(Y), part(K)],
        fixtures: [
          fx('f1', '2027-01-09', X.id, Y.id),
          fx('f2', '2027-01-16', Y.id, X.id, 2),
          fx('f3', '2027-01-23', K.id, Y.id, 3),
        ],
      }),
      201,
    );
    await json(
      call('PATCH', `/series/${SID}`, {
        version: created.version,
        fixtures: [
          fx('f1', '2027-01-10', X.id, Y.id),
          fx('f2', '2027-01-16', X.id, Y.id, 2),
          fx('f3', '2027-01-24', K.id, Y.id, 3),
        ],
      }),
    );
    editEntry = latest(await history('series', SID), 'series.fixtures.edit');
    const label = (id: string) => editEntry.targets.find((t) => t.id === `${SID}#${id}`)?.label;
    assert.equal(label('f1'), 'Xanadu Strikers v Yellowwood Rovers');
    assert.equal(label('f2'), 'Xanadu Strikers v Yellowwood Rovers');
    assert.equal(label('f3'), 'Kestrel Kings v Yellowwood Rovers');
    const f2 = changesOf((await entryOf(editEntry)).detail, 'fixture', `${SID}#f2`);
    assert.deepEqual(change(f2, 'home'), {
      field: 'home',
      from: Y.name,
      to: X.name,
      ref: { type: 'club', id: X.id },
      fromRef: { type: 'club', id: Y.id },
    });
    // Every club the labels name reaches the entry (its `C#` pointers).
    assert.equal(latest(await clubFeed(X.id), 'series.fixtures.edit').id, editEntry.id);
    assert.equal(latest(await clubFeed(K.id), 'series.fixtures.edit').id, editEntry.id);
  });

  test('a result confirmation and its withdrawal both carry the match label', async () => {
    await repo.putFixtureResultIfNewer(T, {
      seriesId: SID,
      fixtureId: 'f1',
      ref: `smartclub:${T}:fixture:${SID}:f1`,
      orderAt: R1,
      homeScore: '150/4 (20)',
      awayScore: '149/9 (20)',
      summary: 'won by 6 wickets',
      winner: 'home',
      method: 'normal',
      noResult: false,
      resultSource: 'live',
      recordedAt: R1,
      storedAt: R1,
    } as StoredFixtureResult);
    await json(call('POST', `/series/${SID}/fixtures/f1/result/confirm`, { recordedAt: R1 }));
    await json(call('DELETE', `/series/${SID}/fixtures/f1/result/confirm`));
    const page = await history('fixture-result', `${SID}#f1`);
    confirmEntry = latest(page, 'fixture-result.confirm');
    unconfirmEntry = latest(page, 'fixture-result.unconfirm');
    for (const e of [confirmEntry, unconfirmEntry]) {
      const t = e.targets.find((x) => x.type === 'fixture-result')!;
      assert.equal(t.label, 'Xanadu Strikers v Yellowwood Rovers', e.action);
    }
    assert.equal(latest(await clubFeed(X.id), 'fixture-result.unconfirm').id, unconfirmEntry.id);
  });

  test("a captain's report and a squad of Y against X: the label names both clubs", async () => {
    const at = new Date().toISOString();
    await repo.createCaptainsReport(T, {
      id: reportId,
      seriesId: SID,
      fixtureId: 'f1',
      clubId: Y.id,
      status: 'pending',
      source: 'manual',
      matchDate: '2027-01-10',
      side: 'away',
      clubName: Y.name,
      opponentName: X.name,
      competition: 'XY League',
      umpiresSnapshot: [],
      recipient: { kind: 'chair', memberId: 'm-chair-y', name: 'Chair Y' },
      captainName: '',
      umpires: [],
      general: '',
      linkExpiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      createdAt: at,
      updatedAt: at,
    } as unknown as CaptainsReport);
    const report = (await repo.getCaptainsReport(T, SID, 'f1', Y.id))!;
    const token = cr.reportLink(T, report, SECRET, 'http://x').token;
    await json(
      app.request(`/captains-report-link/${token}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ captainName: '', umpires: [], general: '', submit: false }),
      }),
    );
    reportEntry = latest(await history('captains-report', reportId), 'captains-report.save');
    assert.equal(
      reportEntry.targets.find((t) => t.id === reportId)!.label,
      'Yellowwood Rovers v Xanadu Strikers',
    );
    assert.equal(latest(await clubFeed(X.id), 'captains-report.save').id, reportEntry.id);

    await repo.openSquadRequestIfAbsent(T, {
      id: squadId,
      seriesId: SID,
      fixtureId: 'f1',
      teamId: Y.id,
      clubId: Y.id,
      status: 'pending',
      fixtureRef: 'fx-ref',
      matchDate: '2027-01-10',
      side: 'away',
      clubName: Y.name,
      teamName: Y.name,
      opponentName: X.name,
      competition: 'XY League',
      recipient: { kind: 'chair', memberId: 'm-sq-y', name: 'Chair Y' },
      linkExpiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      modified: 'm0',
    } as unknown as SquadRequest);
    await json(call('POST', `/admin/squad-requests/${encodeURIComponent(squadId)}/void`));
    squadEntry = latest(await history('squad-request', squadId), 'squad-request.void');
    assert.equal(
      squadEntry.targets.find((t) => t.id === squadId)!.label,
      'Yellowwood Rovers v Xanadu Strikers',
    );
    assert.equal(latest(await clubFeed(X.id), 'squad-request.void').id, squadEntry.id);
  });

  test("a report whose fixture's opponent changed since its snapshot leaves that side unresolved", async () => {
    // f3 is now K v Y, but Y's report was filed against an opponent the fixture no longer names.
    const id = `${SID}~f3~${Y.id}`;
    const at = new Date().toISOString();
    await repo.createCaptainsReport(T, {
      id,
      seriesId: SID,
      fixtureId: 'f3',
      clubId: Y.id,
      status: 'pending',
      source: 'manual',
      matchDate: '2027-01-24',
      side: 'away',
      clubName: Y.name,
      opponentName: 'Old Opponent FC',
      competition: 'XY League',
      umpiresSnapshot: [],
      recipient: { kind: 'chair', memberId: 'm-chair-y3', name: 'Chair Y' },
      captainName: '',
      umpires: [],
      general: '',
      linkExpiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      createdAt: at,
      updatedAt: at,
    } as unknown as CaptainsReport);
    const report = (await repo.getCaptainsReport(T, SID, 'f3', Y.id))!;
    const token = cr.reportLink(T, report, SECRET, 'http://x').token;
    await json(
      app.request(`/captains-report-link/${token}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ captainName: '', umpires: [], general: '', submit: false }),
      }),
    );
    const e = latest(await history('captains-report', id), 'captains-report.save');
    const t = e.targets.find((x) => x.id === id)!;
    assert.equal(t.label, 'Yellowwood Rovers v Old Opponent FC');
    assert.deepEqual(t.clubIds, [Y.id, ''], 'the current opponent is not attached to the label');
    assert.ok(
      !(await clubFeed(K.id)).items.some((x) => x.id === e.id),
      "K's history does not claim a report against someone else",
    );
  });

  test('a competition: one teams change per team, each with a ref to its club', async () => {
    const created = await json<{ id: string }>(
      call('POST', '/competitions', {
        type: 'league',
        name: 'XYK Cup',
        overs: 20,
        teams: [part(X), part(Y), part(K)],
        format: { kind: 'round-robin', legs: 1 },
        schedule: { startDate: '2027-08-07', everyDays: 7, times: ['10:00'] },
      }),
      201,
    );
    competitionId = created.id;
    competitionEntry = latest(await history('competition', competitionId), 'competition.create');
    const teams = changesOf((await entryOf(competitionEntry)).detail, 'competition', competitionId)
      .filter((c) => c.field === 'teams')
      .map((c) => [c.to, c.ref?.id]);
    assert.deepEqual(teams, [
      [X.name, X.id],
      [Y.name, Y.id],
      [K.name, K.id],
    ]);
  });

  test('DELETE X: no stored row holds its name; Y and K keep theirs; the entries stay listed', async () => {
    assert.ok((await auditText()).includes(X.name), 'precondition: X was named');
    await json(call('DELETE', `/clubs/${X.id}`));
    const text = await auditText();
    assert.ok(!text.includes(X.name), 'a stored audit row still holds the deleted club’s name');
    assert.ok(text.includes(Y.name) && text.includes(K.name), 'the surviving clubs keep theirs');

    // Fixture labels and values: X's side reads "Removed club", Y's side stays.
    const series = await history('series', SID);
    assert.ok(
      series.items.some((e) => e.id === editEntry.id),
      'the edit is still listed',
    );
    const edit = latest(series, 'series.fixtures.edit');
    const label = (id: string) => edit.targets.find((t) => t.id === `${SID}#${id}`)?.label;
    assert.equal(label('f1'), 'Removed club v Yellowwood Rovers');
    assert.equal(label('f3'), 'Kestrel Kings v Yellowwood Rovers');
    const f2 = changesOf((await entryOf(edit)).detail, 'fixture', `${SID}#f2`);
    assert.equal(change(f2, 'home')!.from, Y.name);
    assert.notEqual(change(f2, 'home')!.to, X.name);
    assert.equal(change(f2, 'away')!.to, Y.name);

    // The result confirmation and its withdrawal.
    const results = await history('fixture-result', `${SID}#f1`);
    for (const e of [confirmEntry, unconfirmEntry]) {
      const now = results.items.find((x) => x.id === e.id);
      assert.ok(now, `${e.action} still listed`);
      assert.equal(
        now.targets.find((t) => t.type === 'fixture-result')!.label,
        'Removed club v Yellowwood Rovers',
      );
    }
    // The report and the squad of Y keep Y's side.
    const rep = (await history('captains-report', reportId)).items.find(
      (e) => e.id === reportEntry.id,
    )!;
    assert.equal(
      rep.targets.find((t) => t.id === reportId)!.label,
      'Yellowwood Rovers v Removed club',
    );
    const sq = (await history('squad-request', squadId)).items.find((e) => e.id === squadEntry.id)!;
    assert.equal(
      sq.targets.find((t) => t.id === squadId)!.label,
      'Yellowwood Rovers v Removed club',
    );
    // The competition keeps Y and K, loses X.
    const comp = (await history('competition', competitionId)).items.find(
      (e) => e.id === competitionEntry.id,
    )!;
    const names = changesOf((await entryOf(comp)).detail, 'competition', competitionId)
      .filter((c) => c.field === 'teams')
      .map((c) => c.to);
    assert.ok(names.includes(Y.name) && names.includes(K.name));
    assert.ok(!names.includes(X.name));
  });
});

describe('pointer-row budget for club names (gap 6)', () => {
  const pointerRows = (rows: Array<{ sk: string }>, prefix: string) =>
    rows.filter((r) => r.sk.startsWith(prefix));

  function fixtureEdit(clubOf: (i: number, side: 0 | 1) => string) {
    const scope = audit.newAuditScope({
      tenant: T,
      actor: { kind: 'user', key: 'sub-admin', via: 'console' },
      action: 'series.fixtures.edit',
    });
    audit.runAudited(scope, () => {
      audit.auditTarget({ type: 'series', id: 's-big', label: 'Big', op: 'update' });
      // The series plus 24 fixtures: the 25-target cap, nothing truncated by it.
      for (let i = 0; i < 24; i++) {
        const [h, a] = [clubOf(i, 0), clubOf(i, 1)];
        audit.auditTarget({
          type: 'fixture',
          id: `s-big#f${i}`,
          label: `Home ${h} v Away ${a}`,
          clubIds: [h, a],
          op: 'update',
          changes: [
            {
              field: 'home',
              from: `Away ${a}`,
              to: `Home ${h}`,
              ref: { type: 'club', id: h },
              fromRef: { type: 'club', id: a },
            },
            {
              field: 'away',
              from: `Home ${h}`,
              to: `Away ${a}`,
              ref: { type: 'club', id: a },
              fromRef: { type: 'club', id: h },
            },
          ],
        });
      }
    });
    return audit.buildEntry(scope, { status: 200 });
  }

  test('club pointers are per distinct club per entry, not per target', () => {
    // 24 fixtures over a pool of 5 clubs, each naming two of them.
    const set = fixtureEdit((i, side) => `pool-${(i + side) % 5}`);
    const clubRows = pointerRows(set.rows, 'C#');
    assert.equal(clubRows.length, 5);
    const fixtures = set.entry.targets.filter((t) => t.type === 'fixture');
    assert.equal(fixtures.length, 24);
    assert.ok(
      fixtures.every((t) => t.label && t.clubIds?.length === 2),
      'labels keep their clubs',
    );
    assert.ok(set.rows.length <= 100, `${set.rows.length} rows`);
    assert.equal(set.entry.truncated, undefined);
  });

  test('a 25-target edit naming 48 distinct clubs: ≤ 100 rows, nothing names a club without its pointer', () => {
    const set = fixtureEdit((i, side) => `c-${i}-${side}`);
    assert.ok(set.rows.length <= 100, `${set.rows.length} rows`);
    const clubPtr = new Set(pointerRows(set.rows, 'C#').map((r) => r.sk.split('#')[1]));
    const entityPtr = new Set(
      pointerRows(set.rows, 'E#').map((r) => r.sk.split('#').slice(1, 3).join('#')),
    );
    // The 48 label clubs fit (25 target pointers + 48 club pointers + 3 reserved rows); the
    // change values that would need more pointers lose their values instead.
    const fixtures = set.entry.targets.filter((t) => t.type === 'fixture');
    assert.ok(
      fixtures.every((t) => t.label && t.clubIds?.length === 2),
      'labels keep their clubs',
    );
    for (const t of set.entry.targets)
      if (t.label && t.type === 'fixture')
        for (const c of t.clubIds ?? [])
          if (c) assert.ok(clubPtr.has(c), `label of ${t.id} names ${c}`);
    for (const t of set.detail?.targets ?? [])
      for (const c of t.changes)
        if (c.from !== undefined || c.to !== undefined)
          for (const r of [c.ref, c.fromRef])
            if (r)
              assert.ok(entityPtr.has(`club#${r.id}`) && clubPtr.has(r.id), `${t.id} ${c.field}`);
    assert.ok((set.entry.truncated?.rows ?? 0) > 0, 'what did not fit is counted');
  });
});

describe('redactAuditClub on match labels (gap 6)', () => {
  const head = (over: Partial<AuditEntry['targets'][number]>) => ({
    type: 'fixture',
    id: 's#f1',
    op: 'update',
    changeCount: 0,
    ...over,
  });
  const entry = (targets: AuditEntry['targets']) =>
    ({ id: 'e', at: '2026-11-13T00:00:00.000Z', tenant: T, targets }) as unknown as AuditEntry;

  test('rewrites the deleted side, keeps the other; a label it cannot split is dropped', () => {
    const out = audit.redactAuditClub(
      entry([
        head({ label: 'Xa v Yb', clubIds: ['x', 'y'] }),
        head({ id: 's#f2', label: 'Yb v Xa', clubIds: ['y', 'x'] }),
        head({ id: 's#f3', label: 'Odd v name v Yb', clubIds: ['x', 'y'] }),
        head({ id: 's#f4', label: 'Kc v Yb', clubIds: ['k', 'y'] }),
        head({ id: 's#f5', label: 'Yb v Typed opponent', clubIds: ['y', ''] }),
      ]),
      null,
      'x',
      { placeholder: '[removed]' },
    );
    assert.deepEqual(
      out.entry.targets.map((t) => t.label),
      ['Removed club v Yb', 'Yb v Removed club', undefined, 'Kc v Yb', 'Yb v Typed opponent'],
    );
    // Idempotent.
    const again = audit.redactAuditClub(out.entry, null, 'x', { placeholder: '[removed]' });
    assert.equal(again.changed, false);
  });

  test('a value naming the deleted club is replaced; the other side of the same change stays', () => {
    const detail: AuditDetail = {
      targets: [
        {
          type: 'fixture',
          id: 's#f1',
          changes: [
            {
              field: 'home',
              from: 'Yb',
              to: 'Xa',
              ref: { type: 'club', id: 'x' },
              fromRef: { type: 'club', id: 'y' },
            },
            {
              field: 'away',
              from: 'Xa',
              to: 'Yb',
              ref: { type: 'club', id: 'y' },
              fromRef: { type: 'club', id: 'x' },
            },
            { field: 'teams', to: 'Xa', ref: { type: 'club', id: 'x' } },
            { field: 'teams', to: 'Yb', ref: { type: 'club', id: 'y' } },
          ],
        },
      ],
      mentions: [],
    };
    const out = audit.redactAuditClub(entry([head({})]), detail, 'x', { placeholder: '[removed]' });
    const cs = out.detail!.targets[0].changes;
    assert.deepEqual(cs[0], {
      field: 'home',
      from: 'Yb',
      to: 'Removed club',
      ref: { type: 'club', id: 'x' },
      fromRef: { type: 'club', id: 'y' },
    });
    assert.deepEqual(cs[1], {
      field: 'away',
      from: 'Removed club',
      to: 'Yb',
      ref: { type: 'club', id: 'y' },
      fromRef: { type: 'club', id: 'x' },
    });
    assert.deepEqual(cs[2], { field: 'teams', ref: { type: 'club', id: 'x' }, scrubbed: true });
    assert.deepEqual(cs[3], { field: 'teams', to: 'Yb', ref: { type: 'club', id: 'y' } });
  });
});

describe("a club's history reaches entries that name it only in a label", () => {
  const OPERATOR = devAuth('sub-op', 'op@platform', [
    { tenantId: '*', role: 'operator', clubIds: [] },
  ]);
  const P = { id: 'club-p', name: 'Pinecrest Pelicans' };
  const Q = { id: 'club-q', name: 'Quarry Hill Quails' };
  const clubHistory = (id: string, qs = 'limit=200', auth = ADMIN) =>
    json<Page>(call('GET', `/admin/audit/entity/club/${id}?${qs}`, undefined, auth));
  const opClubHistory = (id: string) =>
    json<Page>(
      call('GET', `/platform/tenants/${T}/audit/entity/club/${id}?limit=200`, undefined, OPERATOR),
    );
  /** One stored entry naming `clubId` in a fixture label only (a `C#` pointer, no `E#club`). */
  async function labelOnlyEntry(
    clubId: string,
    visibility: 'tenant' | 'operator' = 'tenant',
    at?: string,
  ) {
    const scope = audit.newAuditScope({
      tenant: T,
      actor: { kind: 'user', key: 'sub-admin', via: 'console' },
      action: 'series.fixtures.edit',
      visibility,
      ...(at ? { at } : {}),
    });
    audit.runAudited(scope, () => {
      audit.auditTarget({
        type: 'fixture',
        id: `s-lbl#${scope.id}`,
        label: `${P.name} v Opponent`,
        clubIds: [clubId, ''],
        op: 'update',
      });
    });
    const set = audit.buildEntry(scope, { status: 200 });
    await repo.putAuditEntry(set);
    return set.entry;
  }
  let editEntry: AuditEntry;
  let clubPatch: AuditEntry;

  before(async () => {
    for (const c of [P, Q]) await repo.createClub(T, club(c.id, c.name));
  });

  test('a fixture edit P v Q is in both clubs’ history', async () => {
    const created = await json<{ version: number }>(
      call('POST', '/series', {
        id: 's-pq',
        name: 'PQ League',
        startDate: '2027-04-03',
        teams: [P.id, Q.id],
        participants: [part(P), part(Q)],
        fixtures: [fx('pq1', '2027-04-03', P.id, Q.id)],
      }),
      201,
    );
    await json(
      call('PATCH', '/series/s-pq', {
        version: created.version,
        fixtures: [fx('pq1', '2027-04-04', P.id, Q.id)],
      }),
    );
    editEntry = latest(await history('series', 's-pq'), 'series.fixtures.edit');
    for (const c of [P, Q])
      assert.ok(
        (await clubHistory(c.id)).items.some((e) => e.id === editEntry.id),
        `the fixture edit is in ${c.id}'s history`,
      );
  });

  test('a club PATCH (both pointers) appears exactly once', async () => {
    const cur = (await repo.getClub(T, P.id))!;
    await json(call('PATCH', `/clubs/${P.id}`, { color: '#654321', version: cur.version }));
    const page = await clubHistory(P.id);
    clubPatch = page.items.find((e) => e.targets.some((t) => t.type === 'club' && t.id === P.id))!;
    assert.ok(clubPatch, `a club entry in ${JSON.stringify(page.items.map((e) => e.action))}`);
    assert.equal(page.items.filter((e) => e.id === clubPatch.id).length, 1);
    const ids = page.items.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'no entry listed twice');
  });

  test('paging across pages returns every entry exactly once, newest first', async () => {
    for (let i = 0; i < 5; i++) await labelOnlyEntry(P.id);
    const cur = (await repo.getClub(T, P.id))!;
    await json(call('PATCH', `/clubs/${P.id}`, { color: '#abcdef', version: cur.version }));
    const all = (await clubHistory(P.id)).items;
    assert.ok(all.length >= 8, `${all.length} entries`);
    const seen: AuditEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await clubHistory(
        P.id,
        `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      assert.ok(page.items.length <= 2);
      seen.push(...page.items);
      cursor = page.cursor;
      pages++;
    } while (cursor && pages < 50);
    assert.ok(pages > 1, 'more than one page');
    assert.deepEqual(
      seen.map((e) => e.id),
      all.map((e) => e.id),
    );
    const order = seen.map((e) => `${e.at}#${e.id}`);
    assert.deepEqual(order, [...order].sort().reverse(), 'newest first');
  });

  test('an operator-only entry naming the club stays hidden from the union admin', async () => {
    const op = await labelOnlyEntry(P.id, 'operator');
    assert.ok(!(await clubHistory(P.id)).items.some((e) => e.id === op.id));
    assert.ok((await opClubHistory(P.id)).items.some((e) => e.id === op.id));
  });

  test('paging crosses month partitions: every entry once, newest first', async () => {
    const R = { id: 'club-r', name: 'Riverbend Ravens' };
    await repo.createClub(T, club(R.id, R.name));
    // This month and next (the newest partition a read walks): three entries in each.
    const now = new Date();
    const first = (m: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    const made: AuditEntry[] = [];
    for (const m of [0, 1])
      for (let k = 0; k < 3; k++)
        made.push(
          await labelOnlyEntry(
            R.id,
            'tenant',
            new Date(first(m).getTime() + k * 60_000).toISOString(),
          ),
        );
    const seen: AuditEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await clubHistory(
        R.id,
        `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      assert.ok(page.items.length <= 2);
      seen.push(...page.items);
      cursor = page.cursor;
      pages++;
    } while (cursor && pages < 20);
    assert.deepEqual(
      seen.map((e) => e.id),
      [...made].reverse().map((e) => e.id),
      'every entry once, newest first, across both months',
    );
    assert.ok(new Set(seen.map((e) => e.at.slice(0, 7))).size === 2, 'two months read');
  });

  test('a cursor this route did not issue is a 400', async () => {
    const res = await call('GET', `/admin/audit/entity/club/${P.id}?cursor=bm9wZQ`);
    assert.equal(res.status, 400);
  });
});
