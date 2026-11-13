/**
 * Audit trail Phase 3 (ADR 0023), second group: field-level old → new values for players and
 * registration, clearances, series / fixtures, competitions, season runs and venues, through
 * the REAL Hono app on an in-process dynalite. Contract: docs/api/audit.md. Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type {
  AuditChange,
  AuditDetail,
  AuditEntry,
  Club,
  CompetitionStructure,
  SeasonCalendar,
} from '../src/types.js';
import { bindSetup, startRunBody } from './season-run-harness.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4871; // unique
const TABLE = 'SmartClubAuditPhase3PlayTest';
const TENANT = 'dolphins';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';
process.env.NOTIFY_DRY_RUN = '1';

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const admin = (sub: string, email: string) =>
  devAuth(sub, email, [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const ADMIN_A = admin('sub-admin-a', 'a@test');
const ADMIN_B = admin('sub-admin-b', 'b@test');
const OPERATOR = devAuth('sub-op', 'op@platform', [
  { tenantId: '*', role: 'operator', clubIds: [] },
]);

const call = (method: string, path: string, body?: unknown, auth = ADMIN_A) =>
  app.request(path, {
    method,
    headers: { 'x-tenant': TENANT, 'x-dev-auth': auth, 'content-type': 'application/json' },
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

/** A record's history as a union admin sees it. */
const history = (type: string, id: string) =>
  json<Page>(call('GET', `/admin/audit/entity/${type}/${encodeURIComponent(id)}?limit=200`));
const entryOf = (e: Pick<AuditEntry, 'at' | 'id'>) =>
  json<Entry>(call('GET', `/admin/audit/entry/${encodeURIComponent(e.at)}/${e.id}`));
const changesOf = (d: AuditDetail | null, type: string, id: string): AuditChange[] =>
  d?.targets.find((t) => t.type === type && t.id === id)?.changes ?? [];
const change = (cs: AuditChange[], field: string) => cs.find((c) => c.field === field);

/** The newest entry of `page` with this action. */
function latest(page: Page, action: string): AuditEntry {
  const hit = page.items.find((e) => e.action === action);
  assert.ok(hit, `${action} in ${JSON.stringify(page.items.map((e) => e.action))}`);
  return hit;
}

const club = (id: string, name: string): Club =>
  ({
    id,
    name,
    district: 'North',
    sub: '',
    chair: `Chair ${id}`,
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#123456',
    ground: {},
    leagues: [],
    exco: { chair: { name: `Chair ${id}`, cell: '0820000001', email: `chair@${id}.test` } },
    version: 1,
  }) as Club;

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let keys: typeof import('../src/keys.js');
let teamKey = '';

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));
  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const ddbAdmin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await ddbAdmin.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig(TENANT);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  keys = await import('../src/keys.js');
  teamKey = ((await repo.getTenantConfig(TENANT))?.leagues ?? [])[0]?.key ?? '';
  assert.ok(teamKey, 'precondition: the seeded tenant has a league catalogue');
  for (const [id, name] of [
    ['club-a', 'Alpha CC'],
    ['club-b', 'Beta CC'],
    ['club-v', 'Vets CC'],
    ['club-z', 'Zeta CC'],
  ])
    await repo.createClub(TENANT, club(id, name));
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

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
  const pk = keys.auditPartitionPk(TENANT, keys.auditMonthOf(new Date().toISOString()));
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

let seq = 0;
/** A chair-form player (passport identity, so the ID number and dob are ours). */
const playerBody = (firstName: string, lastName: string) => {
  seq++;
  return {
    firstName,
    lastName,
    idType: 'passport',
    idNumber: `PXQ${String(seq).padStart(7, '0')}`,
    dob: `1994-0${(seq % 9) + 1}-1${seq % 10}`,
    nationality: 'Zimbabwean',
    race: 'African',
    gender: 'Female',
    cell: `08390000${String(seq).padStart(2, '0')}`,
    email: `${firstName.toLowerCase()}@example.org`,
    team: teamKey,
    district: 'Ethekwini',
  };
};
async function addPlayer(clubId: string, body: ReturnType<typeof playerBody>): Promise<string> {
  // The league key is seeded in `before`, after the describe bodies built their players.
  const res = await call('POST', `/clubs/${clubId}/players`, { ...body, team: teamKey });
  const text = await res.text();
  assert.ok(res.status === 200 || res.status === 201, text);
  return (JSON.parse(text) as { naturalKey: string }).naturalKey;
}

