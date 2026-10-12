/**
 * Seed one scenario table for the dedup CLI battery. Run as a CHILD with childEnv() so repo.ts
 * binds to this scenario's TABLE_NAME:
 *   tsx test/dedup-e2e/seed.ts <scenario> <manifest.json>
 * Scenarios: main (realistic dolphins-like tenant), many:<n> (n PROPOSED pairs, kill test),
 * empty (tenant config + clubs, no players). Writes a manifest of the seeded keys.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Club, PlayerClearance, PlayerRegistration } from '../../src/types.js';

const [scenario = 'main', manifestPath] = process.argv.slice(2);
const T = 'dolphins';
const TABLE = process.env.TABLE_NAME!;
const UPLOADS = process.env.LOCAL_UPLOADS_DIR!;

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

const seed = await import('../../src/seed-core.js');
await seed.seedTenantConfig(T);
const repo = await import('../../src/repo.js');

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const said = (id: string) => sha(`sa-id-${id}`);
const passport = (nat: string, id: string) => sha(`passport-${nat}-${id}`.toLowerCase());

const CLUBS: Array<[string, string]> = [
  ['durban-hc', 'Durban HC'],
  ['northwood', 'Northwood CC'],
  ['crusaders', 'Crusaders CC'],
  ['glenwood', 'Glenwood Old Boys'],
  ['westville', 'Westville CC'],
  ['umhlali', 'Umhlali CC'],
  ['vets-kzn', 'KZN Veterans'],
  ['vets-coast', 'Coast Veterans'],
];
const club = (id: string, name: string): Club =>
  ({
    id,
    name,
    district: 'Durban',
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
for (const [id, name] of CLUBS) await repo.createClub(T, club(id, name));
const clubName = new Map(CLUBS);

const player = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    isMinor: false,
    consentAt: '2026-03-01T00:00:00.000Z',
    createdAt: '2026-03-01T00:00:00.000Z',
    status: 'active',
    idType: 'sa-id',
    ...p,
  }) as PlayerRegistration;

/** A real object under LOCAL_UPLOADS_DIR, addressed by a `local/` key (the fake S3). */
const putDoc = (clubId: string, name: string) => {
  const rel = path.join(T, clubId, 'players', `${name}-id.pdf`);
  mkdirSync(path.dirname(path.join(UPLOADS, rel)), { recursive: true });
  writeFileSync(path.join(UPLOADS, rel), `%PDF-${name}`);
  return {
    objectKey: `local/${rel}`,
    size: 9,
    uploadedAt: '2026-03-01T00:00:00.000Z',
    file: path.join(UPLOADS, rel),
  };
};
const meta = (d: ReturnType<typeof putDoc>) => ({
  objectKey: d.objectKey,
  size: d.size,
  uploadedAt: d.uploadedAt,
});

const manifest: Record<string, unknown> = { tenant: T, table: TABLE, uploads: UPLOADS };

