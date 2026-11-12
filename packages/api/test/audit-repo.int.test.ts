/**
 * Audit storage (repo.putAuditEntry / listAudit* / getAuditEntry / listAuditKeys /
 * scrubAuditFor*) against an in-process dynalite with the REAL repo: month partitions and
 * cursors, each query, expiry, erasure scrubs, an entry at the caps, started → final overwrite.
 * Run with tsx --test.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AuditActor, AuditChange, AuditMention } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4837; // unique
const TABLE = 'SmartClubAuditRepoTest';
dynaliteEnv(DDB_PORT, TABLE);

const NOW = new Date('2027-01-10T10:00:00.000Z');

let ddbServer: Server;
let repo: typeof import('../src/repo.js');
let audit: typeof import('../src/audit.js');
let doc: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
let QueryCommand: typeof import('@aws-sdk/lib-dynamodb').QueryCommand;

before(async () => {
  ddbServer = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  audit = await import('../src/audit.js');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const lib = await import('@aws-sdk/lib-dynamodb');
  QueryCommand = lib.QueryCommand;
  doc = lib.DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: process.env.DYNAMO_ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
  );
});

after(() => stopDynalite(ddbServer));

const user = (sub: string, email = `${sub}@union.test`): AuditActor => ({
  kind: 'user',
  key: sub,
  sub,
  email,
  role: 'admin',
  via: 'console',
});

interface SeedTarget {
  type: string;
  id: string;
  label?: string;
  op?: string;
  clubId?: string;
  changes?: AuditChange[];
}

/** Record an entry the way the middleware will: a scope, the helpers, buildEntry, put. */
async function seed(
  tenant: string,
  at: string,
  opts: {
    actor?: AuditActor;
    action?: string;
    visibility?: 'tenant' | 'operator';
    targets?: SeedTarget[];
    mentions?: AuditMention[];
    id?: string;
    status?: number;
    outcome?: 'started' | 'ok' | 'failed';
  } = {},
) {
  const scope = audit.newAuditScope({
    at,
    tenant,
    actor: opts.actor ?? user('sub-admin'),
    visibility: opts.visibility ?? 'tenant',
    ...(opts.id ? { id: opts.id } : {}),
  });
  audit.runAudited(scope, () => {
    audit.auditSet({ action: opts.action ?? 'thing.update' });
    for (const t of opts.targets ?? []) audit.auditTarget({ op: 'update', ...t });
    for (const m of opts.mentions ?? []) audit.auditMention(m);
  });
  const set = audit.buildEntry(scope, {
    status: opts.status ?? 200,
    ...(opts.outcome ? { outcome: opts.outcome } : {}),
    route: { method: 'PUT', pattern: '/x/:id' },
  });
  await repo.putAuditEntry(set);
  return set;
}

/** Every stored row of a tenant's audit partitions for the given months (raw). */
async function rawRows(tenant: string, months: string[]) {
  const out: Record<string, unknown>[] = [];
  for (const m of months) {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': `TENANT#${tenant}#AUDIT#${m}` },
      }),
    );
    out.push(...(res.Items ?? []));
  }
  return out;
}

async function drain<T>(
  fetch: (cursor?: string) => Promise<{ items: T[]; cursor?: string }>,
): Promise<{ pages: T[][]; all: T[] }> {
  const pages: T[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await fetch(cursor);
    pages.push(page.items);
    cursor = page.cursor;
    if (!cursor) break;
  }
  return { pages, all: pages.flat() };
}