describe('players and registration', () => {
  const thandi = playerBody('Thandi', 'Mokoena');
  let nk: string;

  test('a chair add: the player (label, club), its values, identity and contacts masked', async () => {
    nk = await addPlayer('club-a', thandi);
    const add = latest(await history('player', nk), 'player.create');
    assert.equal(add.actor.sub, 'sub-admin-a');
    const head = add.targets.find((t) => t.type === 'player' && t.id === nk)!;
    assert.equal(head.label, 'Thandi Mokoena');
    assert.equal(head.clubId, 'club-a');
    const cs = changesOf((await entryOf(add)).detail, 'player', nk);
    assert.deepEqual(change(cs, 'firstName'), { field: 'firstName', to: 'Thandi' });
    assert.deepEqual(change(cs, 'team'), { field: 'team', to: teamKey });
    assert.deepEqual(change(cs, 'clubId'), {
      field: 'clubId',
      to: 'club-a',
      ref: { type: 'club', id: 'club-a' },
    });
    for (const f of ['idNumber', 'dob', 'cell', 'email', 'gender', 'race', 'nationality'])
      assert.deepEqual(change(cs, f), { field: f, masked: true }, f);
    // The club's history shows the registration too.
    assert.equal(latest(await history('club', 'club-a'), 'player.create').id, add.id);
  });

  test('veterans club set by another admin: who, and the club old → new with a ref', async () => {
    await json(
      call(
        'PUT',
        `/clubs/club-a/players/${nk}/veterans-club`,
        { veteransClubId: 'club-v' },
        ADMIN_B,
      ),
    );
    const set = latest(await history('player', nk), 'veterans-affiliation.set');
    assert.equal(set.actor.sub, 'sub-admin-b');
    assert.deepEqual(change(changesOf((await entryOf(set)).detail, 'player', nk), 'veteransClub'), {
      field: 'veteransClub',
      to: 'Vets CC',
      ref: { type: 'club', id: 'club-v' },
    });
    // The veterans club's history shows it (the ref's club pointer).
    assert.equal(latest(await history('club', 'club-v'), 'veterans-affiliation.set').id, set.id);
  });

  test('a save that changes nothing is recorded with zero changes', async () => {
    await json(
      call('PUT', `/clubs/club-a/players/${nk}/veterans-club`, { veteransClubId: 'club-v' }),
    );
    const set = latest(await history('player', nk), 'veterans-affiliation.set');
    assert.equal(set.actor.sub, 'sub-admin-a');
    assert.equal(set.targets.find((t) => t.id === nk)!.changeCount, 0);
  });

  test('roster removal: the row it removed, still masked', async () => {
    await json(call('DELETE', `/clubs/club-a/players/${nk}`));
    const rm = latest(await history('player', nk), 'player.remove');
    const cs = changesOf((await entryOf(rm)).detail, 'player', nk);
    assert.deepEqual(change(cs, 'lastName'), { field: 'lastName', from: 'Mokoena' });
    assert.deepEqual(change(cs, 'idNumber'), { field: 'idNumber', masked: true });
  });

  test('no stored row holds the ID number, date of birth or contacts', async () => {
    const text = await auditText();
    for (const secret of [thandi.idNumber, thandi.dob, thandi.cell, thandi.email])
      assert.ok(!text.includes(secret), `audit rows hold ${secret}`);
  });
});

