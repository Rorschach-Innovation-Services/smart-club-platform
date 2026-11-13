/**
 * Audit trail Phase 3 (ADR 0023), third group: field-level old → new values for postponements,
 * captain's reports, squads and team captains, document requests, Match Centre console actions
 * and operator routes — plus the club-delete erasure of player mentions — through the REAL Hono
 * app on an in-process dynalite. Contract: docs/api/audit.md. Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuditChange,
  AuditDetail,
  AuditEntry,
  CaptainsReport,
  Series,
  TenantConfig,
} from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4881; // unique
const TABLE = 'SmartClubAuditPhase3OpsTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';
const UPLOADS = await mkdtemp(path.join(tmpdir(), 'audit-ops-'));
process.env.LOCAL_UPLOADS_DIR = UPLOADS;

const T = 'dolphins';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const sastToday = (h: number) => {
  const day = new Date(Date.now() + 2 * HOUR).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 2 * HOUR + h * 3600_000);
};
const AT_1900 = sastToday(19);
const sastDay = (offset: number) =>
  new Date(AT_1900.getTime() + 2 * HOUR + offset * DAY).toISOString().slice(0, 10);
const TODAY = sastDay(0);
const TOMORROW = sastDay(1);
const S1 = 's-premier-t20';
const S_POST = 's-postpone';
const S_MC = 's-medicoach';
const SECRET = 'local-dev-captains-report-link-secret'; // env.ts's LOCAL_AUTH fallback
const K = (n: number) => String(n).repeat(64).slice(0, 64);

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const ADMIN = devAuth('sub-admin', 'admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const ADMIN_B = devAuth('sub-admin-b', 'b@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const OPERATOR = devAuth('sub-op', 'op@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let keys: typeof import('../src/keys.js');
let cr: typeof import('../src/captains-reports.js');
let squad: typeof import('../src/squad-requests.js');
let audit: typeof import('../src/audit.js');
let teamKey = '';

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
const publicCall = (method: string, p: string, body?: unknown) =>
  app.request(p, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  assert.equal(r.status, status, text);
  return JSON.parse(text) as T;
}

type Page = { items: AuditEntry[]; cursor?: string };
type Entry = { entry: AuditEntry; detail: AuditDetail | null };

const history = (type: string, id: string) =>
  json<Page>(call('GET', `/admin/audit/entity/${type}/${encodeURIComponent(id)}?limit=200`));
const operatorHistory = (type: string, id: string) =>
  json<Page>(
    app.request(`/platform/tenants/${T}/audit/entity/${type}/${encodeURIComponent(id)}?limit=200`, {
      headers: { 'x-dev-auth': OPERATOR },
    }),
  );
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

/** Every row of the tenant's current audit month partition, as one JSON text. */
async function auditText(): Promise<string> {
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
  return JSON.stringify(items);
}

/**
 * Answer every roster-existence BatchGet (key-only projection over PLAYER# keys) with all of its
 * keys unprocessed, as a throttled DynamoDB would; every other request reaches dynalite. Returns
 * the undo.
 */
function failExistenceReads(): () => void {
  type Listener = (req: IncomingMessage, res: ServerResponse) => void;
  const original = ddb.listeners('request')[0] as Listener;
  ddb.removeAllListeners('request');
  ddb.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers['x-amz-target'] !== 'DynamoDB_20120810.BatchGetItem') return original(req, res);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ask = (
        JSON.parse(raw.toString('utf8')) as {
          RequestItems?: Record<
            string,
            { ProjectionExpression?: string; Keys: Array<{ sk?: { S?: string } }> }
          >;
        }
      ).RequestItems?.[TABLE];
      if (
        ask?.ProjectionExpression === 'pk, sk' &&
        ask.Keys.every((k) => k.sk?.S?.startsWith('PLAYER#'))
      ) {
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
        res.end(JSON.stringify({ Responses: { [TABLE]: [] }, UnprocessedKeys: { [TABLE]: ask } }));
        return;
      }
      const replay = Object.assign(Readable.from([raw]), {
        headers: req.headers,
        method: req.method,
        url: req.url,
      });
      original(replay as unknown as IncomingMessage, res);
    });
  });
  return () => {
    ddb.removeAllListeners('request');
    ddb.on('request', original);
  };
}

const club = (id: string, name: string, chair?: { name: string; email?: string; cell?: string }) =>
  ({
    id,
    name,
    district: 'd',
    sub: '',
    chair: chair?.name ?? `Chair ${id}`,
    exco: { chair: chair ?? { name: `Chair ${id}` } },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#000',
    ground: { venue: 'Ground' },
    leagues: ['premier'],
    version: 1,
  }) as never;