describe('feed and queries across months', () => {
  const T = 'feed';
  const ats = [
    '2026-11-03T08:00:00.000Z',
    '2026-11-20T08:00:00.000Z',
    '2026-11-30T23:59:59.999Z',
    '2026-12-01T00:00:00.000Z',
    '2026-12-15T08:00:00.000Z',
    '2027-01-02T08:00:00.000Z',
  ];
  const ids: string[] = [];

  before(async () => {
    for (const [i, at] of ats.entries()) {
      const set = await seed(T, at, {
        actor: user(i % 2 ? 'sub-odd' : 'sub-even'),
        action: i === 4 ? 'settings.update' : 'umpire.update',
        visibility: i === 5 ? 'operator' : 'tenant',
        targets:
          i === 4
            ? [{ type: 'tenant', id: T }]
            : [
                {
                  type: 'umpire',
                  id: i < 3 ? 'u-a-dende' : 'u-m-jooma',
                  label: 'Ump',
                  clubId: i === 1 ? 'home-club' : undefined,
                },
              ],
      });
      ids.push(set.entry.id);
    }
  });

  test('pages newest first across month partitions; the cursor crosses the month boundary', async () => {
    const { pages, all } = await drain((cursor) =>
      repo.listAuditFeed(T, { limit: 2, cursor, now: NOW }),
    );
    assert.deepEqual(
      all.map((e) => e.at),
      [...ats].reverse(),
    );
    assert.ok(pages.length >= 3);
    assert.ok(pages.every((p) => p.length <= 2));
    // The stored entry round-trips without key attributes.
    const first = all[0] as unknown as Record<string, unknown>;
    for (const k of ['pk', 'sk', 'rowType', 'entryId']) assert.equal(first[k], undefined, k);
    assert.equal(all[0].actor.key, 'sub-odd');
  });

  test('from / to bound the instants', async () => {
    const page = await repo.listAuditFeed(T, {
      from: '2026-11-15',
      to: '2026-12-01',
      now: NOW,
    });
    assert.deepEqual(
      page.items.map((e) => e.at),
      [ats[3], ats[2], ats[1]],
    );
  });

  test('type and visibility filter the page; actor reads that person only', async () => {
    const umpires = await drain((cursor) =>
      repo.listAuditFeed(T, { type: 'umpire', limit: 3, cursor, now: NOW }),
    );
    assert.equal(umpires.all.length, 5);
    const tenantOnly = await repo.listAuditFeed(T, { visibility: 'tenant', now: NOW });
    assert.equal(tenantOnly.items.length, 5);
    assert.ok(tenantOnly.items.every((e) => e.visibility === 'tenant'));
    const odd = await repo.listAuditFeed(T, { actor: 'sub-odd', now: NOW });
    assert.deepEqual(
      odd.items.map((e) => e.at),
      [ats[5], ats[3], ats[1]],
    );
    const forActor = await drain((cursor) =>
      repo.listAuditForActor(T, 'sub-even', { limit: 1, cursor, now: NOW }),
    );
    assert.deepEqual(
      forActor.all.map((e) => e.at),
      [ats[4], ats[2], ats[0]],
    );
  });

  test('a filtered feed keeps reading until the page is full (within the read budget)', async () => {
    const F = 'feed-filter';
    const base = Date.parse('2027-01-05T00:00:00.000Z');
    // Three type-B entries, then 300 NEWER type-A entries above them.
    for (let i = 0; i < 303; i++)
      await seed(F, new Date(base + i * 1000).toISOString(), {
        targets: [i < 3 ? { type: 'venue', id: `v-${i}` } : { type: 'umpire', id: `u-${i}` }],
      });
    const page = await repo.listAuditFeed(F, { type: 'venue', limit: 50, now: NOW });
    assert.deepEqual(page.items.map((e) => e.targets[0].id).sort(), ['v-0', 'v-1', 'v-2']);
    assert.equal(page.cursor, undefined, 'the whole month was read: nothing left');
    // A full page stops at the limit-th match and resumes right after it.
    const first = await repo.listAuditFeed(F, { type: 'umpire', limit: 7, now: NOW });
    assert.equal(first.items.length, 7);
    assert.ok(first.cursor);
    const next = await repo.listAuditFeed(F, {
      type: 'umpire',
      limit: 7,
      cursor: first.cursor,
      now: NOW,
    });
    assert.equal(next.items.length, 7);
    assert.equal(
      new Set([...first.items, ...next.items].map((e) => e.id)).size,
      14,
      'no entry repeated or skipped across the cut',
    );
    assert.ok(next.items[0].at < first.items[6].at);
    // Unfiltered reads are unchanged: one page of `limit` rows.
    assert.equal((await repo.listAuditFeed(F, { limit: 5, now: NOW })).items.length, 5);
  });

  test('record history and club history', async () => {
    const dende = await drain((cursor) =>
      repo.listAuditForEntity(T, 'umpire', 'u-a-dende', { limit: 2, cursor, now: NOW }),
    );
    assert.deepEqual(
      dende.all.map((e) => e.at),
      [ats[2], ats[1], ats[0]],
    );
    const jooma = await repo.listAuditForEntity(T, 'umpire', 'u-m-jooma', { now: NOW });
    assert.equal(jooma.items.length, 2);
    const club = await repo.listAuditForClub(T, 'home-club', { now: NOW });
    assert.deepEqual(
      club.items.map((e) => e.id),
      [ids[1]],
    );
    // A prefix of an id is a different record.
    assert.equal((await repo.listAuditForEntity(T, 'umpire', 'u-a', { now: NOW })).items.length, 0);
  });

  test('another tenant sees nothing', async () => {
    assert.equal((await repo.listAuditFeed('other', { now: NOW })).items.length, 0);
  });

  test('a cursor this API did not issue is refused', async () => {
    await assert.rejects(
      repo.listAuditFeed(T, { cursor: 'not-a-cursor', now: NOW }),
      repo.InvalidAuditCursorError,
    );
  });
});

