/**
 * Dump a scenario table's player-related items (for invariant checks after a CLI run):
 *   tsx test/dedup-e2e/inspect.ts [out.json]
 * Prints counts; writes {players, vetaffil, distinct, pendingSync, clearances, other} to out.json.
 */
import { writeFileSync } from 'node:fs';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({
  endpoint: process.env.DYNAMO_ENDPOINT,
  region: 'localhost',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const items: Record<string, unknown>[] = [];
let ExclusiveStartKey: Record<string, never> | undefined;
do {
  const res = await ddb.send(
    new ScanCommand({ TableName: process.env.TABLE_NAME, ExclusiveStartKey }),
  );
  for (const i of res.Items ?? []) items.push(unmarshall(i));
  ExclusiveStartKey = res.LastEvaluatedKey as typeof ExclusiveStartKey;
} while (ExclusiveStartKey);

const sk = (i: Record<string, unknown>) => String(i.sk);
const out = {
  total: items.length,
  players: items.filter((i) => sk(i).startsWith('PLAYER#')),
  vetaffil: items.filter((i) => sk(i).startsWith('VETAFFIL#')),
  distinct: items.filter((i) => sk(i).startsWith('PLAYERDISTINCT#')).map((i) => sk(i)),
  pendingSync: items.filter((i) => sk(i).startsWith('PENDINGPLAYERSYNC#')),
  clearances: items.filter((i) => sk(i).startsWith('CLEARANCE#')),
  clubMeta: items
    .filter((i) => sk(i) === 'META' && String(i.pk).includes('#CLUB#'))
    .map((i) => ({ id: i.id, playerCount: i.playerCount })),
};
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log(
  JSON.stringify({
    total: out.total,
    players: out.players.length,
    vetaffil: out.vetaffil.length,
    distinct: out.distinct.length,
    pendingSync: out.pendingSync.length,
  }),
);
