/**
 * Player document requests (admin "Request ID document" → `/d/<token>` upload page):
 *   - link tokens: round-trip, expiry, tampering, and domain separation from squad tokens;
 *   - skip rules + status aggregation (minor, no contact, cell-only while the template is
 *     pending), through the real admin route against in-process dynalite (dry-run senders);
 *   - idempotent re-send: the same idempotencyKey never sends twice; a new key extends the
 *     pending request (same id, later expiry) instead of minting another;
 *   - the public GET's terminal states (invalid / expired / completed / player gone);
 *   - completion: the staleness guard (a doc that arrived another way wins), the replaced
 *     object is deleted only AFTER the conditional write, one retry on a version conflict;
 *   - the console PATCH id-doc completes a pending request;
 *   - erasure (player, club, tenant) sweeps DOCREQ#, DOCREQLINK# and the NOTIFY#docreq# ledger.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4811;
const TABLE = 'SmartClubDocRequestsTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

const TENANT = 'docreq';
const SECRET = 'local-dev-captains-report-link-secret'; // env.ts LOCAL_AUTH fallback

type Repo = typeof import('../src/repo.js');
type DocReqs = typeof import('../src/doc-requests.js');
type Club = import('../src/types.js').Club;
type PlayerRegistration = import('../src/types.js').PlayerRegistration;
type TenantConfig = import('../src/types.js').TenantConfig;

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: `sub-${email}`, email, memberships })).toString('base64');
const ADMIN = devAuth('admin@union.test', [{ tenantId: TENANT, role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@alpha.test', [{ tenantId: TENANT, role: 'rep', clubIds: ['alpha'] }]);
const headers = (auth: string) => ({
  'x-tenant': TENANT,
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: Repo;
let dr: DocReqs;

const mkClub = (id: string, name: string): Club =>
  ({
    id,
    name,
    district: 'Test District',
    sub: `sub-${id}`,
    chair: 'Chair',
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
    version: 1,
  }) as Club;

let seq = 0;
const mkPlayer = (clubId: string, extra: Partial<PlayerRegistration> = {}): PlayerRegistration => {
  seq++;
  return {
    naturalKey: `nk-${seq}`,
    clubId,
    firstName: `First${seq}`,
    lastName: `Last${seq}`,
    dob: '1994-02-02',
    isMinor: false,
    status: 'active',
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...extra,
  } as PlayerRegistration;
};

const sendRequest = (players: PlayerRegistration[], idempotencyKey: string) =>
  app.request('/admin/doc-requests', {
    method: 'POST',
    headers: headers(ADMIN),
    body: JSON.stringify({
      players: players.map((p) => ({ clubId: p.clubId, naturalKey: p.naturalKey })),
      docKey: 'idDoc',
      idempotencyKey,
    }),
  });

const tokenFor = async (p: PlayerRegistration, e?: number) => {
  const req = await repo.getDocRequest(TENANT, p.naturalKey, 'idDoc');
  assert.ok(req, 'a request exists');
  return dr.signDocRequestLinkToken(
    { t: TENANT, q: req.requestId, e: e ?? Math.floor(Date.parse(req.linkExpiresAt) / 1000) },
    SECRET,
  );
};

before(async () => {
  ddbServer = await startDynalite(DDB_PORT, TABLE);
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');
  dr = await import('../src/doc-requests.js');
  await repo.putTenantConfig({
    tenant: TENANT,
    branding: { name: 'Doc Union', title: 'Doc Union', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
  } as unknown as TenantConfig);
  await repo.createClub(TENANT, mkClub('alpha', 'Alpha CC'));
  await repo.createClub(TENANT, mkClub('beta', 'Beta CC'));
});

after(async () => {
  await stopDynalite(ddbServer);
});

describe('link tokens', () => {
  test('round-trip, expiry and tampering', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    const e = Math.floor(now / 1000) + 60;
    const tok = dr.signDocRequestLinkToken({ t: 'x', q: 'req-1', e }, 's3cret');
    const ok = dr.verifyDocRequestLinkToken(tok, 's3cret', now);
    assert.deepEqual(ok, { ok: true, payload: { t: 'x', q: 'req-1', e } });
    // Valid AT e, expired after.
    assert.equal(dr.verifyDocRequestLinkToken(tok, 's3cret', e * 1000).ok, true);
    assert.deepEqual(dr.verifyDocRequestLinkToken(tok, 's3cret', e * 1000 + 1000), {
      ok: false,
      reason: 'expired',
    });
    // Wrong secret, tampered payload, extra segment.
    assert.deepEqual(dr.verifyDocRequestLinkToken(tok, 'other', now), {
      ok: false,
      reason: 'invalid',
    });
    const [payload, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'x', q: 'req-2', e })).toString('base64url');
    assert.equal(dr.verifyDocRequestLinkToken(`${forged}.${sig}`, 's3cret', now).ok, false);
    assert.equal(dr.verifyDocRequestLinkToken(`${payload}.${sig}.x`, 's3cret', now).ok, false);
  });

  test('a squad-link token with the same payload never verifies (prefix separation)', async () => {
    const { signSquadLinkToken } = await import('../src/squad-requests.js');
    const e = Math.floor(Date.now() / 1000) + 60;
    const squad = signSquadLinkToken({ t: 'x', r: 'm', q: 'req-1', e }, 's3cret');
    assert.equal(dr.verifyDocRequestLinkToken(squad, 's3cret', Date.now()).ok, false);
  });
});

describe('token hygiene', () => {
  test('/d/ and /doc-request-link/ tokens are scrubbed for Sentry', async () => {
    const { scrubReportTokens } = await import('../src/instrument.js');
    assert.equal(scrubReportTokens('https://x.test/d/abc.def?x=1'), 'https://x.test/d/[token]?x=1');
    assert.equal(
      scrubReportTokens('/doc-request-link/abc.def/complete'),
      '/doc-request-link/[token]/complete',
    );
  });
});

describe('skip rules + aggregation', () => {
  const hasCell = (c: string | undefined) => !!c && c.length >= 9;
  test('minor, no contact, cell-only while WhatsApp is unusable', () => {
    assert.equal(
      dr.docRequestSkipReason({ isMinor: true, email: 'a@b.co' }, true, hasCell),
      'skipped_minor',
    );
    assert.equal(dr.docRequestSkipReason({ isMinor: false }, true, hasCell), 'skipped_no_contact');
    assert.equal(
      dr.docRequestSkipReason({ isMinor: false, cell: '0821234567' }, false, hasCell),
      'skipped_whatsapp_unavailable',
    );
    assert.equal(
      dr.docRequestSkipReason({ isMinor: false, cell: '0821234567' }, true, hasCell),
      null,
    );
    assert.equal(
      dr.docRequestSkipReason({ isMinor: false, email: 'a@b.co' }, false, hasCell),
      null,
    );
  });

  test('any sent ⇒ sent; template-gated skip ⇒ whatsapp unavailable; else failed', () => {
    const P = 'template-pending';
    assert.equal(
      dr.aggregateDocRequestStatus(
        [
          { channel: 'email', status: 'sent' },
          { channel: 'whatsapp', status: 'failed' },
        ],
        P,
      ),
      'sent',
    );
    assert.equal(
      dr.aggregateDocRequestStatus(
        [
          { channel: 'email', status: 'skipped' },
          { channel: 'whatsapp', status: 'skipped', error: P },
        ],
        P,
      ),
      'skipped_whatsapp_unavailable',
    );
    assert.equal(
      dr.aggregateDocRequestStatus([{ channel: 'email', status: 'skipped' }], P),
      'skipped_no_contact',
    );
    assert.equal(
      dr.aggregateDocRequestStatus(
        [
          { channel: 'email', status: 'failed' },
          { channel: 'whatsapp', status: 'skipped', error: P },
        ],
        P,
      ),
      'failed',
    );
  });
});

describe('admin send route', () => {
  const reachable = mkPlayer('alpha', { email: 'reach@example.com', cell: '0821234567' });
  const minor = mkPlayer('alpha', { isMinor: true, email: 'kid@example.com' });
  const noContact = mkPlayer('alpha');
  const cellOnly = mkPlayer('alpha', { cell: '0827654321' });

  before(async () => {
    for (const p of [reachable, minor, noContact, cellOnly]) await repo.createPlayer(TENANT, p);
  });

  test('rejects non-admins', async () => {
    const res = await app.request('/admin/doc-requests', {
      method: 'POST',
      headers: headers(REP),
      body: JSON.stringify({ players: [], idempotencyKey: 'abcdefgh1' }),
    });
    assert.equal(res.status, 403);
  });

  test('reports per-player outcomes and creates requests only for the reachable', async () => {
    const res = await sendRequest([reachable, minor, noContact, cellOnly], 'idem-key-0001');
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as {
      results: Array<{ displayName: string; status: string }>;
    };
    // The template is registered, so a cell-only player is reachable over WhatsApp
    // (dry-run in tests reports the send as sent).
    assert.deepEqual(
      results.map((r) => r.status),
      ['sent', 'skipped_minor', 'skipped_no_contact', 'sent'],
    );
    assert.equal(results[0].displayName, `${reachable.firstName} ${reachable.lastName}`);
    assert.ok(!JSON.stringify(results).includes(reachable.naturalKey), 'no natural keys served');
    const req = await repo.getDocRequest(TENANT, reachable.naturalKey, 'idDoc');
    assert.equal(req?.status, 'pending');
    assert.equal(req?.docName, 'ID document');
    assert.ok(!JSON.stringify(req?.lastSendResults).includes('reach@example.com'));
    for (const p of [minor, noContact])
      assert.equal(await repo.getDocRequest(TENANT, p.naturalKey, 'idDoc'), null);
    assert.equal(
      (await repo.getDocRequest(TENANT, cellOnly.naturalKey, 'idDoc'))?.status,
      'pending',
    );
    const link = await repo.getDocRequestLink(TENANT, req!.requestId);
    assert.equal(link?.naturalKey, reachable.naturalKey);
  });

  test('the same idempotencyKey never sends twice; a new key extends the pending request', async () => {
    const before1 = await repo.getDocRequest(TENANT, reachable.naturalKey, 'idDoc');
    const replay = await sendRequest([reachable], 'idem-key-0001');
    assert.equal(replay.status, 200);
    const after1 = await repo.getDocRequest(TENANT, reachable.naturalKey, 'idDoc');
    assert.equal(after1?.lastSentAt, before1?.lastSentAt, 'a replay sends nothing');
    assert.equal(after1?.linkExpiresAt, before1?.linkExpiresAt, 'a replay does not extend');

    await new Promise((r) => setTimeout(r, 5));
    const resend = await sendRequest([reachable], 'idem-key-0002');
    assert.equal(resend.status, 200);
    const after2 = await repo.getDocRequest(TENANT, reachable.naturalKey, 'idDoc');
    assert.equal(after2?.requestId, before1?.requestId, 'same request, re-signed');
    assert.equal(after2?.createdAt, before1?.createdAt);
    assert.ok(after2!.linkExpiresAt > before1!.linkExpiresAt, 'expiry extended');
    // The ledger holds one row per (request, key).
    assert.equal(
      await repo.claimDocRequestNotify(TENANT, before1!.requestId, 'idem-key-0002'),
      false,
    );
  });

  test('the indicator list serves pending requests', async () => {
    const res = await app.request('/admin/doc-requests', { headers: headers(ADMIN) });
    const list = (await res.json()) as Array<{ naturalKey: string; status: string }>;
    assert.ok(list.some((r) => r.naturalKey === reachable.naturalKey && r.status === 'pending'));
  });
});

describe('public link', () => {
  test('GET: pending payload, then the terminal states', async () => {
    const p = mkPlayer('alpha', { email: 'pub@example.com' });
    await repo.createPlayer(TENANT, p);
    assert.equal((await sendRequest([p], 'idem-pub-0001')).status, 200);
    const token = await tokenFor(p);
    const ok = await app.request(`/doc-request-link/${token}`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.state, 'pending');
    assert.equal(body.firstName, p.firstName);
    assert.equal(body.docName, 'ID document');
    assert.equal(body.clubName, 'Alpha CC');
    assert.ok(!JSON.stringify(body).includes(p.naturalKey));

    const bad = await app.request(`/doc-request-link/${token.slice(0, -2)}xx`);
    assert.equal(bad.status, 404);
    const expired = await app.request(`/doc-request-link/${await tokenFor(p, 1000)}`);
    assert.equal(expired.status, 410);
    assert.equal(((await expired.json()) as { kind: string }).kind, 'expired');

    // Player gone from the stored club ⇒ terminally invalid (a request never follows a move).
    await repo.deletePlayer(TENANT, p);
    const gone = await app.request(`/doc-request-link/${token}`);
    assert.equal(gone.status, 404);
    assert.equal(((await gone.json()) as { kind: string }).kind, 'invalid');
  });

  test('upload-url presigns under the club prefix and is rate limited', async () => {
    const p = mkPlayer('alpha', { email: 'rate@example.com' });
    await repo.createPlayer(TENANT, p);
    await sendRequest([p], 'idem-rate-0001');
    const token = await tokenFor(p);
    const first = await app.request(`/doc-request-link/${token}/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    assert.equal(first.status, 200);
    const { objectKey } = (await first.json()) as { objectKey: string };
    assert.match(objectKey, /^docreq\/alpha\/player-id-[0-9a-f-]{36}\.png$/);
    assert.ok(!objectKey.includes(p.naturalKey));
    let last = 200;
    for (let i = 0; i < dr.DOC_REQUEST_UPLOADS_PER_HOUR; i++) {
      last = (
        await app.request(`/doc-request-link/${token}/upload-url`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contentType: 'image/png' }),
        })
      ).status;
    }
    assert.equal(last, 429);
  });
});

describe('completion', () => {
  const okHead = async () => ({ size: 1234, contentType: 'image/png' });

  async function linked(p: PlayerRegistration, key: string) {
    await repo.createPlayer(TENANT, p);
    await sendRequest([p], key);
    return dr.loadLinkedDocRequest(repo, await tokenFor(p), Date.now(), SECRET);
  }

  test('writes idDocMeta, deletes the replaced object only AFTER the write, completes', async () => {
    const p = mkPlayer('alpha', {
      email: 'c1@example.com',
      idDocMeta: {
        objectKey: 'docreq/alpha/player-id-old.png',
        size: 10,
        uploadedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const found = await linked(p, 'idem-c1-00001');
    const log: string[] = [];
    const newKey = `docreq/alpha/player-id-${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}.png`;
    await dr.completeDocRequestUpload(
      {
        repo: {
          ...repo,
          getPlayer: repo.getPlayer,
          completeDocRequest: repo.completeDocRequest,
          updatePlayer: async (...args: Parameters<Repo['updatePlayer']>) => {
            const r = await repo.updatePlayer(...args);
            log.push('write');
            return r;
          },
        },
        headObject: okHead,
        deleteObject: async (k) => {
          log.push(`delete:${k}`);
        },
        now: () => new Date().toISOString(),
        isVersionConflict: (e) => e instanceof repo.VersionConflictError,
      },
      found,
      newKey,
    );
    assert.deepEqual(log, ['write', 'delete:docreq/alpha/player-id-old.png']);
    const row = await repo.getPlayer(TENANT, 'alpha', p.naturalKey);
    assert.equal(row?.idDocMeta?.objectKey, newKey);
    assert.equal(row?.idDocMeta?.size, 1234, 'size comes from the stored object, not the client');
    const req = await repo.getDocRequest(TENANT, p.naturalKey, 'idDoc');
    assert.equal(req?.status, 'completed');
    assert.equal(req?.completedVia, 'link');
    // The completed link now reads as completed.
    const again = await app.request(`/doc-request-link/${await tokenFor(p)}`);
    assert.equal(((await again.json()) as { state: string }).state, 'completed');
  });

  test('retries once on a version conflict; nothing is deleted when the write never lands', async () => {
    const p = mkPlayer('alpha', { email: 'c2@example.com' });
    const found = await linked(p, 'idem-c2-00001');
    const key = `docreq/alpha/player-id-${'2'.repeat(8)}-2222-2222-2222-${'2'.repeat(12)}.pdf`;
    let calls = 0;
    const deletes: string[] = [];
    const deps = {
      repo: {
        ...repo,
        updatePlayer: async (...args: Parameters<Repo['updatePlayer']>) => {
          calls++;
          if (calls === 1) throw new repo.VersionConflictError();
          return repo.updatePlayer(...args);
        },
      },
      headObject: async () => ({ size: 50, contentType: 'application/pdf' }),
      deleteObject: async (k: string) => {
        deletes.push(k);
      },
      now: () => new Date().toISOString(),
      isVersionConflict: (e: unknown) => e instanceof repo.VersionConflictError,
    };
    await dr.completeDocRequestUpload(deps, found, key);
    assert.equal(calls, 2);
    assert.deepEqual(deletes, [], 'no prior object, nothing to delete');

    // Two conflicts in a row ⇒ 409, and no object deleted.
    const q = mkPlayer('alpha', {
      email: 'c3@example.com',
      idDocMeta: {
        objectKey: 'docreq/alpha/player-id-keep.png',
        size: 1,
        uploadedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const found2 = await linked(q, 'idem-c3-00001');
    const del2: string[] = [];
    await assert.rejects(
      dr.completeDocRequestUpload(
        {
          ...deps,
          repo: {
            ...repo,
            updatePlayer: async () => {
              throw new repo.VersionConflictError();
            },
          },
          deleteObject: async (k) => {
            del2.push(k);
          },
        },
        found2,
        key.replace(/2/g, '3'),
      ),
      (err: { status?: number }) => err.status === 409,
    );
    assert.deepEqual(del2, []);
  });

  test('staleness guard: a document that arrived after the request wins', async () => {
    const p = mkPlayer('alpha', { email: 'c4@example.com' });
    const found = await linked(p, 'idem-c4-00001');
    // A doc lands by another path after the request (bypassing the console completion hook).
    await repo.updatePlayer(TENANT, 'alpha', p.naturalKey, {
      idDocMeta: {
        objectKey: 'docreq/alpha/player-id-console.png',
        size: 9,
        uploadedAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    const deletes: string[] = [];
    const key = `docreq/alpha/player-id-${'4'.repeat(8)}-4444-4444-4444-${'4'.repeat(12)}.png`;
    await assert.rejects(
      dr.completeDocRequestUpload(
        {
          repo,
          headObject: okHead,
          deleteObject: async (k) => {
            deletes.push(k);
          },
          now: () => new Date().toISOString(),
          isVersionConflict: (e) => e instanceof repo.VersionConflictError,
        },
        found,
        key,
      ),
      (err: { status?: number; details?: { kind?: string } }) =>
        err.status === 409 && err.details?.kind === 'on_file',
    );
    assert.deepEqual(deletes, [key], 'only the new (unused) upload is removed');
    const row = await repo.getPlayer(TENANT, 'alpha', p.naturalKey);
    assert.equal(row?.idDocMeta?.objectKey, 'docreq/alpha/player-id-console.png');
    assert.equal((await repo.getDocRequest(TENANT, p.naturalKey, 'idDoc'))?.status, 'completed');
  });

  test('rejects foreign keys and oversized / wrong-type objects', async () => {
    const p = mkPlayer('alpha', { email: 'c5@example.com' });
    const found = await linked(p, 'idem-c5-00001');
    const deps = {
      repo,
      headObject: async () => ({ size: 6 * 1024 * 1024, contentType: 'image/png' }),
      deleteObject: async () => {},
      now: () => new Date().toISOString(),
      isVersionConflict: () => false,
    };
    await assert.rejects(
      dr.completeDocRequestUpload(deps, found, 'docreq/beta/player-id-x.png'),
      (e: { status?: number }) => e.status === 400,
    );
    const key = `docreq/alpha/player-id-${'5'.repeat(8)}-5555-5555-5555-${'5'.repeat(12)}.png`;
    await assert.rejects(
      dr.completeDocRequestUpload(deps, found, key),
      (e: { status?: number }) => e.status === 400,
    );
    await assert.rejects(
      dr.completeDocRequestUpload(
        { ...deps, headObject: async () => ({ size: 10, contentType: 'text/html' }) },
        found,
        key,
      ),
      (e: { status?: number }) => e.status === 400,
    );
  });

  test('the console PATCH id-doc completes a pending request', async () => {
    const p = mkPlayer('alpha', { email: 'c6@example.com' });
    await repo.createPlayer(TENANT, p);
    await sendRequest([p], 'idem-c6-00001');
    const res = await app.request(`/clubs/alpha/players/${p.naturalKey}/id-doc`, {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        objectKey: 'docreq/alpha/player-id-c6.png',
        size: 20,
        contentType: 'image/png',
      }),
    });
    assert.equal(res.status, 200);
    const req = await repo.getDocRequest(TENANT, p.naturalKey, 'idDoc');
    assert.equal(req?.status, 'completed');
    assert.equal(req?.completedVia, 'console');
  });
});

describe('erasure', () => {
  const partitionCount = async (tenant: string, needle: string) => {
    const items = await repo.queryAll({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `TENANT#${tenant}#DOCREQ` },
    });
    return items.filter((i) => JSON.stringify(i).includes(needle)).length;
  };

  test('player erasure deletes the request, its pointer and its ledger', async () => {
    const p = mkPlayer('alpha', { email: 'erase@example.com' });
    await repo.createPlayer(TENANT, p);
    await sendRequest([p], 'idem-er-00001');
    const req = (await repo.getDocRequest(TENANT, p.naturalKey, 'idDoc'))!;
    assert.ok((await partitionCount(TENANT, req.requestId)) >= 3, 'request + pointer + ledger');
    const counts = await repo.erasePlayerData(TENANT, p.naturalKey, { by: 'admin@union.test' });
    assert.equal(counts?.docRequests, 1);
    assert.equal(await partitionCount(TENANT, req.requestId), 0);
  });

  test('club erasure deletes only that club’s requests', async () => {
    const a = mkPlayer('beta', { email: 'beta@example.com' });
    const keep = mkPlayer('alpha', { email: 'keep@example.com' });
    await repo.createPlayer(TENANT, a);
    await repo.createPlayer(TENANT, keep);
    await sendRequest([a, keep], 'idem-club-0001');
    const ra = (await repo.getDocRequest(TENANT, a.naturalKey, 'idDoc'))!;
    const club = (await repo.getClub(TENANT, 'beta'))!;
    await repo.eraseClubData(TENANT, club);
    assert.equal(await partitionCount(TENANT, ra.requestId), 0);
    assert.ok(await repo.getDocRequest(TENANT, keep.naturalKey, 'idDoc'));
  });

  test('tenant erasure empties the DOCREQ partition', async () => {
    assert.ok((await partitionCount(TENANT, 'DOC')) > 0);
    await repo.eraseTenantData(TENANT);
    assert.equal(await partitionCount(TENANT, ''), 0);
  });
});
