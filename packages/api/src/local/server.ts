/**
 * Fully-local dev backend — no AWS, no Docker, no Java.
 *
 *   npm --prefix packages/api run dev:local      (or: npx tsx src/local/server.ts)
 *
 * Boots dynalite (in-process, pure-JS DynamoDB clone), creates the single table,
 * seeds the tenants, and serves the SAME Hono app over HTTP. Auth is the dev
 * bypass (LOCAL_AUTH=1, x-dev-auth header) since Cognito OTP can't run offline.
 * S3 uploads are stubbed client-side in local mode.
 *
 * Env is set HERE before importing repo/app (repo reads it at module load).
 */
import { createServer } from 'node:http';

const TABLE = 'SmartClubLocal';
const DDB_PORT = 4567;
const API_PORT = 3333;

process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.AWS_REGION ??= 'localhost';

async function main(): Promise<void> {
  // 1. Start dynalite (in-memory DynamoDB).
  const dynalite = (await import('dynalite')).default as (
    opts?: unknown,
  ) => ReturnType<typeof createServer>;
  const ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));
  console.log(`· dynalite (local DynamoDB) on :${DDB_PORT}`);

  // 2. Create the single table (pk/sk + gsi1). Imports are dynamic so the env
  //    above is set before repo.ts initializes its client.
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
  console.log(`· created table ${TABLE}`);

  // 3. Provision tenants (blank). SEED_DEMO=1 also loads sample clubs/series.
  const demo = process.env.SEED_DEMO === '1';
  const { seedTenantConfig, seedDemoData, SEED_TENANTS } = await import('../seed-core.js');
  for (const t of SEED_TENANTS) {
    await seedTenantConfig(t);
    if (demo) {
      const { clubs, series, leagues } = await seedDemoData(t);
      console.log(
        `· provisioned ${t} + demo: ${clubs} clubs, ${series} series, ${leagues} leagues`,
      );
    } else {
      console.log(`· provisioned ${t} (blank)`);
    }
  }

  // 4. Serve the Hono app.
  const { serve } = await import('@hono/node-server');
  const { app } = await import('../index.js');
  serve({ fetch: app.fetch, port: API_PORT });
  console.log(`\n✓ Local API ready at http://localhost:${API_PORT}`);
  console.log(`  Point the SPA at it: VITE_API_URL=http://localhost:${API_PORT} VITE_LOCAL_AUTH=1`);
  console.log('  Auth is the dev bypass (x-dev-auth) — no Cognito. Ctrl-C to stop.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