describe('entries', () => {
  test('ids containing # stay separate records', async () => {
    const T = 'hashes';
    const at = '2026-11-12T08:00:00.000Z';
    await seed(T, at, { targets: [{ type: 'fixture', id: 's1#f1' }] });
    await seed(T, at, { targets: [{ type: 'fixture', id: 's1#f10' }] });
    await seed(T, at, { targets: [{ type: 'fixture', id: 's1' }] });
    for (const id of ['s1#f1', 's1#f10', 's1'])
      assert.equal(
        (await repo.listAuditForEntity(T, 'fixture', id, { now: NOW })).items.length,
        1,
        id,
      );
  });

  test('getAuditEntry returns headline + detail; detail null without values', async () => {
    const T = 'get';
    const at = '2026-12-05T08:00:00.000Z';
    const withDetail = await seed(T, at, {
      targets: [
        {
          type: 'umpire',
          id: 'u-1',
          label: 'M. Jooma',
          changes: [{ field: 'displayName', from: 'A. Dende', to: 'M. Jooma' }],
        },
      ],
    });
    const got = await repo.getAuditEntry(T, at, withDetail.entry.id, { now: NOW });
    assert.ok(got);
    assert.deepEqual(got.entry, withDetail.entry);
    assert.deepEqual(got.detail?.targets[0].changes, [
      { field: 'displayName', from: 'A. Dende', to: 'M. Jooma' },
    ]);
    const bare = await seed(T, at, { targets: [{ type: 'umpire', id: 'u-2' }] });
    assert.equal((await repo.getAuditEntry(T, at, bare.entry.id, { now: NOW }))?.detail, null);
    assert.equal(await repo.getAuditEntry(T, at, 'missing', { now: NOW }), null);
  });

  test('a "started" headline is overwritten by the final entry with the same id', async () => {
    const T = 'started';
    const at = '2026-12-06T08:00:00.000Z';
    const id = 'entry-started-1';
    await seed(T, at, {
      id,
      action: 'club.delete',
      status: 0,
      outcome: 'started',
      targets: [{ type: 'club', id: 'gone-club', label: 'Gone CC' }],
    });
    let feed = await repo.listAuditFeed(T, { now: NOW });
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].outcome, 'started');
    await seed(T, at, {
      id,
      action: 'club.delete',
      targets: [{ type: 'club', id: 'gone-club', label: 'Gone CC' }],
      mentions: [{ type: 'player', id: 'nk-9', label: 'P' }],
    });
    feed = await repo.listAuditFeed(T, { now: NOW });
    assert.equal(feed.items.length, 1, 'one entry, not two');
    assert.equal(feed.items[0].outcome, 'ok');
    assert.equal(feed.items[0].status, 200);
    assert.ok((await repo.getAuditEntry(T, at, id, { now: NOW }))?.detail?.mentions.length);
  });

  test('expired rows are hidden from every reader', async () => {
    const T = 'expired';
    const at = '2026-11-12T08:00:00.000Z';
    const set = await seed(T, at, {
      actor: user('sub-exp'),
      targets: [{ type: 'umpire', id: 'u-exp', clubId: 'c-exp' }],
    });
    // TTL deletion lags, so an expired row can still be stored: give this entry an expiry
    // already past at NOW and rewrite it.
    for (const r of set.rows)
      (r as Record<string, unknown>).expiresAt = Math.floor(NOW.getTime() / 1000) - 1;
    await repo.putAuditEntry(set);
    assert.equal((await repo.listAuditFeed(T, { now: NOW })).items.length, 0);
    assert.equal(
      (await repo.listAuditForEntity(T, 'umpire', 'u-exp', { now: NOW })).items.length,
      0,
    );
    assert.equal((await repo.listAuditForClub(T, 'c-exp', { now: NOW })).items.length, 0);
    assert.equal((await repo.listAuditForActor(T, 'sub-exp', { now: NOW })).items.length, 0);
    assert.equal(await repo.getAuditEntry(T, at, set.entry.id, { now: NOW }), null);
    assert.equal((await rawRows(T, ['2026-11'])).length, set.rows.length, 'still stored');
  });

  test('an entry at the caps is written whole (≤ 100 rows); more than 100 rows is refused', async () => {
    const T = 'caps';
    const at = '2026-12-10T08:00:00.000Z';
    const set = await seed(T, at, {
      targets: Array.from({ length: 30 }, (_, t) => ({
        type: 'fixture',
        id: `s#f${t}`,
        label: `Fixture ${t}`,
        clubId: `club-${t}`,
        changes: Array.from({ length: 45 }, (_, c) => ({
          field: `f${c}`,
          from: 'a'.repeat(250),
          to: 'b'.repeat(250),
          ...(c === 0 ? { ref: { type: 'umpire', id: `u-${t}` } } : {}),
        })),
      })),
      mentions: Array.from({ length: 45 }, (_, m) => ({
        type: 'scorer',
        id: `sc-${m}`,
        label: `Scorer ${m}`,
      })),
    });
    assert.ok(set.rows.length <= 100 && set.rows.length > 90, `${set.rows.length} rows`);
    const stored = (await rawRows(T, ['2026-12'])).filter((r) => r.entryId === set.entry.id);
    assert.equal(stored.length, set.rows.length, 'every row of the entry landed');
    const got = await repo.getAuditEntry(T, at, set.entry.id, { now: NOW });
    assert.equal(got?.entry.targets.length, 25);
    assert.ok(got?.entry.truncated?.targets && got.entry.truncated.mentions);
    // Every stored mention is findable through its own pointer.
    for (const m of got!.detail!.mentions)
      assert.equal(
        (await repo.listAuditForEntity(T, m.type, m.id, { now: NOW })).items.length,
        1,
        m.id,
      );
    const tooMany = {
      rows: Array.from({ length: 101 }, (_, i) => ({
        pk: 'TENANT#caps#AUDIT#2026-12',
        sk: `X#${i}`,
      })),
    };
    await assert.rejects(repo.putAuditEntry(tooMany), /101 rows/);
  });

  test('listAuditKeys returns every row of the tenant, every month, and nothing else', async () => {
    const keys = await repo.listAuditKeys('feed', { now: NOW });
    const raw = await rawRows('feed', ['2026-11', '2026-12', '2027-01']);
    assert.equal(keys.length, raw.length);
    assert.ok(keys.every((k) => k.pk.startsWith('TENANT#feed#AUDIT#')));
  });
});