const P_UMZ = { teamId: 'umzinto', clubId: 'umzinto', name: 'Umzinto CC' };
const P_AW = { teamId: 'african-warriors', clubId: 'african-warriors', name: 'African Warriors' };
const released = (id: string, name: string, fixtures: unknown[]) =>
  ({
    id,
    name,
    leagueKey: 'premier',
    startDate: TODAY,
    teams: ['umzinto', 'african-warriors'],
    participants: [P_UMZ, P_AW].map((p) => ({ ...p, venue: 'Kingsmead Oval' })),
    fixtures,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

const player = (n: number, clubId: string, firstName: string, lastName: string) =>
  ({
    naturalKey: K(n),
    clubId,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}@umzinto.test`,
    cell: `083123456${n}`,
    isMinor: false,
    dob: '1990-01-01',
    team: 'premier',
    consentAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  }) as never;

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  keys = await import('../src/keys.js');
  cr = await import('../src/captains-reports.js');
  squad = await import('../src/squad-requests.js');
  audit = await import('../src/audit.js');
  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig(T);
  const cfg = (await repo.getTenantConfig(T))!;
  teamKey = (cfg.leagues ?? [])[0]?.key ?? '';
  await repo.putTenantConfig({
    ...cfg,
    features: { ...(cfg.features ?? {}), medicoachSync: true, preMatchSquadLinks: true },
    integrations: { medicoach: { goLiveDate: sastDay(-30) } },
  } as unknown as TenantConfig);
  await repo.createClub(
    T,
    club('umzinto', 'Umzinto CC', { name: 'Uma Chair', email: 'chair@umzinto.test' }),
  );
  await repo.createClub(
    T,
    club('african-warriors', 'African Warriors', { name: 'Awa Chair', email: 'chair@aw.test' }),
  );
  await repo.createClub(T, club('club-x', 'Xi CC'));
  await repo.createClub(T, club('club-y', 'Yonder CC'));
  await repo.putSeries(
    T,
    released(S1, 'Premier T20', [
      { id: 'f0', round: 1, date: TODAY, time: '09:00', home: 'umzinto', away: 'african-warriors' },
      {
        id: 'f1',
        round: 2,
        date: TOMORROW,
        time: '09:00',
        home: 'umzinto',
        away: 'african-warriors',
      },
    ]),
  );
  await repo.putSeries(
    T,
    released(S_POST, 'Postponed League', [
      {
        id: 'p1',
        round: 1,
        date: sastDay(10),
        time: '10:00',
        home: 'umzinto',
        away: 'african-warriors',
      },
    ]),
  );
  await repo.putSeries(
    T,
    released(S_MC, 'Match Centre League', [
      {
        id: 'm1',
        round: 1,
        date: sastDay(30),
        time: '10:00',
        home: 'umzinto',
        away: 'african-warriors',
      },
    ]),
  );
  await repo.createPlayer(T, player(1, 'umzinto', 'Adult', 'Captain'));
  await repo.createPlayer(T, player(2, 'umzinto', 'Second', 'Player'));
});

after(() => stopDynalite(ddb));

describe('club delete strips player mentions of that club', () => {
  let seq = 0;
  const body = (firstName: string, lastName: string) => {
    seq++;
    return {
      firstName,
      lastName,
      idType: 'passport',
      idNumber: `PXO${String(seq).padStart(7, '0')}`,
      dob: '1994-02-12',
      nationality: 'Zimbabwean',
      race: 'African',
      gender: 'Female',
      cell: `08390001${String(seq).padStart(2, '0')}`,
      email: `${firstName.toLowerCase()}@example.org`,
      team: teamKey,
      district: 'Ethekwini',
    };
  };

  async function addPlayer(clubId: string, b: ReturnType<typeof body>) {
    const res = await call('POST', `/clubs/${clubId}/players`, b);
    const text = await res.text();
    assert.ok(res.status === 200 || res.status === 201, text);
    return JSON.parse(text) as { naturalKey: string };
  }

  test('a clearance X → Y for a player at X: deleting X removes the name; Y keeps its player', async () => {
    const p = await addPlayer('club-x', body('Xolani', 'Xabanisa'));
    const q = await addPlayer('club-y', body('Yusuf', 'Yengwa'));
    const opened = await json<{ id: string }>(
      call('POST', '/clubs/club-y/clearances', {
        fromClubId: 'club-x',
        playerNaturalKey: p.naturalKey,
      }),
      201,
    );
    // The player mention carries the club the player was on (the source, X).
    const create = latest(await history('clearance', opened.id), 'clearance.create');
    const m = (await entryOf(create)).detail!.mentions.find((x) => x.type === 'player')!;
    assert.deepEqual(m, {
      type: 'player',
      id: p.naturalKey,
      label: 'Xolani Xabanisa',
      clubId: 'club-x',
    });
    // Y's player is named in another entry (a document request link copy).
    const copy = await json<{ url: string }>(
      call('POST', '/admin/doc-requests/link', { clubId: 'club-y', naturalKey: q.naturalKey }),
    );
    assert.ok(copy.url);
    const before = await auditText();
    assert.ok(before.includes('Xabanisa') && before.includes('Yengwa'), 'precondition');

    await json(call('DELETE', '/clubs/club-x'));
    const text = await auditText();
    for (const secret of ['Xolani', 'Xabanisa'])
      assert.ok(!text.includes(secret), `audit rows still hold ${secret}`);
    // The clearance entry survives with Y's side; the player mention lost its name.
    const { detail } = await entryOf(create);
    const after = detail!.mentions.find((x) => x.type === 'player')!;
    assert.notEqual(after.label, 'Xolani Xabanisa');
    assert.equal(
      detail!.mentions.find((x) => x.type === 'club' && x.id === 'club-y')!.label,
      'Yonder CC',
    );
    // Y's player keeps their label wherever it was recorded.
    const link = latest(await history('player', q.naturalKey), 'link.copy');
    const qm = (await entryOf(link)).detail!.mentions.find((x) => x.id === q.naturalKey)!;
    assert.equal(qm.label, 'Yusuf Yengwa');
    assert.equal(qm.clubId, 'club-y');
  });
});

describe('postponements', () => {
  const REASON = 'POSTPONE-REASON-Q1Z';
  const NOTE = 'COUNTER-NOTE-W8V';
  const RULING = 'RULING-NOTE-T5R';
  let id = '';
  let version = 0;

  test('opened: status, both clubs with refs, the proposal, the reason masked', async () => {
    const r = await json<{ id: string; version: number }>(
      call('POST', '/clubs/umzinto/postponements', {
        seriesId: S_POST,
        fixtureId: 'p1',
        proposedDate: sastDay(17),
        reason: REASON,
      }),
      201,
    );
    id = r.id;
    version = r.version;
    const create = latest(await history('postponement', id), 'postponement.create');
    assert.equal(create.actor.sub, 'sub-admin');
    const head = create.targets.find((t) => t.type === 'postponement')!;
    assert.equal(head.clubId, 'umzinto');
    const cs = changesOf((await entryOf(create)).detail, 'postponement', id);
    assert.deepEqual(change(cs, 'status'), { field: 'status', to: 'open' });
    assert.deepEqual(change(cs, 'requestingClub'), {
      field: 'requestingClub',
      to: 'Umzinto CC',
      ref: { type: 'club', id: 'umzinto' },
    });
    assert.deepEqual(change(cs, 'opposingClub'), {
      field: 'opposingClub',
      to: 'African Warriors',
      ref: { type: 'club', id: 'african-warriors' },
    });
    assert.deepEqual(change(cs, 'proposedDate'), { field: 'proposedDate', to: sastDay(17) });
    assert.deepEqual(change(cs, 'reason'), { field: 'reason', masked: true });
    // In both clubs' and the fixture's history.
    assert.equal(
      latest(await history('club', 'african-warriors'), 'postponement.create').id,
      create.id,
    );
    assert.equal(
      latest(await history('fixture', `${S_POST}#p1`), 'postponement.create').id,
      create.id,
    );
  });

  test('counter by the other club: proposed date old → new, turn, the note masked', async () => {
    const r = await json<{ version: number }>(
      call(
        'POST',
        `/clubs/african-warriors/postponements/${id}/counter`,
        { proposedDate: sastDay(18), note: NOTE, version },
        ADMIN_B,
      ),
    );
    version = r.version;
    const counter = latest(await history('postponement', id), 'postponement.counter');
    assert.equal(counter.actor.sub, 'sub-admin-b');
    const cs = changesOf((await entryOf(counter)).detail, 'postponement', id);
    assert.deepEqual(change(cs, 'proposedDate'), {
      field: 'proposedDate',
      from: sastDay(17),
      to: sastDay(18),
    });
    assert.deepEqual(change(cs, 'awaiting'), {
      field: 'awaiting',
      from: 'opposing',
      to: 'requesting',
    });
    assert.deepEqual(change(cs, 'note'), { field: 'note', masked: true });
  });

  test('accept: ONE entry shows the request change and the fixture change, no duplicate targets', async () => {
    await json(call('POST', `/clubs/umzinto/postponements/${id}/accept`, { version }));
    const accept = latest(await history('postponement', id), 'postponement.accept');
    assert.equal(accept.action, 'postponement.accept');
    const keysOf = accept.targets.map((t) => `${t.type}:${t.id}`);
    assert.equal(new Set(keysOf).size, keysOf.length, `duplicate targets: ${keysOf}`);
    const { detail } = await entryOf(accept);
    const req = changesOf(detail, 'postponement', id);
    assert.deepEqual(change(req, 'status'), { field: 'status', from: 'open', to: 'applied' });
    assert.deepEqual(change(req, 'agreedDate'), { field: 'agreedDate', to: sastDay(18) });
    assert.deepEqual(change(changesOf(detail, 'fixture', `${S_POST}#p1`), 'date'), {
      field: 'date',
      from: sastDay(10),
      to: sastDay(18),
    });
    // The fixture is a target, so it is not mentioned again.
    assert.ok(!detail!.mentions.some((m) => m.type === 'fixture'));
    assert.equal(
      latest(await history('fixture', `${S_POST}#p1`), 'postponement.accept').id,
      accept.id,
    );
  });

  test('admin ruling with a venue (ref), then a club acknowledges (ref the club)', async () => {
    await json(call('PUT', '/venues/v-ruling', { name: 'Ruling Oval' }));
    const ruled = await json<{ version: number }>(
      call('POST', `/admin/postponements/${id}/override`, {
        date: sastDay(20),
        venueId: 'v-ruling',
        note: RULING,
      }),
    );
    const over = latest(await history('postponement', id), 'postponement.override');
    const cs = changesOf((await entryOf(over)).detail, 'postponement', id);
    assert.deepEqual(change(cs, 'status'), { field: 'status', from: 'applied', to: 'admin-final' });
    assert.deepEqual(change(cs, 'proposedVenue'), {
      field: 'proposedVenue',
      to: 'Ruling Oval',
      ref: { type: 'venue', id: 'v-ruling' },
    });
    assert.equal(latest(await history('venue', 'v-ruling'), 'postponement.override').id, over.id);
    await json(
      call('POST', `/clubs/umzinto/postponements/${id}/acknowledge`, { version: ruled.version }),
    );
    const ack = latest(await history('postponement', id), 'postponement.acknowledge');
    assert.deepEqual(changesOf((await entryOf(ack)).detail, 'postponement', id), [
      { field: 'acknowledged.umzinto', to: true, ref: { type: 'club', id: 'umzinto' } },
    ]);
  });

  test('no stored row holds the reason or either note', async () => {
    const text = await auditText();
    for (const secret of [REASON, NOTE, RULING]) assert.ok(!text.includes(secret), secret);
  });
});

