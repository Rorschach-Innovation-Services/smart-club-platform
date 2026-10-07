/**
 * Tenant-wide player erasure (`DELETE /admin/players/:nk`) end to end, through the REAL Hono app
 * on an in-process dynalite, with the local-disk upload sink (STAGE=local + LOCAL_UPLOADS_DIR) so
 * certificate PDFs land on disk where their purge can be asserted:
 *
 *  - rows at two clubs + an approved clearance with a certificate + a registration review + a
 *    veterans request + a captain's report naming the person + a pending REPORTOPEN# marker →
 *    every category removed (CERT# gone, PDF prefix gone, playerCount decremented), the report
 *    scrubbed in place, the marker's captain ref scrubbed (marker kept for the retry), other
 *    people's data untouched, a PII-free audit row, per-category counts;
 *  - re-running the erasure 404s (nothing left in any category);
 *  - a window-auto-rejected clearance with NO player rows anywhere is still erasable (the gate
 *    must not 404 on "no player row") and its snapshot ID document is collected;
 *  - a pending clearance naming the person → 409, nothing touched;
 *  - a cached scorecard / digest feedback that keeps changing under its scrub (forced perpetual
 *    conditional failure) → 409 with NOTHING deleted (rows, clearance, certificate, S3 docs),
 *    and a plain retry then completes the erasure;
 *  - unknown person → 404; a rep → 403.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Club,
  PlayerClearance,
  PlayerRegistration,
  CertificateMeta,
  CaptainsReport,
  PlayerErasureCounts,
  ScorecardConfirmation,
  StoredFixtureScorecard,
} from '../src/types.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4697;
const TABLE = 'SmartClubPlayerErasureTest';
const TENANT = 'erasure';
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
process.env.VERIFY_BASE_URL = 'https://platform.club.example';
delete process.env.CERT_SIGNING_KEY_ARN;

const devAuthAs = (sub: string, email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
const rep = (club: string) =>
  devAuthAs(`rep-${club}`, `rep@${club}.test`, [
    { tenantId: TENANT, role: 'rep', clubIds: [club] },
  ]);
const ADMIN = devAuthAs('admin-1', 'admin@union.test', [
  { tenantId: TENANT, role: 'admin', clubIds: [] },
]);
const headers = (auth: string) => ({
  'x-dev-auth': auth,
  'x-tenant': TENANT,
  'content-type': 'application/json',
});

let uploadsDir: string;
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

const mkClub = (id: string): Club =>
  ({
    id,
    name: `${id[0].toUpperCase()}${id.slice(1)} CC`,
    district: 'Test District',
    sub: '',
    chair: 'Chair',
    affiliation: 'not_started',
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
  }) as unknown as Club;

let seq = 0;
const mkPlayer = (clubId: string, over: Partial<PlayerRegistration> = {}): PlayerRegistration => {
  seq++;
  return {
    naturalKey: `nk-${seq}`,
    clubId,
    firstName: 'Sipho',
    lastName: `Erase${seq}`,
    dob: '1990-01-01',
    isMinor: false,
    status: 'active',
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    idType: 'sa-id',
    idNumber: `90010150${String(10000 + seq).slice(-5)}`,
    email: `sipho${seq}@player.test`,
    cell: '0821234567',
    ...over,
  };
};

const call = (method: string, url: string, auth: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: headers(auth),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const erase = (nk: string, auth = ADMIN) => call('DELETE', `/admin/players/${nk}`, auth);

async function openClearance(from: string, to: string, nk: string) {
  const res = await call('POST', `/clubs/${to}/clearances`, rep(to), {
    fromClubId: from,
    playerNaturalKey: nk,
  });
  assert.equal(res.status, 201);
  return (await res.json()) as PlayerClearance;
}

const playerCount = async (clubId: string): Promise<number> =>
  ((await repo.getClub(TENANT, clubId)) as { playerCount?: number } | null)?.playerCount ?? 0;

const diskPath = (objectKey: string) => path.join(uploadsDir, objectKey.slice('local/'.length));
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const mkReport = (
  fixtureId: string,
  captainName: string,
  contact?: { email?: string; cell?: string },
): CaptainsReport => ({
  id: `s1~${fixtureId}~alpha`,
  seriesId: 's1',
  fixtureId,
  clubId: 'alpha',
  status: 'pending',
  source: 'auto',
  matchDate: '2026-09-20',
  side: 'home',
  clubName: 'Alpha CC',
  opponentName: 'Beta CC',
  competition: 'Premier',
  umpiresSnapshot: [],
  recipient: { kind: 'captain', memberId: `m-${fixtureId}`, name: captainName },
  captainName,
  umpires: [],
  general: '',
  ...(contact ? { recipientContact: contact } : {}),
  createdAt: '2026-09-20T18:00:00.000Z',
  updatedAt: '2026-09-20T18:00:00.000Z',
});

before(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'player-erasure-'));
  process.env.LOCAL_UPLOADS_DIR = uploadsDir;

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
    branding: {
      name: 'Erasure Test Union',
      title: 'Erasure Union',
      logoUrl: '/dolphins-logo.png',
      colors: { '--brand-accent': '#1B4D8C' },
      copy: {},
    },
    submissionDeadline: '2026-12-31',
    knownClubs: [],
    leagues: [],
    districts: ['Test District'],
  });
  for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
    await repo.createClub(TENANT, mkClub(id));
  }
});

after(async () => {
  await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
  await rm(uploadsDir, { recursive: true, force: true });
});

describe('full erasure across every category', () => {
  const p = mkPlayer('alpha');
  const bystander = mkPlayer('alpha', { firstName: 'Thandi', email: 'thandi@player.test' });
  const fullName = `${p.firstName} ${p.lastName}`;
  let approved: PlayerClearance & { certificateMeta?: CertificateMeta };
  let counts: PlayerErasureCounts;
  let before: { beta: number; gamma: number };

  test('setup: transfer alpha→beta (certificate issued), second row at gamma, satellites', async () => {
    await repo.createPlayer(TENANT, p);
    await repo.createPlayer(TENANT, bystander);
    const opened = await openClearance('alpha', 'beta', p.naturalKey);
    const res = await call('PATCH', `/clubs/alpha/clearances/${opened.id}`, rep('alpha'), {
      action: 'issue',
      feesCleared: true,
      misconductCleared: true,
      version: opened.version,
    });
    assert.equal(res.status, 200);
    approved = (await res.json()) as typeof approved;
    assert.ok(approved.certificateMeta?.serial, 'precondition: certificate issued on approve');
    assert.ok(await exists(diskPath(approved.certificateMeta!.objectKey)), 'PDF on disk');
    assert.ok(await repo.getPlayer(TENANT, 'beta', p.naturalKey), 'moved to beta');

    // The same person also on gamma's roster (multi-club), with an ID doc.
    await repo.createPlayer(TENANT, {
      ...p,
      clubId: 'gamma',
      idDocMeta: {
        objectKey: `local/${TENANT}/gamma/${p.naturalKey}.png`,
        size: 1,
        contentType: 'image/png',
        uploadedAt: '2026-05-01T00:00:00.000Z',
      },
    } as PlayerRegistration);

    await repo.createRegistrationReview(TENANT, {
      id: 'rv-1',
      kind: 'cross-club-hold',
      playerNaturalKey: p.naturalKey,
      playerName: fullName,
      destClubId: 'delta',
      destClubName: 'Delta CC',
      linkClubId: 'delta',
      linkClubName: 'Delta CC',
      pendingPlayer: {
        ...p,
        clubId: 'delta',
        idDocMeta: {
          objectKey: `local/${TENANT}/delta/${p.naturalKey}.png`,
          size: 1,
          contentType: 'image/png',
          uploadedAt: '2026-05-01T00:00:00.000Z',
        },
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'open',
    } as import('../src/types.js').RegistrationReview);

    await repo.createVeteransRequest(TENANT, {
      id: 'vr-1',
      playerNaturalKey: p.naturalKey,
      candidateId: 'cand-1',
      playerName: fullName,
      primaryClubId: 'beta',
      primaryClubName: 'Beta CC',
      veteransClubId: 'delta',
      veteransClubName: 'Delta CC',
      requestedAt: '2026-09-02T00:00:00.000Z',
      status: 'pending',
      version: 1,
    } as import('../src/types.js').VeteransRequest);

    assert.ok(
      await repo.openCaptainsReportIfAbsent(
        TENANT,
        mkReport('f1', fullName, { email: p.email, cell: '+27821234567' }),
      ),
    );
    assert.ok(await repo.openCaptainsReportIfAbsent(TENANT, mkReport('f2', 'Someone Else')));

    await repo.putReportOpenMarker(TENANT, {
      ref: 'res-1',
      seriesId: 's1',
      fixtureId: 'f3',
      recordedAt: '2026-09-21T00:00:00.000Z',
      createdAt: '2026-09-21T00:00:00.000Z',
      attempts: 0,
      captainRef: `smartclub:${TENANT}:player:${p.naturalKey}`,
    });
    await repo.putReportOpenMarker(TENANT, {
      ref: 'res-2',
      seriesId: 's1',
      fixtureId: 'f4',
      recordedAt: '2026-09-21T00:00:00.000Z',
      createdAt: '2026-09-21T00:00:00.000Z',
      attempts: 0,
      captainRef: `smartclub:${TENANT}:player:${bystander.naturalKey}`,
    });

    before = { beta: await playerCount('beta'), gamma: await playerCount('gamma') };
  });

  test('DELETE erases and returns per-category counts', async () => {
    const res = await erase(p.naturalKey);
    assert.equal(res.status, 200);
    ({ counts } = (await res.json()) as { counts: PlayerErasureCounts });
    assert.deepEqual(counts, {
      playerRows: 2,
      clearances: 1,
      registrationReviews: 1,
      veteransRequests: 1,
      // certificate PDF + held review doc + gamma row doc
      documents: 3,
      certificates: 1,
      captainsReportsScrubbed: 1,
      scorecardsScrubbed: 0,
      feedbackScrubbed: 0,
      reportOpenMarkers: 1,
    });
  });

  test('rows gone at every club; playerCount decremented', async () => {
    assert.equal(await repo.getPlayer(TENANT, 'beta', p.naturalKey), null);
    assert.equal(await repo.getPlayer(TENANT, 'gamma', p.naturalKey), null);
    assert.equal(await playerCount('beta'), before.beta - 1);
    assert.equal(await playerCount('gamma'), before.gamma - 1);
    assert.ok(await repo.getPlayer(TENANT, 'alpha', bystander.naturalKey), 'bystander untouched');
  });

  test('clearance canonical + mirror, CERT# item and certificate prefix gone', async () => {
    assert.equal(await repo.getClearanceRaw(TENANT, 'alpha', approved.id), null);
    assert.equal(await repo.getInboundClearance(TENANT, 'beta', approved.id), null);
    assert.equal(await repo.getCertificateBySerial(approved.certificateMeta!.serial), null);
    assert.equal(await exists(diskPath(approved.certificateMeta!.objectKey)), false);
    assert.equal(
      await exists(path.join(uploadsDir, repo.clearanceObjectPrefix(TENANT, 'alpha', approved.id))),
      false,
      'whole clearance prefix purged',
    );
  });

  test('review and veterans request (canonical + mirror) gone', async () => {
    assert.equal((await repo.listAllReviews(TENANT)).length, 0);
    assert.equal((await repo.listAllVeteransRequests(TENANT)).length, 0);
    assert.equal((await repo.listOutboundVeteransRequests(TENANT, 'delta')).length, 0);
  });

  test("captain's report naming the person is scrubbed in place; others untouched", async () => {
    const scrubbed = (await repo.getCaptainsReport(TENANT, 's1', 'f1', 'alpha'))!;
    assert.ok(scrubbed, 'report kept (scrubbed, not deleted)');
    assert.equal(scrubbed.captainName, repo.ERASED_NAME);
    assert.equal(scrubbed.recipient.name, repo.ERASED_NAME);
    assert.equal(scrubbed.recipientContact, undefined);
    assert.equal(scrubbed.status, 'pending');
    const other = (await repo.getCaptainsReport(TENANT, 's1', 'f2', 'alpha'))!;
    assert.equal(other.captainName, 'Someone Else');
  });

  test('REPORTOPEN marker addressed to the person keeps its retry but loses the captain ref; others untouched', async () => {
    const markers = await repo.listReportOpenMarkers(TENANT);
    // Both markers survive: deleting one would silently stop that fixture's reports opening for
    // BOTH clubs. The scrubbed one's retry addresses the scoring side's chair instead.
    assert.deepEqual(markers.map((m) => m.ref).sort(), ['res-1', 'res-2']);
    const scrubbed = markers.find((m) => m.ref === 'res-1')!;
    assert.equal(scrubbed.captainRef, undefined);
    assert.equal(scrubbed.fixtureId, 'f3');
    assert.equal(scrubbed.attempts, 0);
    const other = markers.find((m) => m.ref === 'res-2')!;
    assert.equal(other.captainRef, `smartclub:${TENANT}:player:${bystander.naturalKey}`);
  });

  test('audit row: actor + counts only, no PII', async () => {
    const logs = await repo.listPlayerEraseLogs(TENANT);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].by, 'admin@union.test');
    assert.deepEqual(logs[0].counts, counts);
    const blob = JSON.stringify(logs[0]);
    for (const pii of [p.naturalKey, p.lastName, p.email!, p.idNumber!]) {
      assert.ok(!blob.includes(pii), `audit row must not carry ${pii}`);
    }
  });

  test('re-running 404s — nothing left in any category', async () => {
    assert.equal((await erase(p.naturalKey)).status, 404);
    assert.equal((await repo.listPlayerEraseLogs(TENANT)).length, 1, 'no second audit row');
  });
});

describe('orphaned clearance PII', () => {
  test('a window-auto-rejected clearance with NO player rows is erasable; snapshot doc collected', async () => {
    const p = mkPlayer('beta', {
      status: 'clearance-pending',
      idDocMeta: {
        objectKey: `local/${TENANT}/gamma/${'win'}.png`,
        size: 1,
        contentType: 'image/png',
        uploadedAt: '2026-05-01T00:00:00.000Z',
      },
    });
    const id = 'cl-window-1';
    await repo.createAutoRejectedClearance(TENANT, p, {
      id,
      playerNaturalKey: p.naturalKey,
      playerName: `${p.firstName} ${p.lastName}`,
      fromClubId: 'old-directory-club',
      fromClubName: 'Old Directory CC',
      fromClubDirectory: true,
      toClubId: 'beta',
      toClubName: 'Beta CC',
      requestedAt: '2026-09-01T00:00:00.000Z',
      origin: 'registration',
      feesCleared: false,
      misconductCleared: false,
      status: 'rejected',
      rejectedAt: '2026-09-01T00:00:00.000Z',
      rejectedBy: 'system:transfer-window',
      rejectOutcome: 'not-registered',
      version: 1,
    } as PlayerClearance);
    assert.equal((await repo.findPlayerAcrossClubs(TENANT, p.naturalKey, '')).length, 0);
    const raw = (await repo.getClearanceRaw(TENANT, 'old-directory-club', id))!;
    assert.deepEqual(repo.clearanceDocObjectKeys(raw), [`local/${TENANT}/gamma/win.png`]);

    const res = await erase(p.naturalKey);
    assert.equal(res.status, 200, 'gate must not 404 on "no player row"');
    const { counts } = (await res.json()) as { counts: PlayerErasureCounts };
    assert.equal(counts.playerRows, 0);
    assert.equal(counts.clearances, 1);
    assert.equal(counts.documents, 1, 'the snapshot ID document');
    assert.equal(await repo.getClearanceRaw(TENANT, 'old-directory-club', id), null);
    assert.equal(await repo.getInboundClearance(TENANT, 'beta', id), null);
  });

  test('a document named by both a live row and a held record counts once', async () => {
    const objectKey = `local/${TENANT}/gamma/shared-doc.png`;
    const idDocMeta = {
      objectKey,
      size: 1,
      contentType: 'image/png',
      uploadedAt: '2026-05-01T00:00:00.000Z',
    };
    const p = mkPlayer('gamma', { idDocMeta });
    await repo.createPlayer(TENANT, p);
    await repo.createRegistrationReview(TENANT, {
      id: 'rv-shared',
      kind: 'cross-club-hold',
      playerNaturalKey: p.naturalKey,
      playerName: `${p.firstName} ${p.lastName}`,
      destClubId: 'delta',
      destClubName: 'Delta CC',
      linkClubId: 'delta',
      linkClubName: 'Delta CC',
      pendingPlayer: { ...p, clubId: 'delta', idDocMeta },
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'open',
    } as import('../src/types.js').RegistrationReview);

    const res = await erase(p.naturalKey);
    assert.equal(res.status, 200);
    const { counts } = (await res.json()) as { counts: PlayerErasureCounts };
    assert.equal(counts.playerRows, 1);
    assert.equal(counts.registrationReviews, 1);
    assert.equal(counts.documents, 1, 'one object, not one per record naming it');
  });
});

describe('scorecard scrub contention', () => {
  const ccf = () =>
    Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    });

  /** Run `fn` with every DynamoDB command matching `contested` failing its condition. */
  async function withContention<T>(
    contested: (cmd: { input: Record<string, unknown> }, kind: string) => boolean,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const proto = DynamoDBDocumentClient.prototype as unknown as {
      send: (cmd: unknown, ...rest: unknown[]) => Promise<unknown>;
    };
    const original = proto.send;
    proto.send = function (this: unknown, cmd: unknown, ...rest: unknown[]) {
      const c = cmd as { input: Record<string, unknown>; constructor: { name: string } };
      if (contested(c, c.constructor.name)) return Promise.reject(ccf());
      return original.call(this, cmd, ...rest);
    };
    try {
      return await fn();
    } finally {
      proto.send = original;
    }
  }
  const scorecardScrubWrite = (c: { input: Record<string, unknown> }, kind: string) =>
    kind === 'PutCommand' && c.input.ConditionExpression === 'fetchedAt = :f';
  const feedbackScrubWrite = (c: { input: Record<string, unknown> }, kind: string) =>
    kind === 'UpdateCommand' && String(c.input.UpdateExpression).includes('.feedback = :fb');

  const card = (fixtureId: string, batter: string): StoredFixtureScorecard => ({
    seriesId: 's1',
    fixtureId,
    medicoachMatchId: `pma-${fixtureId}`,
    medicoachTournamentId: 'tour-1',
    schemaVersion: 1,
    fetchedAt: '2026-09-20T18:00:00.000Z',
    available: true,
    innings: [
      {
        battingTeamName: 'Alpha CC',
        totalRuns: 10,
        wickets: 0,
        overs: '2.0',
        extras: { byes: 0, legByes: 0, wides: 0, noBalls: 0, penalties: 0, total: 0 },
        batters: [
          {
            order: 1,
            name: batter,
            runs: 10,
            ballsFaced: 12,
            fours: 1,
            sixes: 0,
            strikeRate: 83.33,
            howOut: 'not out',
          },
        ],
        bowlers: [],
        fallOfWickets: [],
      },
    ],
  });

  test('a scorecard that keeps changing → 409, NOTHING deleted; a retry then completes', async () => {
    const p = mkPlayer('alpha');
    const fullName = `${p.firstName} ${p.lastName}`;
    await repo.createPlayer(TENANT, p);
    const opened = await openClearance('alpha', 'beta', p.naturalKey);
    const issued = await call('PATCH', `/clubs/alpha/clearances/${opened.id}`, rep('alpha'), {
      action: 'issue',
      feesCleared: true,
      misconductCleared: true,
      version: opened.version,
    });
    assert.equal(issued.status, 200);
    const approved = (await issued.json()) as PlayerClearance & {
      certificateMeta?: CertificateMeta;
    };
    const pdf = diskPath(approved.certificateMeta!.objectKey);
    assert.ok(await exists(pdf), 'precondition: certificate PDF on disk');
    await repo.putFixtureScorecard(TENANT, card('fc-1', fullName));
    const logsBefore = (await repo.listPlayerEraseLogs(TENANT)).length;

    const res = await withContention(scorecardScrubWrite, () => erase(p.naturalKey));
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /try again/);
    await withContention(scorecardScrubWrite, () =>
      assert.rejects(repo.erasePlayerData(TENANT, p.naturalKey, { by: 'admin@union.test' }), {
        name: 'ScorecardScrubContentionError',
        code: 'SCORECARD_SCRUB_CONTENTION',
      }),
    );

    // Nothing destructive ran: row, clearance (canonical + mirror), CERT#, PDF, card, no audit.
    assert.ok(await repo.getPlayer(TENANT, 'beta', p.naturalKey), 'PLAYER# row kept');
    assert.ok(await repo.getClearanceRaw(TENANT, 'alpha', approved.id), 'clearance kept');
    assert.ok(await repo.getInboundClearance(TENANT, 'beta', approved.id), 'mirror kept');
    assert.ok(await repo.getCertificateBySerial(approved.certificateMeta!.serial), 'CERT# kept');
    assert.ok(await exists(pdf), 'certificate PDF kept');
    const kept = (await repo.getFixtureScorecard(TENANT, 's1', 'fc-1'))!;
    assert.equal(kept.innings![0].batters[0].name, fullName);
    assert.equal(kept.terminal, undefined);
    assert.equal((await repo.listPlayerEraseLogs(TENANT)).length, logsBefore, 'no audit row');

    // A plain retry finishes the job.
    const retry = await erase(p.naturalKey);
    assert.equal(retry.status, 200);
    const { counts } = (await retry.json()) as { counts: PlayerErasureCounts };
    assert.equal(counts.scorecardsScrubbed, 1);
    assert.equal(counts.clearances, 1);
    const scrubbed = (await repo.getFixtureScorecard(TENANT, 's1', 'fc-1'))!;
    assert.equal(scrubbed.innings![0].batters[0].name, repo.ERASED_NAME);
    assert.equal(scrubbed.terminal, true);
    assert.equal(await repo.getClearanceRaw(TENANT, 'alpha', approved.id), null);
    assert.equal(await exists(pdf), false);
  });

  test('digest feedback that keeps changing → 409, NOTHING deleted (clearance-only person, no PLAYER# rows); a retry then completes', async () => {
    const objectKey = `local/${TENANT}/gamma/contended.png`;
    const p = mkPlayer('beta', {
      status: 'clearance-pending',
      idDocMeta: {
        objectKey,
        size: 1,
        contentType: 'image/png',
        uploadedAt: '2026-05-01T00:00:00.000Z',
      },
    });
    const fullName = `${p.firstName} ${p.lastName}`;
    const id = 'cl-contended';
    await repo.createAutoRejectedClearance(TENANT, p, {
      id,
      playerNaturalKey: p.naturalKey,
      playerName: fullName,
      fromClubId: 'old-directory-club',
      fromClubName: 'Old Directory CC',
      fromClubDirectory: true,
      toClubId: 'beta',
      toClubName: 'Beta CC',
      requestedAt: '2026-09-01T00:00:00.000Z',
      origin: 'registration',
      feesCleared: false,
      misconductCleared: false,
      status: 'rejected',
      rejectedAt: '2026-09-01T00:00:00.000Z',
      rejectedBy: 'system:transfer-window',
      rejectOutcome: 'not-registered',
      version: 1,
    } as PlayerClearance);
    await mkdir(path.dirname(diskPath(objectKey)), { recursive: true });
    await writeFile(diskPath(objectKey), 'x');
    assert.ok(
      await repo.createScorecardConfirmation(TENANT, {
        tenant: TENANT,
        clubId: 'beta',
        clubName: 'Beta CC',
        weekKey: '2026-W38',
        ref: 'scc-1',
        memberId: 'm-1',
        linkExpiresAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-09-21T00:00:00.000Z',
        entries: {
          's1#fd-1': {
            seriesId: 's1',
            fixtureId: 'fd-1',
            homeTeamName: 'Beta CC',
            awayTeamName: 'Alpha CC',
            fixtureDate: '2026-09-20',
            status: 'correction',
            feedback: `${fullName} was not out.`,
          },
        },
      } as ScorecardConfirmation),
    );

    const res = await withContention(feedbackScrubWrite, () => erase(p.naturalKey));
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /try again/);

    // Nothing destructive ran: the clearance (the ONLY record of the person) and its doc survive,
    // so the retry still finds them — with the name the feedback must lose.
    assert.ok(await repo.getClearanceRaw(TENANT, 'old-directory-club', id), 'clearance kept');
    assert.ok(await repo.getInboundClearance(TENANT, 'beta', id), 'mirror kept');
    assert.ok(await exists(diskPath(objectKey)), 'snapshot ID doc kept');
    const kept = (await repo.getScorecardConfirmation(TENANT, '2026-W38', 'beta'))!;
    assert.equal(kept.entries['s1#fd-1'].feedback, `${fullName} was not out.`);

    const retry = await erase(p.naturalKey);
    assert.equal(retry.status, 200);
    const { counts } = (await retry.json()) as { counts: PlayerErasureCounts };
    assert.equal(counts.feedbackScrubbed, 1);
    assert.equal(counts.clearances, 1);
    const scrubbed = (await repo.getScorecardConfirmation(TENANT, '2026-W38', 'beta'))!;
    assert.equal(scrubbed.entries['s1#fd-1'].feedback, `${repo.ERASED_NAME} was not out.`);
    assert.equal(await repo.getClearanceRaw(TENANT, 'old-directory-club', id), null);
    assert.equal(await exists(diskPath(objectKey)), false);
  });

  test('a single lost race is retried transparently (no throw)', async () => {
    const p = mkPlayer('delta');
    await repo.createPlayer(TENANT, p);
    await repo.putFixtureScorecard(TENANT, card('fc-race', `${p.firstName} ${p.lastName}`));
    let fails = 1;
    const res = await withContention(
      (c, kind) => scorecardScrubWrite(c, kind) && fails-- > 0,
      () => erase(p.naturalKey),
    );
    assert.equal(res.status, 200);
    const { counts } = (await res.json()) as { counts: PlayerErasureCounts };
    assert.equal(counts.scorecardsScrubbed, 1);
  });
});

describe('gates', () => {
  test('a pending clearance naming the person → 409, nothing touched', async () => {
    const p = mkPlayer('gamma');
    await repo.createPlayer(TENANT, p);
    const opened = await openClearance('gamma', 'delta', p.naturalKey);
    const res = await erase(p.naturalKey);
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { error: string }).error,
      /resolve or reject the open clearance/,
    );
    assert.ok(await repo.getPlayer(TENANT, 'gamma', p.naturalKey), 'row kept');
    assert.ok(await repo.getClearanceRaw(TENANT, 'gamma', opened.id), 'clearance kept');
  });

  test('unknown person → 404', async () => {
    assert.equal((await erase('nk-nobody')).status, 404);
  });

  test('a club rep cannot erase (admin-only)', async () => {
    const p = mkPlayer('alpha');
    await repo.createPlayer(TENANT, p);
    assert.equal((await erase(p.naturalKey, rep('alpha'))).status, 403);
    assert.ok(await repo.getPlayer(TENANT, 'alpha', p.naturalKey));
  });
});
