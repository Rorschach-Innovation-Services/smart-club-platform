/**
 * The duplicate-remediation CLIs against the real repo (dynalite): resolve-duplicate-players
 * (plan is read-only and masked; confirm backs up, fills the survivor — veterans through the
 * VETAFFIL path — carries a stale-only ID document and keeps its object, refuses blocked /
 * out-of-band groups, records deleted keys, is idempotent) and tombstone-deleted-players
 * (requires the sync on, refuses live keys, dry-run writes nothing, confirm queues erase rows).
 * Also pins the keepDocs default: an ordinary deletePlayer still purges the ID document.
 *
 * Same harness as backfill-player-team.int.test.ts: in-process dynalite + the real repo.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Club, PlayerRegistration, TenantConfig } from '../src/types.js';

// Env must be set BEFORE importing repo — it reads TABLE_NAME at module load.
const DDB_PORT = 4713; // unique: 4599–4711 are taken
const TABLE = 'SmartClubResolveDuplicatesTest';
const UPLOADS = mkdtempSync(path.join(tmpdir(), 'resolve-dups-uploads-'));
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.LOCAL_UPLOADS_DIR = UPLOADS;
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const T = 'dolphins';
let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let cli: typeof import('../src/resolve-duplicate-players.js');
let tomb: typeof import('../src/tombstone-deleted-players.js');
let countItems: () => Promise<number>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const S1 = sha('sa-id-0102035000081');
const SLUG1 = 'sa-id-sipho-dlamini-2001-02-03';
const S2 = sha('sa-id-9905065000082');
const SLUG2 = 'thabo-nkosi-1999-05-06';
const S3 = sha('sa-id-0001015000083');
const SLUG3 = 'ayanda-zulu-2000-01-01';
const S4 = sha('sa-id-9802025000084');
const S5 = sha('sa-id-9703035000085');
const SLUG5 = 'bongani-khumalo-1997-03-03';

const club = (id: string): Club =>
  ({
    id,
    name: `${id.toUpperCase()} CC`,
    district: 'Test District',
    sub: 's',
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
    leagues: ['premier'],
    version: 1,
  }) as unknown as Club;

const player = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    firstName: 'Sipho',
    lastName: 'Dlamini',
    dob: '2001-02-03',
    isMinor: false,
    consentAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    clubId: 'a',
    status: 'active',
    idType: 'sa-id',
    idNumber: '0102035000081',
    ...p,
  }) as PlayerRegistration;

const docKey = (name: string) => `local/${T}/a/players/${name}-id.pdf`;
const docFile = (name: string) => path.join(UPLOADS, T, 'a', 'players', `${name}-id.pdf`);
const putDoc = (name: string) => {
  mkdirSync(path.dirname(docFile(name)), { recursive: true });
  writeFileSync(docFile(name), 'pdf');
  return { objectKey: docKey(name), size: 3, uploadedAt: '2026-05-01T00:00:00.000Z' };
};

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));
  const { DynamoDBClient, CreateTableCommand, ScanCommand } =
    await import('@aws-sdk/client-dynamodb');
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
  countItems = async () =>
    (await admin.send(new ScanCommand({ TableName: TABLE, Select: 'COUNT' }))).Count ?? 0;

  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig(T);
  repo = await import('../src/repo.js');
  cli = await import('../src/resolve-duplicate-players.js');
  tomb = await import('../src/tombstone-deleted-players.js');

  for (const id of ['a', 'b', 'vets']) await repo.createClub(T, club(id));
  // G1 — same club, sha survivor (bare) + legacy slug row carrying the only ID doc, history,
  // a cricket profile and a veterans affiliation.
  await repo.createPlayer(T, player({ naturalKey: S1 }));
  await repo.createPlayer(
    T,
    player({
      naturalKey: SLUG1,
      lastClub: 'Old CC',
      battingHand: 'Left',
      bowlerType: '',
      veteransClubId: 'vets',
      veteransClub: 'VETS CC',
      idDocMeta: putDoc('slug1'),
    }),
  );
  // G2 — cross-club pair.
  const thabo = { firstName: 'Thabo', lastName: 'Nkosi', dob: '1999-05-06' };
  await repo.createPlayer(T, player({ ...thabo, naturalKey: S2 }));
  await repo.createPlayer(T, player({ ...thabo, naturalKey: SLUG2, clubId: 'b' }));
  // G3 — blocked by an open registration review naming the slug key.
  const ayanda = { firstName: 'Ayanda', lastName: 'Zulu', dob: '2000-01-01' };
  await repo.createPlayer(T, player({ ...ayanda, naturalKey: S3 }));
  await repo.createPlayer(T, player({ ...ayanda, naturalKey: SLUG3 }));
  await repo.createRegistrationReview(T, {
    id: 'rev-1',
    kind: 'off-system-alert',
    playerNaturalKey: SLUG3,
    playerName: 'Ayanda Zulu',
    destClubId: 'a',
    destClubName: 'A CC',
    linkClubId: 'a',
    linkClubName: 'A CC',
    typedPreviousClub: 'Somewhere CC',
    createdAt: '2026-05-01T00:00:00.000Z',
    status: 'open',
    version: 0,
  });
  // K — one identity active at two clubs.
  const lwazi = { firstName: 'Lwazi', lastName: 'Mthembu', dob: '1998-02-02' };
  await repo.createPlayer(T, player({ ...lwazi, naturalKey: S4 }));
  await repo.createPlayer(T, player({ ...lwazi, naturalKey: S4, clubId: 'b' }));
  // G4 — two real people sharing name + dob (to be confirmed distinct).
  const bongani = { firstName: 'Bongani', lastName: 'Khumalo', dob: '1997-03-03' };
  await repo.createPlayer(T, player({ ...bongani, naturalKey: S5 }));
  await repo.createPlayer(T, player({ ...bongani, naturalKey: SLUG5 }));
});

after(() => {
  ddbServer?.close();
});

const outDir = mkdtempSync(path.join(tmpdir(), 'resolve-dups-out-'));
const entryFor = (file: import('../src/resolve-duplicate-players.js').DecisionsFile, nk: string) =>
  file.entries.find((e) => e.naturalKeys.includes(nk))!;

describe('resolve-duplicate-players args', () => {
  test('plan by default; confirm needs --decisions; unknown flags refused', () => {
    assert.deepEqual(cli.parseArgs(['--tenant', 't', '--out', 'o']), {
      tenant: 't',
      out: 'o',
      mode: 'plan',
    });
    assert.equal(
      cli.parseArgs(['--tenant', 't', '--out', 'o', '--confirm', '--decisions', 'd']).mode,
      'confirm',
    );
    assert.throws(() => cli.parseArgs(['--tenant', 't', '--out', 'o', '--confirm']), /--decisions/);
    assert.throws(() => cli.parseArgs(['--tenant', 't']), /--out is required/);
    assert.throws(() => cli.parseArgs(['--tenant', 't', '--out', 'o', '--bogus']), /unknown/);
    assert.equal(cli.parseArgs(['--tenant', 't', '--out', 'o', '--force']).force, true);
    assert.throws(
      () =>
        cli.parseArgs(['--tenant', 't', '--out', 'o', '--confirm', '--decisions', 'd', '--force']),
      /--force only applies to --plan/,
    );
    assert.throws(
      () => cli.parseArgs(['--help']),
      (e: Error) => e.name === 'HelpRequested',
    );
    assert.equal(cli.exitCodeFor(new cli.HelpRequested()), 0);
    assert.equal(cli.exitCodeFor(new cli.ValidationError('x')), 2);
    assert.equal(cli.exitCodeFor(new Error('x')), 1);
  });
});

describe('resolve-duplicate-players', () => {
  let plan: import('../src/resolve-duplicate-players.js').DecisionsFile;
  let edited: import('../src/resolve-duplicate-players.js').DecisionsFile;

  test('plan: classifies every group, writes nothing to the table, masks the review', async () => {
    const before = await countItems();
    plan = await cli.runPlan(repo, T, outDir, '2026-10-08T00:00:00.000Z');
    assert.equal(await countItems(), before, 'the plan made no table write');

    const g1 = entryFor(plan, S1);
    assert.equal(g1.status, 'PROPOSED');
    assert.equal(g1.survivor, S1);
    assert.equal(g1.action, `merge-into:${S1}`);
    assert.equal(g1.docOnlyOnStale, true);
    assert.equal(g1.purgeCertificates, false);
    assert.deepEqual(g1.rows.map((r) => r.keyKind).sort(), ['legacy-slug', 'sha256']);

    const g2 = entryFor(plan, S2);
    assert.equal(g2.status, 'NEEDS-CHOICE');
    assert.equal(g2.survivor, null);
    assert.equal(g2.action, 'skip');

    const g3 = entryFor(plan, S3);
    assert.equal(g3.status, 'BLOCKED');
    assert.deepEqual(g3.blockedBy, ['REGREVIEW#rev-1']);

    const k = plan.entries.find((e) => e.kind === 'same-key-multi-club')!;
    assert.equal(k.status, 'OUT-OF-BAND');
    assert.deepEqual(k.naturalKeys, [S4]);

    const json = path.join(outDir, 'decisions.json');
    assert.equal(statSync(json).mode & 0o777, 0o600);
    const md = readFileSync(path.join(outDir, 'decisions-review.md'), 'utf8');
    for (const secret of [S1, SLUG1, 'Sipho', 'Dlamini', '2001-02-03', '0102035000081'])
      assert.ok(!md.includes(secret), `review must not contain ${secret.slice(0, 12)}`);
    assert.ok(md.includes('S.D. (2001)'), 'initials + birth year');
    assert.ok(md.includes(`${S1.slice(0, 8)}…`), 'keys cut to 8 chars');
    // Legacy slug keys embed name/dob fragments: never printed, not even their first 8 chars.
    for (const slug of [SLUG1, SLUG2, SLUG3, SLUG5])
      assert.ok(!md.includes(slug.slice(0, 8)), `no slug fragment ${slug.slice(0, 8)}`);
  });

  test('confirm: backup, fill (veterans via VETAFFIL), carried doc kept, refusals listed', async () => {
    const file = structuredClone(plan);
    edited = file;
    entryFor(file, S2).action = `merge-into:${S2}`; // the sporting choice: A keeps Thabo
    entryFor(file, S3).action = `merge-into:${S3}`; // blocked — must be refused
    entryFor(file, S5).action = 'distinct';
    file.entries.find((e) => e.kind === 'same-key-multi-club')!.action = `merge-into:${S4}`;

    const lines: string[] = [];
    const report = await cli.applyDecisions(repo, T, file, outDir, (l) => lines.push(l));

    assert.deepEqual(report.merged.sort(), [entryFor(file, S1).id, entryFor(file, S2).id].sort());
    assert.deepEqual(report.distinct, [entryFor(file, S5).id]);
    assert.deepEqual(
      report.refused.map((r) => r.id).sort(),
      [
        entryFor(file, S3).id,
        file.entries.find((e) => e.kind === 'same-key-multi-club')!.id,
      ].sort(),
    );

    // Backup holds the pre-merge stale row.
    const backup = JSON.parse(readFileSync(report.backupPath!, 'utf8'));
    assert.ok(
      backup.groups.some((g: { rows: PlayerRegistration[] }) =>
        g.rows.some((r) => r.naturalKey === SLUG1 && r.lastClub === 'Old CC'),
      ),
    );

    // Survivor filled; its own values win; the stale-only ID doc carried AND still on disk.
    const s1 = (await repo.getPlayer(T, 'a', S1))!;
    assert.equal(s1.lastClub, 'Old CC');
    assert.equal(s1.battingHand, 'Left');
    assert.equal(s1.bowlerType, '');
    assert.equal(s1.idDocMeta?.objectKey, docKey('slug1'));
    assert.ok(existsSync(docFile('slug1')), 'keepDocs left the carried object in place');
    assert.equal(s1.veteransClubId, 'vets');
    const affiliates = await repo.listVeteransAffiliations(T, 'vets');
    assert.deepEqual(
      affiliates.map((a) => a.naturalKey),
      [S1],
      'VETAFFIL record exists for the survivor (and the stale one went with its row)',
    );

    // Stale rows gone; blocked group untouched; distinct pair recorded.
    assert.equal(await repo.getPlayer(T, 'a', SLUG1), null);
    assert.equal(await repo.getPlayer(T, 'b', SLUG2), null);
    assert.ok(await repo.getPlayer(T, 'a', SLUG3));
    assert.ok(await repo.getPlayer(T, 'b', S4));
    const pairs = await repo.listPlayerDistinctPairs(T);
    assert.ok(pairs.has([S5, SLUG5].sort().join('#')));

    const deleted = JSON.parse(readFileSync(path.join(outDir, 'deleted-nks.json'), 'utf8'));
    assert.deepEqual(
      deleted.map((d: { naturalKey: string }) => d.naturalKey).sort(),
      [SLUG1, SLUG2].sort(),
    );
    assert.equal(statSync(path.join(outDir, 'deleted-nks.json')).mode & 0o777, 0o600);
    for (const slug of [SLUG1, SLUG2, SLUG3])
      assert.ok(
        !lines.join('\n').includes(slug.slice(0, 8)),
        'log lines never show a slug fragment',
      );
  });

  test('confirm is idempotent: a re-run deletes nothing more', async () => {
    const file = structuredClone(edited);
    const report = await cli.applyDecisions(repo, T, file, outDir, () => {});
    // B13: the distinct pair is already marked, so it is not re-applied either.
    assert.deepEqual(
      report.alreadyDone.sort(),
      [entryFor(file, S1).id, entryFor(file, S2).id, entryFor(file, S5).id].sort(),
    );
    assert.equal(report.backupPath, null, 'nothing to apply → no new backup');
    assert.equal(report.deleted.length, 0);
    const deleted = JSON.parse(readFileSync(path.join(outDir, 'deleted-nks.json'), 'utf8'));
    assert.equal(deleted.length, 2);
  });

  /** Seed a fresh same-club pair (sha survivor + legacy slug) and plan just that group. */
  async function seedPair(tag: string, dob: string, survivorDoc?: string, staleDoc?: string) {
    const nk = sha(`sa-id-${tag}`);
    const slug = `${tag}-legacy-${dob}`;
    const who = { firstName: 'Pair', lastName: tag, dob };
    await repo.createPlayer(
      T,
      player({
        ...who,
        naturalKey: nk,
        ...(survivorDoc ? { idDocMeta: putDoc(survivorDoc) } : {}),
      }),
    );
    await repo.createPlayer(
      T,
      player({ ...who, naturalKey: slug, ...(staleDoc ? { idDocMeta: putDoc(staleDoc) } : {}) }),
    );
    const dir = mkdtempSync(path.join(tmpdir(), `resolve-dups-${tag}-`));
    const full = await cli.runPlan(repo, T, dir);
    const entry = full.entries.find((e) => e.naturalKeys.includes(nk))!;
    assert.equal(entry.action, `merge-into:${nk}`);
    return { nk, slug, dir, file: { ...full, entries: [entry] } };
  }

  test('a re-run after a partial failure keeps the doc the survivor already carries', async () => {
    const { nk, slug, dir, file } = await seedPair('partial', '1990-01-01', undefined, 'partial');
    // Run 1: the fill carries the doc, then the stale delete fails (simulated).
    const failing = {
      ...repo,
      deletePlayer: async () => {
        throw Object.assign(new Error('lost race'), { name: 'ConditionalCheckFailedException' });
      },
    } as typeof repo;
    const lines: string[] = [];
    const r1 = await cli.applyDecisions(failing, T, structuredClone(file), dir, (l) =>
      lines.push(l),
    );
    assert.deepEqual(r1.merged, []);
    assert.equal(r1.refused.length, 1);
    assert.ok(lines.some((l) => l.includes('PARTIALLY applied')));
    assert.ok(!lines.some((l) => l.includes('✓')), 'no success line on a partial run');
    assert.equal((await repo.getPlayer(T, 'a', nk))?.idDocMeta?.objectKey, docKey('partial'));
    assert.ok(await repo.getPlayer(T, 'a', slug), 'stale row still present');

    // Run 2: the survivor already references the stale row's object — it must survive.
    const r2 = await cli.applyDecisions(repo, T, structuredClone(file), dir, () => {});
    assert.deepEqual(r2.merged, [file.entries[0].id]);
    assert.equal(await repo.getPlayer(T, 'a', slug), null);
    assert.ok(existsSync(docFile('partial')), 'the survivor-referenced object survived');
  });

  test('survivor and stale sharing one objectKey on a first run: the object survives', async () => {
    const shared = putDoc('shared');
    const { nk, slug, dir, file } = await seedPair('shared', '1991-01-01');
    await repo.updatePlayer(T, 'a', nk, { idDocMeta: shared });
    await repo.updatePlayer(T, 'a', slug, { idDocMeta: shared });
    const r = await cli.applyDecisions(repo, T, structuredClone(file), dir, () => {});
    assert.deepEqual(r.merged, [file.entries[0].id]);
    assert.equal(await repo.getPlayer(T, 'a', slug), null);
    assert.ok(existsSync(docFile('shared')));
  });

  test('a foreign key spliced into a group is refused; nothing is deleted', async () => {
    const { nk, slug, dir, file } = await seedPair('splice', '1992-01-01');
    const edited = structuredClone(file);
    const e = edited.entries[0];
    // An unrelated live person (Lwazi, S4 at A) pasted into the group.
    e.naturalKeys.push(S4);
    e.rows.push({ ...e.rows[0], naturalKey: S4, clubId: 'a' });
    const r = await cli.applyDecisions(repo, T, edited, dir, () => {});
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0].why, /name \+ date of birth/);
    assert.equal(r.deleted.length, 0);
    assert.ok(await repo.getPlayer(T, 'a', S4));
    assert.ok(await repo.getPlayer(T, 'a', slug));
    assert.ok(await repo.getPlayer(T, 'a', nk));
  });

  test('deletePlayer without keepDocs still purges the ID document (default unchanged)', async () => {
    const meta = putDoc('plain');
    await repo.createPlayer(
      T,
      player({ naturalKey: 'plain-row', firstName: 'Plain', idDocMeta: meta }),
    );
    await repo.deletePlayer(T, (await repo.getPlayer(T, 'a', 'plain-row'))!);
    assert.ok(!existsSync(docFile('plain')));
  });
});