describe("captain's reports", () => {
  const reportId = `${S1}~f0~umzinto`;
  const COMMENT = 'UMPIRE-COMMENT-H3J';
  const OTHER = 'OTHER-CONCERN-N4B';
  const GENERAL = 'GENERAL-REMARKS-L2C';
  const FREE = 'Freddy Freetext';
  const ratings = { decisions: 4, pressure: 3, behaviour: 5, communication: 4, regulations: 2 };
  let rated = { id: '', displayName: '' };
  let linked = { id: '', displayName: '' };
  let submitEntry: AuditEntry;

  test('a chair forwards the link: recipient kind, the player named with a ref, contact masked', async () => {
    rated = await json(call('POST', '/umpires', { displayName: 'U.Rated' }), 201);
    linked = await json(call('POST', '/umpires', { displayName: 'U.Linked' }), 201);
    const at = new Date().toISOString();
    await repo.createCaptainsReport(T, {
      id: reportId,
      seriesId: S1,
      fixtureId: 'f0',
      clubId: 'umzinto',
      status: 'pending',
      source: 'manual',
      matchDate: TODAY,
      side: 'home',
      clubName: 'Umzinto CC',
      opponentName: 'African Warriors',
      competition: 'Premier T20',
      umpiresSnapshot: [],
      recipient: { kind: 'chair', memberId: 'm-chair-1', name: 'Uma Chair' },
      captainName: '',
      umpires: [],
      general: '',
      linkExpiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      createdAt: at,
      updatedAt: at,
    } as unknown as CaptainsReport);
    const report = (await repo.getCaptainsReport(T, S1, 'f0', 'umzinto'))!;
    const chairToken = cr.reportLink(T, report, SECRET, 'http://x').token;
    await json(
      publicCall('POST', `/captains-report-link/${chairToken}/forward`, {
        candidateId: cr.forwardCandidateId(SECRET, T, reportId, K(1)),
      }),
    );
    const fwd = latest(await history('captains-report', reportId), 'captains-report.forward');
    assert.equal(fwd.actor.kind, 'link');
    assert.equal(fwd.actor.recipientKind, 'chair');
    const cs = changesOf((await entryOf(fwd)).detail, 'captains-report', reportId);
    assert.deepEqual(change(cs, 'recipientKind'), {
      field: 'recipientKind',
      from: 'chair',
      to: 'captain',
    });
    assert.deepEqual(change(cs, 'recipient'), {
      field: 'recipient',
      to: 'Adult Captain',
      ref: { type: 'player', id: K(1) },
    });
    assert.deepEqual(change(cs, 'recipientContact'), { field: 'recipientContact', masked: true });
    // The forward fills the captain's name: a person typed in, masked.
    assert.deepEqual(change(cs, 'captainName'), { field: 'captainName', masked: true });
    // The forward is in the captain's (player's) history.
    assert.equal(latest(await history('player', K(1)), 'captains-report.forward').id, fwd.id);
  });

  test('the captain submits by link: attributed to the link recipient, ratings kept, no comment text', async () => {
    const forwarded = (await repo.getCaptainsReport(T, S1, 'f0', 'umzinto'))!;
    const token = cr.reportLink(T, forwarded, SECRET, 'http://x').token;
    await json(
      publicCall('PUT', `/captains-report-link/${token}`, {
        captainName: 'Adult Captain',
        declaration: true,
        general: GENERAL,
        umpires: [
          {
            umpireId: rated.id,
            name: rated.displayName,
            ratings,
            concerns: { lbw: true },
            otherConcern: OTHER,
            comments: COMMENT,
          },
          { name: FREE, ratings, concerns: {}, otherConcern: '', comments: `${COMMENT}-2` },
        ],
        submit: true,
      }),
    );
    submitEntry = latest(await history('captains-report', reportId), 'captains-report.save');
    assert.equal(submitEntry.actor.kind, 'link');
    assert.equal(submitEntry.actor.recipientKind, 'captain');
    assert.equal(submitEntry.actor.recipientId, forwarded.recipient.memberId);
    const head = submitEntry.targets.find((t) => t.id === reportId)!;
    assert.equal(head.op, 'submit');
    assert.equal(head.label, 'Umzinto CC v African Warriors');
    const cs = changesOf((await entryOf(submitEntry)).detail, 'captains-report', reportId);
    const ref = { type: 'umpire', id: rated.id };
    assert.deepEqual(change(cs, 'status'), { field: 'status', from: 'pending', to: 'submitted' });
    assert.deepEqual(change(cs, 'umpires.1.umpire'), {
      field: 'umpires.1.umpire',
      to: 'U.Rated',
      ref,
    });
    assert.deepEqual(change(cs, 'umpires.1.ratings'), {
      field: 'umpires.1.ratings',
      to: 'decisions 4, pressure 3, behaviour 5, communication 4, regulations 2',
      ref,
    });
    assert.deepEqual(change(cs, 'umpires.1.concerns'), {
      field: 'umpires.1.concerns',
      to: ['lbw'],
      ref,
    });
    for (const f of ['umpires.1.comments', 'umpires.1.otherConcern'])
      assert.deepEqual(change(cs, f), { field: f, masked: true, ref }, f);
    // A free-text umpire has no record to scrub by: the name is masked.
    assert.deepEqual(change(cs, 'umpires.2.umpire'), { field: 'umpires.2.umpire', masked: true });
    assert.deepEqual(change(cs, 'general'), { field: 'general', masked: true });
    // The rated umpire's history holds the report entry.
    assert.equal(
      latest(await history('umpire', rated.id), 'captains-report.save').id,
      submitEntry.id,
    );
    const text = await auditText();
    for (const secret of [COMMENT, OTHER, GENERAL, FREE]) assert.ok(!text.includes(secret), secret);
  });

  test('admin attribution: the typed name → the registry umpire, both under its ref', async () => {
    await json(
      call('POST', `/captains-reports/${reportId}/umpires/1/attribute`, {
        umpireId: linked.id,
        action: 'linked',
      }),
    );
    const attr = latest(
      await history('captains-report', reportId),
      'captains-report.attribute-umpire',
    );
    const ref = { type: 'umpire', id: linked.id };
    assert.deepEqual(changesOf((await entryOf(attr)).detail, 'captains-report', reportId), [
      { field: 'umpires.2.umpire', from: FREE, to: 'U.Linked', ref },
      { field: 'umpires.2.attribution', to: 'linked', ref },
    ]);
    assert.equal(
      latest(await history('umpire', linked.id), 'captains-report.attribute-umpire').id,
      attr.id,
    );
  });

  test('erasing an umpire scrubs the report entries that rated them', async () => {
    await json(call('DELETE', `/umpires/${rated.id}`));
    const { detail } = await entryOf(submitEntry);
    const cs = changesOf(detail, 'captains-report', reportId);
    for (const f of ['umpires.1.umpire', 'umpires.1.ratings', 'umpires.1.concerns']) {
      const c = change(cs, f)!;
      assert.equal(c.scrubbed, true, f);
      assert.equal(c.to, undefined, f);
    }
    assert.ok(!JSON.stringify(detail).includes('U.Rated'));
    // Another umpire's attribution is untouched.
    const attr = latest(
      await history('captains-report', reportId),
      'captains-report.attribute-umpire',
    );
    const cs2 = changesOf((await entryOf(attr)).detail, 'captains-report', reportId);
    assert.equal(change(cs2, 'umpires.2.umpire')!.to, 'U.Linked');
  });
});

