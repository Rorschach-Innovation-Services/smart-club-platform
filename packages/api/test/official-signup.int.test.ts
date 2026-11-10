/**
 * Official self-registration (docs/api/officials.md): admin links, the public routes, the
 * pending lifecycle (possibleMatches, approve, pending-merge, reject) through the REAL Hono app
 * on an in-process dynalite. Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { Scorer, Series, TenantConfig, Umpire } from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4827; // unique
const TABLE = 'SmartClubOfficialSignupTest';
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

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: TENANT, role: 'club', clubIds: ['home-club'] }]);

const call = (method: string, path: string, body?: unknown, auth: string | null = ADMIN) =>
  app.request(path, {
    method,
    headers: {
      'x-tenant': TENANT,
      ...(auth ? { 'x-dev-auth': auth } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;
async function mint(role: 'umpire' | 'scorer') {
  const res = await call('POST', `/admin/official-signup-link/${role}`);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await json<{ url: string; createdAt: string }>(res);
  assert.match(body.url, /\/officials\/register\?t=/);
  return tokenOf(body.url);
}
const submit = (token: string, body: unknown) =>
  call('POST', `/official-signup?t=${encodeURIComponent(token)}`, body, null);

const person = (over: Record<string, unknown> = {}) => ({
  firstNames: 'Andile',
  surname: 'Ngubane',
  phone: '082 123 4567',
  email: 'andile@example.org',
  consent: true,
  ...over,
});

const pendingUmpires = async () => (await repo.listUmpires(TENANT)).filter((u) => u.pending);
const pendingScorers = async () => (await repo.listScorers(TENANT)).filter((u) => u.pending);

const participants = [
  { teamId: 'home-club', clubId: 'home-club', name: 'Home Club' },
  { teamId: 'away-club', clubId: 'away-club', name: 'Away Club' },
];
const series = (id: string, fixtures: unknown[]): Series =>
  ({
    id,
    name: `Series ${id}`,
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: participants.map((p) => p.teamId),
    participants,
    fixtures,
    kind: 'series',
    approved: true,
    released: false,
    releasedAt: null,
    version: 1,
  }) as Series;

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));

  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const admin = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await admin.send(
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

  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  await repo.putTenantConfig({
    tenant: TENANT,
    branding: { name: 'KZN Dolphins', title: 'KZN Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
  } as unknown as TenantConfig);
  for (const p of participants) await repo.putClub(TENANT, { id: p.clubId, name: p.name } as never);
});

after(() => new Promise<void>((resolve) => ddbServer.close(() => resolve())));

describe('admin links', () => {
  test('mint, read, rotate (old token dies), revoke; non-admin 403', async () => {
    const empty = await call('GET', '/admin/official-signup-link/umpire');
    assert.deepEqual(await json(empty), { url: null });
    const t1 = await mint('umpire');
    const got = await json<{ url: string }>(
      await call('GET', '/admin/official-signup-link/umpire'),
    );
    assert.equal(tokenOf(got.url), t1);
    const pub = await call('GET', `/official-signup?t=${t1}`, undefined, null);
    assert.equal(pub.status, 200);
    assert.deepEqual(await json(pub), { role: 'umpire', tenantName: 'KZN Dolphins' });
    const t2 = await mint('umpire');
    assert.notEqual(t1, t2);
    assert.equal((await call('GET', `/official-signup?t=${t1}`, undefined, null)).status, 404);
    assert.equal(await repo.getToken(t1), null, 'rotated token item deleted');
    assert.equal((await call('GET', `/official-signup?t=${t2}`, undefined, null)).status, 200);
    // The scorer link is independent of the umpire one.
    const s1 = await mint('scorer');
    assert.equal((await call('GET', `/official-signup?t=${t2}`, undefined, null)).status, 200);
    assert.equal(
      (await json<{ role: string }>(await call('GET', `/official-signup?t=${s1}`, undefined, null)))
        .role,
      'scorer',
    );
    assert.equal((await call('DELETE', '/admin/official-signup-link/umpire')).status, 200);
    assert.equal((await call('GET', `/official-signup?t=${t2}`, undefined, null)).status, 404);
    assert.equal((await call('POST', `/official-signup?t=${t2}`, person(), null)).status, 404);
    assert.deepEqual(await json(await call('GET', '/admin/official-signup-link/umpire')), {
      url: null,
    });
    assert.equal(
      (await call('DELETE', '/admin/official-signup-link/umpire')).status,
      200,
      'idempotent',
    );
    assert.equal(
      (await call('POST', '/admin/official-signup-link/umpire', undefined, REP)).status,
      403,
    );
    assert.equal((await call('GET', '/admin/official-signup-link/referee')).status, 404);
  });

  test('a stale Settings save cannot resurrect a revoked pointer; GET /tenant never shows it', async () => {
    const t = await mint('scorer');
    const stale = await json<TenantConfig>(await call('GET', '/tenant/config'));
    assert.equal((stale as { officialSignupLinks?: unknown }).officialSignupLinks, undefined);
    await call('DELETE', '/admin/official-signup-link/scorer');
    const save = await call('PUT', '/tenant/config', {
      ...stale,
      officialSignupLinks: { scorer: { token: t, createdAt: 'x' } },
    });
    assert.ok(save.status < 300, await save.clone().text());
    assert.equal((await repo.getTenantConfig(TENANT))?.officialSignupLinks?.scorer, undefined);
    assert.equal((await call('GET', `/official-signup?t=${t}`, undefined, null)).status, 404);
    const pub = await call('GET', '/tenant', undefined, null);
    assert.ok(!(await pub.text()).includes('officialSignupLinks'));
  });

  test('bad tokens: missing 400, unknown 404, a club-signup token 404', async () => {
    assert.equal((await call('GET', '/official-signup', undefined, null)).status, 400);
    assert.equal((await call('GET', '/official-signup?t=nope', undefined, null)).status, 404);
    await repo.putSignupToken('club-tok', TENANT, 'x');
    assert.equal((await call('GET', '/official-signup?t=club-tok', undefined, null)).status, 404);
  });
});

describe('public submission', () => {
  let umpTok = '';
  let scTok = '';
  before(async () => {
    umpTok = await mint('umpire');
    scTok = await mint('scorer');
  });

  test('validation failures are 400 and write nothing', async () => {
    for (const bad of [
      person({ consent: false }),
      person({ consent: undefined }),
      person({ firstNames: ' ' }),
      person({ surname: undefined }),
      person({ phone: '' }),
      person({ phone: '12345' }),
      person({ email: 'not-an-email' }),
      person({ surname: 'x'.repeat(61) }),
      'not an object',
    ]) {
      const res = await submit(umpTok, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const scBad = await submit(scTok, person({ emergencyPhone: 'abc' }));
    assert.equal(scBad.status, 400);
    assert.equal((await pendingUmpires()).length, 0);
    assert.equal((await pendingScorers()).length, 0);
  });

  test('an umpire lands pending + inactive with consent; role comes from the token', async () => {
    const res = await submit(umpTok, person({ role: 'scorer', firstNames: '  andile   thabo ' }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await json(res), { ok: true });
    const [u] = await pendingUmpires();
    assert.equal(u.displayName, 'A.Ngubane');
    assert.equal(u.fullName, 'andile thabo Ngubane');
    assert.equal(u.phone, '0821234567');
    assert.equal(u.email, 'andile@example.org');
    assert.equal(u.active, false);
    assert.equal(u.pending, true);
    assert.equal(u.source, 'self-registration');
    assert.ok(u.consentAt && u.submittedAt);
    assert.equal((await pendingScorers()).length, 0, 'body role ignored');
  });

  test('a same-phone submission files its OWN pending record; the first is untouched', async () => {
    const [first] = await pendingUmpires();
    await new Promise((r) => setTimeout(r, 5));
    const res = await submit(
      umpTok,
      person({
        firstNames: 'Imposter',
        surname: 'Ngubane',
        phone: '+27821234567',
        email: 'evil@example.org',
      }),
    );
    assert.deepEqual(await json(res), { ok: true });
    const list = await pendingUmpires();
    assert.equal(list.length, 2);
    assert.deepEqual(await repo.getUmpire(TENANT, first.id), first, 'byte-for-byte unchanged');
    const second = list.find((u) => u.id !== first.id)!;
    assert.equal(second.fullName, 'Imposter Ngubane');
    // Both rows list each other in pendingDuplicates (admin view).
    const view = await json<Array<Umpire & { pendingDuplicates?: unknown }>>(
      await call('GET', '/umpires'),
    );
    assert.deepEqual(view.find((u) => u.id === first.id)!.pendingDuplicates, [
      { id: second.id, displayName: second.displayName, submittedAt: second.submittedAt },
    ]);
    assert.deepEqual(view.find((u) => u.id === second.id)!.pendingDuplicates, [
      { id: first.id, displayName: first.displayName, submittedAt: first.submittedAt },
    ]);
    // Rejecting one leaves the other.
    const del = await call('DELETE', `/umpires/${second.id}`);
    assert.equal((await json<{ hardDeleted: boolean }>(del)).hardDeleted, true);
    assert.deepEqual(await repo.getUmpire(TENANT, first.id), first);
    const after = await json<Array<Umpire & { pendingDuplicates?: unknown }>>(
      await call('GET', '/umpires'),
    );
    assert.deepEqual(after.find((u) => u.id === first.id)!.pendingDuplicates, []);
  });

  test('a scorer submission carries the scorer-only fields', async () => {
    const res = await submit(
      scTok,
      person({
        firstNames: 'Priya',
        surname: 'Govender',
        phone: '0831112222',
        idNumber: '8001015009087',
        emergencyPhone: '+27 84 000 0000',
        address: '1 Road',
      }),
    );
    assert.equal(res.status, 200);
    const [s] = await pendingScorers();
    assert.equal(s.displayName, 'Priya Govender');
    assert.equal(s.emergencyPhone, '0840000000');
    assert.equal(s.idNumber, '8001015009087');
    assert.equal(s.active, false);
  });

  test('a pending umpire cannot be appointed and is hidden from club lists', async () => {
    const [u] = await pendingUmpires();
    await repo.putSeries(
      TENANT,
      series('s-app', [
        { id: 'f1', round: 1, date: '2026-12-06', home: 'home-club', away: 'away-club' },
      ]),
    );
    const put = await call('PUT', '/series/s-app/fixtures/f1/officials', { umpires: [u.id] });
    assert.equal(put.status, 400);
    const clubList = await json<Array<{ id: string }>>(
      await call('GET', '/umpires', undefined, REP),
    );
    assert.ok(!clubList.some((x) => x.id === u.id));
    // The public captain's-report link's umpire registry lists active entries only.
    const rid = 's-app~f1~home-club';
    await repo.createCaptainsReport(TENANT, {
      id: rid,
      seriesId: 's-app',
      fixtureId: 'f1',
      clubId: 'home-club',
      status: 'pending',
      matchDate: '2099-12-06',
      linkExpiresAt: '2099-12-13T21:59:59.000Z',
      recipient: { memberId: 'm-cap', name: 'Cap' },
      umpiresSnapshot: [],
      umpires: [],
      captainName: '',
      general: '',
      declaration: false,
      createdAt: '2026-11-01T00:00:00Z',
    } as never);
    const link = await call('GET', `/captains-reports/${rid}/link`);
    assert.equal(link.status, 200, await link.clone().text());
    const { url } = await json<{ url: string }>(link);
    const tok = url.split('/').pop()!.split('?')[0];
    const pub = await call('GET', `/captains-report-link/${tok}`, undefined, null);
    assert.equal(pub.status, 200, await pub.clone().text());
    const reg = (await json<{ registry: Array<{ id: string }> }>(pub)).registry;
    assert.ok(!reg.some((x) => x.id === u.id), 'pending umpire not offered to captains');
    // The appointments import resolves names through ACTIVE aliases only.
    const imp = await import('../src/import-umpire-appointments.js');
    const { byName } = imp.resolveUmpireNames(['A.Ngubane'], await repo.listUmpires(TENANT));
    assert.equal(byName.size, 0);
    // PATCH active:true is still refused (Task 0 guard).
    const patch = await call('PATCH', `/umpires/${u.id}`, { active: true });
    assert.equal(patch.status, 409);
    assert.equal((await json<{ code: string }>(patch)).code, 'umpire_pending');
  });

  test('rate limit: 120 submissions an hour per token, then 429', async () => {
    const t = await mint('scorer');
    await repo.bumpSignupTokenCounter(t, new Date().toISOString(), 1); // open the window
    for (let i = 0; i < 118; i++)
      await repo.bumpSignupTokenCounter(t, new Date().toISOString(), 1000);
    const ok = await submit(
      t,
      person({ phone: '0835550001', firstNames: 'Rate', surname: 'Limited' }),
    );
    assert.equal(ok.status, 200, 'the 120th is allowed');
    const over = await submit(
      t,
      person({ phone: '0835550002', firstNames: 'Rate', surname: 'Over' }),
    );
    assert.equal(over.status, 429);
  });
});

describe('pending lifecycle', () => {
  const ump = (id: string, over: Partial<Umpire> = {}): Umpire => ({
    id,
    displayName: id,
    aliases: [],
    active: true,
    ...over,
  });

  test('possibleMatches: ranked, active-only, admin-only', async () => {
    await repo.putUmpire(
      TENANT,
      ump('u-reg-ngubane', { displayName: 'A.Ngubane', aliases: ['angubane'] }),
    );
    await repo.putUmpire(
      TENANT,
      ump('u-ayanda', { displayName: 'Ayanda Ngubane', aliases: ['ayandangubane'] }),
    );
    await repo.putUmpire(
      TENANT,
      ump('u-byphone', { displayName: 'Z.Phone', aliases: ['zphone'], phone: '082 123 4567' }),
    );
    await repo.putUmpire(
      TENANT,
      ump('u-erased', { displayName: 'A.Ngubane', active: false, erasedAt: 'x' }),
    );
    await repo.putUmpire(
      TENANT,
      ump('u-merged', { displayName: 'A.Ngubane', active: false, mergedInto: 'u-reg-ngubane' }),
    );
    const list = await json<Array<Umpire & { possibleMatches?: unknown }>>(
      await call('GET', '/umpires'),
    );
    const pending = list.find((u) => u.pending)!;
    assert.deepEqual(pending.possibleMatches, [
      { id: 'u-byphone', displayName: 'Z.Phone', reason: 'phone' },
      { id: 'u-reg-ngubane', displayName: 'A.Ngubane', reason: 'name' },
      { id: 'u-ayanda', displayName: 'Ayanda Ngubane', reason: 'surname-initial' },
    ]);
    assert.ok(list.filter((u) => !u.pending).every((u) => u.possibleMatches === undefined));
  });

  test('approve: clash 409 names the existing entry; not-pending 409', async () => {
    const [p] = await pendingUmpires();
    const res = await call('POST', `/umpires/${p.id}/approve`, { submittedAt: p.submittedAt });
    assert.equal(res.status, 409);
    const body = await json<{ code: string; umpireId: string; displayName: string }>(res);
    assert.equal(body.code, 'umpire_alias_taken');
    assert.equal(body.umpireId, 'u-reg-ngubane');
    assert.equal(body.displayName, 'A.Ngubane');
    const live = await call('POST', '/umpires/u-reg-ngubane/approve', { submittedAt: 'x' });
    assert.equal(live.status, 409);
    assert.equal((await json<{ code: string }>(live)).code, 'umpire_not_pending');
  });

  test('approve success: active, pending cleared, provenance kept', async () => {
    const [s] = await pendingScorers();
    const res = await call('POST', `/scorers/${s.id}/approve`, { submittedAt: s.submittedAt });
    assert.equal(res.status, 200, await res.clone().text());
    const got = (await repo.getScorer(TENANT, s.id))!;
    assert.equal(got.active, true);
    assert.equal(got.pending, undefined);
    assert.equal(got.source, 'self-registration');
    assert.ok(got.consentAt && got.submittedAt);
    await repo.putScorer(TENANT, { ...got, id: 'sc-dup', pending: true, active: false } as Scorer);
    const clash = await call('POST', '/scorers/sc-dup/approve', { submittedAt: got.submittedAt });
    assert.equal(clash.status, 409);
    assert.equal((await json<{ code: string; scorerId: string }>(clash)).scorerId, s.id);
    await repo.deleteScorer(TENANT, 'sc-dup');
  });

  test('pending-merge: contact_choice_required, then each choice; aliases untouched; consent carried', async () => {
    const [p0] = await pendingUmpires();
    // The resubmission cleared the email; give the pending one so it conflicts.
    const p = { ...p0, email: 'andile@example.org' };
    await repo.putUmpire(TENANT, p);
    // Target holds a different email; phone is blank there.
    await repo.putUmpire(
      TENANT,
      ump('u-target', {
        displayName: 'A.N',
        aliases: ['an'],
        email: 'office@example.org',
        fullName: 'Kept Name',
      }),
    );
    const blocked = await call('POST', `/umpires/${p.id}/merge`, {
      targetId: 'u-target',
      submittedAt: p.submittedAt,
    });
    assert.equal(blocked.status, 409);
    const b = await json<{ code: string; conflicts: unknown }>(blocked);
    assert.equal(b.code, 'contact_choice_required');
    assert.deepEqual(b.conflicts, [
      { field: 'email', source: p.email, target: 'office@example.org' },
    ]);
    assert.ok(await repo.getUmpire(TENANT, p.id), 'nothing applied');
    assert.equal(
      (
        await call('POST', `/umpires/${p.id}/merge`, {
          targetId: 'u-target',
          submittedAt: p.submittedAt,
          contact: { email: 'maybe' },
        })
      ).status,
      400,
    );

    const keep = await call('POST', `/umpires/${p.id}/merge`, {
      submittedAt: p.submittedAt,
      targetId: 'u-target',
      contact: { email: 'target' },
    });
    assert.equal(keep.status, 200, await keep.clone().text());
    const k = await json<{ target: Umpire; previous: unknown; repointed: number }>(keep);
    assert.deepEqual(k.previous, { phone: null, email: 'office@example.org' });
    assert.equal(k.repointed, 0);
    assert.equal(k.target.email, 'office@example.org');
    assert.equal(k.target.phone, '0821234567', 'blank filled');
    assert.equal(k.target.fullName, 'Kept Name', 'held non-contact field kept');
    assert.deepEqual(k.target.aliases, ['an'], 'aliases not moved');
    assert.equal(k.target.consentAt, p.consentAt);
    assert.equal(k.target.source, 'self-registration');
    assert.equal(await repo.getUmpire(TENANT, p.id), null, 'pending source gone');

    // 'source' choice replaces the held value.
    const tok = await mint('umpire');
    await submit(
      tok,
      person({ firstNames: 'Andile', phone: '0829990000', email: 'new@example.org' }),
    );
    const [p2] = await pendingUmpires();
    const take = await call('POST', `/umpires/${p2.id}/merge`, {
      submittedAt: p2.submittedAt,
      targetId: 'u-target',
      contact: { phone: 'source', email: 'source' },
    });
    assert.equal(take.status, 200, await take.clone().text());
    const t = await json<{ target: Umpire; previous: unknown }>(take);
    assert.deepEqual(t.previous, { phone: '0821234567', email: 'office@example.org' });
    assert.equal(t.target.phone, '0829990000');
    assert.equal(t.target.email, 'new@example.org');
  });

  test('pending-merge into an inactive or erased target is refused', async () => {
    const tok = await mint('umpire');
    await submit(tok, person({ firstNames: 'Inactive', surname: 'Target', phone: '0827770000' }));
    const p = (await pendingUmpires()).find((u) => u.phone === '0827770000')!;
    await repo.putUmpire(TENANT, ump('u-off', { active: false }));
    assert.equal(
      (
        await call('POST', `/umpires/${p.id}/merge`, {
          targetId: 'u-off',
          submittedAt: p.submittedAt,
        })
      ).status,
      409,
    );
    const erased = await call('POST', `/umpires/${p.id}/merge`, {
      targetId: 'u-erased',
      submittedAt: p.submittedAt,
    });
    assert.equal((await json<{ code: string }>(erased)).code, 'umpire_erased');
  });

  test('reject: DELETE hard-deletes a pending record that has possible matches', async () => {
    const p = (await pendingUmpires()).find((u) => u.phone === '0827770000')!;
    const res = await call('DELETE', `/umpires/${p.id}`);
    assert.equal(res.status, 200);
    assert.equal((await json<{ hardDeleted: boolean }>(res)).hardDeleted, true);
    assert.equal(await repo.getUmpire(TENANT, p.id), null);
  });

  test('classic merge is unchanged (source retired with mergedInto, aliases adopted)', async () => {
    await repo.putUmpire(TENANT, ump('u-classic-src', { displayName: 'C.Src', aliases: ['csrc'] }));
    await repo.putUmpire(TENANT, ump('u-classic-dst', { displayName: 'C.Dst', aliases: ['cdst'] }));
    const res = await call('POST', '/umpires/u-classic-src/merge', { targetId: 'u-classic-dst' });
    assert.equal(res.status, 200, await res.clone().text());
    const src = (await repo.getUmpire(TENANT, 'u-classic-src'))!;
    assert.equal(src.mergedInto, 'u-classic-dst');
    assert.ok((await repo.getUmpire(TENANT, 'u-classic-dst'))!.aliases.includes('csrc'));
  });

  test('scorer pending-merge fills blanks including scorer-only fields', async () => {
    await repo.putScorer(TENANT, { id: 'sc-target', displayName: 'P Govender', active: true });
    const tok = await mint('scorer');
    await submit(
      tok,
      person({
        firstNames: 'Priya',
        surname: 'Govendor',
        phone: '0836660000',
        idNumber: '123',
        address: 'Addr',
      }),
    );
    const p = (await pendingScorers())[0];
    const res = await call('POST', `/scorers/${p.id}/merge`, {
      targetId: 'sc-target',
      submittedAt: p.submittedAt,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const t = (await repo.getScorer(TENANT, 'sc-target'))!;
    assert.equal(t.phone, '0836660000');
    assert.equal(t.idNumber, '123');
    assert.equal(t.address, 'Addr');
    assert.equal(t.displayName, 'P Govender');
    assert.equal(await repo.getScorer(TENANT, p.id), null);
  });
});

describe('review guards and limits', () => {
  test('approve/merge need submittedAt and 409 registration_changed when the record changed', async () => {
    const tok = await mint('umpire');
    await submit(tok, person({ firstNames: 'Stale', surname: 'Review', phone: '0824440000' }));
    const seen = (await pendingUmpires()).find((u) => u.phone === '0824440000')!;
    assert.equal((await call('POST', `/umpires/${seen.id}/approve`)).status, 400);
    assert.equal(
      (await call('POST', `/umpires/${seen.id}/merge`, { targetId: 'u-target' })).status,
      400,
    );
    // A concurrent admin action changed the record (simulated through the repo).
    await repo.putUmpire(TENANT, {
      ...seen,
      fullName: 'Stale Changed',
      submittedAt: new Date().toISOString(),
    });
    const approve = await call('POST', `/umpires/${seen.id}/approve`, {
      submittedAt: seen.submittedAt,
    });
    assert.equal(approve.status, 409);
    assert.equal((await json<{ code: string }>(approve)).code, 'registration_changed');
    const before = await repo.getUmpire(TENANT, 'u-target');
    const merge = await call('POST', `/umpires/${seen.id}/merge`, {
      targetId: 'u-target',
      submittedAt: seen.submittedAt,
      contact: { phone: 'source', email: 'source' },
    });
    assert.equal(merge.status, 409);
    assert.equal((await json<{ code: string }>(merge)).code, 'registration_changed');
    assert.deepEqual(await repo.getUmpire(TENANT, 'u-target'), before, 'nothing written');
    const now = (await repo.getUmpire(TENANT, seen.id))!;
    assert.equal(now.pending, true);
    assert.equal(now.fullName, 'Stale Changed');
    await repo.deleteUmpire(TENANT, seen.id);
  });

  test('scorer: a same-phone submission never touches the first one', async () => {
    const tok = await mint('scorer');
    await submit(
      tok,
      person({
        firstNames: 'Opt',
        surname: 'Fields',
        phone: '0825550000',
        idNumber: '99',
        address: 'A',
        emergencyPhone: '0845550000',
      }),
    );
    const first = (await pendingScorers()).find((x) => x.phone === '0825550000')!;
    await submit(
      tok,
      person({
        firstNames: 'Other',
        surname: 'Person',
        phone: '0825550000',
        email: 'x@example.org',
        idNumber: '11',
        address: 'B',
      }),
    );
    assert.deepEqual(await repo.getScorer(TENANT, first.id), first, 'byte-for-byte unchanged');
    const both = (await pendingScorers()).filter((x) => x.phone === '0825550000');
    assert.equal(both.length, 2);
    for (const x of both) await repo.deleteScorer(TENANT, x.id);
  });

  test('an id collision at create retries with a suffixed id (no 500)', async () => {
    // Unit: a collision on the first create (the race) retries under a suffix.
    const { createWithFreshId } = await import('../src/official-signup.js');
    const tried: string[] = [];
    const id = await createWithFreshId(
      'u-x',
      new Set(),
      async (candidate) => {
        tried.push(candidate);
        if (tried.length === 1) throw new repo.UmpireExistsError();
      },
      (err) => err instanceof repo.UmpireExistsError,
    );
    assert.equal(tried[0], 'u-x');
    assert.match(id, /^u-x-[0-9a-f]{6}$/);
    // Through the route: the stem already taken ⇒ a suffixed id, 200.
    await repo.createUmpire(TENANT, {
      id: 'u-r-condition',
      displayName: 'R.Condition',
      aliases: [],
      active: false,
    });
    const tok = await mint('umpire');
    const res = await submit(
      tok,
      person({ firstNames: 'Race', surname: 'Condition', phone: '0826660000' }),
    );
    assert.equal(res.status, 200, await res.clone().text());
    const mine = (await pendingUmpires()).find((u) => u.phone === '0826660000')!;
    assert.match(mine.id, /^u-r-condition-[0-9a-f]{6}$/);
    await repo.deleteUmpire(TENANT, mine.id);
    await repo.deleteUmpire(TENANT, 'u-r-condition');
  });

  test('pending cap counts every submission, same-phone ones included', async () => {
    const { MAX_PENDING_OFFICIALS } = await import('../src/official-signup.js');
    const already = (await pendingScorers()).length;
    for (let i = already; i < MAX_PENDING_OFFICIALS - 2; i++)
      await repo.putScorer(TENANT, {
        id: `sc-flood-${i}`,
        displayName: `Flood ${i}`,
        phone: `07${String(i).padStart(8, '0')}`,
        active: false,
        pending: true,
        submittedAt: 'x',
      } as Scorer);
    const tok = await mint('scorer');
    const same = person({ firstNames: 'Twice', surname: 'Over', phone: '0827778888' });
    assert.equal((await submit(tok, same)).status, 200);
    assert.equal((await submit(tok, same)).status, 200, 'second same-phone record is its own');
    assert.equal((await submit(tok, same)).status, 429, 'the cap counts both');
    assert.equal((await pendingScorers()).length, MAX_PENDING_OFFICIALS);
    for (let i = already; i < MAX_PENDING_OFFICIALS - 2; i++)
      await repo.deleteScorer(TENANT, `sc-flood-${i}`);
    for (const x of (await pendingScorers()).filter((x) => x.phone === '0827778888'))
      await repo.deleteScorer(TENANT, x.id);
  });

  test('umpire pending-merge filling fullName adds it as an alias, or 409s on a clash', async () => {
    await repo.putUmpire(TENANT, {
      id: 'u-blank',
      displayName: 'B.Lank',
      aliases: ['blank'],
      active: true,
    });
    const tok = await mint('umpire');
    await submit(tok, person({ firstNames: 'Bongani', surname: 'Lank', phone: '0821110000' }));
    const p = (await pendingUmpires()).find((u) => u.phone === '0821110000')!;
    // Another active umpire already answers to the full name ⇒ 409, nothing written.
    await repo.putUmpire(TENANT, {
      id: 'u-holder',
      displayName: 'Bongani Lank',
      aliases: ['bonganilank'],
      active: true,
    });
    const clash = await call('POST', `/umpires/${p.id}/merge`, {
      targetId: 'u-blank',
      submittedAt: p.submittedAt,
    });
    assert.equal(clash.status, 409);
    const body = await json<{ code: string; umpireId: string }>(clash);
    assert.equal(body.code, 'umpire_alias_taken');
    assert.equal(body.umpireId, 'u-holder');
    assert.deepEqual((await repo.getUmpire(TENANT, 'u-blank'))!.aliases, ['blank']);
    assert.ok(await repo.getUmpire(TENANT, p.id));
    await repo.deleteUmpire(TENANT, 'u-holder');
    const ok = await call('POST', `/umpires/${p.id}/merge`, {
      targetId: 'u-blank',
      submittedAt: p.submittedAt,
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    const t = (await repo.getUmpire(TENANT, 'u-blank'))!;
    assert.deepEqual([...t.aliases].sort(), ['blank', 'bonganilank']);
    assert.ok(!t.aliases.includes('blank-sheet-form-from-source'));
  });

  test("a token minted for tenant A works on tenant B's host and files into A", async () => {
    // Club-signup precedent: the token self-describes its tenant and the request host is
    // never trusted for authorization, so the token's tenant wins.
    const tok = await mint('scorer');
    const other = await app.request(`/official-signup?t=${tok}`, {
      headers: { 'x-tenant': 'titans' },
    });
    assert.equal(other.status, 200);
    assert.equal((await json<{ tenantName: string }>(other)).tenantName, 'KZN Dolphins');
    const post = await app.request(`/official-signup?t=${tok}`, {
      method: 'POST',
      headers: { 'x-tenant': 'titans', 'content-type': 'application/json' },
      body: JSON.stringify(person({ firstNames: 'Cross', surname: 'Tenant', phone: '0829998888' })),
    });
    assert.equal(post.status, 200);
    assert.ok((await pendingScorers()).some((x) => x.phone === '0829998888'));
    assert.equal((await repo.listScorers('titans')).length, 0);
  });

  test('every link route answers Cache-Control: no-store', async () => {
    await mint('umpire');
    const get = await call('GET', '/admin/official-signup-link/umpire');
    assert.equal(get.headers.get('cache-control'), 'no-store');
    const empty = await call('GET', '/admin/official-signup-link/scorer');
    assert.equal(empty.headers.get('cache-control'), 'no-store');
    const del = await call('DELETE', '/admin/official-signup-link/scorer');
    assert.equal(del.headers.get('cache-control'), 'no-store');
  });
});

describe('tenant erasure', () => {
  test('removes the official signup tokens', async () => {
    const u = await mint('umpire');
    const s = await mint('scorer');
    await repo.eraseTenantData(TENANT);
    assert.equal(await repo.getToken(u), null);
    assert.equal(await repo.getToken(s), null);
  });
});