describe('clearances', () => {
  const lindiwe = playerBody('Lindiwe', 'Zulu');
  const NOTE = 'NOTE-TEXT-Q7XW';
  const REASON = 'REJECT-REASON-K9PL';
  let nk: string;
  let cid: string;
  let version = 0;

  test('opened: both clubs with refs, the note masked; in both clubs and the player history', async () => {
    nk = await addPlayer('club-a', lindiwe);
    const opened = await json<{ id: string; version: number }>(
      call('POST', '/clubs/club-b/clearances', {
        fromClubId: 'club-a',
        playerNaturalKey: nk,
        note: NOTE,
      }),
      201,
    );
    cid = opened.id;
    version = opened.version;
    const create = latest(await history('clearance', cid), 'clearance.create');
    const cs = changesOf((await entryOf(create)).detail, 'clearance', cid);
    assert.deepEqual(change(cs, 'status'), { field: 'status', to: 'pending' });
    assert.deepEqual(change(cs, 'fromClub'), {
      field: 'fromClub',
      to: 'Alpha CC',
      ref: { type: 'club', id: 'club-a' },
    });
    assert.deepEqual(change(cs, 'toClub'), {
      field: 'toClub',
      to: 'Beta CC',
      ref: { type: 'club', id: 'club-b' },
    });
    assert.deepEqual(change(cs, 'note'), { field: 'note', masked: true });
    assert.equal(create.targets.find((t) => t.id === cid)!.label, undefined);
    assert.equal(latest(await history('club', 'club-a'), 'clearance.create').id, create.id);
    assert.equal(latest(await history('club', 'club-b'), 'clearance.create').id, create.id);
    assert.equal(latest(await history('player', nk), 'clearance.create').id, create.id);
    const mention = (await entryOf(create)).detail!.mentions.find((m) => m.type === 'player');
    // The player's club at that moment (the source: the player is still on its roster).
    assert.deepEqual(mention, { type: 'player', id: nk, label: 'Lindiwe Zulu', clubId: 'club-a' });
  });

  test('source club answers: who, and fees false → true; a repeat changes nothing', async () => {
    const answered = await json<{ version: number }>(
      call('PATCH', `/clubs/club-a/clearances/${cid}`, { feesCleared: true, version }, ADMIN_B),
    );
    version = answered.version;
    const upd = latest(await history('clearance', cid), 'clearance.update');
    assert.equal(upd.actor.sub, 'sub-admin-b');
    assert.deepEqual(changesOf((await entryOf(upd)).detail, 'clearance', cid), [
      { field: 'feesCleared', from: false, to: true },
    ]);
    const again = await json<{ version: number }>(
      call('PATCH', `/clubs/club-a/clearances/${cid}`, { feesCleared: true, version }),
    );
    version = again.version;
    const noop = latest(await history('clearance', cid), 'clearance.update');
    assert.equal(noop.actor.sub, 'sub-admin-a');
    assert.equal(noop.targets.find((t) => t.id === cid)!.changeCount, 0);
  });

  test('admin reject: status pending → rejected, the reason masked, both clubs see it', async () => {
    await json(
      call('POST', `/admin/clearances/${cid}/reject`, {
        fromClubId: 'club-a',
        version,
        reason: REASON,
      }),
    );
    const rej = latest(await history('clearance', cid), 'clearance.reject');
    const cs = changesOf((await entryOf(rej)).detail, 'clearance', cid);
    assert.deepEqual(change(cs, 'status'), { field: 'status', from: 'pending', to: 'rejected' });
    assert.deepEqual(change(cs, 'rejectReason'), { field: 'rejectReason', masked: true });
    assert.equal(latest(await history('club', 'club-a'), 'clearance.reject').id, rej.id);
    assert.equal(latest(await history('club', 'club-b'), 'clearance.reject').id, rej.id);
    assert.equal(latest(await history('player', nk), 'clearance.reject').id, rej.id);
    const text = await auditText();
    for (const secret of [NOTE, REASON, lindiwe.idNumber, lindiwe.dob])
      assert.ok(!text.includes(secret), `audit rows hold ${secret}`);
  });

  test('after DELETE /admin/players/:nk no audit row holds the player’s name or natural key', async () => {
    assert.ok((await auditText()).includes('Lindiwe'), 'precondition: the name was recorded');
    await json(call('DELETE', `/admin/players/${nk}`));
    const text = await auditText();
    for (const secret of ['Lindiwe', 'Zulu', nk])
      assert.ok(!text.includes(secret), `audit rows still hold ${secret}`);
    // The clearance's entries stay (the clubs' side), without the player.
    const rej = latest(await history('clearance', cid), 'clearance.reject');
    const { detail } = await entryOf(rej);
    assert.ok(!detail!.mentions.some((m) => m.type === 'player' && m.id));
  });
});