describe('squads and team captains', () => {
  const GUEST = 'Gus Guestname';
  let requestId = '';

  test('a squad submit by link: status, counts, players as refs, guest names not stored', async () => {
    const notices: Array<{ requestId: string; token: string }> = [];
    await squad.openPreMatchSquadRequests(T, (await repo.getTenantConfig(T))!, {
      repo,
      now: () => AT_1900,
      log: () => {},
      sendNotice: async (n: { requestId: string; token: string; channels: string[] }) => {
        notices.push(n);
        return n.channels.map((channel) => ({ channel, status: 'sent' }));
      },
      whatsappTemplateStatus: () => 'pending',
      linkSecret: () => SECRET,
    } as never);
    const n = notices.find((x) => x.requestId === `${S1}~f1~umzinto`);
    assert.ok(n, 'the squad request was opened');
    requestId = n.requestId;
    const view = (await (await app.request(`/squad-link/${n.token}`)).json()) as {
      request: { modified: string };
      roster: Array<{ id: string; name: string }>;
    };
    const adult = view.roster.find((r) => r.name === 'Adult Captain')!;
    await json(
      publicCall('PUT', `/squad-link/${n.token}`, {
        expectedModified: view.request.modified,
        players: [adult.id],
        captainId: adult.id,
        guests: [{ name: GUEST }],
        submit: true,
      }),
    );
    const save = latest(await history('squad-request', requestId), 'squad-request.save');
    assert.equal(save.actor.kind, 'link');
    assert.equal(save.targets.find((t) => t.id === requestId)!.op, 'submit');
    const cs = changesOf((await entryOf(save)).detail, 'squad-request', requestId);
    const ref = { type: 'player', id: K(1) };
    assert.deepEqual(change(cs, 'status'), { field: 'status', from: 'pending', to: 'submitted' });
    assert.deepEqual(change(cs, 'selection.players'), { field: 'selection.players', to: 1 });
    assert.deepEqual(change(cs, 'selection.guests'), { field: 'selection.guests', to: 1 });
    assert.deepEqual(change(cs, 'selection.captain'), {
      field: 'selection.captain',
      to: 'Adult Captain',
      ref,
    });
    assert.deepEqual(change(cs, 'selection.player'), {
      field: 'selection.player',
      to: 'Adult Captain',
      ref,
    });
    assert.ok(!(await auditText()).includes(GUEST));
  });

  test('admin void: status submitted → void', async () => {
    await json(call('POST', `/admin/squad-requests/${encodeURIComponent(requestId)}/void`));
    const v = latest(await history('squad-request', requestId), 'squad-request.void');
    assert.deepEqual(
      change(changesOf((await entryOf(v)).detail, 'squad-request', requestId), 'status'),
      { field: 'status', from: 'submitted', to: 'void' },
    );
  });

  test('team captain set, then changed by another admin: name old → new with refs', async () => {
    const cap = await json<{ competitions: Array<{ scope: string }> }>(
      call('GET', '/clubs/umzinto/teams/umzinto/captain'),
    );
    const scope = cap.competitions[0]?.scope;
    assert.ok(scope, 'the team plays a competition');
    const { candidates } = await json<{ candidates: Array<{ id: string; name: string }> }>(
      call('GET', '/clubs/umzinto/teams/umzinto/captain-candidates'),
    );
    const pick = (name: string) => candidates.find((x) => x.name === name)!.id;
    await json(
      call('PUT', '/clubs/umzinto/teams/umzinto/captain', {
        scope,
        candidateId: pick('Adult Captain'),
      }),
    );
    await json(
      call(
        'PUT',
        '/clubs/umzinto/teams/umzinto/captain',
        { scope, candidateId: pick('Second Player') },
        ADMIN_B,
      ),
    );
    const set = latest(await history('player', K(2)), 'club.team-captain.set');
    assert.equal(set.actor.sub, 'sub-admin-b');
    assert.deepEqual(changesOf((await entryOf(set)).detail, 'club', 'umzinto'), [
      {
        field: `captain.umzinto.${scope}`,
        from: 'Adult Captain',
        to: 'Second Player',
        ref: { type: 'player', id: K(2) },
        fromRef: { type: 'player', id: K(1) },
      },
    ]);
  });
});

