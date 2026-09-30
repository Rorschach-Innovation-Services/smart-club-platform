/**
 * Integration tests for `POST /season-runs/:id/rebase` — the one audited exception to
 * snapshot immutability — plus the run-time `pairingOverride` guard on POST/PATCH.
 *
 * What is pinned:
 * - the snapshot adopted is the SERVER's live structure, gated twice: the live structure
 *   id and version must equal the ones the admin reviewed (409 otherwise), and the run
 *   write is version-conditional like PATCH (409 on a stale run);
 * - the target is the league's CURRENT setup structure (a clone or per-season fork the
 *   league moved onto), falling back to the snapshot's id when the league has no setup;
 * - stage reconciliation, including the rules the client cannot infer for itself
 *   (its divergence check compares pairings only, and confirmed groups shadow the spec):
 *   entrant change clears groups, schedule change marks `staleSchedule`, format change
 *   drops `pairingOverride`, a dangling `fromStage` warns;
 * - the ROOT format marker: a rebase onto a structure whose `name`/`overs` changed stamps
 *   `formatChanged` on every surviving stage; the next generate adopts the new name/overs
 *   and clears it, while a regenerate WITHOUT it keeps a released series' stored
 *   `seriesType`/`maxOvers`; a client can neither set nor clear it;
 * - audit entries are stamped server-side;
 * - PATCH still strips a client-supplied snapshot after a rebase.
 *
 * Same harness as season-venues.int.test.ts: in-process dynalite + the REAL Hono app.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type {
  Club,
  CompetitionStructure,
  SeasonCalendar,
  SeasonRun,
  Series,
  StageRun,
  StageSpec,
} from '../src/types.js';
import { bindSetup, startRunBody } from './season-run-harness.js';
import { rebaseTargetFor } from '../../engine/src/run.js';

// Env must be set BEFORE importing repo/app — repo reads TABLE_NAME at module load.
const DDB_PORT = 4639; // next free odd port after veterans-requests (4637)
const TABLE = 'SmartClubSeasonRunRebaseTest';
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.LOCAL_AUTH = '1';
process.env.STAGE = 'local';
process.env.USER_POOL_ID = 'test-pool';
process.env.AWS_REGION ??= 'localhost';
process.env.UPLOADS_BUCKET = 'test-uploads';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_MAX_ATTEMPTS = '1';

const devAuth = (email: string, memberships: unknown) =>
  Buffer.from(JSON.stringify({ sub: 'u', email, memberships })).toString('base64');
const ADMIN = devAuth('admin@test', [{ tenantId: 'dolphins', role: 'admin', clubIds: [] }]);
const REP = devAuth('rep@test', [{ tenantId: 'dolphins', role: 'rep', clubIds: ['testers'] }]);

const headers = (auth: string) => ({
  'x-tenant': 'dolphins',
  'x-dev-auth': auth,
  'content-type': 'application/json',
});

const CALENDAR: SeasonCalendar = {
  id: 'cal-2627',
  label: '2026/27',
  blocks: [
    { id: 'b1', label: 'Block 1', start: '2026-09-13', end: '2026-12-13' },
    { id: 'b2', label: 'Block 2', start: '2027-01-10', end: '2027-03-28' },
  ],
};

const weekly = (blockIndex: number): StageSpec['schedule'] => ({
  blockIndex,
  cadence: { kind: 'weekly' },
});

// v1 — what the season started with. One stage per reconciliation rule, so each
// assertion below isolates exactly one kind of change.
const POOLS: StageSpec = {
  id: 'pools',
  name: 'Pools',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
  schedule: weekly(0),
};
const KO: StageSpec = {
  id: 'ko',
  name: 'Knockout',
  format: { kind: 'knockout', pairing: 'seeded' },
  entrants: {
    kind: 'manual',
    derivedFrom: { rule: 'from-standings', fromStage: 'pools', detail: 'Top two per group' },
  },
  schedule: weekly(1),
};
const PLATE: StageSpec = {
  id: 'plate',
  name: 'Plate',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'all-registered' },
  schedule: weekly(1),
};
const UNTOUCHED: StageSpec = {
  id: 'untouched',
  name: 'Friendlies',
  format: { kind: 'single-match' },
  entrants: { kind: 'all-registered' },
  schedule: weekly(0),
};
const DROPPED: StageSpec = {
  id: 'dropped',
  name: 'Shield',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'all-registered' },
  schedule: weekly(1),
};

const V1: CompetitionStructure = {
  id: 'st-rb',
  name: 'Pools to knockout',
  version: 1,
  stages: [POOLS, KO, PLATE, UNTOUCHED, DROPPED],
};

// v2 — the live structure an operator has since saved.
const BOWL: StageSpec = {
  id: 'bowl',
  name: 'Bowl',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'all-registered' },
  schedule: weekly(1),
};
const V2: CompetitionStructure = {
  ...V1,
  version: 2,
  stages: [
    // entrant spec changed
    { ...POOLS, entrants: { ...POOLS.entrants, method: 'blocks' } as StageSpec['entrants'] },
    // format changed
    { ...KO, format: { kind: 'knockout', pairing: 'cross-pool' } },
    // schedule changed
    { ...PLATE, schedule: { blockIndex: 1, cadence: { kind: 'every-n-weeks', n: 2 } } },
    UNTOUCHED,
    // DROPPED removed, BOWL added
    BOWL,
  ],
};

// A legacy live structure whose knockout names a stage that no longer exists (saved
// before the forward-reference guard, so written straight through repo here).
const LEGACY_V1: CompetitionStructure = { ...V1, id: 'st-legacy', stages: [POOLS, KO] };
const LEGACY_V2: CompetitionStructure = {
  ...LEGACY_V1,
  version: 2,
  stages: [
    { ...POOLS, id: 'pools-renamed' },
    {
      ...KO,
      entrants: {
        kind: 'manual',
        derivedFrom: { rule: 'from-standings', fromStage: 'pools', detail: 'Top two' },
      },
    },
  ],
};

// A structure whose only change between versions is a stage's `activateFrom` — the
// reveal date generated series embed, so it must mark the schedule stale on its own.
const REVEAL_V1: CompetitionStructure = { ...V1, id: 'st-reveal', stages: [PLATE] };
const REVEAL_V2: CompetitionStructure = {
  ...REVEAL_V1,
  version: 2,
  stages: [{ ...PLATE, schedule: { ...PLATE.schedule, activateFrom: '2027-01-18' } }],
};

const confirmedStages = (): StageRun[] => [
  {
    specId: 'pools',
    status: 'generated',
    groups: [
      { id: 'g-a', label: 'Group A', entrants: ['a1', 'a2', 'a3'], seriesId: 's-a' },
      { id: 'g-b', label: 'Group B', entrants: ['b1', 'b2', 'b3'], seriesId: 's-b' },
    ],
    audit: [{ at: '2026-09-01T00:00:00.000Z', by: 'first@test', prefill: [], accepted: true }],
  },
  {
    specId: 'ko',
    status: 'generated',
    pairingOverride: 'within-pool',
    groups: [
      { id: 'g-ko', label: 'Knockout', entrants: ['a1', 'a2', 'b1', 'b2'], seriesId: 's-ko' },
    ],
  },
  {
    specId: 'plate',
    status: 'generated',
    groups: [{ id: 'g-p', label: 'Plate', entrants: ['a3', 'b3'], seriesId: 's-p' }],
  },
  {
    specId: 'untouched',
    status: 'generated',
    groups: [{ id: 'g-u', label: 'Friendlies', entrants: ['a1', 'b1'], seriesId: 's-u' }],
  },
  {
    specId: 'dropped',
    status: 'generated',
    groups: [{ id: 'g-d', label: 'Shield', entrants: ['a3', 'b3'], seriesId: 's-d' }],
  },
];

// A league with no setup in config: its runs fall back to their snapshot's own structure.
const NO_SETUP = 'no-setup-league';

const run = (over: Partial<SeasonRun> = {}): SeasonRun => ({
  id: 'sr-rb',
  leagueKey: 'premier-men',
  // A stored deprecated competitionId is inert.
  competitionId: 'comp-1',
  seasonLabel: '2026/27',
  structureSnapshot: V1,
  calendarSnapshot: CALENDAR,
  stages: confirmedStages(),
  version: 1,
  ...over,
});

// Resolved in before().
let ddbServer: Server;
let app: (typeof import('../src/index.js'))['app'];
let repo: typeof import('../src/repo.js');

const rebase = (id: string, body: unknown, auth = ADMIN) =>
  app.request(`/season-runs/${id}/rebase`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
  });

before(async () => {
  const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
  ddbServer = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));

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

  const seed = await import('../src/seed-core.js');
  await seed.seedTenantConfig('dolphins');
  ({ app } = await import('../src/index.js'));
  repo = await import('../src/repo.js');

  const cfg = await repo.getTenantConfig('dolphins');
  await repo.putTenantConfig({ ...cfg!, structures: [V2, LEGACY_V2, REVEAL_V2] });
  // POST /season-runs freezes what config sets up: premier-men runs the live V2.
  await bindSetup(repo, 'dolphins', {
    leagueKey: 'premier-men',
    structure: V2,
    calendar: CALENDAR,
  });
});

after(() => {
  ddbServer?.close();
});

describe('POST /season-runs/:id/rebase — guards', () => {
  test('a club rep cannot rebase', async () => {
    await repo.putSeasonRun('dolphins', run({ id: 'sr-rep' }));
    const res = await rebase(
      'sr-rep',
      { structureId: 'st-rb', structureVersion: 2, version: 1 },
      REP,
    );
    assert.equal(res.status, 403);
  });

  test('an unknown run is a 404', async () => {
    const res = await rebase('nope', { structureId: 'st-rb', structureVersion: 2, version: 1 });
    assert.equal(res.status, 404);
  });

  test('a deleted structure is a 404 — there is nothing live to adopt', async () => {
    await repo.putSeasonRun(
      'dolphins',
      run({ id: 'sr-gone', leagueKey: NO_SETUP, structureSnapshot: { ...V1, id: 'st-deleted' } }),
    );
    const res = await rebase('sr-gone', {
      structureId: 'st-deleted',
      structureVersion: 2,
      version: 1,
    });
    assert.equal(res.status, 404);
  });

  test('missing versions are a 400, never an unconditional write', async () => {
    await repo.putSeasonRun('dolphins', run({ id: 'sr-400' }));
    assert.equal(
      (await rebase('sr-400', { structureId: 'st-rb', structureVersion: 2 })).status,
      400,
    );
    assert.equal((await rebase('sr-400', { structureId: 'st-rb', version: 1 })).status, 400);
    assert.equal((await repo.getSeasonRun('dolphins', 'sr-400'))?.structureSnapshot.version, 1);
  });

  test('a structure edited since the review is a 409 and nothing is written', async () => {
    await repo.putSeasonRun('dolphins', run({ id: 'sr-live409' }));
    // The admin reviewed v3; the live structure is v2.
    const res = await rebase('sr-live409', {
      structureId: 'st-rb',
      structureVersion: 3,
      version: 1,
    });
    assert.equal(res.status, 409);
    // Coded so the console can say "reopen Review changes" rather than string-match.
    assert.equal(((await res.json()) as { code?: string }).code, 'structure_changed');
    const stored = await repo.getSeasonRun('dolphins', 'sr-live409');
    assert.equal(stored?.structureSnapshot.version, 1);
    assert.equal(stored?.version, 1);
  });

  test('a missing structureId is a 400 naming what is missing', async () => {
    await repo.putSeasonRun('dolphins', run({ id: 'sr-noid' }));
    const res = await rebase('sr-noid', { structureVersion: 2, version: 1 });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /id of the structure you reviewed/);
    assert.equal((await repo.getSeasonRun('dolphins', 'sr-noid'))?.structureSnapshot.version, 1);
  });

  test('a stale run version is a 409, same as PATCH', async () => {
    await repo.putSeasonRun('dolphins', run({ id: 'sr-run409', version: 4 }));
    const res = await rebase('sr-run409', {
      structureId: 'st-rb',
      structureVersion: 2,
      version: 3,
    });
    assert.equal(res.status, 409);
    assert.equal(
      (await repo.getSeasonRun('dolphins', 'sr-run409'))?.structureSnapshot.version,
      1,
      'the snapshot must not move on a conflict',
    );
  });

  test('already on the live version is a no-op — no version bump, no audit noise', async () => {
    await repo.putSeasonRun('dolphins', run({ id: 'sr-noop', structureSnapshot: V2 }));
    const res = await rebase('sr-noop', { structureId: 'st-rb', structureVersion: 2, version: 1 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SeasonRun;
    assert.equal(body.version, 1);
    assert.deepEqual(body.stages, confirmedStages());
  });

  test('a stale run version is a 409 even when already on the live version', async () => {
    await repo.putSeasonRun(
      'dolphins',
      run({ id: 'sr-noop409', structureSnapshot: V2, version: 3 }),
    );
    const stale = await rebase('sr-noop409', {
      structureId: 'st-rb',
      structureVersion: 2,
      version: 2,
    });
    assert.equal(stale.status, 409, 'the no-op return must not mask a stale run version');
    const fresh = await rebase('sr-noop409', {
      structureId: 'st-rb',
      structureVersion: 2,
      version: 3,
    });
    assert.equal(fresh.status, 200);
    assert.equal(((await fresh.json()) as SeasonRun).version, 3, 'still a no-op — no bump');
  });
});

describe('POST /season-runs/:id/rebase — reconciliation', () => {
  let body: SeasonRun & { warnings?: string[] };
  const stage = (specId: string) => body.stages.find((s) => s.specId === specId);

  before(async () => {
    await repo.putSeasonRun('dolphins', run());
    const res = await rebase('sr-rb', {
      structureId: 'st-rb',
      structureVersion: 2,
      version: 1,
      // A client-supplied snapshot is not a thing this route reads.
      structureSnapshot: { ...V2, name: 'Forged' },
    });
    assert.equal(res.status, 200);
    body = (await res.json()) as typeof body;
  });

  test('the snapshot becomes the SERVER-fetched live structure and the run version bumps', () => {
    assert.equal(body.structureSnapshot.version, 2);
    assert.equal(body.structureSnapshot.name, 'Pools to knockout');
    assert.deepEqual(
      body.structureSnapshot.stages.map((s) => s.id),
      V2.stages.map((s) => s.id),
    );
    assert.equal(body.version, 2);
    assert.equal(body.warnings, undefined, 'no warnings key on a clean rebase');
    // v1 → v2 kept the root name and overs, so no stage is marked to adopt a new format.
    assert.ok(body.stages.every((st) => st.formatChanged === undefined));
  });

  test('an entrant-spec change clears groups to awaiting-entrants, keeping the old grouping in the audit', () => {
    const pools = stage('pools')!;
    assert.equal(pools.status, 'awaiting-entrants');
    assert.deepEqual(pools.groups, []);
    assert.equal(pools.audit!.length, 2, 'the earlier entry survives, one rebase entry appended');
    assert.equal(pools.audit![0]!.by, 'first@test');
    const entry = pools.audit![1]!;
    assert.equal(entry.event, 'rebase');
    assert.deepEqual(entry.prefill, [
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
    assert.equal(pools.staleSchedule, undefined, 'the schedule did not change');
  });

  test('a format change drops the run-time pairing override and records it', () => {
    const ko = stage('ko')!;
    assert.equal(ko.pairingOverride, undefined);
    assert.equal(ko.audit!.at(-1)!.event, 'rebase');
    assert.equal(ko.audit!.at(-1)!.pairing, 'within-pool');
    // Groups are untouched — only the entrant rule clears them.
    assert.equal(ko.groups[0]!.seriesId, 's-ko');
    assert.equal(ko.status, 'generated');
  });

  test('a schedule change marks staleSchedule and keeps the groups', () => {
    const plate = stage('plate')!;
    assert.equal(plate.staleSchedule, true);
    assert.equal(plate.groups[0]!.seriesId, 's-p');
    assert.equal(plate.audit!.at(-1)!.event, 'rebase');
  });

  test('an activateFrom-only change marks staleSchedule — series embed the reveal date', async () => {
    await repo.putSeasonRun(
      'dolphins',
      run({
        id: 'sr-reveal',
        leagueKey: NO_SETUP,
        structureSnapshot: REVEAL_V1,
        stages: confirmedStages().filter((s) => s.specId === 'plate'),
      }),
    );
    const res = await rebase('sr-reveal', {
      structureId: 'st-reveal',
      structureVersion: 2,
      version: 1,
    });
    assert.equal(res.status, 200);
    const plate = ((await res.json()) as SeasonRun).stages.find((s) => s.specId === 'plate')!;
    assert.equal(plate.staleSchedule, true);
    assert.equal(plate.status, 'generated', 'groups are not cleared by a schedule change');
    assert.equal(plate.audit!.at(-1)!.event, 'rebase');
  });

  test('an unchanged stage is carried over verbatim — no audit entry', () => {
    assert.deepEqual(
      stage('untouched'),
      confirmedStages().find((s) => s.specId === 'untouched'),
    );
  });

  test('a removed spec drops its StageRun; a new spec gains an awaiting-entrants one', async () => {
    assert.equal(stage('dropped'), undefined);
    assert.deepEqual(stage('bowl'), {
      specId: 'bowl',
      status: 'awaiting-entrants',
      groups: [],
      audit: [],
    });
  });

  test('rebase audit entries are stamped server-side with the caller', () => {
    for (const specId of ['pools', 'ko', 'plate']) {
      const entry = stage(specId)!.audit!.at(-1)!;
      assert.equal(entry.by, 'admin@test', specId);
      assert.ok(entry.at && entry.at > '2026-09-01', `${specId} has a fresh timestamp`);
      assert.equal(entry.accepted, false);
    }
  });

  test('a later PATCH still strips a client-supplied snapshot — rebase is the only door', async () => {
    const current = await repo.getSeasonRun('dolphins', 'sr-rb');
    const res = await app.request('/season-runs/sr-rb', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        ...current,
        structureSnapshot: { ...V1, name: 'Rolled back by hand' },
        calendarSnapshot: { ...CALENDAR, label: 'Tampered' },
      }),
    });
    assert.equal(res.status, 200);
    const patched = (await res.json()) as SeasonRun;
    assert.equal(patched.structureSnapshot.version, 2);
    assert.equal(patched.structureSnapshot.name, 'Pools to knockout');
    assert.equal(patched.calendarSnapshot.label, '2026/27');
    // The PATCH round trip preserves the rebase's markers.
    assert.equal(patched.stages.find((s) => s.specId === 'plate')?.staleSchedule, true);
  });
});

describe('POST /season-runs/:id/rebase — dangling fromStage', () => {
  test('a derivation naming no live stage is reported as a warning', async () => {
    await repo.putSeasonRun(
      'dolphins',
      run({ id: 'sr-warn', leagueKey: NO_SETUP, structureSnapshot: LEGACY_V1, stages: [] }),
    );
    const res = await rebase('sr-warn', {
      structureId: 'st-legacy',
      structureVersion: 2,
      version: 1,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SeasonRun & { warnings?: string[] };
    assert.equal(body.structureSnapshot.version, 2);
    assert.equal(body.warnings?.length, 1);
    assert.match(body.warnings![0]!, /"Knockout" derives from a stage that no longer exists/);
    // The warning is informational — it is not persisted onto the run.
    assert.equal(
      ((await repo.getSeasonRun('dolphins', 'sr-warn')) as { warnings?: unknown }).warnings,
      undefined,
    );
  });
});

describe('pairingOverride guard on the season-run write paths', () => {
  test('PATCH 400s an unknown pairing override and persists a valid one', async () => {
    await repo.putSeasonRun('dolphins', run({ id: 'sr-po', stages: [] }));
    const bad = await app.request('/season-runs/sr-po', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: 1,
        stages: [{ specId: 'ko', status: 'ready', groups: [], pairingOverride: 'best-v-worst' }],
      }),
    });
    assert.equal(bad.status, 400);

    const good = await app.request('/season-runs/sr-po', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: 1,
        stages: [{ specId: 'ko', status: 'ready', groups: [], pairingOverride: 'within-pool' }],
      }),
    });
    assert.equal(good.status, 200);
    const stored = await repo.getSeasonRun('dolphins', 'sr-po');
    assert.equal(stored?.stages[0]?.pairingOverride, 'within-pool');
  });

  test('POST 400s an unknown pairing override', async () => {
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(
        startRunBody({
          id: 'sr-po-post',
          // One season per league per label: the directly-seeded runs hold '2026/27'.
          seasonLabel: 'po-post',
          stages: [{ specId: 'ko', status: 'ready', groups: [], pairingOverride: 'x' as never }],
        }),
      ),
    });
    assert.equal(res.status, 400);
    assert.equal(await repo.getSeasonRun('dolphins', 'sr-po-post'), null);

    // Control: the same body with a known override starts — so the 400 above was the
    // override, not the binding.
    const ok = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(
        startRunBody({
          id: 'sr-po-post',
          seasonLabel: 'po-post',
          stages: [{ specId: 'ko', status: 'ready', groups: [], pairingOverride: 'within-pool' }],
        }),
      ),
    });
    assert.equal(ok.status, 201, await ok.clone().text());
    const stored = await repo.getSeasonRun('dolphins', 'sr-po-post');
    assert.equal(stored?.structureSnapshot.version, V2.version, 'froze the live structure');
    assert.equal(stored?.stages[0]?.pairingOverride, 'within-pool');
  });
});

describe('the rebase root-format marker (formatChanged)', () => {
  const LEAGUE = 'fmt-league';
  const RUN = 'sr-fmt';
  const SERIES = `s-${RUN}-league-g1`;
  const LEAGUE_STAGE: StageSpec = {
    id: 'league',
    name: 'League',
    format: { kind: 'round-robin', legs: 1 },
    entrants: { kind: 'all-registered' },
    schedule: weekly(0),
  };
  const FMT_V1: CompetitionStructure = {
    id: 'st-fmt',
    name: 'One-Day League',
    version: 1,
    overs: 50,
    stages: [LEAGUE_STAGE],
  };
  // Same stages; only the ROOT name and overs change.
  const FMT_V2: CompetitionStructure = { ...FMT_V1, version: 2, name: 'T20 League', overs: 20 };

  const generate = (version: number) =>
    app.request(`/season-runs/${RUN}/stages/league/generate`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify({ version, confirmReleasedOverwrite: true }),
    });
  const stored = async (): Promise<SeasonRun> => (await repo.getSeasonRun('dolphins', RUN))!;
  const series = async (): Promise<Series> => (await repo.getSeries('dolphins', SERIES))!;

  before(async () => {
    for (const id of ['fmt-a', 'fmt-b', 'fmt-c', 'fmt-d'])
      await repo.putClub('dolphins', {
        id,
        name: `Club ${id}`,
        leagues: [LEAGUE],
        ground: { venue: `${id} Oval` },
        affiliation: 'complete',
      } as unknown as Club);
    await bindSetup(repo, 'dolphins', { leagueKey: LEAGUE, structure: FMT_V1, calendar: CALENDAR });
    const res = await app.request('/season-runs', {
      method: 'POST',
      headers: headers(ADMIN),
      body: JSON.stringify(startRunBody({ id: RUN, leagueKey: LEAGUE, seasonLabel: 'fmt' })),
    });
    assert.equal(res.status, 201, await res.clone().text());
    const gen = await generate(1);
    assert.equal(gen.status, 200, await gen.clone().text());
    const s = await series();
    assert.equal(s.seriesType, 'One-Day League');
    assert.equal(s.maxOvers, 50);
    // Released — and, like a competitions-era series, carrying its own format label.
    await repo.putSeries('dolphins', {
      ...s,
      seriesType: '50 Over (Red Ball)',
      maxOvers: 45,
      approved: true,
      released: true,
      releasedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  test('a regenerate WITHOUT the marker keeps a released series’ stored seriesType/maxOvers', async () => {
    const res = await generate((await stored()).version);
    assert.equal(res.status, 200, await res.clone().text());
    const s = await series();
    assert.equal(s.released, true);
    assert.equal(s.seriesType, '50 Over (Red Ball)');
    assert.equal(s.maxOvers, 45);
  });

  test('a rebase onto a new root name/overs stamps formatChanged on every surviving stage', async () => {
    const cfg = await repo.getTenantConfig('dolphins');
    await repo.putTenantConfig({
      ...cfg!,
      structures: (cfg!.structures ?? []).map((st) => (st.id === FMT_V2.id ? FMT_V2 : st)),
    });
    const res = await rebase(RUN, {
      structureId: FMT_V2.id,
      structureVersion: 2,
      version: (await stored()).version,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as SeasonRun;
    assert.equal(body.stages.length, 1);
    assert.equal(body.stages[0]!.formatChanged, true);
    // The stage spec itself is unchanged: no audit entry, groups kept.
    assert.equal(body.stages[0]!.groups[0]!.seriesId, SERIES);
    assert.equal((await stored()).stages[0]!.formatChanged, true, 'stored, not response-only');
  });

  test('a client can neither clear the marker nor set it through PATCH or POST', async () => {
    const current = await stored();
    const res = await app.request(`/season-runs/${RUN}`, {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: current.version,
        stages: current.stages.map(({ formatChanged: _fc, ...st }) => st),
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await stored()).stages[0]!.formatChanged, true, 'the stored marker is replayed');

    const other = await repo.getSeasonRun('dolphins', 'sr-po');
    const set = await app.request('/season-runs/sr-po', {
      method: 'PATCH',
      headers: headers(ADMIN),
      body: JSON.stringify({
        version: other!.version,
        stages: [{ specId: 'ko', status: 'ready', groups: [], formatChanged: true }],
      }),
    });
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal(
      (await repo.getSeasonRun('dolphins', 'sr-po'))!.stages[0]!.formatChanged,
      undefined,
    );
  });

  test('the next generate adopts the new name/overs and clears the marker', async () => {
    const res = await generate((await stored()).version);
    assert.equal(res.status, 200, await res.clone().text());
    const s = await series();
    assert.equal(s.released, true, 'still published');
    assert.equal(s.seriesType, 'T20 League');
    assert.equal(s.maxOvers, 20);
    assert.equal((await stored()).stages[0]!.formatChanged, undefined);
  });

  test('after that, a regenerate keeps the adopted format', async () => {
    await repo.putSeries('dolphins', { ...(await series()), seriesType: 'Kept label' });
    const res = await generate((await stored()).version);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await series()).seriesType, 'Kept label');
  });
});

describe('rebase follows the league’s current setup structure', () => {
  const LEAGUE = 'clone-league';
  // The migration's per-league clone / a per-season fork: same stage ids as the original,
  // its own id, name and overs.
  const CLONE: CompetitionStructure = {
    ...V2,
    id: 'st-rb-clone-league',
    name: 'Pools to knockout (Clone League)',
    version: 1,
    overs: 50,
  };
  const onClone = (id: string, over: Partial<SeasonRun> = {}) =>
    run({ id, leagueKey: LEAGUE, structureSnapshot: V1, ...over });

  before(async () => {
    await bindSetup(repo, 'dolphins', { leagueKey: LEAGUE, structure: CLONE, calendar: CALENDAR });
  });

  test('the league’s setup structure is the target — not the snapshot’s original', async () => {
    await repo.putSeasonRun('dolphins', onClone('sr-clone'));
    const res = await rebase('sr-clone', {
      structureId: CLONE.id,
      structureVersion: CLONE.version,
      version: 1,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as SeasonRun;
    assert.equal(body.structureSnapshot.id, CLONE.id);
    assert.equal(body.structureSnapshot.name, CLONE.name);
    assert.equal(body.version, 2);
    // Stage ids carried over, so the reconciliation is stage by stage, as with a version bump.
    const pools = body.stages.find((s) => s.specId === 'pools')!;
    assert.equal(pools.status, 'awaiting-entrants');
    assert.equal(
      body.stages.find((s) => s.specId === 'dropped'),
      undefined,
    );
    assert.ok(body.stages.find((s) => s.specId === 'bowl'));
    // The root name/overs moved, so every survivor adopts them on its next generate.
    assert.ok(
      body.stages.filter((s) => s.specId !== 'bowl').every((s) => s.formatChanged === true),
    );
  });

  test('a client that reviewed the original structure is a 409 structure_changed', async () => {
    await repo.putSeasonRun('dolphins', onClone('sr-clone-stale'));
    const res = await rebase('sr-clone-stale', {
      structureId: 'st-rb',
      structureVersion: 2,
      version: 1,
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, 'structure_changed');
    const stored = await repo.getSeasonRun('dolphins', 'sr-clone-stale');
    assert.equal(stored?.structureSnapshot.id, 'st-rb');
    assert.equal(stored?.version, 1);
  });

  test('editing the ORIGINAL no longer produces skew for a run already on the clone', async () => {
    await repo.putSeasonRun('dolphins', onClone('sr-clone-noop', { structureSnapshot: CLONE }));
    const cfg = await repo.getTenantConfig('dolphins');
    await repo.putTenantConfig({
      ...cfg!,
      structures: (cfg!.structures ?? []).map((st) =>
        st.id === V2.id ? { ...V2, version: 3, overs: 20 } : st,
      ),
    });
    try {
      const target = rebaseTargetFor(
        (await repo.getSeasonRun('dolphins', 'sr-clone-noop'))!,
        await repo.getTenantConfig('dolphins'),
      );
      assert.equal(target?.id, CLONE.id);
      assert.equal(target?.version, CLONE.version);
      // Nothing to adopt: the original's v3 is never offered, and applying is a no-op.
      const res = await rebase('sr-clone-noop', {
        structureId: CLONE.id,
        structureVersion: CLONE.version,
        version: 1,
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as SeasonRun;
      assert.equal(body.version, 1);
      assert.equal(body.structureSnapshot.overs, 50);
      const toOriginal = await rebase('sr-clone-noop', {
        structureId: V2.id,
        structureVersion: 3,
        version: 1,
      });
      assert.equal(toOriginal.status, 409);
    } finally {
      const after = await repo.getTenantConfig('dolphins');
      await repo.putTenantConfig({
        ...after!,
        structures: (after!.structures ?? []).map((st) => (st.id === V2.id ? V2 : st)),
      });
    }
  });
});