describe('series and fixtures', () => {
  const SID = 's-audit';
  const fx = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
    id,
    round: 1,
    date,
    time: '10:00',
    home: 'club-a',
    away: 'club-b',
    ...extra,
  });
  let version = 1;
  const patch = async (body: Record<string, unknown>) => {
    const s = await json<{ version: number }>(
      call('PATCH', `/series/${SID}`, { ...body, version }),
    );
    version = s.version;
  };

  test('venues: a save shows old → new, the address masked; a repeat changes nothing', async () => {
    await json(
      call('PUT', '/venues/v-one', {
        name: 'Ground One',
        suburb: 'Glenwood',
        address: '1 SECRET RD',
      }),
    );
    await json(call('PUT', '/venues/v-two', { name: 'Ground Two' }));
    await json(
      call(
        'PUT',
        '/venues/v-one',
        { name: 'Ground One', suburb: 'Morningside', address: '2 HIDDEN AV' },
        ADMIN_B,
      ),
    );
    const save = latest(await history('venue', 'v-one'), 'venue.save');
    assert.equal(save.actor.sub, 'sub-admin-b');
    assert.deepEqual(changesOf((await entryOf(save)).detail, 'venue', 'v-one'), [
      { field: 'suburb', from: 'Glenwood', to: 'Morningside' },
      { field: 'address', masked: true },
    ]);
    await json(
      call('PUT', '/venues/v-one', {
        name: 'Ground One',
        suburb: 'Morningside',
        address: '2 HIDDEN AV',
      }),
    );
    const noop = latest(await history('venue', 'v-one'), 'venue.save');
    assert.equal(noop.targets.find((t) => t.id === 'v-one')!.changeCount, 0);
    const text = await auditText();
    for (const secret of ['1 SECRET RD', '2 HIDDEN AV']) assert.ok(!text.includes(secret), secret);
  });

  test('a fixture date + venue edit reads as series.fixtures.edit with one fixture target', async () => {
    await json(
      call('POST', '/series', {
        id: SID,
        name: 'Audit League',
        startDate: '2027-01-09',
        teams: ['club-a', 'club-b'],
        fixtures: [
          fx('f1', '2027-01-09', { venueId: 'v-one', venueName: 'Ground One' }),
          fx('f2', '2027-01-16', { round: 2, home: 'club-b', away: 'club-a' }),
        ],
        released: false,
      }),
      201,
    );
    await patch({
      fixtures: [
        fx('f1', '2027-01-10', { venueId: 'v-two', venueName: 'Ground Two' }),
        fx('f2', '2027-01-16', { round: 2, home: 'club-b', away: 'club-a' }),
      ],
    });
    const edit = latest(await history('series', SID), 'series.fixtures.edit');
    assert.equal(edit.actor.sub, 'sub-admin-a');
    const fixtures = edit.targets.filter((t) => t.type === 'fixture');
    assert.deepEqual(
      fixtures.map((t) => [t.id, t.label, t.op]),
      [[`${SID}#f1`, 'club-a v club-b', 'update']],
    );
    assert.deepEqual(changesOf((await entryOf(edit)).detail, 'fixture', `${SID}#f1`), [
      { field: 'date', from: '2027-01-09', to: '2027-01-10' },
      {
        field: 'venue',
        from: 'Ground One',
        to: 'Ground Two',
        ref: { type: 'venue', id: 'v-two' },
        fromRef: { type: 'venue', id: 'v-one' },
      },
    ]);
    assert.deepEqual(edit.counts, { fixturesChanged: 1, fixturesAdded: 0, fixturesRemoved: 0 });
    // The fixture's own history and both venues' histories show it.
    assert.equal(latest(await history('fixture', `${SID}#f1`), 'series.fixtures.edit').id, edit.id);
    assert.equal(latest(await history('venue', 'v-one'), 'series.fixtures.edit').id, edit.id);
  });

  test('approve and release are classified, with the flag old → new', async () => {
    await patch({ approved: true });
    const approve = latest(await history('series', SID), 'series.approve');
    assert.deepEqual(changesOf((await entryOf(approve)).detail, 'series', SID), [
      { field: 'approved', from: false, to: true },
    ]);
    await patch({ released: true });
    const release = latest(await history('series', SID), 'series.release');
    assert.deepEqual(
      change(changesOf((await entryOf(release)).detail, 'series', SID), 'released'),
      { field: 'released', from: false, to: true },
    );
  });

  test('a save that changes nothing is a plain series.update with zero changes', async () => {
    await patch({ name: 'Audit League' });
    const upd = latest(await history('series', SID), 'series.update');
    const head = upd.targets.find((t) => t.type === 'series' && t.id === SID)!;
    assert.equal(head.label, 'Audit League');
    assert.equal(head.changeCount, 0);
    assert.equal(upd.targets.filter((t) => t.type === 'fixture').length, 0);
  });

  test('a large fixture edit keeps 25 targets and counts the rest', async () => {
    const day = (n: number) =>
      new Date(Date.UTC(2027, 4, 1) + n * 86_400_000).toISOString().slice(0, 10);
    const fixtures = (shift: number) =>
      Array.from({ length: 30 }, (_, i) => fx(`f${i + 1}`, day(i * 2 + shift), { round: i + 1 }));
    const big = await json<{ version: number }>(
      call('POST', '/series', {
        id: 's-big',
        name: 'Big League',
        startDate: day(0),
        teams: ['club-a', 'club-b'],
        fixtures: fixtures(0),
        released: false,
      }),
      201,
    );
    await json(call('PATCH', '/series/s-big', { fixtures: fixtures(1), version: big.version }));
    const edit = latest(await history('series', 's-big'), 'series.fixtures.edit');
    assert.equal(edit.targets.length, 25);
    assert.equal(edit.targets.filter((t) => t.type === 'fixture').length, 24);
    assert.equal(edit.truncated?.targets, 6);
    assert.deepEqual(edit.counts, { fixturesChanged: 30, fixturesAdded: 0, fixturesRemoved: 0 });
  });

  test('venue delete: what the venue held, address masked', async () => {
    await json(call('DELETE', '/venues/v-two'));
    const del = latest(await history('venue', 'v-two'), 'venue.delete');
    assert.equal(del.targets.find((t) => t.id === 'v-two')!.label, 'Ground Two');
    assert.deepEqual(changesOf((await entryOf(del)).detail, 'venue', 'v-two'), [
      { field: 'name', from: 'Ground Two' },
    ]);
  });
});