describe('document requests', () => {
  test('admin send: players named (club + name), counts; the upload completes the status', async () => {
    await json(
      call('POST', '/admin/doc-requests', {
        players: [{ clubId: 'umzinto', naturalKey: K(2) }],
        idempotencyKey: 'audit-ops-0001',
      }),
    );
    const send = latest(await history('player', K(2)), 'doc-request.send');
    assert.equal(send.counts?.players, 1);
    assert.ok('sent' in (send.counts ?? {}) || 'skipped' in (send.counts ?? {}));
    const { detail } = await entryOf(send);
    assert.deepEqual(
      detail!.mentions.find((m) => m.type === 'player'),
      { type: 'player', id: K(2), label: 'Second Player', clubId: 'umzinto' },
    );
    const req = send.targets.find((t) => t.type === 'doc-request')!;
    assert.deepEqual(change(changesOf(detail, 'doc-request', req.id), 'status'), {
      field: 'status',
      to: 'pending',
    });

    const copy = await json<{ url: string }>(
      call('POST', '/admin/doc-requests/link', { clubId: 'umzinto', naturalKey: K(2) }),
    );
    const token = new URL(copy.url).pathname.split('/d/').at(-1)!;
    const name = `player-id-${randomUUID()}.pdf`;
    await mkdir(path.join(UPLOADS, T, 'umzinto'), { recursive: true });
    await writeFile(path.join(UPLOADS, T, 'umzinto', name), '%PDF-1.4 test');
    await json(
      publicCall('POST', `/doc-request-link/${token}/complete`, {
        objectKey: `local/${T}/umzinto/${name}`,
      }),
    );
    const done = latest(await history('doc-request', req.id), 'doc-request.complete');
    assert.equal(done.actor.kind, 'link');
    assert.deepEqual(changesOf((await entryOf(done)).detail, 'doc-request', req.id), [
      { field: 'status', from: 'pending', to: 'completed' },
    ]);
    assert.ok(!(await auditText()).includes(name), 'the object key is not stored');
  });
});

describe('Match Centre console', () => {
  test('sync now records only that it was triggered — nothing the sync writes', async () => {
    const res = await call('POST', '/integrations/medicoach/sync-now');
    assert.equal(res.status, 200, await res.clone().text());
    const page = await json<Page>(call('GET', '/admin/audit?limit=50'));
    const sync = latest(page, 'medicoach.sync-trigger');
    assert.equal(sync.actor.sub, 'sub-admin');
    assert.deepEqual(sync.targets, []);
    assert.equal((await entryOf(sync)).detail, null);
  });

  test('a helper inside runUnaudited adds nothing to the request scope', () => {
    const scope = audit.newAuditScope();
    audit.runAudited(scope, () => {
      audit.runUnaudited(() =>
        audit.auditTarget({ type: 'fixture', id: 's#f', op: 'update', changes: [] }),
      );
      audit.auditSet({ action: 'kept' });
    });
    assert.deepEqual(scope.targets, []);
    assert.equal(scope.action, 'kept');
  });

  test('applying a held change: the decision and the fixture change in one entry', async () => {
    const ref = `mc-ref-${randomUUID().slice(0, 8)}`;
    await repo.putSyncConflict(T, {
      ref,
      seriesId: S_MC,
      fixtureId: 'm1',
      current: { date: sastDay(30), time: '10:00' },
      proposed: {
        scheduledTime: null,
        timeTbc: false,
        dateTbc: false,
        venue: null,
        postponed: true,
        cancelled: false,
        changedAt: new Date().toISOString(),
      },
      fields: ['status'],
      reason: 'clash',
      detail: [],
      detectedAt: new Date().toISOString(),
    });
    await json(call('POST', '/integrations/medicoach/conflicts/apply', { ref }, ADMIN_B));
    const page = await history('fixture', `${S_MC}#m1`);
    const apply = latest(page, 'medicoach.conflicts.apply');
    assert.equal(apply.actor.sub, 'sub-admin-b');
    const cs = changesOf((await entryOf(apply)).detail, 'fixture', `${S_MC}#m1`);
    assert.deepEqual(change(cs, 'status'), { field: 'status', to: 'postponed' });
    assert.deepEqual(change(cs, 'medicoach.conflict'), {
      field: 'medicoach.conflict',
      to: 'applied',
    });
    assert.deepEqual(change(cs, 'medicoach.conflictRef'), {
      field: 'medicoach.conflictRef',
      to: ref,
    });
  });

  test('dropping an outbox row records the decision on the fixture', async () => {
    const ref = `mc-out-${randomUUID().slice(0, 8)}`;
    await repo.putPendingSync(T, {
      ref,
      seriesId: S_MC,
      fixtureId: 'm1',
      schedule: {
        scheduledTime: `${sastDay(30)}T08:00:00.000Z`,
        timeTbc: false,
        dateTbc: false,
        venue: 'Kingsmead Oval',
        postponed: false,
        cancelled: false,
        changedAt: new Date().toISOString(),
      },
      origin: 'admin',
      enqueuedAt: new Date().toISOString(),
      attempts: 9,
    });
    await json(call('POST', '/integrations/medicoach/outbox/drop', { ref }));
    const drop = latest(await history('fixture', `${S_MC}#m1`), 'medicoach.outbox.drop');
    assert.deepEqual(changesOf((await entryOf(drop)).detail, 'fixture', `${S_MC}#m1`), [
      { field: 'medicoach.outbox', to: 'dropped' },
      { field: 'medicoach.outboxRef', to: ref },
    ]);
  });
});

