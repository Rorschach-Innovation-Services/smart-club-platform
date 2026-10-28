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
import { mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLE = 'SmartClubLocal';
const DDB_PORT = 4567;
const API_PORT = 3333;
/**
 * The checkout this stack runs from (packages/api/src/local → repo root). Served at
 * `GET /__local/stack` so the Playwright global setup can refuse to reuse a stack another
 * worktree started on the same fixed ports.
 */
export const STACK_ROOT = realpathSync.native(
  fileURLToPath(new URL('../../../..', import.meta.url)),
);

process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.AWS_REGION ??= 'localhost';
process.env.LOCAL_UPLOADS_DIR ??= path.join(os.tmpdir(), 'smart-club-local-uploads');
mkdirSync(process.env.LOCAL_UPLOADS_DIR, { recursive: true });

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
  console.log(`· local uploads dir: ${process.env.LOCAL_UPLOADS_DIR}`);

  // 3. Provision tenants (blank). SEED_DEMO=1 also loads sample clubs/series.
  const demo = process.env.SEED_DEMO === '1';
  const { seedTenantConfig, seedDemoData, SEED_TENANTS } = await import('../seed-core.js');
  for (const t of SEED_TENANTS) {
    // Fresh dynalite each boot ⇒ create-if-absent always creates here.
    const { leagues } = await seedTenantConfig(t);
    if (demo) {
      const { clubs, series } = await seedDemoData(t);
      console.log(
        `· provisioned ${t} + demo: ${clubs} clubs, ${series} series (${leagues} leagues)`,
      );
    } else {
      console.log(`· provisioned ${t} (blank, ${leagues} leagues)`);
    }
  }

  // 4. Serve the Hono app.
  const { serve } = await import('@hono/node-server');
  const { app } = await import('../index.js');
  const { setReportNoticeWindowOverride } = await import('../captains-reports.js');
  serve({
    fetch: (req, ...rest) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/__local/stack')
        return Response.json({ root: STACK_ROOT, pid: process.pid });
      // e2e only: force the notice windows (captain's reports 18:00, squad links 08:00 SAST)
      // open/closed, or back to the real clock. Lives here (outside the Hono app), so the Lambda never has it.
      if (pathname === '/__e2e/report-notice-window' && req.method === 'POST')
        return setReportNoticeWindow(req, setReportNoticeWindowOverride);
      return app.fetch(req, ...rest);
    },
    port: API_PORT,
  });
  console.log(`\n✓ Local API ready at http://localhost:${API_PORT}`);
  console.log(`  Point the SPA at it: VITE_API_URL=http://localhost:${API_PORT} VITE_LOCAL_AUTH=1`);
  console.log('  Auth is the dev bypass (x-dev-auth) — no Cognito. Ctrl-C to stop.\n');
}

async function setReportNoticeWindow(
  req: Request,
  setOverride: (fn: ((now: Date) => boolean) | undefined) => void,
): Promise<Response> {
  const { mode } = (await req.json().catch(() => ({}))) as { mode?: unknown };
  if (mode === 'open') setOverride(() => true);
  else if (mode === 'closed') setOverride(() => false);
  else if (mode === 'real') setOverride(undefined);
  else return Response.json({ error: "mode must be 'open', 'closed' or 'real'" }, { status: 400 });
  return Response.json({ mode });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
