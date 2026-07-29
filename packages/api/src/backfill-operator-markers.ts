/**
 * One-off backfill — make EXISTING platform operators enumerable.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-operator-markers.ts [--confirm]
 *
 * Operators are indexed by a `PLATFORM#OPERATORS` marker item (keys.ts) so tenant
 * creation can auto-grant them admin without scanning the table. The marker is written by
 * `repo.putUser`, so anyone granted operator BEFORE that existed has none — and would be
 * silently skipped by the auto-grant, which is the kind of failure nobody notices until a
 * new tenant is mysteriously invisible to half the team.
 *
 * This is the only place a full scan is acceptable: once, deliberately, not per request.
 * Dry-run by default.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import * as repo from './repo.js';
import { PLATFORM_TENANT } from './types.js';
import type { Membership } from './types.js';
import { tableName } from './env.js';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(process.env.DYNAMO_ENDPOINT ? { endpoint: process.env.DYNAMO_ENDPOINT } : {}),
);

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const TABLE = tableName();

  // Scan for USER# META items carrying a '*' operator membership.
  const found: Array<{ sub: string; email: string }> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'begins_with(pk, :u) AND sk = :m',
        ExpressionAttributeValues: { ':u': 'USER#', ':m': 'META' },
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const memberships = (item.memberships ?? []) as Membership[];
      if (memberships.some((m) => m.tenantId === PLATFORM_TENANT && m.role === 'operator'))
        found.push({ sub: String(item.sub), email: String(item.email) });
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const indexed = new Set((await repo.listOperators()).map((o) => o.sub));
  const missing = found.filter((o) => !indexed.has(o.sub));

  console.log(`operators found: ${found.length}, already indexed: ${indexed.size}`);
  if (missing.length === 0) {
    console.log('nothing to backfill.');
    return;
  }
  console.log(`missing markers (${missing.length}):`);
  for (const o of missing) console.log(`  ${o.email}`);

  if (!confirm) {
    console.log('\ndry run — re-run with --confirm to write the markers.');
    return;
  }

  for (const o of missing) {
    // putUser rewrites the META item unchanged and reconciles markers, which is what
    // mints the operator marker. Reading first keeps memberships authoritative.
    const user = await repo.getUser(o.sub);
    if (!user) {
      console.warn(`  ${o.email}: USER# vanished between scan and write — skipped`);
      continue;
    }
    await repo.putUser(user);
    console.log(`  ✓ ${o.email}`);
  }
  console.log(`\nbackfilled ${missing.length} operator marker(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
