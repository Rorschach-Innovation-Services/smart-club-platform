/**
 * Audit trail for public links and link copies (ADR 0023) through the REAL Hono app on an
 * in-process dynalite: every public link kind records its tenant and a `link` actor (the
 * recipient's opaque member id, never the token); a forwarded captain's-report link names the
 * NEW recipient on the next submit; GET link copies are recorded; an unresolvable link writes
 * nothing and does not crash. Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuditEntry, CaptainsReport, Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4853; // unique
const TABLE = 'SmartClubAuditLinksTest';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';
const UPLOADS = await mkdtemp(path.join(tmpdir(), 'audit-links-'));
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
const SECRET = 'local-dev-captains-report-link-secret'; // env.ts's LOCAL_AUTH fallback
const K = (n: number) => String(n).repeat(64).slice(0, 64);

const devAuth = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const ADMIN = devAuth('sub-admin', 'admin@test', [{ tenantId: T, role: 'admin', clubIds: [] }]);
const call = async (method: string, p: string, body?: unknown, auth: string | null = ADMIN) =>
  app.request(p, {
    method,
    headers: {
      'x-tenant': T,
      ...(auth ? { 'x-dev-auth': auth } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let ddb: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');
let keys: typeof import('../src/keys.js');
let cr: typeof import('../src/captains-reports.js');
let squad: typeof import('../src/squad-requests.js');

/** Every token handed out in this file: none may appear in any audit row. */
const tokens: string[] = [];

const club = (id: string, name: string, chair: { name: string; email?: string; cell?: string }) =>
  ({
    id,
    name,
    district: 'd',
    sub: '',
    chair: chair.name,
    exco: { chair },
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
  }) as never;

const P_UMZ = { teamId: 'umzinto', clubId: 'umzinto', name: 'Umzinto CC' };
const P_AW = { teamId: 'african-warriors', clubId: 'african-warriors', name: 'African Warriors' };

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  app = (await import('../src/index.js')).app;
  repo = await import('../src/repo.js');
  keys = await import('../src/keys.js');
  cr = await import('../src/captains-reports.js');
  squad = await import('../src/squad-requests.js');
  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig(T);
  const cfg = (await repo.getTenantConfig(T))!;
  await repo.putTenantConfig({
    ...cfg,
    features: { ...(cfg.features ?? {}), medicoachSync: true, preMatchSquadLinks: true },
    integrations: { medicoach: { goLiveDate: sastDay(-30) } },
  } as unknown as TenantConfig);
  await repo.createClub(
    T,
    club('umzinto', 'Umzinto CC', {
      name: 'Uma Chair',
      email: 'chair@umzinto.test',
      cell: '0821234567',
    }),
  );
  await repo.createClub(
    T,
    club('african-warriors', 'African Warriors', { name: 'Awa Chair', email: 'chair@aw.test' }),
  );
  await repo.putSeries(T, {
    id: S1,
    name: 'Premier T20',
    leagueKey: 'premier',
    startDate: TODAY,
    teams: ['umzinto', 'african-warriors'],
    participants: [P_UMZ, P_AW].map((p) => ({ ...p, venue: 'Kingsmead Oval' })),
    fixtures: [
      { id: 'f0', round: 1, date: TODAY, time: '09:00', home: 'umzinto', away: 'african-warriors' },
      {
        id: 'f1',
        round: 2,
        date: TOMORROW,
        time: '09:00',
        home: 'umzinto',
        away: 'african-warriors',
      },
    ],
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  } as unknown as Series);
  await repo.createPlayer(T, {
    naturalKey: K(1),
    clubId: 'umzinto',
    firstName: 'Adult',
    lastName: 'Captain',
    email: 'adult@umzinto.test',
    cell: '0831234567',
    isMinor: false,
    dob: '1990-01-01',
    consentAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as never);
});

after(() => stopDynalite(ddb));

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
  const out: Record<string, unknown>[] = [];
  for (const tenant of [T, '*']) {
    const pk = keys.auditPartitionPk(tenant, keys.auditMonthOf(new Date().toISOString()));
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk },
      }),
    );
    out.push(...(res.Items ?? []));
  }
  return out;
}

const headlines = async () =>
  (await auditRows()).filter((r) => (r.sk as string).startsWith('A#')) as unknown as Array<
    AuditEntry & { sk: string }
  >;