describe('competitions', () => {
  let id: string;
  const team = (clubId: string, name: string) => ({ teamId: clubId, clubId, name });

  test('create, then a rename by another admin: name old → new; a repeat changes nothing', async () => {
    const created = await json<{ id: string }>(
      call('POST', '/competitions', {
        type: 'league',
        name: 'Audit Cup',
        overs: 20,
        teams: [team('club-a', 'Alpha CC'), team('club-b', 'Beta CC'), team('club-v', 'Vets CC')],
        format: { kind: 'round-robin', legs: 1 },
        schedule: { startDate: '2027-08-07', everyDays: 7, times: ['10:00'] },
      }),
      201,
    );
    id = created.id;
    const create = latest(await history('competition', id), 'competition.create');
    const cc = changesOf((await entryOf(create)).detail, 'competition', id);
    assert.deepEqual(change(cc, 'name'), { field: 'name', to: 'Audit Cup' });
    // One change per team, each naming its club (so deleting that club reaches it).
    assert.deepEqual(
      cc.filter((c) => c.field === 'teams'),
      [
        { field: 'teams', to: 'Alpha CC', ref: { type: 'club', id: 'club-a' } },
        { field: 'teams', to: 'Beta CC', ref: { type: 'club', id: 'club-b' } },
        { field: 'teams', to: 'Vets CC', ref: { type: 'club', id: 'club-v' } },
      ],
    );

    await json(call('PATCH', `/competitions/${id}`, { name: 'Renamed Cup' }, ADMIN_B));
    const upd = latest(await history('competition', id), 'competition.update');
    assert.equal(upd.actor.sub, 'sub-admin-b');
    assert.equal(upd.targets.find((t) => t.type === 'competition')!.label, 'Renamed Cup');
    assert.deepEqual(changesOf((await entryOf(upd)).detail, 'competition', id), [
      { field: 'name', from: 'Audit Cup', to: 'Renamed Cup' },
    ]);

    await json(call('PATCH', `/competitions/${id}`, { name: 'Renamed Cup' }));
    const noop = latest(await history('competition', id), 'competition.update');
    assert.equal(noop.targets.find((t) => t.type === 'competition')!.changeCount, 0);
  });

  test('delete: the config it had and the series removed', async () => {
    await json(call('DELETE', `/competitions/${id}`));
    const del = latest(await history('competition', id), 'competition.delete');
    assert.equal(del.counts?.series, 1);
    assert.deepEqual(change(changesOf((await entryOf(del)).detail, 'competition', id), 'name'), {
      field: 'name',
      from: 'Renamed Cup',
    });
  });
});

describe('season runs', () => {
  const CAL: SeasonCalendar = {
    id: 'cal-audit',
    label: '2026/27',
    blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' }],
  };
  const STRUCT: CompetitionStructure = {
    id: 'st-audit',
    name: 'Single league',
    version: 1,
    stages: [
      {
        id: 'main',
        name: 'Main',
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
      },
    ],
  } as CompetitionStructure;

  test('rename by another admin: season label old → new; a repeat changes nothing', async () => {
    await bindSetup(repo, TENANT, { leagueKey: 'audit-league', structure: STRUCT, calendar: CAL });
    const run = await json<{ id: string; version: number }>(
      call('POST', '/season-runs', startRunBody({ id: 'sr-audit', leagueKey: 'audit-league' })),
      201,
    );
    const create = latest(await history('season-run', run.id), 'season-run.create');
    const cc = changesOf((await entryOf(create)).detail, 'season-run', run.id);
    assert.deepEqual(change(cc, 'structure'), { field: 'structure', to: 'Single league v1' });
    assert.deepEqual(change(cc, 'stages.main.status'), {
      field: 'stages.main.status',
      to: 'awaiting-entrants',
    });

    const renamed = await json<{ version: number }>(
      call(
        'PATCH',
        `/season-runs/${run.id}`,
        { seasonLabel: '2027/28', version: run.version },
        ADMIN_B,
      ),
    );
    const upd = latest(await history('season-run', run.id), 'season-run.update');
    assert.equal(upd.actor.sub, 'sub-admin-b');
    assert.equal(upd.targets.find((t) => t.id === run.id)!.label, 'audit-league 2027/28');
    assert.deepEqual(changesOf((await entryOf(upd)).detail, 'season-run', run.id), [
      { field: 'seasonLabel', from: '2026/27', to: '2027/28' },
    ]);

    await json(
      call('PATCH', `/season-runs/${run.id}`, { seasonLabel: '2027/28', version: renamed.version }),
    );
    const noop = latest(await history('season-run', run.id), 'season-run.update');
    assert.equal(noop.actor.sub, 'sub-admin-a');
    assert.equal(noop.targets.find((t) => t.id === run.id)!.changeCount, 0);
  });
});