if (scenario === 'main') {
  // A — same-club sha + legacy slug; ONLY the stale row has an ID doc, history, cricket
  // profile and a veterans affiliation.
  const A = { firstName: 'Sipho', lastName: 'Dlamini', dob: '2001-02-03' };
  const SHA_A = said('0102035000081');
  const SLUG_A = 'sa-id-sipho-dlamini-2001-02-03';
  const docA = putDoc('durban-hc', 'slug-a');
  await repo.createPlayer(
    T,
    player({ ...A, naturalKey: SHA_A, clubId: 'durban-hc', idNumber: '0102035000081', team: 'A' }),
  );
  await repo.createPlayer(
    T,
    player({
      ...A,
      naturalKey: SLUG_A,
      clubId: 'durban-hc',
      idNumber: '0102035000081',
      lastClub: 'Old Collegians',
      battingHand: 'Left',
      bowlerType: '',
      position: 'Wicket-keeper',
      idDocMeta: meta(docA),
      createdAt: '2024-02-01T00:00:00.000Z',
    }),
  );
  // The stale row's veterans affiliation through the real path (writes VETAFFIL#).
  await repo.setPlayerVeteransClub(T, 'durban-hc', SLUG_A, { id: 'vets-kzn', name: 'KZN Veterans' }, 'admin');
  // B — cross-club pair (sha at Northwood, slug at Crusaders).
  const B = { firstName: 'Thabo', lastName: 'Nkosi', dob: '1999-05-06' };
  const SHA_B = said('9905065000082');
  const SLUG_B = 'thabo-nkosi-1999-05-06';
  await repo.createPlayer(
    T,
    player({ ...B, naturalKey: SHA_B, clubId: 'northwood', idNumber: '9905065000082' }),
  );
  await repo.createPlayer(
    T,
    player({ ...B, naturalKey: SLUG_B, clubId: 'crusaders', lastClub: 'Varsity', isWk: true }),
  );
  // C — three identities at one club: sha survivor WITH its own doc, two slugs, one with a doc.
  const C = { firstName: 'Ayanda', lastName: 'Zulu', dob: '2000-01-01' };
  const SHA_C = said('0001015000083');
  const SLUG_C1 = 'ayanda-zulu-2000-01-01';
  const SLUG_C2 = 'sa-id-ayanda-zulu-2000-01-01';
  const docC = putDoc('glenwood', 'sha-c');
  const docC1 = putDoc('glenwood', 'slug-c1');
  await repo.createPlayer(
    T,
    player({
      ...C,
      naturalKey: SHA_C,
      clubId: 'glenwood',
      idNumber: '0001015000083',
      idDocMeta: meta(docC),
      battingHand: 'Right',
    }),
  );
  await repo.createPlayer(
    T,
    player({
      ...C,
      naturalKey: SLUG_C1,
      clubId: 'glenwood',
      idDocMeta: meta(docC1),
      battingHand: 'Left',
    }),
  );
  await repo.createPlayer(
    T,
    player({
      ...C,
      firstName: 'AYANDA ',
      naturalKey: SLUG_C2,
      clubId: 'glenwood',
      bowlingHand: 'Left',
      bowlerType: 'Spin',
    }),
  );
  // D — passport-keyed pair (one person, nationality typed two ways) — two sha keys.
  const D = { firstName: 'Tendai', lastName: 'Moyo', dob: '1995-07-07' };
  const SHA_D1 = passport('ZW', 'FN123456');
  const SHA_D2 = passport('ZIMBABWE', 'FN123456');
  await repo.createPlayer(
    T,
    player({
      ...D,
      naturalKey: SHA_D1,
      clubId: 'westville',
      idType: 'passport',
      nationality: 'ZW',
      idNumber: 'FN123456',
    }),
  );
  await repo.createPlayer(
    T,
    player({
      ...D,
      naturalKey: SHA_D2,
      clubId: 'westville',
      idType: 'passport',
      nationality: 'Zimbabwe',
      idNumber: 'FN123456',
    }),
  );
  // E — twins sharing name + dob (two real people, two sha keys at one club).
  const E = { firstName: 'Bongani', lastName: 'Khumalo', dob: '1997-03-03' };
  const SHA_E1 = said('9703035000085');
  const SHA_E2 = said('9703035000186');
  await repo.createPlayer(
    T,
    player({ ...E, naturalKey: SHA_E1, clubId: 'umhlali', idNumber: '9703035000085' }),
  );
  await repo.createPlayer(
    T,
    player({ ...E, naturalKey: SHA_E2, clubId: 'umhlali', idNumber: '9703035000186' }),
  );
  // F — clearance-pending entanglement: the sha row is mid-transfer to Umhlali.
  const F = { firstName: 'Lwazi', lastName: 'Mthembu', dob: '1998-02-02' };
  const SHA_F = said('9802025000087');
  const SLUG_F = 'lwazi-mthembu-1998-02-02';
  await repo.createPlayer(
    T,
    player({ ...F, naturalKey: SHA_F, clubId: 'westville', idNumber: '9802025000087' }),
  );
  await repo.createPlayer(T, player({ ...F, naturalKey: SLUG_F, clubId: 'westville' }));
  const clr: PlayerClearance = {
    id: 'clr-f',
    playerNaturalKey: SHA_F,
    playerName: 'Lwazi Mthembu',
    fromClubId: 'westville',
    toClubId: 'umhlali',
    fromClubName: 'Westville CC',
    toClubName: 'Umhlali CC',
    requestedAt: '2026-09-01T00:00:00.000Z',
    feesCleared: false,
    misconductCleared: false,
    status: 'pending',
    version: 0,
  } as PlayerClearance;
  await repo.createClearance(T, clr);
  // G — pre-marked PLAYERDISTINCT pair → SETTLED.
  const G = { firstName: 'Nomsa', lastName: 'Cele', dob: '1996-04-04' };
  const SHA_G = said('9604045000088');
  const SLUG_G = 'nomsa-cele-1996-04-04';
  await repo.createPlayer(
    T,
    player({ ...G, naturalKey: SHA_G, clubId: 'durban-hc', idNumber: '9604045000088' }),
  );
  await repo.createPlayer(T, player({ ...G, naturalKey: SLUG_G, clubId: 'durban-hc' }));
  await repo.putPlayerDistinct(T, SHA_G, SLUG_G);
  // H — 3-identity group where ONE pair is already confirmed distinct (sha vs slug H1).
  const H = { firstName: 'Kagiso', lastName: 'Mokoena', dob: '1994-09-09' };
  const SHA_H = said('9409095000089');
  const SLUG_H1 = 'kagiso-mokoena-1994-09-09';
  const SLUG_H2 = 'sa-id-kagiso-mokoena-1994-09-09';
  for (const nk of [SHA_H, SLUG_H1, SLUG_H2])
    await repo.createPlayer(
      T,
      player({
        ...H,
        naturalKey: nk,
        clubId: 'northwood',
        ...(nk === SHA_H ? { idNumber: '9409095000089' } : {}),
      }),
    );
  await repo.putPlayerDistinct(T, SHA_H, SLUG_H1);
  // K — one sha key ACTIVE at two clubs → OUT-OF-BAND.
  const K = { firstName: 'Musa', lastName: 'Ngcobo', dob: '1993-01-01' };
  const SHA_K = said('9301015000090');
  for (const c of ['glenwood', 'westville'])
    await repo.createPlayer(
      T,
      player({ ...K, naturalKey: SHA_K, clubId: c, idNumber: '9301015000090' }),
    );
  // K2 — same key active at one club + a lingering placeholder at another → INFO.
  const K2 = { firstName: 'Zanele', lastName: 'Mkhize', dob: '1992-02-02' };
  const SHA_K2 = said('9202025000091');
  await repo.createPlayer(
    T,
    player({ ...K2, naturalKey: SHA_K2, clubId: 'crusaders', idNumber: '9202025000091' }),
  );
  await repo.createPlayer(
    T,
    player({
      ...K2,
      naturalKey: SHA_K2,
      clubId: 'umhlali',
      idNumber: '9202025000091',
      placeholder: true,
    }),
  );
  // I — survivor key also has a lingering placeholder row at another club, plus a slug row.
  const I = { firstName: 'Sibusiso', lastName: 'Shange', dob: '1991-03-03' };
  const SHA_I = said('9103035000092');
  const SLUG_I = 'sibusiso-shange-1991-03-03';
  await repo.createPlayer(
    T,
    player({ ...I, naturalKey: SHA_I, clubId: 'durban-hc', idNumber: '9103035000092' }),
  );
  await repo.createPlayer(
    T,
    player({
      ...I,
      naturalKey: SHA_I,
      clubId: 'northwood',
      idNumber: '9103035000092',
      placeholder: true,
    }),
  );
  await repo.createPlayer(T, player({ ...I, naturalKey: SLUG_I, clubId: 'durban-hc' }));
  // V — survivor already has a DIFFERENT veterans club than the stale row.
  const V = { firstName: 'Peter', lastName: 'Smith', dob: '1970-01-01' };
  const SHA_V = said('7001015000093');
  const SLUG_V = 'peter-smith-1970-01-01';
  await repo.createPlayer(
    T,
    player({
      ...V,
      naturalKey: SHA_V,
      clubId: 'crusaders',
      idNumber: '7001015000093',
    }),
  );
  await repo.createPlayer(T, player({ ...V, naturalKey: SLUG_V, clubId: 'crusaders' }));
  await repo.setPlayerVeteransClub(T, 'crusaders', SHA_V, { id: 'vets-coast', name: 'Coast Veterans' }, 'admin');
  await repo.setPlayerVeteransClub(T, 'crusaders', SLUG_V, { id: 'vets-kzn', name: 'KZN Veterans' }, 'admin');
  // A singleton bystander that must never be touched.
  const SHA_Z = said('8801015000094');
  await repo.createPlayer(
    T,
    player({
      firstName: 'Lonely',
      lastName: 'Person',
      dob: '1988-01-01',
      naturalKey: SHA_Z,
      clubId: 'umhlali',
      idNumber: '8801015000094',
    }),
  );
  Object.assign(manifest, {
    SHA_A,
    SLUG_A,
    docA: docA.file,
    docAKey: docA.objectKey,
    SHA_B,
    SLUG_B,
    SHA_C,
    SLUG_C1,
    SLUG_C2,
    docC: docC.file,
    docC1: docC1.file,
    SHA_D1,
    SHA_D2,
    SHA_E1,
    SHA_E2,
    SHA_F,
    SLUG_F,
    SHA_G,
    SLUG_G,
    SHA_H,
    SLUG_H1,
    SLUG_H2,
    SHA_K,
    SHA_K2,
    SHA_I,
    SLUG_I,
    SHA_V,
    SLUG_V,
    SHA_Z,
  });
} else if (scenario.startsWith('many:')) {
  const n = Number(scenario.slice(5));
  const pairs: Array<{ sha: string; slug: string; clubId: string; doc: string }> = [];
  for (let i = 0; i < n; i++) {
    const clubId = CLUBS[i % 6][0];
    const id = `85${String(i).padStart(4, '0')}5000${String(i % 100).padStart(3, '0')}`.slice(0, 13);
    const who = { firstName: `Bulk${i}`, lastName: 'Player', dob: '1985-01-01' };
    const s = said(id);
    const slug = `bulk${i}-player-1985-01-01`;
    const d = putDoc(clubId, `bulk${i}`);
    await repo.createPlayer(T, player({ ...who, naturalKey: s, clubId, idNumber: id }));
    await repo.createPlayer(
      T,
      player({ ...who, naturalKey: slug, clubId, idDocMeta: meta(d), lastClub: `Prev${i}` }),
    );
    pairs.push({ sha: s, slug, clubId, doc: d.file });
  }
  manifest.pairs = pairs;
} else if (scenario !== 'empty') {
  throw new Error(`unknown scenario ${scenario}`);
}

manifest.clubNames = Object.fromEntries(clubName);
if (manifestPath) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`seeded ${scenario} into ${TABLE}`);