describe('operator routes', () => {
  test('document intake: operator-only, the club’s document fields, object keys and file names masked', async () => {
    const res = await app.request(`/platform/tenants/${T}/doc-intake/commit`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            clubId: 'umzinto',
            docKey: 'constitution',
            objectKey: `local/${T}/umzinto/INTAKE-KEY-Z9.pdf`,
            size: 1234,
            contentType: 'application/pdf',
            sourceName: 'INTAKE-FILENAME-P7.pdf',
          },
        ],
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const intake = latest(await operatorHistory('club', 'umzinto'), 'doc-intake.commit');
    assert.equal(intake.visibility, 'operator');
    assert.equal(intake.actor.sub, 'sub-op');
    assert.equal(intake.counts?.clubs, 1);
    const detail = await json<Entry>(
      app.request(
        `/platform/tenants/${T}/audit/entry/${encodeURIComponent(intake.at)}/${intake.id}`,
        { headers: { 'x-dev-auth': OPERATOR } },
      ),
    );
    const cs = changesOf(detail.detail, 'club', 'umzinto');
    assert.deepEqual(change(cs, 'docs.constitution'), { field: 'docs.constitution', to: true });
    assert.deepEqual(change(cs, 'docMeta.constitution.objectKey'), {
      field: 'docMeta.constitution.objectKey',
      masked: true,
    });
    // Tenant admins do not see operator entries.
    assert.ok(!(await history('club', 'umzinto')).items.some((e) => e.id === intake.id));
    const text = await auditText();
    for (const secret of ['INTAKE-KEY-Z9', 'INTAKE-FILENAME-P7']) assert.ok(!text.includes(secret));
  });
});

// ── Review follow-ups ──