describe('resolve-duplicate-players — safety fixes (E2E-FINDINGS B1–B5, B8–B11)', () => {
  type File = import('../src/resolve-duplicate-players.js').DecisionsFile;
  type Row = Partial<PlayerRegistration> & { naturalKey: string };

  /** Seed one name + dob group (rows given) and plan; returns that group's entry as a file. */
  async function seedGroup(tag: string, dob: string, rows: Row[]) {
    const who = { firstName: 'Group', lastName: tag, dob };
    for (const r of rows) await repo.createPlayer(T, player({ ...who, ...r }));
    const dir = mkdtempSync(path.join(tmpdir(), `resolve-dups-${tag}-`));
    const full = await cli.runPlan(repo, T, dir);
    const entry = full.entries.find(
      (e) => e.kind === 'name-dob-group' && e.naturalKeys.includes(rows[0].naturalKey),
    )!;
    const file: File = { ...full, entries: [entry] };
    return { dir, entry, file, who };
  }
  const withAction = (file: File, action: string): File => ({
    ...file,
    entries: [{ ...file.entries[0], action }],
  });
  const alive = async (clubId: string, nk: string) => !!(await repo.getPlayer(T, clubId, nk));

  test('B1: a partly-distinct group is NEEDS-CHOICE and a merge across the pair is refused', async () => {
    const nk = sha('sa-id-b1');
    const [s1, s2] = ['b1-slug-one-1980-01-01', 'b1-slug-two-1980-01-01'];
    await repo.putPlayerDistinct(T, nk, s1);
    const { dir, entry, file } = await seedGroup('Bone', '1980-01-01', [
      { naturalKey: nk },
      { naturalKey: s1, idNumber: undefined },
      { naturalKey: s2, idNumber: undefined },
    ]);
    assert.equal(entry.status, 'NEEDS-CHOICE');
    assert.equal(entry.action, 'skip');
    assert.deepEqual(entry.distinctPairs, [[nk, s1].sort()]);
    const r = await cli.applyDecisions(
      repo,
      T,
      withAction(file, `merge-into:${nk}`),
      dir,
      () => {},
    );
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0].why, /PLAYERDISTINCT/);
    assert.ok(await alive('a', s1), 'the confirmed-distinct row is never deleted');
    assert.ok(await alive('a', s2));
    assert.equal(r.backupPath, null, 'refused before any write');
  });

  test('B1: a marker added AFTER the plan still refuses the merge (live check)', async () => {
    const nk = sha('sa-id-b1late');
    const slug = 'b1late-slug-1980-02-02';
    const { dir, entry, file } = await seedGroup('Blate', '1980-02-02', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    assert.equal(entry.status, 'PROPOSED');
    await repo.putPlayerDistinct(T, nk, slug);
    const r = await cli.applyDecisions(repo, T, file, dir, () => {});
    assert.match(r.refused[0]?.why ?? '', /PLAYERDISTINCT/);
    assert.ok(await alive('a', slug));
  });

  test('B2: each key is recorded (fsynced) BEFORE its row is deleted', async () => {
    const nk = sha('sa-id-b2wal');
    const slug = 'b2wal-slug-1981-01-01';
    const { dir, file } = await seedGroup('Bwal', '1981-01-01', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    const seenAtDelete: string[][] = [];
    const spy = {
      ...repo,
      deletePlayer: async (...a: Parameters<typeof repo.deletePlayer>) => {
        seenAtDelete.push(
          JSON.parse(readFileSync(path.join(dir, 'deleted-nks.json'), 'utf8')).map(
            (d: { naturalKey: string }) => d.naturalKey,
          ),
        );
        return repo.deletePlayer(...a);
      },
    } as typeof repo;
    const r = await cli.applyDecisions(spy, T, file, dir, () => {});
    assert.equal(r.merged.length, 1);
    assert.deepEqual(seenAtDelete, [[slug]], 'the record was on disk when the delete ran');
  });

  test('B2: an unwritable deleted-nks.json refuses the run before any write', async () => {
    const nk = sha('sa-id-b2ro');
    const slug = 'b2ro-slug-1981-02-02';
    const { dir, file } = await seedGroup('Bro', '1981-02-02', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    const del = path.join(dir, 'deleted-nks.json');
    writeFileSync(del, '[]', { mode: 0o400 });
    await assert.rejects(
      cli.applyDecisions(repo, T, file, dir, () => {}),
      (e: Error) => e.name === 'ValidationError' && /cannot write/.test(e.message),
    );
    assert.ok(await alive('a', slug), 'nothing deleted');
    assert.ok(!readdirSync(dir).some((n) => n.startsWith('backup-')), 'no backup written');
  });

  test('B2: an "already merged" re-run backfills a missing record', async () => {
    const nk = sha('sa-id-b2bf');
    const slug = 'b2bf-slug-1981-03-03';
    const { dir, file } = await seedGroup('Bbf', '1981-03-03', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    await cli.applyDecisions(repo, T, file, dir, () => {});
    const del = path.join(dir, 'deleted-nks.json');
    writeFileSync(del, '[]'); // the record lost (crash between delete and record, pre-fix)
    const r = await cli.applyDecisions(repo, T, file, dir, () => {});
    assert.deepEqual(r.backfilled, [slug]);
    assert.deepEqual(
      JSON.parse(readFileSync(del, 'utf8')).map((d: { naturalKey: string }) => d.naturalKey),
      [slug],
    );
  });

  test('B3: merge-into a legacy slug while the group holds a sha key is refused', async () => {
    const nk = sha('sa-id-b3');
    const slug = 'b3-slug-1982-01-01';
    const { dir, file } = await seedGroup('Bthree', '1982-01-01', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    const r = await cli.applyDecisions(
      repo,
      T,
      withAction(file, `merge-into:${slug}`),
      dir,
      () => {},
    );
    assert.match(r.refused[0]?.why ?? '', /legacy slug key/);
    assert.ok(await alive('a', nk), 'the sha row survives');
    assert.ok(await alive('a', slug));
  });

  test('B4/B16: one malformed entry aborts the whole run before any write', async () => {
    const nk = sha('sa-id-b4');
    const slug = 'b4-slug-1983-01-01';
    const { dir, file } = await seedGroup('Bfour', '1983-01-01', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    const bad: File = {
      ...file,
      entries: [file.entries[0], { ...file.entries[0], id: 'G-typo', action: 'merge' }],
    };
    await assert.rejects(
      cli.applyDecisions(repo, T, bad, dir, () => {}),
      (e: Error) => e.name === 'ValidationError' && /unknown action "merge"/.test(e.message),
    );
    assert.ok(await alive('a', slug), 'the valid merge did not run either');
    for (const shape of [
      [],
      { tenant: T },
      { tenant: T, entries: [{ ...file.entries[0], purgeCertificates: 'yes' }] },
    ])
      await assert.rejects(
        cli.applyDecisions(repo, T, shape, dir, () => {}),
        (e: Error) => e.name === 'ValidationError',
      );
  });

  test('U4: merge-into accepts the 8-char ref the review md prints', async () => {
    const nk = sha('sa-id-u4');
    const slug = 'u4-slug-1983-02-02';
    const { dir, file } = await seedGroup('Ufour', '1983-02-02', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    const r = await cli.applyDecisions(
      repo,
      T,
      withAction(file, `merge-into:${nk.slice(0, 8)}…`),
      dir,
      () => {},
    );
    assert.equal(r.merged.length, 1);
    assert.ok(!(await alive('a', slug)));
  });

  test('B5: a new identity after the plan refuses the group', async () => {
    const nk = sha('sa-id-b5a');
    const slug = 'b5a-slug-1984-01-01';
    const { dir, file, who } = await seedGroup('Bfivea', '1984-01-01', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    await repo.createPlayer(
      T,
      player({ ...who, naturalKey: 'b5a-third-1984-01-01', idNumber: undefined }),
    );
    const r = await cli.applyDecisions(repo, T, file, dir, () => {});
    assert.match(r.refused[0]?.why ?? '', /appeared since the plan/);
    assert.ok(await alive('a', slug));
  });

  test('B5: a stale key registered at another club after the plan refuses the group', async () => {
    const nk = sha('sa-id-b5b');
    const slug = 'b5b-slug-1984-02-02';
    const { dir, file, who } = await seedGroup('Bfiveb', '1984-02-02', [
      { naturalKey: nk },
      { naturalKey: slug, idNumber: undefined },
    ]);
    await repo.createPlayer(
      T,
      player({ ...who, naturalKey: slug, clubId: 'b', idNumber: undefined }),
    );
    const r = await cli.applyDecisions(repo, T, file, dir, () => {});
    assert.match(r.refused[0]?.why ?? '', /rows appeared since the plan/);
    assert.ok(await alive('a', slug));
    assert.ok(!existsSync(path.join(dir, 'deleted-nks.json')), 'a live key is never recorded');
  });

  test('B9: a survivor placeholder elsewhere blocks neither the plan nor the merge', async () => {
    const nk = sha('sa-id-b9');
    const slug = 'b9-slug-1985-01-01';
    const { dir, entry, file } = await seedGroup('Bnine', '1985-01-01', [
      { naturalKey: nk },
      { naturalKey: nk, clubId: 'b', placeholder: true },
      { naturalKey: slug, idNumber: undefined },
    ]);
    assert.equal(entry.status, 'PROPOSED');
    assert.equal(entry.survivor, nk);
    const r = await cli.applyDecisions(repo, T, file, dir, () => {});
    assert.equal(r.merged.length, 1, JSON.stringify(r.refused));
    assert.ok(!(await alive('a', slug)));
    assert.ok(await alive('b', nk), 'the placeholder is left untouched');
  });

  test('B8: a conflicting stale value is reported, not silently dropped', async () => {
    const nk = sha('sa-id-b8');
    const slug = 'b8-slug-1985-02-02';
    const { dir, file } = await seedGroup('Beight', '1985-02-02', [
      { naturalKey: nk, battingHand: 'Right' },
      { naturalKey: slug, idNumber: undefined, battingHand: 'Left' },
    ]);
    const r = await cli.applyDecisions(repo, T, file, dir, () => {});
    assert.deepEqual(
      r.conflicts.map((c) => [c.field, c.kept]),
      [['battingHand', '"Right"']],
    );
  });

  test('B10/B11: unknown tenant refused; a re-plan never overwrites decisions.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'resolve-dups-b11-'));
    await assert.rejects(cli.runPlan(repo, 'dolphinz', dir), /unknown tenant/);
    await cli.runPlan(repo, T, dir);
    const json = path.join(dir, 'decisions.json');
    writeFileSync(json, '{"edited":true}');
    await assert.rejects(cli.runPlan(repo, T, dir), /already exists/);
    assert.equal(readFileSync(json, 'utf8'), '{"edited":true}');
    await cli.runPlan(repo, T, dir, undefined, { force: true });
    assert.notEqual(readFileSync(json, 'utf8'), '{"edited":true}');
  });
});

describe('tombstone-deleted-players', () => {
  const entries = () => [
    { tenant: T, naturalKey: SLUG1, clubIds: ['a'] },
    { tenant: T, naturalKey: SLUG2, clubIds: ['b'] },
    { tenant: T, naturalKey: S3, clubIds: ['a'] }, // still live — refused
    { tenant: 'other', naturalKey: 'x', clubIds: ['a'] },
  ];

  test('args', () => {
    assert.deepEqual(tomb.parseArgs(['--tenant', 't', '--deleted', 'f']), {
      tenant: 't',
      deleted: 'f',
      confirm: false,
    });
    assert.throws(() => tomb.parseArgs(['--tenant', 't']), /--deleted is required/);
  });

  test('refuses --confirm while the player sync is off; the dry run still works', async () => {
    await assert.rejects(
      tomb.tombstoneDeleted(repo, T, entries(), { confirm: true, log: () => {} }),
      (err: Error) => err.name === 'SyncOffError' && /playerSync/.test(err.message),
    );
    const dry = await tomb.tombstoneDeleted(repo, T, entries(), { confirm: false, log: () => {} });
    assert.equal(dry.syncOn, false);
    assert.deepEqual(dry.refusedLive, [S3]);
  });

  test('B7: a malformed file is refused whole, before any read or write', async () => {
    const before = await countItems();
    for (const junk of [
      [{ tenant: T }],
      [{ tenant: T, naturalKey: '', clubIds: [] }],
      [1, 2],
      { tenant: T },
      [{ tenant: T, naturalKey: 'k', clubIds: 'a' }],
    ])
      await assert.rejects(
        tomb.tombstoneDeleted(repo, T, junk, { confirm: true, log: () => {} }),
        (err: Error) => err.name === 'ValidationError',
      );
    assert.equal(await countItems(), before, 'no tombstone written');
    await assert.rejects(
      tomb.tombstoneDeleted(repo, 'dolphinz', [], { confirm: false, log: () => {} }),
      /unknown tenant/,
    );
  });

  test('deleted-nks dedupe: an unstamped duplicate wins (a re-delete must be erased again)', () => {
    const merged = cli.validateDeletedEntries(
      [
        { tenant: T, naturalKey: 'k1', clubIds: ['a'], tombstonedAt: '2026-10-01T00:00:00.000Z' },
        { tenant: T, naturalKey: 'k1', clubIds: ['b'] },
        { tenant: T, naturalKey: 'k2', clubIds: ['a'] },
        { tenant: T, naturalKey: 'k2', clubIds: ['a'], tombstonedAt: '2026-10-02T00:00:00.000Z' },
        { tenant: T, naturalKey: 'k3', clubIds: ['a'], tombstonedAt: '2026-10-01T00:00:00.000Z' },
        { tenant: T, naturalKey: 'k3', clubIds: ['a'], tombstonedAt: '2026-10-05T00:00:00.000Z' },
      ],
      'hand-merged.json',
    );
    assert.deepEqual(merged, [
      { tenant: T, naturalKey: 'k1', clubIds: ['a', 'b'] },
      { tenant: T, naturalKey: 'k2', clubIds: ['a'] },
      { tenant: T, naturalKey: 'k3', clubIds: ['a'], tombstonedAt: '2026-10-05T00:00:00.000Z' },
    ]);
  });

  test('B6: output masks legacy slugs the same way resolve does', async () => {
    const lines: string[] = [];
    await tomb.tombstoneDeleted(repo, T, entries(), { confirm: false, log: (l) => lines.push(l) });
    const out = lines.join('\n');
    for (const slug of [SLUG1, SLUG2]) {
      assert.ok(!out.includes(slug.slice(0, 8)), 'no slug fragment');
      assert.ok(out.includes(cli.maskKey(slug)), 'the same ref as the resolve CLI');
    }
  });

  test('dry run writes nothing; confirm queues erase tombstones; live keys refused', async () => {
    const cfg = (await repo.getTenantConfig(T)) as TenantConfig;
    await repo.putTenantConfig({
      ...cfg,
      features: { ...(cfg.features ?? {}), medicoachSync: true },
      integrations: {
        ...(cfg.integrations ?? {}),
        medicoach: { ...(cfg.integrations?.medicoach ?? {}), playerSync: true },
      },
    } as TenantConfig);

    const before = await countItems();
    const dry = await tomb.tombstoneDeleted(repo, T, entries(), { confirm: false, log: () => {} });
    assert.equal(await countItems(), before, 'dry run made no write');
    assert.deepEqual(dry.wouldQueue, [SLUG1, SLUG2].sort());
    assert.deepEqual(dry.refusedLive, [S3]);
    assert.equal(dry.otherTenant, 1);

    const lines: string[] = [];
    const done = await tomb.tombstoneDeleted(repo, T, entries(), {
      confirm: true,
      log: (l) => lines.push(l),
      at: '2026-10-08T10:00:00.000Z',
    });
    assert.deepEqual(done.queued, [SLUG1, SLUG2].sort());
    for (const nk of [SLUG1, SLUG2])
      assert.equal((await repo.getPendingPlayerSync(T, nk))?.op, 'erase');
    assert.equal(await repo.getPendingPlayerSync(T, S3), null);
    assert.ok(!lines.join('\n').includes(SLUG1), 'masked output');

    const again = await tomb.tombstoneDeleted(repo, T, entries(), { confirm: true, log: () => {} });
    assert.deepEqual(again.alreadyQueued, [SLUG1, SLUG2].sort());
    assert.equal(again.queued.length, 0);
  });
});