describe('erasure scrubs', () => {
  test('an official: names and values gone everywhere; id and pointers kept; re-run is a no-op', async () => {
    const T = 'scrub-official';
    const at1 = '2026-11-12T08:00:00.000Z';
    const at2 = '2026-12-02T08:00:00.000Z';
    // The Dende → Jooma overwrite: one record, two people.
    await seed(T, at1, {
      targets: [
        {
          type: 'umpire',
          id: 'u-a-dende',
          label: 'A. Dende',
          changes: [{ field: 'displayName', from: 'A. Dende', to: 'M. Jooma' }],
        },
      ],
    });
    // A fixture naming the umpire in a change, and a merge mentioning them.
    await seed(T, at2, {
      targets: [
        {
          type: 'fixture',
          id: 's1#f1',
          label: 'Home v Away',
          changes: [
            {
              field: 'umpire',
              from: 'A. Dende',
              to: 'B. Other',
              ref: { type: 'umpire', id: 'u-b-other' },
              fromRef: { type: 'umpire', id: 'u-a-dende' },
            },
            { field: 'time', from: '09:00', to: '10:00' },
          ],
        },
      ],
      mentions: [
        { type: 'umpire', id: 'u-a-dende', label: 'A. Dende' },
        { type: 'umpire', id: 'u-c-keep', label: 'C. Keep' },
      ],
    });
    const n = await repo.scrubAuditForEntity(T, 'umpire', ['u-a-dende'], {
      placeholder: 'Removed umpire',
      now: NOW,
    });
    assert.equal(n, 2);
    const rows = await rawRows(T, ['2026-11', '2026-12']);
    const text = JSON.stringify(rows);
    for (const v of ['Dende', 'Jooma']) assert.ok(!text.includes(v), v);
    assert.ok(text.includes('C. Keep'), 'other people untouched');
    assert.ok(text.includes('10:00'), 'unrelated values untouched');
    const history = await repo.listAuditForEntity(T, 'umpire', 'u-a-dende', { now: NOW });
    assert.equal(history.items.length, 2, 'pointers and record id kept (assumption 4)');
    assert.equal(
      await repo.scrubAuditForEntity(T, 'umpire', ['u-a-dende'], {
        placeholder: 'Removed umpire',
        now: NOW,
      }),
      0,
    );
  });

  test('a player: the natural key is blanked and its pointers dropped', async () => {
    const T = 'scrub-player';
    const at = '2026-12-03T08:00:00.000Z';
    const nk = 'nk-9001015009087';
    await seed(T, at, {
      targets: [{ type: 'player', id: nk, label: 'Sipho Erase', clubId: 'alpha' }],
    });
    await seed(T, at, {
      targets: [
        {
          type: 'clearance',
          id: 'clr-1',
          label: 'Clearance',
          clubId: 'alpha',
          changes: [{ field: 'player', to: 'Sipho Erase', ref: { type: 'player', id: nk } }],
        },
      ],
    });
    await repo.scrubAuditForEntity(T, 'player', [nk], {
      placeholder: '[removed]',
      dropPointers: true,
      now: NOW,
    });
    const text = JSON.stringify(await rawRows(T, ['2026-12']));
    for (const v of [nk, 'Sipho', 'Erase']) assert.ok(!text.includes(v), v);
    assert.equal((await repo.listAuditForEntity(T, 'player', nk, { now: NOW })).items.length, 0);
    assert.equal((await repo.listAuditFeed(T, { now: NOW })).items.length, 2, 'entries stay');
  });

  test('a club: its side is redacted, a surviving club keeps its side', async () => {
    const T = 'scrub-club';
    const at = '2026-12-04T08:00:00.000Z';
    const two = await seed(T, at, {
      targets: [
        {
          type: 'clearance',
          id: 'clr-2',
          label: 'Gone CC to Survivor CC',
          clubId: 'gone',
          changes: [{ field: 'fromClubName', to: 'Gone CC' }],
        },
        {
          type: 'club',
          id: 'survivor',
          label: 'Survivor CC',
          changes: [{ field: 'name', from: 'Old Survivor', to: 'Survivor CC' }],
        },
      ],
      mentions: [{ type: 'club', id: 'gone', label: 'Gone CC' }],
    });
    const one = await seed(T, at, {
      targets: [
        {
          type: 'club',
          id: 'gone',
          label: 'Gone CC',
          changes: [{ field: 'name', from: 'Gone Old', to: 'Gone CC' }],
        },
      ],
    });
    const n = await repo.scrubAuditForClub(T, 'gone', { placeholder: '[removed]', now: NOW });
    assert.equal(n, 2);
    const text = JSON.stringify(await rawRows(T, ['2026-12']));
    for (const v of ['Gone CC', 'Gone Old']) assert.ok(!text.includes(v), v);
    const kept = await repo.getAuditEntry(T, at, two.entry.id, { now: NOW });
    assert.equal(kept?.entry.targets[1].label, 'Survivor CC');
    assert.deepEqual(kept?.detail?.targets[1].changes[0], {
      field: 'name',
      from: 'Old Survivor',
      to: 'Survivor CC',
    });
    assert.equal(kept?.entry.targets[0].scrubbed, true);
    assert.equal(
      (await repo.getAuditEntry(T, at, one.entry.id, { now: NOW }))?.entry.targets[0].label,
      undefined,
    );
  });

  test('a club with ~1,000 entries is redacted whole within the club delete budget', async () => {
    const T = 'scrub-club-bulk';
    const at = '2026-12-05T08:00:00.000Z';
    const { BatchWriteCommand } = await import('@aws-sdk/lib-dynamodb');
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 1000; i++) {
      const scope = audit.newAuditScope({ at, tenant: T, actor: user('sub-bulk') });
      audit.runAudited(scope, () =>
        audit.auditTarget({
          type: 'club',
          id: 'bulkgone',
          label: 'Bulk Gone CC',
          op: 'update',
          changes: [{ field: 'name', from: `Bulk Gone ${i}`, to: 'Bulk Gone CC' }],
        }),
      );
      rows.push(...audit.buildEntry(scope, { status: 200, action: 'club.update' }).rows);
    }
    for (let i = 0; i < rows.length; i += 25)
      await doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE]: rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
          },
        }),
      );
    const t0 = performance.now();
    const n = await repo.scrubAuditForClub(T, 'bulkgone', { placeholder: '[removed]', now: NOW });
    const ms = performance.now() - t0;
    assert.equal(n, 1000);
    const text = JSON.stringify(await rawRows(T, ['2026-12']));
    assert.ok(!text.includes('Bulk Gone'), 'a club name survived');
    // Generous for dynalite; the point is batched reads + bounded concurrency, not 2,000 Gets
    // and 2,000 Puts one after another.
    assert.ok(ms < 20_000, `scrub took ${Math.round(ms)} ms`);
    // Idempotent: a re-delete finds nothing left to change.
    assert.equal(
      await repo.scrubAuditForClub(T, 'bulkgone', { placeholder: '[removed]', now: NOW }),
      0,
    );
  });
});
