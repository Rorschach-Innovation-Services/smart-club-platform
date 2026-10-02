/**
 * In-process dynalite + the single table, created exactly as the other *.int.test.ts files
 * (and src/local/server.ts) create it: pk/sk primary + gsi1. Shared by the medicoach-sync
 * tests; the older suites inline the same setup.
 *
 * Callers must set TABLE_NAME / DYNAMO_ENDPOINT etc. BEFORE importing repo/app (repo reads
 * TABLE_NAME at module load) — `dynaliteEnv` does that for a given port + table.
 */
import type { Server } from 'node:http';

export function dynaliteEnv(port: number, table: string): void {
  process.env.TABLE_NAME = table;
  process.env.DYNAMO_ENDPOINT = `http://localhost:${port}`;
  process.env.LOCAL_AUTH = '1';
  process.env.STAGE = 'local';
  process.env.USER_POOL_ID = 'test-pool';
  process.env.AWS_REGION ??= 'localhost';
  process.env.UPLOADS_BUCKET = 'test-uploads';
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_MAX_ATTEMPTS = '1';
}

export async function startDynalite(port: number, table: string): Promise<Server> {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  const server = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const admin = new DynamoDBClient({
    endpoint: `http://localhost:${port}`,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  await admin.send(
    new CreateTableCommand({
      TableName: table,
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
  return server;
}

export const stopDynalite = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));