describe('club delete scrubs players who exist nowhere else (review I1)', () => {
  let seq = 0;
  const body = (firstName: string, lastName: string) => {
    seq++;
    return {
      firstName,
      lastName,
      idType: 'passport',
      idNumber: `PXR${String(seq).padStart(7, '0')}`,
      dob: '1991-03-14',
      nationality: 'Zimbabwean',
      race: 'African',
      gender: 'Female',
      cell: `08390002${String(seq).padStart(2, '0')}`,
      email: `${firstName.toLowerCase()}@example.org`,
      team: teamKey,
      district: 'Ethekwini',
    };
  };
  async function addPlayer(clubId: string, b: ReturnType<typeof body>) {
    const res = await call('POST', `/clubs/${clubId}/players`, b);
    const text = await res.text();
    assert.ok(res.status === 200 || res.status === 201, text);
    return JSON.parse(text) as { naturalKey: string };
  }
  const nkOf = (s: string) => createHash('sha256').update(s).digest('hex');
  const mentionLabel = async (e: AuditEntry, nk: string) =>
    (await entryOf(e)).detail?.mentions.find((m) => m.type === 'player' && m.id === nk)?.label;

  test('register at P → clear to Q → delete Q: the name leaves every stored row; players still elsewhere keep theirs', async () => {
    await repo.createClub(T, club('club-p', 'Papa CC'));
    await repo.createClub(T, club('club-q', 'Quebec CC'));
    // The mover: registered at P, then cleared to Q (no row left at P).
    const mover = await addPlayer('club-p', body('Movina', 'Mthembu'));
    const opened = await json<{ id: string }>(
      call('POST', '/clubs/club-q/clearances', {
        fromClubId: 'club-p',
        playerNaturalKey: mover.naturalKey,
      }),
      201,
    );
    await json(
      call('PATCH', `/clubs/club-p/clearances/${opened.id}`, {
        feesCleared: true,
        misconductCleared: true,
      }),
    );
    await json(call('PATCH', `/clubs/club-p/clearances/${opened.id}`, { action: 'issue' }));
    assert.ok(await repo.getPlayer(T, 'club-q', mover.naturalKey), 'precondition: at Q');
    assert.equal(
      await repo.getPlayer(T, 'club-p', mover.naturalKey),
      null,
      'precondition: not at P',
    );

    // Still elsewhere: a person registered at both P and Q, named in a P-era entry.
    const dualKey = nkOf('dual-dlamini');
    const dual = (clubId: string) =>
      ({
        naturalKey: dualKey,
        clubId,
        firstName: 'Dual',
        lastName: 'Dlamini',
        isMinor: false,
        dob: '1990-01-01',
        team: teamKey,
        consentAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      }) as never;
    await repo.createPlayer(T, dual('club-p'));
    await repo.createPlayer(T, dual('club-q'));
    await json(call('POST', '/admin/doc-requests/link', { clubId: 'club-p', naturalKey: dualKey }));
    const dualLink = latest(await history('player', dualKey), 'link.copy');
    // A veterans affiliate of Q (primary at P): not on Q's roster.
    const vet = await addPlayer('club-p', body('Vicky', 'Veteranza'));
    await json(
      call('PUT', `/clubs/club-p/players/${vet.naturalKey}/veterans-club`, {
        veteransClubId: 'club-q',
      }),
    );
    const vetSet = latest(await history('player', vet.naturalKey), 'veterans-affiliation.set');

    const before = await auditText();
    assert.ok(before.includes('Mthembu') && before.includes('Dlamini'), 'precondition');

    await json(call('DELETE', '/clubs/club-q'));
    const text = await auditText();
    for (const secret of ['Movina', 'Mthembu'])
      assert.ok(!text.includes(secret), `audit rows still hold ${secret}`);
    // No record of the mover remains anywhere, so their natural key goes too (blanked in the
    // entries, `E#` pointers dropped) — as a player erasure does it.
    assert.ok(!text.includes(mover.naturalKey), 'the mover’s natural key is still stored');
    assert.equal((await history('player', mover.naturalKey)).items.length, 0, 'pointers dropped');
    // The clearance entries stay, with the clubs' side.
    assert.ok((await history('clearance', opened.id)).items.length > 0, 'clearance history kept');
    // Still registered at P: the P-era label, id and pointers stay.
    assert.equal(await mentionLabel(dualLink, dualKey), 'Dual Dlamini');
    assert.ok(text.includes(dualKey), 'a player still elsewhere keeps their key');
    const vetHead = vetSet.targets.find((t) => t.type === 'player' && t.id === vet.naturalKey)!;
    assert.equal(vetHead.label, 'Vicky Veteranza');
    const vetNow = latest(await history('player', vet.naturalKey), 'veterans-affiliation.set');
    assert.equal(
      vetNow.targets.find((t) => t.type === 'player' && t.id === vet.naturalKey)!.label,
      'Vicky Veteranza',
    );
  });

  /** A roster player created directly (no audit of its own), at `clubId`. */
  const rosterPlayer = (nk: string, clubId: string, firstName: string, lastName: string) =>
    ({
      naturalKey: nk,
      clubId,
      firstName,
      lastName,
      isMinor: false,
      dob: '1990-01-01',
      team: teamKey,
      consentAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    }) as never;
  /** One stored entry naming the player as written while they were at `clubId`, at `at`. */
  async function earlierEntry(nk: string, name: string, clubId: string, at?: string) {
    const scope = audit.newAuditScope({
      tenant: T,
      actor: { kind: 'user', key: 'sub-admin', via: 'console' },
      action: 'player.update',
      ...(at ? { at } : {}),
    });
    audit.runAudited(scope, () =>
      audit.auditTarget({
        type: 'player',
        id: nk,
        clubId,
        label: name,
        op: 'update',
        changes: [{ field: 'firstName', from: 'Earlier', to: name.split(' ')[0] }],
      }),
    );
    await repo.putAuditEntry(audit.buildEntry(scope, { status: 200 }));
  }
  /** Every audit row of the given month partitions, as one JSON text. */
  async function auditTextIn(months: string[]): Promise<string> {
    const { DynamoDBDocumentClient, QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: process.env.DYNAMO_ENDPOINT,
        region: 'localhost',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    );
    const items: Record<string, unknown>[] = [];
    for (const m of months) {
      let start: Record<string, unknown> | undefined;
      do {
        const res = await doc.send(
          new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: 'pk = :p',
            ExpressionAttributeValues: { ':p': keys.auditPartitionPk(T, m) },
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
        items.push(...(res.Items ?? []));
        start = res.LastEvaluatedKey;
      } while (start);
    }
    return JSON.stringify(items);
  }

  test('200 roster players, 2–3 earlier-club entries each spread over 26 month partitions: all redacted, within budget', async () => {
    const N = 200;
    // Two years after launch: the scrub reads 26 month partitions (2026-11 … 2028-12).
    const NOW = new Date('2028-11-15T10:00:00.000Z');
    const months: string[] = [];
    for (let y = 2026, m = 11; months.length < 26; m === 12 ? (y++, (m = 1)) : m++)
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    assert.equal(months.at(-1), '2028-12');
    const atIn = (k: number) => `${months[k % 25]}-10T08:00:00.000Z`;
    await repo.createClub(T, club('club-old', 'Oldtown CC'));
    await repo.createClub(T, club('club-w', 'Whisky CC'));
    const people = Array.from({ length: N }, (_, i) => ({
      nk: nkOf(`w-${i}`),
      name: `Wfirst${i} Wlast${i}`,
    }));
    for (const [i, p] of people.entries())
      await repo.createPlayer(T, rosterPlayer(p.nk, 'club-w', `Wfirst${i}`, `Wlast${i}`));
    // Entries written while each player was at an earlier club (not the one being deleted), each
    // in a different month.
    const jobs: Array<() => Promise<void>> = [];
    for (const [i, p] of people.entries())
      for (let k = 0; k < 2 + (i % 2); k++)
        jobs.push(() => earlierEntry(p.nk, p.name, 'club-old', atIn(i * 3 + k)));
    // Two more roster players who are ALSO registered at club-old: untouched by the delete.
    const stayers = [0, 1].map((i) => ({ nk: nkOf(`stay-${i}`), name: `Stayfirst${i} Staylast` }));
    for (const [i, p] of stayers.entries()) {
      for (const clubId of ['club-w', 'club-old'])
        await repo.createPlayer(T, rosterPlayer(p.nk, clubId, `Stayfirst${i}`, 'Staylast'));
      jobs.push(() => earlierEntry(p.nk, p.name, 'club-old', atIn(i + 7)));
    }
    for (let i = 0; i < jobs.length; i += 25)
      await Promise.all(jobs.slice(i, i + 25).map((j) => j()));
    const before = await auditTextIn(months);
    assert.ok(before.includes('Wlast199'), 'precondition');
    assert.equal(
      new Set(months.slice(0, 25).filter((m) => before.includes(`"${m}-10T08`))).size,
      25,
      'precondition: entries in 25 months',
    );

    const t0 = performance.now();
    await repo.eraseClubData(T, (await repo.getClub(T, 'club-w'))!, { now: NOW });
    const ms = Math.round(performance.now() - t0);
    console.log(
      `club delete with ${N} roster players (${jobs.length} entries over 26 months): ${ms} ms`,
    );
    // The Lambda allows 30 s; dynalite is far slower than DynamoDB, so this is generous.
    assert.ok(ms < 20_000, `club delete took ${ms} ms`);
    assert.equal(await repo.getClub(T, 'club-w'), null, 'the delete completed');
    const text = await auditTextIn(months);
    assert.ok(!text.includes('Wfirst') && !text.includes('Wlast'), 'a roster name survived');
    // Nobody on this roster exists elsewhere: no stored row holds any of their natural keys.
    const kept = people.filter((p) => text.includes(p.nk));
    assert.deepEqual(kept, [], `${kept.length} natural keys survived`);
    const hist = (nk: string) => repo.listAuditForEntity(T, 'player', nk, { now: NOW });
    assert.equal((await hist(people[0].nk)).items.length, 0, 'pointers dropped');
    // Players still registered at another club keep their key, label and history.
    for (const p of stayers) {
      assert.ok(text.includes(p.nk) && text.includes(p.name), `${p.name} was touched`);
      assert.equal((await hist(p.nk)).items.length, 1);
    }
    // Re-runnable: a second pass over the same keys finds nothing left to do.
    assert.equal(
      await repo.scrubAuditForEntity(
        T,
        'player',
        people.map((p) => p.nk),
        { placeholder: '[removed]', dropPointers: true, now: NOW },
      ),
      0,
    );
  });

  test('an existence read left unprocessed fails the delete (5xx) before anything irreversible; a retry scrubs', async () => {
    await repo.createClub(T, club('club-u', 'Uniform CC'));
    await repo.createClub(T, club('club-u-old', 'Uniform Old CC'));
    const nk = nkOf('u-only');
    await repo.createPlayer(T, rosterPlayer(nk, 'club-u', 'Ulrika', 'Unprocessed'));
    await earlierEntry(nk, 'Ulrika Unprocessed', 'club-u-old');

    const restore = failExistenceReads();
    let res: Response;
    try {
      res = await call('DELETE', '/clubs/club-u');
    } finally {
      restore();
    }
    assert.equal(res.status, 500, await res.clone().text());
    assert.ok(await repo.getClub(T, 'club-u'), 'the club still exists');
    assert.ok(await repo.getPlayer(T, 'club-u', nk), 'the roster still exists');
    assert.ok((await auditText()).includes('Unprocessed'), 'nothing was scrubbed on a guess');

    await json(call('DELETE', '/clubs/club-u'));
    assert.equal(await repo.getClub(T, 'club-u'), null);
    const text = await auditText();
    assert.ok(!text.includes('Unprocessed') && !text.includes(nk), 'the retry scrubbed them');
  });

  test('a scrub past its time budget stops before the deletes; the retry finishes without redoing it', async () => {
    await repo.createClub(T, club('club-v', 'Victor CC'));
    await repo.createClub(T, club('club-v-old', 'Victor Old CC'));
    const people = Array.from({ length: 30 }, (_, i) => ({
      nk: nkOf(`v-${i}`),
      name: `Vfirst${i} Vlast${i}`,
    }));
    for (const [i, p] of people.entries()) {
      await repo.createPlayer(T, rosterPlayer(p.nk, 'club-v', `Vfirst${i}`, `Vlast${i}`));
      await earlierEntry(p.nk, p.name, 'club-v-old');
    }
    await assert.rejects(
      repo.eraseClubData(T, (await repo.getClub(T, 'club-v'))!, { auditScrubBudgetMs: 0 }),
      (err: Error) =>
        err.name === 'AuditErasureIncompleteError' && !/Vfirst|Vlast/.test(err.message),
    );
    assert.ok(await repo.getClub(T, 'club-v'), 'the club still exists');
    assert.equal((await repo.listPlayers(T, 'club-v')).length, 30, 'the roster still exists');
    // The first step (25 players) finished — rewritten and pointers dropped — the rest did not.
    const left: typeof people = [];
    for (const p of people) if ((await history('player', p.nk)).items.length) left.push(p);
    assert.equal(left.length, 5, `${left.length} players still have pointers`);
    const mid = await auditText();
    for (const p of people.filter((x) => !left.includes(x)))
      assert.ok(!mid.includes(p.name), `${p.name} not scrubbed by the first step`);

    await json(call('DELETE', '/clubs/club-v'));
    const text = await auditText();
    assert.ok(!text.includes('Vfirst') && !text.includes('Vlast'), 'a name survived the retry');
    assert.deepEqual(
      people.filter((p) => text.includes(p.nk)),
      [],
      'a natural key survived the retry',
    );
  });

  test('clearance-pending and veterans variants: who is kept, who is scrubbed', async () => {
    await repo.createClub(T, club('club-g', 'Golf CC'));
    await repo.createClub(T, club('club-g-dest', 'Golf Dest CC'));
    await repo.createClub(T, club('club-g-old', 'Golf Old CC'));
    // Held at the deleted club as 'clearance-pending', no row anywhere else → scrubbed.
    const pendingHere = { nk: nkOf('g-pending-here'), name: 'Penny Pendinghere' };
    await repo.createPlayer(T, {
      ...(rosterPlayer(pendingHere.nk, 'club-g', 'Penny', 'Pendinghere') as object),
      status: 'clearance-pending',
    } as never);
    // On the deleted club's roster AND pre-created 'clearance-pending' at a destination → kept
    // (a pending row is a row).
    const pendingThere = { nk: nkOf('g-pending-there'), name: 'Pierre Pendingthere' };
    await repo.createPlayer(T, rosterPlayer(pendingThere.nk, 'club-g', 'Pierre', 'Pendingthere'));
    await repo.createPlayer(T, {
      ...(rosterPlayer(pendingThere.nk, 'club-g-dest', 'Pierre', 'Pendingthere') as object),
      status: 'clearance-pending',
    } as never);
    // Primary at the deleted club with a veterans club elsewhere: the veterans club holds only an
    // affiliation, not a player row → scrubbed.
    const vetsOut = { nk: '', name: 'Vusi Veteransout' };
    vetsOut.nk = (await addPlayer('club-g', body('Vusi', 'Veteransout'))).naturalKey;
    await json(
      call('PUT', `/clubs/club-g/players/${vetsOut.nk}/veterans-club`, {
        veteransClubId: 'club-g-dest',
      }),
    );
    for (const p of [pendingHere, pendingThere, vetsOut])
      await earlierEntry(p.nk, p.name, 'club-g-old');

    await json(call('DELETE', '/clubs/club-g'));
    const text = await auditText();
    for (const p of [pendingHere, vetsOut]) {
      assert.ok(!text.includes(p.name), `${p.name} survived`);
      assert.ok(!text.includes(p.nk), `${p.name}'s natural key survived`);
    }
    assert.ok(text.includes(pendingThere.name), 'the player pending elsewhere keeps their name');
    assert.ok(text.includes(pendingThere.nk), 'the player pending elsewhere keeps their key');
  });
});

describe('player erasure reaches every ref (review I3)', () => {
  test('DELETE /admin/players/:nk strips squad selections, squad captain, team captain and report recipient', async () => {
    const before = await auditText();
    for (const name of ['Adult Captain', 'Second Player'])
      assert.ok(before.includes(name), `precondition: ${name} recorded`);
    // Where they were named: a squad selection and its captain, the team captain change, the
    // captain's report forward recipient.
    assert.ok((await history('player', K(1))).items.some((e) => e.action === 'squad-request.save'));
    assert.ok(
      (await history('player', K(1))).items.some((e) => e.action === 'captains-report.forward'),
    );
    assert.ok(
      (await history('player', K(2))).items.some((e) => e.action === 'club.team-captain.set'),
    );

    await json(call('DELETE', `/admin/players/${K(1)}`));
    await json(call('DELETE', `/admin/players/${K(2)}`));
    const text = await auditText();
    for (const secret of ['Adult Captain', 'Second Player', K(1), K(2)])
      assert.ok(!text.includes(secret), `audit rows still hold ${secret}`);
  });
});