describe('club delete', () => {
  test('after DELETE /clubs/:id no audit row holds its players’ names', async () => {
    await addPlayer('club-z', playerBody('Bongani', 'Khumalo'));
    await addPlayer('club-z', playerBody('Ayanda', 'Dube'));
    const before = await auditText();
    assert.ok(before.includes('Bongani') && before.includes('Dube'), 'precondition');
    await json(call('DELETE', '/clubs/club-z'));
    const text = await auditText();
    for (const secret of ['Bongani', 'Khumalo', 'Ayanda', 'Dube'])
      assert.ok(!text.includes(secret), `audit rows still hold ${secret}`);
  });
});

describe('operator roster intake', () => {
  test('names the players it created (operator-only), with counts', async () => {
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            clubId: 'club-b',
            rowNumber: 2,
            firstName: 'Musa',
            lastName: 'Shabalala',
            dob: '1990-05-05',
            team: teamKey,
          },
        ],
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const page = await json<Page>(
      app.request(`/platform/tenants/${TENANT}/audit/entity/club/club-b?limit=200`, {
        headers: { 'x-dev-auth': OPERATOR },
      }),
    );
    const intake = latest(page, 'roster-intake.commit');
    assert.equal(intake.visibility, 'operator');
    assert.equal(intake.counts?.created, 1);
    const p = intake.targets.find((t) => t.type === 'player')!;
    assert.equal(p.label, 'Musa Shabalala');
    assert.equal(p.clubId, 'club-b');
  });
});

// ── Review follow-ups ──

/** Luhn-valid RSA ID for `dob` (YYYY-MM-DD); `seq` keeps ids distinct for one dob. */
function saId(dob: string, seq: number): string {
  const [y, m, d] = dob.split('-');
  const twelve = `${y.slice(2)}${m}${d}${String(seq).padStart(4, '0')}08`;
  let sum = 0;
  let alt = true;
  for (let i = twelve.length - 1; i >= 0; i--) {
    let digit = twelve.charCodeAt(i) - 48;
    if (alt) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alt = !alt;
  }
  return twelve + String((10 - (sum % 10)) % 10);
}

/** Of `names`, those any stored audit row holds. */
async function storedNames(names: string[]): Promise<string[]> {
  const text = await auditText();
  return names.filter((n) => text.includes(n));
}

