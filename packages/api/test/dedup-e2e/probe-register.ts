/**
 * In-process probe of the public /register route for a legacy-key ID (no ports besides the
 * battery dynalite): does the request complete, and what does it answer?
 *   with-env.sh <table> <uploads> npx tsx test/dedup-e2e/probe-register.ts [legacy|clean|chair]
 */
const mode = process.argv[2] ?? 'legacy';
const { DynamoDBClient, CreateTableCommand, PutItemCommand } =
  await import('@aws-sdk/client-dynamodb');
const admin = new DynamoDBClient({
  endpoint: process.env.DYNAMO_ENDPOINT,
  region: 'localhost',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const TABLE = process.env.TABLE_NAME!;
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
await seed.seedTenantConfig('dolphins');
await seed.seedDemoData('dolphins');
const S = (v: string) => ({ S: v });
await admin.send(
  new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: S('TENANT#dolphins#CLUB#verulam'),
      sk: S('PLAYER#pub-legacyzz-1985-03-04'),
      naturalKey: S('pub-legacyzz-1985-03-04'),
      clubId: S('verulam'),
      firstName: S('Pub'),
      lastName: S('Legacyzz'),
      dob: S('1985-03-04'),
      idType: S('sa-id'),
      idNumber: S('8503045800085'),
      status: S('active'),
      team: S('premier'),
      isMinor: { BOOL: false },
      consentAt: S('2024-02-01T00:00:00.000Z'),
      createdAt: S('2024-02-01T00:00:00.000Z'),
      version: { N: '0' },
    },
  }),
);
const { app } = await import('../../src/index.js');
const auth = Buffer.from(
  JSON.stringify({
    sub: 'dev-admin',
    email: 'admin@dolphins.local',
    memberships: [{ tenantId: 'dolphins', role: 'admin', clubIds: [] }],
  }),
).toString('base64');
const h = { 'content-type': 'application/json', 'x-tenant': 'dolphins', 'x-dev-auth': auth };
const link = await app.request('/clubs/berea/reg-link', { method: 'POST', headers: h });
const token = ((await link.json()) as { playerRegLink: { token: string } }).playerRegLink.token;
const body = {
  firstName: mode === 'clean' ? 'Clean' : 'Pub',
  lastName: mode === 'clean' ? 'Personzz' : 'Legacyzz',
  idType: 'sa-id',
  idNumber: mode === 'clean' ? '8604055800084' : '8503045800085',
  race: 'African',
  gender: 'Male',
  nationality: 'South African',
  cell: '0821234567',
  team: 'premier',
  district: 'Durban Central',
  lastClub: '—',
  idDocMeta: { objectKey: 'local/dolphins/x.png', size: 100, contentType: 'image/png' },
};
const t0 = Date.now();
const timer = setTimeout(() => {
  console.log(`HUNG after ${Date.now() - t0}ms`);
  process.exit(3);
}, 20_000);
const res =
  mode === 'chair'
    ? await app.request('/clubs/tongaat/players', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ ...body, lastClub: undefined }),
      })
    : await app.request(`/register/berea?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant': 'dolphins' },
        body: JSON.stringify(body),
      });
clearTimeout(timer);
console.log(mode, res.status, await res.text(), `${Date.now() - t0}ms`);
process.exit(0);

export {}; // a module, so top-level await typechecks
