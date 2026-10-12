/**
 * Change live data between --plan and --confirm (stale-decisions scenarios):
 *   tsx test/dedup-e2e/mutate.ts <manifest.json> <op>...
 * ops: new-slug-a (a 3rd identity for group A), stale-b-at-umhlali (the stale key B registered
 * at a second club), delete-survivor-v, rename-c2 (a spelling fix on a stale row),
 * flush-pending (simulate the sync worker draining PENDINGPLAYERSYNC#), revive-<KEY> (re-create a
 * deleted key's row so tombstone sees it live).
 */
import { readFileSync } from 'node:fs';
import type { PlayerRegistration } from '../../src/types.js';

const [manifestPath, ...ops] = process.argv.slice(2);
const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>;
const T = 'dolphins';
const repo = await import('../../src/repo.js');
const base = {
  isMinor: false,
  consentAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  status: 'active',
} as const;

for (const op of ops) {
  if (op === 'new-slug-a') {
    await repo.createPlayer(T, {
      ...base,
      firstName: 'Sipho',
      lastName: 'Dlamini',
      dob: '2001-02-03',
      naturalKey: 'sipho-dlamini-2001-02-03',
      clubId: 'durban-hc',
    } as PlayerRegistration);
  } else if (op === 'stale-b-at-umhlali') {
    await repo.createPlayer(T, {
      ...base,
      firstName: 'Thabo',
      lastName: 'Nkosi',
      dob: '1999-05-06',
      naturalKey: m.SLUG_B,
      clubId: 'umhlali',
    } as PlayerRegistration);
  } else if (op === 'delete-survivor-v') {
    await repo.deletePlayer(T, (await repo.getPlayer(T, 'crusaders', m.SHA_V))!);
  } else if (op === 'rename-c2') {
    await repo.updatePlayer(T, 'glenwood', m.SLUG_C2, { firstName: 'Ayandaa' });
  } else if (op === 'flush-pending') {
    const { DynamoDBClient, ScanCommand, DeleteItemCommand } =
      await import('@aws-sdk/client-dynamodb');
    const ddb = new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    const res = await ddb.send(new ScanCommand({ TableName: process.env.TABLE_NAME }));
    let n = 0;
    for (const i of res.Items ?? [])
      if (i.sk.S?.startsWith('PENDINGPLAYERSYNC#')) {
        await ddb.send(
          new DeleteItemCommand({
            TableName: process.env.TABLE_NAME,
            Key: { pk: i.pk, sk: i.sk },
          }),
        );
        n++;
      }
    console.log(`flushed ${n} pending sync row(s)`);
  } else if (op === 'sync-on') {
    const cfg = (await repo.getTenantConfig(T))!;
    await repo.putTenantConfig({
      ...cfg,
      features: { ...(cfg.features ?? {}), medicoachSync: true },
      integrations: {
        ...(cfg.integrations ?? {}),
        medicoach: { ...(cfg.integrations?.medicoach ?? {}), playerSync: true },
      },
    } as typeof cfg);
  } else if (op.startsWith('revive-')) {
    const nk = m[op.slice('revive-'.length)] ?? op.slice('revive-'.length);
    await repo.createPlayer(T, {
      ...base,
      firstName: 'Revived',
      lastName: 'Row',
      dob: '1990-01-01',
      naturalKey: nk,
      clubId: 'umhlali',
    } as PlayerRegistration);
  } else throw new Error(`unknown op ${op}`);
  console.log(`applied ${op}`);
}