describe('large roster commits (review I3)', () => {
  const ROWS = 30;
  const surname = (prefix: string, i: number) => `${prefix}${String.fromCharCode(65 + i)}son`;

  test('a chair roster commit of 30: 25 targets named, the rest only counted', async () => {
    const items = Array.from({ length: ROWS }, (_, i) => ({
      rowNumber: i + 2,
      firstName: 'Rosta',
      lastName: surname('Chq', i),
      dob: '1995-03-03',
      idNumber: saId('1995-03-03', 100 + i),
      team: teamKey,
    }));
    const res = await json<{ summary: Record<string, number> }>(
      call('POST', '/clubs/club-b/roster/commit', { items }),
    );
    assert.equal(res.summary.created, ROWS);
    const commit = latest(await history('club', 'club-b'), 'roster.commit');
    assert.equal(commit.counts?.created, ROWS);
    assert.equal(commit.targets.length, 25);
    const named = commit.targets.filter((t) => t.type === 'player');
    assert.equal((commit.truncated?.targets ?? 0) + named.length, ROWS);
    for (const t of named) assert.match(t.label ?? '', /^Rosta Chq[A-Z]son$/);
    const labels = new Set(named.map((t) => t.label));
    const overflow = items.map((x) => `Rosta ${x.lastName}`).filter((n) => !labels.has(n));
    assert.equal(overflow.length, ROWS - named.length);
    assert.deepEqual(await storedNames(overflow.map((n) => n.split(' ')[1])), []);
    // No overflow player has a history of its own.
    const key = (await repo.listPlayers(TENANT, 'club-b')).find(
      (p) => p.lastName === overflow[0].split(' ')[1],
    )!.naturalKey;
    assert.equal((await history('player', key)).items.length, 0);
  });

  test('an operator roster intake of 30: 25 named (operator-only), the rest only counted', async () => {
    const items = Array.from({ length: ROWS }, (_, i) => ({
      clubId: 'club-a',
      rowNumber: i + 2,
      firstName: 'Intaka',
      lastName: surname('Opq', i),
      dob: '1993-04-04',
      team: teamKey,
    }));
    const res = await app.request(`/platform/tenants/${TENANT}/roster-intake/commit`, {
      method: 'POST',
      headers: { 'x-dev-auth': OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const page = await json<Page>(
      app.request(`/platform/tenants/${TENANT}/audit/entity/club/club-a?limit=200`, {
        headers: { 'x-dev-auth': OPERATOR },
      }),
    );
    const intake = latest(page, 'roster-intake.commit');
    assert.equal(intake.visibility, 'operator');
    assert.equal(intake.counts?.created, ROWS);
    assert.equal(intake.targets.length, 25);
    const named = intake.targets.filter((t) => t.type === 'player');
    assert.equal(named.length, 25);
    assert.equal(intake.truncated?.targets, ROWS - 25);
    const labels = new Set(named.map((t) => t.label));
    const overflow = items.map((x) => x.lastName).filter((n) => !labels.has(`Intaka ${n}`));
    assert.equal(overflow.length, ROWS - 25);
    assert.deepEqual(await storedNames(overflow), []);
  });
});

describe('veterans requests (review I3 + accept "before")', () => {
  const NOTE = 'VET-NOTE-P3K';
  const REASON = 'VET-DECLINE-REASON-M7Q';
  const request = (id: string, nk: string, name: string) =>
    ({
      id,
      playerNaturalKey: nk,
      candidateId: `cand-${id}`,
      playerName: name,
      primaryClubId: 'club-a',
      primaryClubName: 'Alpha CC',
      veteransClubId: 'club-v',
      veteransClubName: 'Vets CC',
      note: NOTE,
      requestedAt: '2026-11-01T00:00:00.000Z',
      status: 'pending' as const,
      version: 0,
    }) as import('../src/types.js').VeteransRequest;

  test('decline: status pending → declined, the reason masked, both clubs see it', async () => {
    const nk = await addPlayer('club-a', playerBody('Vusi', 'Declino'));
    await repo.createVeteransRequest(TENANT, request('vr-decline', nk, 'Vusi Declino'));
    await json(
      call('POST', '/clubs/club-a/veterans-requests/vr-decline/decline', { reason: REASON }),
    );
    const dec = latest(await history('veterans-request', 'vr-decline'), 'veterans-request.decline');
    const cs = changesOf((await entryOf(dec)).detail, 'veterans-request', 'vr-decline');
    assert.deepEqual(change(cs, 'status'), { field: 'status', from: 'pending', to: 'declined' });
    assert.deepEqual(change(cs, 'declineReason'), { field: 'declineReason', masked: true });
    assert.equal(latest(await history('club', 'club-v'), 'veterans-request.decline').id, dec.id);
    assert.equal(latest(await history('player', nk), 'veterans-request.decline').id, dec.id);
    assert.deepEqual(await storedNames([NOTE, REASON]), []);
  });

  test('accept records the real before: a player already at that veterans club shows no change', async () => {
    const nk = await addPlayer('club-a', playerBody('Vela', 'Already'));
    await json(
      call('PUT', `/clubs/club-a/players/${nk}/veterans-club`, { veteransClubId: 'club-v' }),
    );
    await repo.createVeteransRequest(TENANT, request('vr-same', nk, 'Vela Already'));
    await json(
      call('POST', '/admin/veterans-requests/vr-same/accept', { primaryClubId: 'club-a' }),
    );
    const acc = latest(await history('veterans-request', 'vr-same'), 'veterans-request.accept');
    assert.deepEqual(
      change(changesOf((await entryOf(acc)).detail, 'veterans-request', 'vr-same'), 'status'),
      { field: 'status', from: 'pending', to: 'accepted' },
    );
    assert.equal(
      change(changesOf((await entryOf(acc)).detail, 'player', nk), 'veteransClub'),
      undefined,
    );
  });

  test('accept of a player with no veterans club: none → the club, with a ref', async () => {
    const nk = await addPlayer('club-a', playerBody('Vika', 'Fresh'));
    await repo.createVeteransRequest(TENANT, request('vr-fresh', nk, 'Vika Fresh'));
    await json(call('POST', '/clubs/club-a/veterans-requests/vr-fresh/accept', {}));
    const acc = latest(await history('player', nk), 'veterans-request.accept');
    assert.deepEqual(change(changesOf((await entryOf(acc)).detail, 'player', nk), 'veteransClub'), {
      field: 'veteransClub',
      to: 'Vets CC',
      ref: { type: 'club', id: 'club-v' },
    });
    assert.deepEqual(await storedNames([NOTE]), []);
  });
});

describe('registration reviews (review I3)', () => {
  test('an off-system alert is recorded with the player mention; the typed club never stored', async () => {
    const typed = 'Faraway Typed Offsystem CC';
    const res = await call('POST', '/clubs/club-a/players', {
      ...playerBody('Regina', 'Reviewed'),
      team: teamKey,
      lastClub: typed,
    });
    assert.ok(res.status === 200 || res.status === 201, await res.clone().text());
    const nk = ((await res.json()) as { naturalKey: string }).naturalKey;
    const reviews = await json<Array<{ id: string; kind: string; playerNaturalKey?: string }>>(
      call('GET', '/admin/registration-reviews'),
    ).then((r) => (Array.isArray(r) ? r : ((r as unknown as { items: never[] }).items ?? [])));
    const review = reviews.find((r) => r.kind === 'off-system-alert');
    assert.ok(review, JSON.stringify(reviews));
    const create = latest(await history('registration-review', review.id), 'player.create');
    const head = create.targets.find((t) => t.type === 'registration-review')!;
    assert.equal(head.op, 'create');
    assert.equal(head.clubId, 'club-a');
    const mention = (await entryOf(create)).detail!.mentions.find((m) => m.type === 'player');
    assert.deepEqual(mention, {
      type: 'player',
      id: nk,
      label: 'Regina Reviewed',
      clubId: 'club-a',
    });
    assert.equal(latest(await history('player', nk), 'player.create').id, create.id);
    // The review's own fields: kind and status, the destination club with a ref; the typed
    // club is free text, recorded as set without its value.
    assert.deepEqual(changesOf((await entryOf(create)).detail, 'registration-review', review.id), [
      { field: 'kind', to: 'off-system-alert' },
      { field: 'status', to: 'open' },
      { field: 'destClub', to: 'Alpha CC', ref: { type: 'club', id: 'club-a' } },
      { field: 'typedPreviousClub', masked: true },
    ]);

    await json(
      call('POST', `/admin/registration-reviews/${review.id}/ack`, { destClubId: 'club-a' }),
    );
    const ack = latest(await history('registration-review', review.id), 'registration-review.ack');
    const acs = changesOf((await entryOf(ack)).detail, 'registration-review', review.id);
    assert.equal(change(acs, 'status')?.from, 'open');
    assert.notEqual(change(acs, 'status')?.to, undefined);
    // The review's history reads create, then ack (newest first).
    assert.deepEqual(
      (await history('registration-review', review.id)).items.map((e) => e.id),
      [ack.id, create.id],
    );
    assert.deepEqual(await storedNames([typed]), []);
  });
});

describe('audit code never fails a request (review M1)', () => {
  test('a diff helper that throws: the PATCH still answers 200 and the write is committed', async () => {
    const CAL: SeasonCalendar = {
      id: 'cal-broken',
      label: '2026/27',
      blocks: [{ id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' }],
    };
    const STRUCT = {
      id: 'st-broken',
      name: 'Single league',
      version: 1,
      stages: [
        {
          id: 'main',
          name: 'Main',
          format: { kind: 'round-robin', legs: 1 },
          entrants: { kind: 'all-registered' },
          schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        },
      ],
    } as CompetitionStructure;
    await bindSetup(repo, TENANT, { leagueKey: 'broken-league', structure: STRUCT, calendar: CAL });
    const run = await json<{ id: string }>(
      call('POST', '/season-runs', startRunBody({ id: 'sr-broken', leagueKey: 'broken-league' })),
      201,
    );
    // A stored group the audit view cannot read (a null entry): seasonRunAuditView throws on it.
    const stored = (await repo.getSeasonRun(TENANT, run.id))!;
    await repo.putSeasonRun(TENANT, {
      ...stored,
      stages: stored.stages.map((s) => ({ ...s, groups: [null as never] })),
    });
    const fresh = (await repo.getSeasonRun(TENANT, run.id))!;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    let res: Response;
    try {
      res = await call('PATCH', `/season-runs/${run.id}`, {
        seasonLabel: '2099/00',
        version: fresh.version,
      });
    } finally {
      console.error = orig;
    }
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await repo.getSeasonRun(TENANT, run.id))!.seasonLabel, '2099/00');
    // Reported once per failure, naming only the error class.
    assert.ok(
      errors.some((l) => l === 'audit: recording failed (TypeError)'),
      errors.join('\n'),
    );
  });
});
