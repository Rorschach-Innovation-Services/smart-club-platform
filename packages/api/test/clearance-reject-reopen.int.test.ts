/**
 * Repo-level integration tests for reject-cancels-the-move + reversible Reopen (Group 1).
 *
 * Boots an in-process dynalite, creates the single table, and drives the REAL repo directly
 * (no HTTP, no AWS) — the reject/reopen case machinery lives in the data layer. Each case A–D
 * is exercised end to end (reject → assert → reopen → assert), plus the drift/conflict paths.
 *
 * Run with the API package's test runner (tsx --test), which resolves NodeNext ".js" specifiers.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// Env must be set BEFORE importing repo/keys — repo reads TABLE_NAME at module load.
const DDB_PORT = 4633; // distinct from the dev stack (4567) and api.int.test (4599)
const TABLE = 'SmartClubReject';
const TENANT = 'reji';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
// A failed S3 delete must not hang the suite — cap retries, and use local/ object keys below
// so deleteUploadObjects skips the network entirely.
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

type Repo = typeof import('../src/repo.js');
type Keys = typeof import('../src/keys.js');
type PlayerRegistration = import('../src/types.js').PlayerRegistration;
type PlayerClearance = import('../src/types.js').PlayerClearance;
type Club = import('../src/types.js').Club;

let ddbServer: Server;
let repo: Repo;
let keys: Keys;
// A raw doc client, used only to seed a legacy (snapshot-less) rejected clearance.
let docClient: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
let RawPut: typeof import('@aws-sdk/lib-dynamodb').PutCommand;

const idDoc = (key: string, size = 1) => ({
  objectKey: key,
  size,
  uploadedAt: '2026-05-01T00:00:00.000Z',
  contentType: 'image/png',
});

const mkClub = (id: string, name: string, extra: Record<string, unknown> = {}): Club =>
  ({
    id,
    name,
    district: 'Test District',
    sub: `sub-${id}`,
    chair: 'Chair',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: '#445566',
    ground: {},
    leagues: [],
    version: 1,
    ...extra,
  }) as unknown as Club;

const mkPlayer = (
  clubId: string,
  nk: string,
  extra: Partial<PlayerRegistration> = {},
): PlayerRegistration => ({
  naturalKey: nk,
  clubId,
  firstName: 'Test',
  lastName: 'Player',
  dob: '1994-02-02',
  isMinor: false,
  status: 'active',
  consentAt: '2026-05-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
  ...extra,
});

const mkClearance = (
  id: string,
  fromClubId: string,
  toClubId: string,
  nk: string,
  extra: Partial<PlayerClearance> = {},
): PlayerClearance =>
  ({
    id,
    playerNaturalKey: nk,
    playerName: 'Test Player',
    fromClubId,
    toClubId,
    fromClubName: `${fromClubId} name`,
    toClubName: `${toClubId} name`,
    requestedAt: '2026-05-01T00:00:00.000Z',
    feesCleared: false,
    misconductCleared: false,
    status: 'pending',
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
    ...extra,
  }) as PlayerClearance;

const count = async (clubId: string): Promise<number> =>
  ((await repo.getClub(TENANT, clubId)) as { playerCount?: number } | null)?.playerCount ?? 0;

const named = (e: unknown): string => (e as { name?: string }).name ?? '';

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

  const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb');
  RawPut = PutCommand;
  docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  repo = await import('../src/repo.js');
  keys = await import('../src/keys.js');
});

after(() => {
  ddbServer?.close();
});

// ── Case A — request-origin (rep-initiated transfer) ──
describe('case A (request)', () => {
  test('reject reactivates the source; reopen re-pends it; reject/reopen repeats', async () => {
    await repo.createClub(TENANT, mkClub('a-src', 'A Src'));
    await repo.createClub(TENANT, mkClub('a-dst', 'A Dst'));
    await repo.createPlayer(TENANT, mkPlayer('a-src', 'ap', { idDocMeta: idDoc('local/a-src') }));
    // No origin ⇒ 'request'. createClearance flips the source player to clearance-pending.
    await repo.createClearance(TENANT, mkClearance('a-clr', 'a-src', 'a-dst', 'ap'));
    assert.equal((await repo.getPlayer(TENANT, 'a-src', 'ap'))?.status, 'clearance-pending');

    const rejected = await repo.rejectClearance(TENANT, 'a-src', 'a-clr', {
      at: 't1',
      by: 'admin',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectOutcome, 'source-reactivated');
    assert.equal((await repo.getPlayer(TENANT, 'a-src', 'ap'))?.status, 'active');

    const reopened = await repo.reopenClearance(TENANT, 'a-src', 'a-clr', {
      at: 't2',
      by: 'admin',
    });
    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.rejectOutcome, undefined);
    assert.equal(reopened.rejectedAt, undefined);
    assert.equal(reopened.reopenedAt, 't2');
    assert.equal(reopened.reopenedBy, 'admin');
    assert.equal((await repo.getPlayer(TENANT, 'a-src', 'ap'))?.status, 'clearance-pending');

    // Repeat: reject again (defaults read the freshly-bumped version).
    const rejected2 = await repo.rejectClearance(TENANT, 'a-src', 'a-clr', {
      at: 't3',
      by: 'admin',
    });
    assert.equal(rejected2.status, 'rejected');
    assert.equal((await repo.getPlayer(TENANT, 'a-src', 'ap'))?.status, 'active');
    const reopened2 = await repo.reopenClearance(TENANT, 'a-src', 'a-clr', {
      at: 't4',
      by: 'admin',
    });
    assert.equal(reopened2.status, 'pending');
    assert.equal((await repo.getPlayer(TENANT, 'a-src', 'ap'))?.status, 'clearance-pending');
  });
});

// ── Case B — registration-origin, source holds the real pending row ──
describe('case B (dest-deleted, source reactivated)', () => {
  test('reject deletes dest, reactivates source, dest −1; reopen restores byte-equal; approve works', async () => {
    await repo.createClub(TENANT, mkClub('b-src', 'B Src'));
    await repo.createClub(TENANT, mkClub('b-dst', 'B Dst'));
    // Real active source row (non-placeholder: carries an ID doc).
    await repo.createPlayer(TENANT, mkPlayer('b-src', 'bp', { idDocMeta: idDoc('local/b-src') }));
    const destPlayer = mkPlayer('b-dst', 'bp', {
      status: 'clearance-pending',
      lastClub: 'B Src',
      idDocMeta: idDoc('local/b-dst', 2),
      cell: '0830000002',
      registeredVia: 'link',
    });
    // createPlayerWithClearance creates the dest row (+dest count) and flips the source to pending.
    await repo.createPlayerWithClearance(
      TENANT,
      destPlayer,
      mkClearance('b-clr', 'b-src', 'b-dst', 'bp', { origin: 'registration' }),
    );
    const dstBefore = await count('b-dst');

    const rejected = await repo.rejectClearance(TENANT, 'b-src', 'b-clr', { at: 't', by: 'admin' });
    assert.equal(rejected.rejectOutcome, 'source-reactivated');
    assert.equal(await repo.getPlayer(TENANT, 'b-dst', 'bp'), null, 'dest row deleted');
    assert.equal(
      (await repo.getPlayer(TENANT, 'b-src', 'bp'))?.status,
      'active',
      'source reactivated',
    );
    assert.equal(await count('b-dst'), dstBefore - 1, 'dest count −1');

    const reopened = await repo.reopenClearance(TENANT, 'b-src', 'b-clr', {
      at: 't2',
      by: 'admin',
    });
    assert.equal(reopened.status, 'pending');
    assert.deepEqual(
      await repo.getPlayer(TENANT, 'b-dst', 'bp'),
      destPlayer,
      'dest row restored byte-equal incl idDocMeta',
    );
    assert.equal(
      (await repo.getPlayer(TENANT, 'b-src', 'bp'))?.status,
      'clearance-pending',
      'source re-pended',
    );
    assert.equal(await count('b-dst'), dstBefore, 'dest count restored');

    // Approve the reopened clearance (registration-origin admin override activates the dest).
    const cur = await repo.getClearance(TENANT, 'b-src', 'b-clr');
    const approved = await repo.resolveClearance(TENANT, 'b-src', 'b-clr', {
      mode: 'admin',
      at: 't3',
      by: 'admin',
      expectedVersion: cur!.version,
    });
    assert.equal(approved.status, 'admin-override');
    assert.equal((await repo.getPlayer(TENANT, 'b-dst', 'bp'))?.status, 'active');
  });
});

// ── Case B′ — registration-origin, source already holds an ACTIVE row ──
describe('case B′ (dest-deleted, source untouched)', () => {
  test('reject leaves the source row untouched; reopen too; reopen blocks if source left', async () => {
    await repo.createClub(TENANT, mkClub('bp-src', 'BP Src'));
    await repo.createClub(TENANT, mkClub('bp-dst', 'BP Dst'));
    const destPlayer = mkPlayer('bp-dst', 'bpp', {
      status: 'clearance-pending',
      lastClub: 'BP Src',
      idDocMeta: idDoc('local/bp-dst'),
      cell: '0830000010',
    });
    // Sourceless create (no source flip), then a separate ACTIVE row at the source club.
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      destPlayer,
      mkClearance('bp-clr', 'bp-src', 'bp-dst', 'bpp', { origin: 'registration' }),
    );
    const srcActive = mkPlayer('bp-src', 'bpp', {
      status: 'active',
      idDocMeta: idDoc('local/bp-src'),
    });
    await repo.createPlayer(TENANT, srcActive);

    const rejected = await repo.rejectClearance(TENANT, 'bp-src', 'bp-clr', {
      at: 't',
      by: 'admin',
    });
    assert.equal(rejected.rejectOutcome, 'source-reactivated');
    assert.deepEqual(await repo.getPlayer(TENANT, 'bp-src', 'bpp'), srcActive, 'source untouched');
    assert.equal(await repo.getPlayer(TENANT, 'bp-dst', 'bpp'), null, 'dest deleted');

    const reopened = await repo.reopenClearance(TENANT, 'bp-src', 'bp-clr', {
      at: 't2',
      by: 'admin',
    });
    assert.equal(reopened.status, 'pending');
    assert.deepEqual(
      await repo.getPlayer(TENANT, 'bp-src', 'bpp'),
      srcActive,
      'source still untouched after reopen',
    );
    assert.deepEqual(await repo.getPlayer(TENANT, 'bp-dst', 'bpp'), destPlayer, 'dest restored');

    // Reject again, then transfer the source player OUT — reopen must Block (no double-active).
    await repo.rejectClearance(TENANT, 'bp-src', 'bp-clr', { at: 't3', by: 'admin' });
    await repo.deletePlayer(TENANT, srcActive);
    await assert.rejects(
      () => repo.reopenClearance(TENANT, 'bp-src', 'bp-clr', { at: 't4', by: 'admin' }),
      (e) => named(e) === 'ClearanceReopenBlockedError',
    );
    // The failed reopen unwound: the clearance is still rejected and the dest row is not present.
    assert.equal((await repo.getClearance(TENANT, 'bp-src', 'bp-clr'))?.status, 'rejected');
    assert.equal(await repo.getPlayer(TENANT, 'bp-dst', 'bpp'), null, 'dest restore unwound');
  });
});

// ── Case B″ — registration-origin, source holds only a placeholder ──
describe('case B″ (moved-over-placeholder)', () => {
  test('the real registration replaces the placeholder; only dest −1; reopen restores the placeholder', async () => {
    await repo.createClub(TENANT, mkClub('bpp-src', 'BPP Src'));
    await repo.createClub(TENANT, mkClub('bpp-dst', 'BPP Dst'));
    const destPlayer = mkPlayer('bpp-dst', 'bppp', {
      status: 'clearance-pending',
      lastClub: 'BPP Src',
      idDocMeta: idDoc('local/bpp-dst'),
      cell: '0830000011',
      registeredVia: 'link',
    });
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      destPlayer,
      // fromClubName matches the destination row's lastClub (as the real flow writes it) so the
      // reject's lastClub clear and reopen's lastClub restore are both observable.
      mkClearance('bpp-clr', 'bpp-src', 'bpp-dst', 'bppp', {
        origin: 'registration',
        fromClubName: 'BPP Src',
      }),
    );
    // The placeholder source row (marker set): name/ID only, no contact, no ID doc.
    const placeholder = mkPlayer('bpp-src', 'bppp', {
      status: 'clearance-pending',
      placeholder: true,
    });
    await repo.createPlayer(TENANT, placeholder);
    const srcBefore = await count('bpp-src');
    const dstBefore = await count('bpp-dst');

    const rejected = await repo.rejectClearance(TENANT, 'bpp-src', 'bpp-clr', {
      at: 't',
      by: 'admin',
    });
    assert.equal(rejected.rejectOutcome, 'moved-to-source');
    assert.equal(await repo.getPlayer(TENANT, 'bpp-dst', 'bppp'), null, 'dest deleted');
    const atSrc = await repo.getPlayer(TENANT, 'bpp-src', 'bppp');
    assert.equal(atSrc?.status, 'active', 'real registration active at the source');
    assert.equal(atSrc?.idDocMeta?.objectKey, 'local/bpp-dst', 'the real ID doc replaced the stub');
    assert.equal(atSrc?.placeholder, undefined, 'placeholder marker gone');
    assert.equal(
      atSrc?.lastClub,
      undefined,
      'lastClub cleared like case C (row lives at that club)',
    );
    assert.equal(
      await count('bpp-src'),
      srcBefore,
      'source count unchanged (placeholder was counted)',
    );
    assert.equal(await count('bpp-dst'), dstBefore - 1, 'dest count −1');

    const reopened = await repo.reopenClearance(TENANT, 'bpp-src', 'bpp-clr', {
      at: 't2',
      by: 'admin',
    });
    assert.equal(reopened.status, 'pending');
    assert.deepEqual(
      await repo.getPlayer(TENANT, 'bpp-src', 'bppp'),
      placeholder,
      'placeholder restored at the source',
    );
    const backAtDst = await repo.getPlayer(TENANT, 'bpp-dst', 'bppp');
    assert.equal(
      backAtDst?.status,
      'clearance-pending',
      'registration back at the destination, pending',
    );
    assert.equal(backAtDst?.idDocMeta?.objectKey, 'local/bpp-dst');
    assert.equal(backAtDst?.lastClub, 'BPP Src', 'lastClub restored to fromClubName');
    assert.equal(await count('bpp-dst'), dstBefore, 'dest count restored');
  });

  test('reopen blocks (source untouched) when the source rep opened a new transfer after the B″ reject', async () => {
    await repo.createClub(TENANT, mkClub('b2p-src', 'B2P Src'));
    await repo.createClub(TENANT, mkClub('b2p-dst', 'B2P Dst'));
    await repo.createClub(TENANT, mkClub('b2p-new', 'B2P New')); // destination of the NEW transfer
    const destPlayer = mkPlayer('b2p-dst', 'b2pp', {
      status: 'clearance-pending',
      lastClub: 'B2P Src',
      idDocMeta: idDoc('local/b2p-dst'),
      cell: '0830000012',
      registeredVia: 'link',
    });
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      destPlayer,
      mkClearance('b2p-clr', 'b2p-src', 'b2p-dst', 'b2pp', {
        origin: 'registration',
        fromClubName: 'B2P Src',
      }),
    );
    await repo.createPlayer(
      TENANT,
      mkPlayer('b2p-src', 'b2pp', { status: 'clearance-pending', placeholder: true }),
    );

    // B″ reject: the real registration is now active at the source club.
    await repo.rejectClearance(TENANT, 'b2p-src', 'b2p-clr', { at: 't', by: 'admin' });
    assert.equal((await repo.getPlayer(TENANT, 'b2p-src', 'b2pp'))?.status, 'active');

    // The source rep opens a NEW (request-origin) transfer for that player → the source row is
    // held 'clearance-pending'. Reopening the ORIGINAL clearance must NOT replace that held row
    // with the placeholder — it must Block, leaving the held row untouched.
    await repo.createClearance(TENANT, mkClearance('b2p-new-clr', 'b2p-src', 'b2p-new', 'b2pp'));
    const held = await repo.getPlayer(TENANT, 'b2p-src', 'b2pp');
    assert.equal(held?.status, 'clearance-pending', 'source row held by the new transfer');

    await assert.rejects(
      () => repo.reopenClearance(TENANT, 'b2p-src', 'b2p-clr', { at: 't2', by: 'admin' }),
      (e) => named(e) === 'ClearanceReopenBlockedError',
    );
    // The blocked reopen unwound cleanly: source row untouched, dest restore rolled back, and the
    // original clearance is still rejected.
    assert.deepEqual(
      await repo.getPlayer(TENANT, 'b2p-src', 'b2pp'),
      held,
      'the held source row is untouched by the blocked reopen',
    );
    assert.equal(await repo.getPlayer(TENANT, 'b2p-dst', 'b2pp'), null, 'dest restore unwound');
    assert.equal((await repo.getClearance(TENANT, 'b2p-src', 'b2p-clr'))?.status, 'rejected');
  });
});

// ── Case C — registration-origin, source club exists but holds no row ──
describe('case C (moved-to-source)', () => {
  test('registration moves to the source (active, lastClub cleared, counts moved); reopen restores, edits survive', async () => {
    await repo.createClub(TENANT, mkClub('c-src', 'C Src'));
    await repo.createClub(TENANT, mkClub('c-dst', 'C Dst'));
    const destPlayer = mkPlayer('c-dst', 'cp', {
      status: 'clearance-pending',
      lastClub: 'C Src',
      idDocMeta: idDoc('local/c-dst', 3),
      previousIdDocMeta: idDoc('local/c-prev', 4),
      cell: '0830000020',
    });
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      destPlayer,
      // fromClubName matches the source club's display name (as the real flow writes it) and the
      // destination row's lastClub — so reopen's lastClub restore is observable.
      mkClearance('c-clr', 'c-src', 'c-dst', 'cp', {
        origin: 'registration',
        fromClubName: 'C Src',
      }),
    );
    const srcBefore = await count('c-src');
    const dstBefore = await count('c-dst');

    const rejected = await repo.rejectClearance(TENANT, 'c-src', 'c-clr', { at: 't', by: 'admin' });
    assert.equal(rejected.rejectOutcome, 'moved-to-source');
    assert.equal(await repo.getPlayer(TENANT, 'c-dst', 'cp'), null, 'dest gone');
    const atSrc = await repo.getPlayer(TENANT, 'c-src', 'cp');
    assert.equal(atSrc?.status, 'active');
    assert.equal(atSrc?.lastClub, undefined, 'lastClub cleared (row must not name its own club)');
    assert.equal(atSrc?.idDocMeta?.objectKey, 'local/c-dst', 'same ID doc objectKey moved');
    assert.equal(atSrc?.previousIdDocMeta?.objectKey, 'local/c-prev');
    assert.equal(await count('c-src'), srcBefore + 1, 'source count +1');
    assert.equal(await count('c-dst'), dstBefore - 1, 'dest count −1');

    // Edit the row at the source, then reopen — the edit survives (reopen moves the LIVE row).
    await repo.updatePlayer(TENANT, 'c-src', 'cp', { gender: 'Female' });
    const reopened = await repo.reopenClearance(TENANT, 'c-src', 'c-clr', {
      at: 't2',
      by: 'admin',
    });
    assert.equal(reopened.status, 'pending');
    assert.equal(await repo.getPlayer(TENANT, 'c-src', 'cp'), null, 'moved off the source');
    const backAtDst = await repo.getPlayer(TENANT, 'c-dst', 'cp');
    assert.equal(backAtDst?.status, 'clearance-pending');
    assert.equal(backAtDst?.gender, 'Female', 'post-reject edit survived');
    assert.equal(backAtDst?.lastClub, 'C Src', 'lastClub restored');
    assert.equal(await count('c-src'), srcBefore, 'source count restored');
    assert.equal(await count('c-dst'), dstBefore, 'dest count restored');
  });

  test('reopen blocks when the source row was removed after a case-C reject', async () => {
    await repo.createClub(TENANT, mkClub('c2-src', 'C2 Src'));
    await repo.createClub(TENANT, mkClub('c2-dst', 'C2 Dst'));
    const destPlayer = mkPlayer('c2-dst', 'c2p', {
      status: 'clearance-pending',
      lastClub: 'C2 Src',
      idDocMeta: idDoc('local/c2-dst'),
      cell: '0830000021',
    });
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      destPlayer,
      mkClearance('c2-clr', 'c2-src', 'c2-dst', 'c2p', { origin: 'registration' }),
    );
    await repo.rejectClearance(TENANT, 'c2-src', 'c2-clr', { at: 't', by: 'admin' });
    const moved = await repo.getPlayer(TENANT, 'c2-src', 'c2p');
    assert.ok(moved, 'row moved to the source');
    // The source rep deletes the player (purges the only ID-doc copy) — reopen can't find it.
    await repo.deletePlayer(TENANT, moved!);
    await assert.rejects(
      () => repo.reopenClearance(TENANT, 'c2-src', 'c2-clr', { at: 't2', by: 'admin' }),
      (e) => named(e) === 'ClearanceReopenBlockedError',
    );
  });
});

// ── Case D — off-system directory source ──
describe('case D (dest-activated)', () => {
  test('player stays active at the destination in place; no clearanceRejected*; counts unchanged; reopen re-pends', async () => {
    await repo.createClub(TENANT, mkClub('d-dst', 'D Dst')); // NO source club (off-system)
    const destPlayer = mkPlayer('d-dst', 'dp', {
      status: 'clearance-pending',
      lastClub: 'Offline Prev CC',
      idDocMeta: idDoc('local/d-dst'),
      cell: '0830000030',
    });
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      destPlayer,
      mkClearance('d-clr', 'd-old', 'd-dst', 'dp', {
        origin: 'registration',
        fromClubDirectory: true,
      }),
    );
    const dstBefore = await count('d-dst');

    const rejected = await repo.rejectClearance(TENANT, 'd-old', 'd-clr', { at: 't', by: 'admin' });
    assert.equal(rejected.rejectOutcome, 'stays-at-destination');
    const atDst = await repo.getPlayer(TENANT, 'd-dst', 'dp');
    assert.equal(atDst?.status, 'active', 'active in place at the destination');
    assert.equal(
      atDst?.clearanceRejectedAt,
      undefined,
      'no legacy clearance-rejected flag written',
    );
    assert.equal(atDst?.clearanceRejectedReason, undefined);
    assert.equal(await count('d-dst'), dstBefore, 'counts unchanged');

    const reopened = await repo.reopenClearance(TENANT, 'd-old', 'd-clr', {
      at: 't2',
      by: 'admin',
    });
    assert.equal(reopened.status, 'pending');
    assert.equal((await repo.getPlayer(TENANT, 'd-dst', 'dp'))?.status, 'clearance-pending');
  });

  test('once a club claims the slug and rosters the player, reject downgrades to B′ (source row survives)', async () => {
    await repo.createClub(TENANT, mkClub('d2-dst', 'D2 Dst'));
    const destPlayer = mkPlayer('d2-dst', 'd2p', {
      status: 'clearance-pending',
      lastClub: 'Offline',
      idDocMeta: idDoc('local/d2-dst'),
      cell: '0830000031',
    });
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      destPlayer,
      mkClearance('d2-clr', 'd2-old', 'd2-dst', 'd2p', {
        origin: 'registration',
        fromClubDirectory: true,
      }),
    );
    // A club signs up under the directory slug and rosters the player ACTIVE. Detection on live
    // state now sees a source row → B′ (the D ConditionCheck's downgrade), NOT a directory reject.
    await repo.createClub(TENANT, mkClub('d2-old', 'D2 Old (claimed)'));
    const srcActive = mkPlayer('d2-old', 'd2p', {
      status: 'active',
      idDocMeta: idDoc('local/d2-old'),
    });
    await repo.createPlayer(TENANT, srcActive);

    const rejected = await repo.rejectClearance(TENANT, 'd2-old', 'd2-clr', {
      at: 't',
      by: 'admin',
    });
    assert.equal(
      rejected.rejectOutcome,
      'source-reactivated',
      'B′ outcome, not stays-at-destination',
    );
    assert.deepEqual(
      await repo.getPlayer(TENANT, 'd2-old', 'd2p'),
      srcActive,
      'the actively-rostered source row survives the reject',
    );
    assert.equal(await repo.getPlayer(TENANT, 'd2-dst', 'd2p'), null, 'dest removed');
  });

  test('a stale expectedVersion reject VersionConflicts', async () => {
    await repo.createClub(TENANT, mkClub('d3-dst', 'D3 Dst'));
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      mkPlayer('d3-dst', 'd3p', { status: 'clearance-pending', idDocMeta: idDoc('local/d3-dst') }),
      mkClearance('d3-clr', 'd3-old', 'd3-dst', 'd3p', {
        origin: 'registration',
        fromClubDirectory: true,
      }),
    );
    await assert.rejects(
      () =>
        repo.rejectClearance(TENANT, 'd3-old', 'd3-clr', {
          at: 't',
          by: 'admin',
          expectedVersion: 99,
        }),
      (e) => named(e) === 'VersionConflictError',
    );
  });
});

// ── Reopen drift / conflict paths ──
describe('reopen conflicts', () => {
  test('reopen after the player re-registered at the destination → PlayerExistsAtDestination', async () => {
    await repo.createClub(TENANT, mkClub('re-src', 'RE Src'));
    await repo.createClub(TENANT, mkClub('re-dst', 'RE Dst'));
    await repo.createPlayerWithSourcelessClearance(
      TENANT,
      mkPlayer('re-dst', 'rep', { status: 'clearance-pending', idDocMeta: idDoc('local/re-dst') }),
      mkClearance('re-clr', 're-src', 're-dst', 'rep', { origin: 'registration' }),
    );
    // Case C reject (source club exists, no row) — dest row removed.
    await repo.rejectClearance(TENANT, 're-src', 're-clr', { at: 't', by: 'admin' });
    // Someone registers the player at the destination again before reopen.
    await repo.createPlayer(TENANT, mkPlayer('re-dst', 'rep', { status: 'active' }));
    await assert.rejects(
      () => repo.reopenClearance(TENANT, 're-src', 're-clr', { at: 't2', by: 'admin' }),
      (e) => named(e) === 'PlayerExistsAtDestinationError',
    );
  });

  test('reopen of a pending clearance → VersionConflict', async () => {
    await repo.createClub(TENANT, mkClub('rp-dst', 'RP Dst'));
    await repo.createClub(TENANT, mkClub('rp-src', 'RP Src'));
    await repo.createPlayer(TENANT, mkPlayer('rp-src', 'rpp'));
    await repo.createClearance(TENANT, mkClearance('rp-clr', 'rp-src', 'rp-dst', 'rpp'));
    await assert.rejects(
      () => repo.reopenClearance(TENANT, 'rp-src', 'rp-clr', { at: 't', by: 'admin' }),
      (e) => named(e) === 'VersionConflictError',
    );
  });

  test('reopen of a legacy rejected clearance (no snapshot) → Blocked', async () => {
    const id = 'legacy-clr';
    const clr = mkClearance('legacy-clr', 'lg-src', 'lg-dst', 'lgp', {
      origin: 'registration',
      status: 'rejected',
      rejectedAt: 't',
      rejectedBy: 'a',
      version: 1,
    });
    // Seed a rejected canonical with NO rejectSnapshot — the shape a pre-feature reject left.
    await docClient.send(
      new RawPut({
        TableName: TABLE,
        Item: {
          ...keys.clearanceKey(TENANT, 'lg-src', id),
          ...keys.clearanceGsi1(TENANT, clr.requestedAt),
          ...clr,
        },
      }),
    );
    await assert.rejects(
      () => repo.reopenClearance(TENANT, 'lg-src', id, { at: 't2', by: 'a' }),
      (e) =>
        named(e) === 'ClearanceReopenBlockedError' &&
        /before reopen was supported/.test((e as Error).message),
    );
  });
});

// ── Snapshot containment + erasure ──
describe('snapshot containment and erasure', () => {
  test('the mirror never carries rejectSnapshot; publicClearance and getClearance strip it; getClearanceRaw keeps it', async () => {
    await repo.createClub(TENANT, mkClub('sc-src', 'SC Src'));
    await repo.createClub(TENANT, mkClub('sc-dst', 'SC Dst'));
    await repo.createPlayer(
      TENANT,
      mkPlayer('sc-src', 'scp', { idDocMeta: idDoc('local/sc-src') }),
    );
    await repo.createPlayerWithClearance(
      TENANT,
      mkPlayer('sc-dst', 'scp', { status: 'clearance-pending', idDocMeta: idDoc('local/sc-dst') }),
      mkClearance('sc-clr', 'sc-src', 'sc-dst', 'scp', { origin: 'registration' }),
    );
    await repo.rejectClearance(TENANT, 'sc-src', 'sc-clr', { at: 't', by: 'admin' });

    const raw = await repo.getClearanceRaw(TENANT, 'sc-src', 'sc-clr');
    assert.ok(raw?.rejectSnapshot, 'the canonical keeps the snapshot');
    assert.equal(raw!.rejectSnapshot!.case, 'dest-deleted');

    const pub = await repo.getClearance(TENANT, 'sc-src', 'sc-clr');
    assert.equal(pub?.rejectSnapshot, undefined, 'getClearance strips the snapshot');
    assert.equal(pub?.rejectOutcome, 'source-reactivated', 'but keeps the public outcome');

    const forSource = (await repo.listClearancesForSource(TENANT, 'sc-src')).find(
      (x) => x.id === 'sc-clr',
    );
    assert.equal(forSource?.rejectSnapshot, undefined, 'the source-rep listing is stripped');

    const inbound = (await repo.listInboundForDest(TENANT, 'sc-dst')).find(
      (x) => x.id === 'sc-clr',
    );
    assert.equal(inbound?.rejectSnapshot, undefined, 'the destination mirror never carried it');

    assert.equal(repo.publicClearance(raw!).rejectSnapshot, undefined, 'publicClearance strips it');
  });

  test('clearanceDocObjectKeys returns the snapshot ID-doc keys and the destination-club erase reads the canonical', async () => {
    await repo.createClub(TENANT, mkClub('er-src', 'ER Src'));
    await repo.createClub(TENANT, mkClub('er-dst', 'ER Dst'));
    await repo.createPlayer(
      TENANT,
      mkPlayer('er-src', 'erp', { idDocMeta: idDoc('local/er-src') }),
    );
    await repo.createPlayerWithClearance(
      TENANT,
      mkPlayer('er-dst', 'erp', {
        status: 'clearance-pending',
        idDocMeta: idDoc('local/er-dst-id'),
        previousIdDocMeta: idDoc('local/er-dst-prev'),
      }),
      mkClearance('er-clr', 'er-src', 'er-dst', 'erp', { origin: 'registration' }),
    );
    await repo.rejectClearance(TENANT, 'er-src', 'er-clr', { at: 't', by: 'admin' });

    const raw = await repo.getClearanceRaw(TENANT, 'er-src', 'er-clr');
    assert.deepEqual(
      repo.clearanceDocObjectKeys(raw!).sort(),
      ['local/er-dst-id', 'local/er-dst-prev'].sort(),
      'both the self-asserted and previous ID-doc keys are collected from the snapshot',
    );

    // The destination-club erase path reaches the snapshot via the canonical under the source
    // club: the inbound mirror at er-dst points at it. Erase completes and removes the mirror.
    const inboundBefore = (await repo.listInboundForDest(TENANT, 'er-dst')).find(
      (x) => x.id === 'er-clr',
    );
    assert.ok(inboundBefore, 'the rejected clearance mirror is inbound to the destination club');
    const destClub = await repo.getClub(TENANT, 'er-dst');
    await repo.eraseClubData(TENANT, destClub!);
    assert.equal(
      (await repo.listInboundForDest(TENANT, 'er-dst')).find((x) => x.id === 'er-clr'),
      undefined,
      'the inbound mirror is gone after the destination-club erase',
    );
  });

  test('the SOURCE-club erase collects the rejected snapshot ID-doc keys and removes canonical + mirror', async () => {
    await repo.createClub(TENANT, mkClub('es-src', 'ES Src'));
    await repo.createClub(TENANT, mkClub('es-dst', 'ES Dst'));
    await repo.createPlayer(
      TENANT,
      mkPlayer('es-src', 'esp', { idDocMeta: idDoc('local/es-src') }),
    );
    await repo.createPlayerWithClearance(
      TENANT,
      mkPlayer('es-dst', 'esp', {
        status: 'clearance-pending',
        idDocMeta: idDoc('local/es-dst-id'),
        previousIdDocMeta: idDoc('local/es-dst-prev'),
      }),
      mkClearance('es-clr', 'es-src', 'es-dst', 'esp', { origin: 'registration' }),
    );
    // Case B reject (source holds the real pending row) — canonical + snapshot live under es-src.
    await repo.rejectClearance(TENANT, 'es-src', 'es-clr', { at: 't', by: 'admin' });

    const raw = await repo.getClearanceRaw(TENANT, 'es-src', 'es-clr');
    assert.deepEqual(
      repo.clearanceDocObjectKeys(raw!).sort(),
      ['local/es-dst-id', 'local/es-dst-prev'].sort(),
      'the source-side canonical carries the destination ID-doc keys on its snapshot',
    );

    // Erasing the SOURCE club walks its outgoing clearances, reads the rejected canonical for its
    // snapshot keys (branch under listClearancesForSource), then deletes canonical + mirror.
    const srcClub = await repo.getClub(TENANT, 'es-src');
    await repo.eraseClubData(TENANT, srcClub!);
    assert.equal(
      await repo.getClearanceRaw(TENANT, 'es-src', 'es-clr'),
      null,
      'the canonical is gone after the source-club erase',
    );
    assert.equal(
      (await repo.listInboundForDest(TENANT, 'es-dst')).find((x) => x.id === 'es-clr'),
      undefined,
      'the destination mirror is gone too',
    );
  });

  test('eraseTenantData removes a rejected clearance and its snapshot-bearing canonical', async () => {
    // A throwaway tenant so the wipe cannot disturb the shared TENANT other tests use.
    const T = 'reji-erase';
    await repo.createClub(T, mkClub('et-src', 'ET Src'));
    await repo.createClub(T, mkClub('et-dst', 'ET Dst'));
    await repo.createPlayer(T, mkPlayer('et-src', 'etp', { idDocMeta: idDoc('local/et-src') }));
    await repo.createPlayerWithClearance(
      T,
      mkPlayer('et-dst', 'etp', {
        status: 'clearance-pending',
        idDocMeta: idDoc('local/et-dst-id'),
      }),
      mkClearance('et-clr', 'et-src', 'et-dst', 'etp', { origin: 'registration' }),
    );
    await repo.rejectClearance(T, 'et-src', 'et-clr', { at: 't', by: 'admin' });
    assert.ok(await repo.getClearanceRaw(T, 'et-src', 'et-clr'), 'rejected canonical exists');

    const removed = await repo.eraseTenantData(T);
    assert.ok(removed > 0, 'the tenant wipe deleted items');
    assert.equal(
      await repo.getClearanceRaw(T, 'et-src', 'et-clr'),
      null,
      'the rejected canonical is gone after the tenant wipe',
    );
    assert.equal((await repo.listClubs(T)).length, 0, 'no clubs remain in the wiped tenant');
  });
});