async function newHeadlines(fn: () => unknown) {
  const seen = new Set((await headlines()).map((h) => h.sk));
  await fn();
  return (await headlines()).filter((h) => !seen.has(h.sk));
}

/** The one entry `fn` wrote. */
async function oneEntry(fn: () => Response | Promise<Response>, expectStatus = 200) {
  let res!: Response;
  const added = await newHeadlines(async () => {
    res = await fn();
  });
  assert.equal(res.status, expectStatus, await res.clone().text());
  assert.equal(added.length, 1, `one entry, got ${added.map((a) => a.action).join(', ')}`);
  return { entry: added[0], res };
}

describe('self-registration links', () => {
  test('player registration: tenant + a shared registration-link actor', async () => {
    await repo.putToken('reg-token-audit-123', T, 'umzinto', new Date().toISOString());
    tokens.push('reg-token-audit-123');
    const ctx = (await (await app.request('/register/umzinto?t=reg-token-audit-123')).json()) as {
      leagues: Array<{ key: string }>;
      districts: string[];
    };
    // The presign is skipped (nothing written); the submit is the entry.
    let objectKey = '';
    const up = await newHeadlines(async () => {
      const res = await app.request('/register/umzinto/id-doc/upload-url?t=reg-token-audit-123', {
        method: 'POST',
        body: JSON.stringify({ contentType: 'image/png' }),
      });
      objectKey = ((await res.json()) as { objectKey: string }).objectKey;
    });
    assert.equal(up.length, 0);
    const { entry } = await oneEntry(
      () =>
        app.request('/register/umzinto?t=reg-token-audit-123', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            firstName: 'Reg',
            lastName: 'Istrant',
            idType: 'passport',
            idNumber: 'AUD0001',
            dob: '1995-03-03',
            nationality: 'Zimbabwean',
            race: 'African',
            gender: 'Male',
            cell: '0839990000',
            team: ctx.leagues[0].key,
            district: ctx.districts[0],
            consent: true,
            idDocMeta: { objectKey, size: 100, contentType: 'image/png' },
          }),
        }),
      201,
    );
    assert.equal(entry.action, 'player.register');
    assert.equal(entry.tenant, T);
    assert.deepEqual(entry.actor, {
      kind: 'link',
      key: 'link:player-registration:shared',
      via: 'player-registration',
    });
    // The club (from the path) and the player row the registration created, at that club.
    assert.deepEqual(
      entry.targets.map((t) => [t.type, t.type === 'player' ? !!t.id : t.id, t.op, t.clubId]),
      [
        ['club', 'umzinto', 'register', undefined],
        ['player', true, 'create', 'umzinto'],
      ],
    );
  });

  test('club signup and official signup: link actors, the created record named', async () => {
    const minted = (await (await call('POST', '/admin/club-signup-link')).json()) as {
      clubSignupLink: { token: string };
    };
    const ct = minted.clubSignupLink.token;
    tokens.push(ct);
    const cfg = (await (await app.request(`/club-signup?t=${ct}`)).json()) as {
      districts: string[];
    };
    const club = await oneEntry(
      () =>
        app.request(`/club-signup?t=${ct}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clubName: 'Audit Signup CC',
            district: cfg.districts[0],
            repName: 'Robin Rep',
            repEmail: 'robin@auditsignup.test',
          }),
        }),
      201,
    );
    assert.equal(club.entry.action, 'club.signup');
    assert.equal(club.entry.tenant, T);
    assert.equal(club.entry.actor.kind, 'link');
    assert.equal(club.entry.actor.key, 'link:club-signup:shared');

    const off = (await (await call('POST', '/admin/official-signup-link/umpire')).json()) as {
      url: string;
    };
    const ot = new URL(off.url).searchParams.get('t')!;
    tokens.push(ot);
    const official = await oneEntry(() =>
      call(
        'POST',
        `/official-signup?t=${encodeURIComponent(ot)}`,
        {
          firstNames: 'Andile',
          surname: 'Auditump',
          phone: '082 123 4567',
          email: 'andile@example.org',
          consent: true,
        },
        null,
      ),
    );
    assert.equal(official.entry.action, 'official.signup');
    assert.equal(official.entry.tenant, T);
    assert.equal(official.entry.actor.key, 'link:official-signup:shared');
    assert.equal(official.entry.targets.length, 1);
    assert.equal(official.entry.targets[0].type, 'umpire');
    assert.equal(official.entry.targets[0].op, 'create');
  });
});

describe("captain's report links", () => {
  const reportId = `${S1}~f0~umzinto`;

  test('a forwarded link names the NEW recipient on the next submit; copies are recorded', async () => {
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

    // An admin copies the chair's link (a GET): recorded, no token stored.
    const copy = await oneEntry(() => call('GET', `/captains-reports/${reportId}/link`));
    assert.equal(copy.entry.action, 'link.copy');
    assert.equal(copy.entry.actor.key, 'sub-admin');
    assert.deepEqual(
      copy.entry.targets.map((t) => [t.type, t.id, t.op, t.clubId]),
      [['captains-report', reportId, 'copy', 'umzinto']],
    );
    const chairToken = new URL(((await copy.res.json()) as { url: string }).url).pathname
      .split('/r/')
      .at(-1)!;
    tokens.push(chairToken);
    assert.equal(chairToken, cr.reportLink(T, report, SECRET, 'http://x').token);

    // The chair forwards it to the captain.
    const candidateId = cr.forwardCandidateId(SECRET, T, reportId, K(1));
    const fwd = await oneEntry(() =>
      app.request(`/captains-report-link/${chairToken}/forward`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidateId }),
      }),
    );
    assert.equal(fwd.entry.action, 'captains-report.forward');
    assert.equal(fwd.entry.tenant, T);
    assert.deepEqual(fwd.entry.actor, {
      kind: 'link',
      key: 'link:captains-report:m-chair-1',
      via: 'captains-report',
      recipientKind: 'chair',
      recipientId: 'm-chair-1',
    });

    // The captain's own link (a new member id) submits.
    const forwarded = (await repo.getCaptainsReport(T, S1, 'f0', 'umzinto'))!;
    assert.equal(forwarded.recipient.kind, 'captain');
    const captainId = forwarded.recipient.memberId;
    assert.notEqual(captainId, 'm-chair-1');
    const capToken = cr.reportLink(T, forwarded, SECRET, 'http://x').token;
    tokens.push(capToken);
    const sub = await oneEntry(() =>
      app.request(`/captains-report-link/${capToken}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          captainName: 'Adult Captain',
          declaration: true,
          general: '',
          umpires: [
            {
              name: 'A Freetext',
              ratings: {
                decisions: 4,
                pressure: 4,
                behaviour: 5,
                communication: 4,
                regulations: 2,
              },
              concerns: {},
              otherConcern: '',
              comments: '',
            },
          ],
          submit: true,
        }),
      }),
    );
    assert.equal(sub.entry.action, 'captains-report.save');
    assert.equal(sub.entry.actor.recipientKind, 'captain');
    assert.equal(sub.entry.actor.recipientId, captainId);
    assert.equal(sub.entry.actor.key, `link:captains-report:${captainId}`);
    assert.deepEqual(
      sub.entry.targets.map((t) => [t.type, t.id, t.op]),
      [['captains-report', reportId, 'submit']],
    );
    // The report's history holds the copy, the forward and the submit.
    const hist = await repo.listAuditForEntity(T, 'captains-report', reportId);
    assert.equal(hist.items.length, 3);
  });

  test('reading a link writes nothing; a bad token writes nothing and does not crash', async () => {
    const reads = await newHeadlines(async () => {
      assert.equal((await app.request('/captains-report-link/not-a-token')).status, 404);
      assert.equal(
        (
          await app.request('/captains-report-link/not-a-token', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        404,
      );
      assert.equal((await app.request('/squad-link/not-a-token')).status, 404);
      assert.equal(
        (await app.request('/doc-request-link/not-a-token/complete', { method: 'POST' })).status,
        404,
      );
      assert.equal(
        (
          await app.request('/register/umzinto?t=bogus', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        404,
      );
      assert.equal((await app.request('/official-signup?t=bogus', { method: 'POST' })).status, 404);
    });
    assert.equal(reads.length, 0);
  });
});

describe('squad links', () => {
  test('a squad save names the squad link and its recipient', async () => {
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
    tokens.push(n.token);
    const request = (await repo.getSquadRequest(T, S1, 'f1', 'umzinto'))!;
    const view = (await (await app.request(`/squad-link/${n.token}`)).json()) as {
      request: { modified: string };
      roster: Array<{ id: string }>;
    };
    const { entry } = await oneEntry(() =>
      app.request(`/squad-link/${n.token}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedModified: view.request.modified,
          players: [view.roster[0].id],
        }),
      }),
    );
    assert.equal(entry.action, 'squad-request.save');
    assert.equal(entry.tenant, T);
    assert.equal(entry.actor.kind, 'link');
    assert.equal(entry.actor.via, 'squad');
    assert.equal(entry.actor.recipientKind, request.recipient.kind);
    assert.equal(entry.actor.recipientId, request.recipient.memberId);
    assert.deepEqual(
      entry.targets.map((t) => [t.type, t.id, t.op]),
      [['squad-request', request.id, 'save']],
    );

    // An admin's GET copy of the squad link is recorded.
    const copy = await oneEntry(() =>
      call('GET', `/admin/squad-requests/${encodeURIComponent(request.id)}/link`),
    );
    assert.equal(copy.entry.action, 'link.copy');
    assert.deepEqual(
      copy.entry.targets.map((t) => [t.type, t.id]),
      [['squad-request', request.id]],
    );
    tokens.push(
      new URL(((await copy.res.json()) as { url: string }).url).pathname.split('/').at(-1)!,
    );
  });
});

describe('document request links', () => {
  test('the copy and the completion are recorded; the link actor is the request, not the player', async () => {
    const copy = await oneEntry(() =>
      call('POST', '/admin/doc-requests/link', { clubId: 'umzinto', naturalKey: K(1) }),
    );
    assert.equal(copy.entry.action, 'link.copy');
    const requestId = copy.entry.targets[0].id;
    assert.equal(copy.entry.targets[0].type, 'doc-request');
    const token = new URL(((await copy.res.json()) as { url: string }).url).pathname
      .split('/d/')
      .at(-1)!;
    tokens.push(token);

    // A real (local-sink) upload, then completion through the public link.
    const name = `player-id-${randomUUID()}.pdf`;
    await mkdir(path.join(UPLOADS, T, 'umzinto'), { recursive: true });
    await writeFile(path.join(UPLOADS, T, 'umzinto', name), '%PDF-1.4 test');
    const done = await oneEntry(() =>
      app.request(`/doc-request-link/${token}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectKey: `local/${T}/umzinto/${name}` }),
      }),
    );
    assert.equal(done.entry.action, 'doc-request.complete');
    assert.equal(done.entry.tenant, T);
    assert.deepEqual(done.entry.actor, {
      kind: 'link',
      key: `link:doc-request:${requestId}`,
      via: 'doc-request',
      recipientKind: 'player',
    });
    assert.deepEqual(
      done.entry.targets.map((t) => [t.type, t.id, t.op]),
      [['doc-request', requestId, 'complete']],
    );
  });
});

describe('secrets', () => {
  test('no link token, natural key or query string appears in any audit row', async () => {
    const dump = JSON.stringify(await auditRows());
    assert.ok(tokens.length >= 7, `collected ${tokens.length} tokens`);
    for (const t of tokens) assert.ok(!dump.includes(t), `token ${t.slice(0, 12)}… stored`);
    // A natural key is never an actor (a link is keyed on its opaque member / request id). It
    // may name the PLAYER record itself — a mention, a target or a change `ref`, as everywhere
    // else in the trail — which is how a player erasure finds and blanks it.
    const rows = await auditRows();
    const actors = JSON.stringify(rows.map((r) => r.actor ?? null));
    assert.ok(!actors.includes(K(1)), 'natural key used as an actor');
    const outsidePlayerRefs = JSON.stringify(rows)
      .replaceAll(`"type":"player","id":"${K(1)}"`, '')
      .replaceAll(`"id":"${K(1)}","type":"player"`, '')
      .replaceAll(`#player#${K(1)}#`, '');
    assert.ok(!outsidePlayerRefs.includes(K(1)), 'natural key stored outside a player reference');
    assert.ok(!dump.includes('?t='), 'query string stored');
  });
});
