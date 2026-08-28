/**
 * END-TO-END tests for the Plan B fixture importer (src/import-planb-fixtures.ts) and its
 * post-import comparison tool (src/compare-planb-fixtures.ts).
 *
 * Unlike import-planb.test.ts (pure-helper unit tests), this drives the REAL importer as a
 * CHILD PROCESS against an in-process dynalite table seeded from a read-only export of the
 * LIVE prod `dolphins` tenant, and asserts on observable outcomes only: the child's exit
 * code, its stdout/stderr, and the rows it actually stored (read back via repo.ts / a raw
 * Query). No mocks, no stubs — real ExcelJS workbooks, the real repo layer, the real CLI.
 *
 * ── Why it is environment-gated ──────────────────────────────────────────────────────────
 * The two source workbooks and the three prod-snapshot JSON files live only on the author's
 * machine (they contain club-contact PII and must NEVER enter the repo), so CI cannot run
 * this. When either env var below is unset the suite registers a single SKIPPED test rather
 * than failing, so `npm test` stays green everywhere.
 *
 *   PLANB_SHEETS_DIR   a directory containing BOTH workbooks, with these exact names:
 *                        - "KZNCU Dolphins Updated Fixtures.xlsx"
 *                        - "KZNCU_2026-27_T20_Fixtures_Premier_and_Promotion_REVISED.xlsx"
 *   PLANB_SEED_DIR     a directory containing the three raw DynamoDB Query exports:
 *                        - prod-series-raw.json  (25 series)
 *                        - prod-clubs-raw.json   (39 clubs)
 *                        - prod-tenant-raw.json  (CONFIG + 73 VENUE + EXPORT rows)
 *
 * ── How to run it ────────────────────────────────────────────────────────────────────────
 *   cd packages/api
 *   PLANB_SHEETS_DIR=/Users/you/Downloads \
 *   PLANB_SEED_DIR=/path/to/scratchpad \
 *   npx tsx --test test/import-planb.e2e.test.ts
 *
 * See docs/runbooks/planb-fixtures-import.md → "Local rehearsal (e2e test)".
 *
 * ── Harness ──────────────────────────────────────────────────────────────────────────────
 * In-process dynalite on port 4627 (next free odd port after progressive-release's 4625).
 * The single table is created EXACTLY as src/local/server.ts creates it (pk/sk + gsi1). The
 * raw JSON items are already marshalled, so they are seeded straight through BatchWriteItem.
 * A FRESH table is delete+recreated and re-seeded before EACH scenario (beforeEach), so the
 * scenarios are independent. The importer runs via `tsx src/import-planb-fixtures.ts` with a
 * throwaway temp cwd (so its `./planb-backup-*.json` never lands in the repo) and the env
 * repo.ts reads (TABLE_NAME, DYNAMO_ENDPOINT, AWS creds, STAGE). dynalite runs in THIS
 * process, so the child is spawned async (never spawnSync — that would block the event loop
 * serving dynalite and deadlock the child).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Series } from '../src/types.js';

const SHEETS_DIR = process.env.PLANB_SHEETS_DIR;
const SEED_DIR = process.env.PLANB_SEED_DIR;
const ENABLED = Boolean(SHEETS_DIR && SEED_DIR);

const DDB_PORT = 4627; // next free ODD port after progressive-release (4625); local-uploads (4623), reps (4621), structure-intake (4619)
const TABLE = 'SmartClubPlanbE2E';
const TENANT = 'dolphins';
const ENDPOINT = `http://localhost:${DDB_PORT}`;

// Env repo.ts reads at module load — set BEFORE importing repo.js below.
process.env.TABLE_NAME = TABLE;
process.env.DYNAMO_ENDPOINT = ENDPOINT;
process.env.AWS_REGION ??= 'localhost';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.STAGE = 'local';
process.env.AWS_MAX_ATTEMPTS = '1';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(testDir, '..');
const TSX_BIN = path.join(API_DIR, 'node_modules', '.bin', 'tsx');
const IMPORTER = path.join(API_DIR, 'src', 'import-planb-fixtures.ts');
const COMPARE = path.join(API_DIR, 'src', 'compare-planb-fixtures.ts');

const DOLPHINS_FILE = path.join(SHEETS_DIR ?? '', 'KZNCU Dolphins Updated Fixtures.xlsx');
const REVISED_FILE = path.join(
  SHEETS_DIR ?? '',
  'KZNCU_2026-27_T20_Fixtures_Premier_and_Promotion_REVISED.xlsx',
);

// ── Types for reading rows back (a subset of the stored Series shape) ──
interface Fix {
  id: string;
  round?: number;
  date?: string;
  time?: string;
  home: string;
  away: string;
  venueName?: string;
  venueReason?: string;
  status?: string;
}
interface StoredSeries {
  id: string;
  version: number;
  approved?: boolean;
  released?: boolean;
  releasedAt?: string | null;
  withheld?: Record<string, boolean>;
  revealedAt?: Record<string, string>;
  startDate?: string;
  teams: string[];
  participants?: Array<{ teamId: string; clubId: string; name: string }>;
  fixtures: Fix[];
}

if (!ENABLED) {
  describe('Plan B importer end-to-end', () => {
    test(
      'SKIPPED — set PLANB_SHEETS_DIR and PLANB_SEED_DIR to run (see docs/runbooks/planb-fixtures-import.md)',
      { skip: 'PLANB_SHEETS_DIR and/or PLANB_SEED_DIR not set' },
      () => {},
    );
  });
} else {
  // Dynamic so the env above is in place first.
  let ddb: import('@aws-sdk/client-dynamodb').DynamoDBClient;
  let ddbMod: typeof import('@aws-sdk/client-dynamodb');
  let repo: typeof import('../src/repo.js');
  let ddbServer: Server;
  let workDir: string; // holds perturbed workbooks + per-run backup cwds

  const rawItems = (file: string): Record<string, unknown>[] => {
    const parsed = JSON.parse(readFileSync(path.join(SEED_DIR!, file), 'utf8')) as {
      Items?: Record<string, unknown>[];
    };
    return parsed.Items ?? [];
  };

  const createTable = async () => {
    const { CreateTableCommand } = ddbMod;
    await ddb.send(
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
  };

  const deleteTableAndWait = async () => {
    const { DeleteTableCommand, DescribeTableCommand } = ddbMod;
    try {
      await ddb.send(new DeleteTableCommand({ TableName: TABLE }));
    } catch {
      /* not there yet */
    }
    // dynalite deletes asynchronously — poll until it is really gone so the recreate below
    // can't race a ResourceInUseException.
    for (let i = 0; i < 200; i++) {
      try {
        await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
      } catch (e) {
        if ((e as { name?: string }).name === 'ResourceNotFoundException') return;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  const seed = async () => {
    const { BatchWriteItemCommand } = ddbMod;
    const items = [
      ...rawItems('prod-series-raw.json'),
      ...rawItems('prod-clubs-raw.json'),
      ...rawItems('prod-tenant-raw.json'),
    ];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item: Item as never } }));
      await ddb.send(new BatchWriteItemCommand({ RequestItems: { [TABLE]: batch } }));
    }
  };

  /** Run the importer/compare CLI as a child process against the seeded table. Each call
   *  gets a fresh throwaway cwd so a `--confirm` run's backup file is isolated and never
   *  reaches the repo. Returns exit code, combined stdout+stderr, and the cwd used. */
  const runCli = (
    script: string,
    args: string[],
  ): Promise<{ code: number | null; out: string; cwd: string }> => {
    const cwd = mkdtempSync(path.join(workDir, 'run-'));
    return new Promise((resolve) => {
      const child = spawn(TSX_BIN, [script, ...args], {
        cwd,
        env: {
          ...process.env,
          TABLE_NAME: TABLE,
          DYNAMO_ENDPOINT: ENDPOINT,
          AWS_REGION: 'localhost',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          STAGE: 'local',
          AWS_MAX_ATTEMPTS: '1',
        },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out, cwd }));
    });
  };

  const importArgs = (...extra: string[]) => [
    '--file',
    DOLPHINS_FILE,
    '--t20',
    REVISED_FILE,
    ...extra,
  ];
  const runImport = (...extra: string[]) => runCli(IMPORTER, importArgs(...extra));

  const listPlanb = async (): Promise<StoredSeries[]> => {
    const all = (await repo.listSeries(TENANT)) as unknown as StoredSeries[];
    return all.filter((s) => String(s.id).startsWith('s-planb-'));
  };
  const getSeries = async (id: string): Promise<StoredSeries | null> =>
    (await repo.getSeries(TENANT, id)) as unknown as StoredSeries | null;
  const versionMap = async (): Promise<Map<string, number>> =>
    new Map((await listPlanb()).map((s) => [s.id, s.version]));

  /** Export the local table's series as the raw DynamoDB Query JSON the compare tool wants. */
  const exportSeriesJson = async (): Promise<string> => {
    const { QueryCommand } = ddbMod;
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :p',
        ExpressionAttributeValues: { ':p': { S: `TENANT#${TENANT}#TYPE#SERIES` } },
      }),
    );
    const file = path.join(mkdtempSync(path.join(workDir, 'exp-')), 'series.json');
    writeFileSync(file, JSON.stringify({ Items: res.Items ?? [] }));
    return file;
  };

  /** Load the Dolphins workbook fresh, mutate it, and save a perturbed copy in workDir.
   *  The Downloads original is never touched. */
  const perturbDolphins = async (
    mutate: (wb: ExcelJS.Workbook) => void,
    name: string,
  ): Promise<string> => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(DOLPHINS_FILE);
    mutate(wb);
    const out = path.join(workDir, name);
    await wb.xlsx.writeFile(out);
    return out;
  };
  const sheet = (wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet => {
    const ws = wb.worksheets.find((w) => w.name.trim() === name);
    assert.ok(ws, `worksheet "${name}" not found`);
    return ws;
  };

  const countOccurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  before(async () => {
    ddbMod = await import('@aws-sdk/client-dynamodb');
    const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
    ddbServer = dynalite({ createTableMs: 0 });
    await new Promise<void>((resolve) => ddbServer.listen(DDB_PORT, resolve));
    ddb = new ddbMod.DynamoDBClient({
      endpoint: ENDPOINT,
      region: 'localhost',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    repo = await import('../src/repo.js');
    workDir = mkdtempSync(path.join(os.tmpdir(), 'planb-e2e-'));
  });

  after(async () => {
    await new Promise<void>((resolve) => ddbServer.close(() => resolve()));
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await deleteTableAndWait();
    await createTable();
    await seed();
  });

  // Snapshot facts asserted against (from prod-series-raw.json): the 23 series the import
  // OVERWRITES, plus the 2 keep-list series it never touches.
  const KEEP_LIST = ['s-planb-promotion-men-50ov-g1', 's-planb-promotion-men-50ov-g2'];
  const KLOOF_DIRECTIVE_GROUNDS = ['Peace Park', 'Fairfield Park', 'Malvern Park'];
  const WEEKENDS: Record<number, string[]> = {
    1: ['2026-10-24', '2026-10-25'],
    2: ['2026-11-21', '2026-11-22'],
    3: ['2027-01-23', '2027-01-24'],
    4: ['2027-02-20', '2027-02-21'],
  };

  describe('Plan B importer end-to-end', () => {
    // ─────────────────────────── Happy path ───────────────────────────

    test('1. --parse-only: parses clean, no repo touched', async () => {
      const { code, out } = await runImport('--parse-only');
      assert.equal(code, 0, out);
      // Promotion Women ga/gb/gc each 40, Premier Women g2 each 5.
      assert.ok(out.includes('promotion-women-t20-ga'));
      assert.equal(
        countOccurrences(out, '✓ 40 fixtures (expected 40)'),
        3,
        'ga/gb/gc should each parse 40',
      );
      assert.ok(out.includes('premier-women-t20-g2'));
      assert.ok(out.includes('✓ 5 fixtures (expected 5)'));
      assert.ok(!out.includes('Orphan fixture rows'), 'no orphan block on a clean parse');
      assert.ok(out.includes('Parsing clean'));
    });

    test('2. dry run: writes nothing, resolves names, three Kloof moves, clash-pass clean, 23 to write', async () => {
      const before = await versionMap();
      const { code, out } = await runImport();
      assert.equal(code, 0, out);

      // No series row changed.
      const after = await versionMap();
      assert.deepEqual([...after].sort(), [...before].sort(), 'dry run must not change any row');

      // Name-resolution sign-off: Parkgate resolved, zero unresolved names.
      assert.ok(out.includes('Name resolution sign-off'));
      assert.ok(out.includes('"Parkgate" → Parkgate Hambanathi CC (parkgate-hambanathi-cc)'));
      assert.ok(!out.includes('did not resolve'), 'no unresolved team names');

      // Three premier-men-t20-1 Kloof CC directive moves onto a directive candidate.
      const kloofMoves = out
        .split('\n')
        .filter((l) => /s-planb-premier-men-t20-1 f\d+: Kloof CC →/.test(l));
      assert.equal(kloofMoves.length, 3, 'exactly three Kloof CC directive moves');
      const grounds = kloofMoves.map((l) => l.match(/Kloof CC → ([^[]+?) \[/)?.[1]?.trim());
      for (const g of grounds)
        assert.ok(
          g && KLOOF_DIRECTIVE_GROUNDS.includes(g),
          `Kloof move target "${g}" must be a directive candidate`,
        );
      // FINDING (recorded): all three land on Peace Park.
      assert.deepEqual(grounds, ['Peace Park', 'Peace Park', 'Peace Park']);

      // Clash-pass outcome, verbatim: no unresolved clashes, with auto-moves.
      assert.ok(out.includes('✓ no unresolved clashes'), 'clash pass resolved everything');
      assert.ok(!out.includes('unresolved clash(es)'));
      assert.match(out, /\d+ auto-move\(s\)/);
      assert.ok(out.includes('skipped, ground undeterminable: 0'));

      // GENUINE-edits section empty; 23 to write.
      assert.ok(
        !out.includes('GENUINE edits'),
        'no genuine admin edits against a matched snapshot',
      );
      assert.ok(out.includes('23 series to write.'));
      assert.ok(out.includes('[dry-run] nothing written'));
    });

    test('3. --confirm: writes 23, lifecycle preserved, versions +1, ga/gb/gc=40, keep-list untouched', async () => {
      const before = await versionMap();
      const { code, out, cwd } = await runImport('--confirm');
      assert.equal(code, 0, out);

      // A backup file was written (into the throwaway cwd, not the repo).
      const backups = readdirSync(cwd).filter((f) => /^planb-backup-.*\.json$/.test(f));
      assert.equal(backups.length, 1, 'exactly one backup file written');

      const after = new Map((await listPlanb()).map((s) => [s.id, s]));

      // 23 written (everything except the 2 keep-list), version bumped by exactly 1.
      const written = [...before.keys()].filter((id) => !KEEP_LIST.includes(id));
      assert.equal(written.length, 23);
      for (const id of written) {
        const s = after.get(id)!;
        assert.equal(s.version, before.get(id)! + 1, `${id} version should bump by 1`);
      }
      // Keep-list untouched.
      for (const id of KEEP_LIST) {
        assert.equal(after.get(id)!.version, before.get(id)!, `${id} must be untouched`);
      }

      // Lifecycle preserved (a series that was approved+unreleased stays so).
      const pt1 = after.get('s-planb-premier-men-t20-1')!;
      assert.equal(pt1.approved, true);
      assert.equal(pt1.released, false);

      // Promotion Women ga/gb/gc now 40 fixtures with rounds 1–4 → the four weekends.
      for (const g of ['ga', 'gb', 'gc']) {
        const s = after.get(`s-planb-promotion-women-t20-${g}`)!;
        assert.equal(s.fixtures.length, 40, `${g} should have 40 fixtures`);
        const byRound: Record<number, Set<string>> = {};
        for (const f of s.fixtures) (byRound[f.round!] ??= new Set()).add(f.date!);
        for (const round of [1, 2, 3, 4])
          assert.deepEqual(
            [...(byRound[round] ?? [])].sort(),
            WEEKENDS[round],
            `${g} round ${round} weekend dates`,
          );
      }

      // Premier Women g2 has 5.
      assert.equal(after.get('s-planb-premier-women-t20-g2')!.fixtures.length, 5);

      // Promotion Men 30-over split: top10 has umlazi not simplex; bottom10 mirrors.
      const top10 = after.get('s-planb-promotion-men-30ov-top10')!;
      const bot10 = after.get('s-planb-promotion-men-30ov-bottom10')!;
      assert.ok(top10.teams.includes('umlazi-cricket-club'));
      assert.ok(!top10.teams.includes('simplex-reservoir-hills-crimson'));
      assert.ok(bot10.teams.includes('simplex-reservoir-hills-crimson'));
      assert.ok(!bot10.teams.includes('umlazi-cricket-club'));

      // Hillary Malvern's 3 Premier T20 HOME fixtures carry the directive venue.
      const hm = pt1.participants!.find((p) => p.clubId === 'hillary-malvern-cricket-club')!.teamId;
      const hmHome = pt1.fixtures.filter((f) => f.home === hm);
      const directiveHome = hmHome.filter((f) =>
        (f.venueReason ?? '').startsWith('Union directive'),
      );
      assert.equal(directiveHome.length, 3, 'three Hillary Malvern home directive fixtures');
      for (const f of directiveHome) assert.ok(KLOOF_DIRECTIVE_GROUNDS.includes(f.venueName ?? ''));
    });

    test('4. compare tool after confirm: only-sheet/only-plat 0, venue diffs are alias auto-moves + 3 directive lines', async () => {
      const confirm = await runImport('--confirm');
      assert.equal(confirm.code, 0, confirm.out);

      const seriesJson = await exportSeriesJson();
      const clubsJson = path.join(SEED_DIR!, 'prod-clubs-raw.json');
      const { code, out } = await runCli(COMPARE, [
        '--file',
        DOLPHINS_FILE,
        '--t20',
        REVISED_FILE,
        '--series-json',
        seriesJson,
        '--clubs-json',
        clubsJson,
      ]);
      assert.equal(code, 0, out);

      // No fixtures only-in-sheet or only-on-platform.
      const total = out.split('\n').find((l) => /^\s*TOTAL\s+\d/.test(l));
      assert.ok(total, 'summary TOTAL row present');
      const nums = total!.trim().split(/\s+/).slice(1).map(Number); // onlySheet onlyPlat changed venueDiff
      assert.equal(nums[0], 0, 'only-sheet must be 0');
      assert.equal(nums[1], 0, 'only-platform must be 0');

      // Every venue-diff line is either an import-authored alias auto-move OR one of the
      // three Peace Park directive lines — nothing "genuine".
      const venueLines = out.split('\n').filter((l) => /venue "/.test(l));
      const directive = venueLines.filter((l) => /Union directive/.test(l));
      const autoMove = venueLines.filter((l) => /\[import-authored auto-move\]/.test(l));
      const neither = venueLines.filter(
        (l) => !/Union directive/.test(l) && !/\[import-authored auto-move\]/.test(l),
      );
      assert.equal(directive.length, 3, 'exactly three Kloof→Peace Park directive venue diffs');
      assert.equal(neither.length, 0, 'no unexplained venue diffs');
      assert.ok(autoMove.length > 0, 'the remaining venue diffs are alias auto-moves');
      // Every non-T20 slug matches cleanly.
      assert.ok(out.includes('✓ matches'));
    });

    test('5. idempotent re-run of --confirm: versions bump again, fixture content identical', async () => {
      const before = await versionMap();
      const first = await runImport('--confirm');
      assert.equal(first.code, 0, first.out);
      const afterFirst = await getSeries('s-planb-promotion-women-t20-ga');

      const second = await runImport('--confirm');
      assert.equal(second.code, 0, second.out);
      const afterSecond = await getSeries('s-planb-promotion-women-t20-ga');

      assert.equal(afterFirst!.version, before.get('s-planb-promotion-women-t20-ga')! + 1);
      assert.equal(afterSecond!.version, afterFirst!.version + 1, 'second run bumps version again');
      assert.deepEqual(
        afterSecond!.fixtures,
        afterFirst!.fixtures,
        'fixture content identical across idempotent re-runs',
      );
    });

    test('6. lifecycle + progressive-release masking preserved across a confirm', async () => {
      const target = 's-planb-premier-men-t20-1';
      const cur = (await getSeries(target))!;
      await repo.putSeries(TENANT, {
        ...(cur as unknown as Series),
        released: true,
        releasedAt: '2026-08-20T00:00:00.000Z',
        approved: true,
        withheld: { venue: true, time: true },
        revealedAt: { venue: '2026-08-27T00:00:00Z' },
      } as unknown as Series);

      const { code, out } = await runImport('--confirm');
      assert.equal(code, 0, out);
      const wrote = out.split('\n').find((l) => l.includes(`wrote ${target}`));
      assert.ok(wrote, 'the overwrite line for the target series is printed');
      assert.ok(wrote!.includes('(withheld: venue,time)'), `expected withheld note, got: ${wrote}`);

      const after = (await getSeries(target))!;
      assert.equal(after.released, true, 'released preserved');
      assert.equal(after.approved, true, 'approved preserved');
      assert.deepEqual(after.withheld, { venue: true, time: true }, 'withheld preserved');
      assert.deepEqual(after.revealedAt, { venue: '2026-08-27T00:00:00Z' }, 'revealedAt preserved');
    });

    // ─────────────────────────── Failure modes ───────────────────────────

    test('7. dropped Premier Men 50-over row: count gate fails closed; bypass then hits the shrink edit-gate', async () => {
      // Blank the home cell of a 50-Over Top-6 fixture (row 51) → the section parses 29.
      const file = await perturbDolphins((wb) => {
        sheet(wb, 'Premier Men').getCell('A51').value = '';
      }, 's7.xlsx');

      const def = await runCli(IMPORTER, ['--file', file, '--t20', REVISED_FILE]);
      assert.equal(def.code, 1, def.out);
      assert.ok(def.out.includes('Refusing to continue'));
      assert.ok(
        def.out.includes('parsed 29 fixtures (expected 30)'),
        'the count mismatch is named',
      );

      // FINDING: --allow-count-mismatch bypasses the COUNT gate, but against the seeded
      // prod snapshot the dropped row leaves a prod-only fixture id (the shrink), which the
      // admin-edit gate treats as a GENUINE edit — so the run still fails closed (this is the
      // documented "a revision that DROPS fixtures must be READ, not waved through" rail).
      const allow = await runCli(IMPORTER, [
        '--file',
        file,
        '--t20',
        REVISED_FILE,
        '--allow-count-mismatch',
      ]);
      assert.equal(allow.code, 1, allow.out);
      assert.ok(!allow.out.includes('parsed 29 fixtures (expected 30)'), 'count gate was bypassed');
      assert.ok(
        allow.out.includes('existing series carry admin edits'),
        'the shrink trips the admin-edit gate instead',
      );

      // With BOTH escape hatches the dry run proceeds (exit 0) and still writes nothing.
      const before = await versionMap();
      const both = await runCli(IMPORTER, [
        '--file',
        file,
        '--t20',
        REVISED_FILE,
        '--allow-count-mismatch',
        '--discard-edits',
      ]);
      assert.equal(both.code, 0, both.out);
      assert.ok(both.out.includes('series to write.'));
      assert.ok(both.out.includes('[dry-run] nothing written'));
      assert.deepEqual(await versionMap(), before, 'dry run wrote nothing');
    });

    test('8. unknown section header → orphan rows, always fatal (even with --allow-count-mismatch)', async () => {
      const file = await perturbDolphins((wb) => {
        sheet(wb, 'Premier Women').getCell('A1').value = 'T20 Premier Ladies Group 1';
      }, 's8.xlsx');

      const res = await runCli(IMPORTER, ['--file', file, '--t20', REVISED_FILE]);
      assert.equal(res.code, 1, res.out);
      assert.ok(res.out.includes('orphan fixture row(s)'));
      assert.ok(res.out.includes('Orphan fixture rows'), 'the orphan lines are printed');
      assert.ok(res.out.includes('Refusing to continue'));

      const allow = await runCli(IMPORTER, [
        '--file',
        file,
        '--t20',
        REVISED_FILE,
        '--allow-count-mismatch',
      ]);
      assert.equal(allow.code, 1, 'a 0-fixture/orphan section is always fatal');
      assert.ok(allow.out.includes('orphan fixture row(s)'));
    });

    test('9. unknown team name aborts, naming the unresolved name; nothing written', async () => {
      const file = await perturbDolphins((wb) => {
        // "Umzinto" in the 50-Over Bottom-6 section (row 102) → an unresolvable name.
        sheet(wb, 'Premier Men').getCell('A102').value = 'Umzintooo';
      }, 's9.xlsx');

      const before = await versionMap();
      const res = await runCli(IMPORTER, ['--file', file, '--t20', REVISED_FILE, '--confirm']);
      assert.equal(res.code, 1, res.out);
      assert.ok(res.out.includes('did not resolve to a club'));
      assert.ok(res.out.includes('"Umzintooo"'));
      assert.deepEqual(await versionMap(), before, 'nothing written on an unresolved name');
    });

    test('10. Premier T20 pair-set asymmetry between the two files aborts', async () => {
      const file = await perturbDolphins((wb) => {
        // Row 3 "Umzinto v African Warriors" → "Umzinto v Crusaders": a pair the REVISED
        // Premier sheet does not contain (and drops one it does).
        sheet(wb, 'Premier Men').getCell('E3').value = 'Crusaders';
      }, 's10.xlsx');

      const res = await runCli(IMPORTER, ['--file', file, '--t20', REVISED_FILE]);
      assert.equal(res.code, 1, res.out);
      assert.ok(res.out.includes('pair-set asymmetry'));
      assert.ok(res.out.includes('Refusing to continue'));
    });

    test('11. venue clash against a seeded released series: auto-moved (not aborted); reason stored', async () => {
      // Seed an extra RELEASED series occupying Siripat 1 on 2026-09-27 09:00 — the slot of
      // the incoming promotion-men-t20-g1 f1 (Simplex RHCC v Spartan Sporting).
      await repo.putSeries(TENANT, {
        id: 's-clash-probe',
        name: 'Clash Probe',
        leagueKey: 'promotion',
        startDate: '2026-09-27',
        endDate: '2026-09-27',
        kind: 'series',
        approved: true,
        approvedAt: '2026-08-01T00:00:00.000Z',
        released: true,
        releasedAt: '2026-08-01T00:00:00.000Z',
        version: 1,
        teams: ['probe-a', 'probe-b'],
        participants: [
          { teamId: 'probe-a', clubId: 'probe-a', name: 'Probe A' },
          { teamId: 'probe-b', clubId: 'probe-b', name: 'Probe B' },
        ],
        fixtures: [
          {
            id: 'f1',
            round: 1,
            date: '2026-09-27',
            time: '09:00',
            home: 'probe-a',
            away: 'probe-b',
            venueName: 'Siripat 1',
          },
        ],
      } as unknown as Series);

      // Dry run: the clash is reported and auto-moved; the run does NOT abort.
      const dry = await runImport();
      assert.equal(dry.code, 0, dry.out);
      const moveLine = dry.out
        .split('\n')
        .find(
          (l) => /s-planb-promotion-men-t20-g1 f1:/.test(l) && /clashed with s-clash-probe/.test(l),
        );
      assert.ok(moveLine, 'g1 f1 is auto-moved off Siripat 1 to avoid s-clash-probe');
      assert.ok(dry.out.includes('✓ no unresolved clashes'));

      // Confirm and read back: the moved fixture stores a "Moved to avoid ..." reason.
      const conf = await runImport('--confirm');
      assert.equal(conf.code, 0, conf.out);
      const g1 = (await getSeries('s-planb-promotion-men-t20-g1'))!;
      const f1 = g1.fixtures.find((f) => f.id === 'f1')!;
      assert.ok(
        (f1.venueReason ?? '').startsWith('Moved to avoid'),
        `expected a Moved-to-avoid reason, got: ${f1.venueReason}`,
      );
      assert.notEqual(f1.venueName, 'Siripat 1', 'the fixture moved off the clashing ground');
    });

    test('12. genuine admin edit (completed fixture) gates --confirm; --discard-edits overwrites it', async () => {
      const target = 's-planb-premier-men-t20-1';
      const cur = (await getSeries(target))!;
      cur.fixtures[0].status = 'completed';
      await repo.putSeries(TENANT, cur as unknown as Series);

      const gated = await runImport('--confirm');
      assert.equal(gated.code, 1, gated.out);
      assert.ok(gated.out.includes('GENUINE'));
      assert.ok(gated.out.includes(`${target}: fixture f1 has status "completed"`));
      assert.ok(gated.out.includes('refusing to overwrite'));

      const discard = await runImport('--confirm', '--discard-edits');
      assert.equal(discard.code, 0, discard.out);
      const after = (await getSeries(target))!;
      const f1 = after.fixtures.find((f) => f.id === 'f1')!;
      assert.equal(f1.status, undefined, 'the completed status is discarded (documented effect)');
    });

    test('13. prune / revert dry runs list the right sets and write nothing', async () => {
      const before = await versionMap();

      // Prune: none of the 4 superseded DELETE_SLUGS exist in the snapshot.
      const prune = await runCli(IMPORTER, ['--prune']);
      assert.equal(prune.code, 0, prune.out);
      assert.ok(prune.out.includes('Nothing to prune'));

      // Revert (dry) lists the 23 imported series, excluding the 2 keep-list.
      const revert = await runCli(IMPORTER, ['--revert']);
      assert.equal(revert.code, 0, revert.out);
      assert.equal(
        countOccurrences(revert.out, '[dry-run] would delete'),
        23,
        'revert lists 23 (keep-list excluded)',
      );
      assert.ok(revert.out.includes('Keeping 2 series'));

      // Revert --all (dry) lists all 25.
      const revertAll = await runCli(IMPORTER, ['--revert', '--all']);
      assert.equal(revertAll.code, 0, revertAll.out);
      assert.equal(countOccurrences(revertAll.out, '[dry-run] would delete'), 25);

      assert.deepEqual(await versionMap(), before, 'dry prune/revert wrote nothing');
    });

    test('14. flag validation: prune+revert and unknown flags fail with the usage error', async () => {
      const both = await runCli(IMPORTER, ['--prune', '--revert']);
      assert.equal(both.code, 1, both.out);
      assert.ok(both.out.includes('mutually exclusive'));

      const unknown = await runCli(IMPORTER, ['--frobnicate']);
      assert.equal(unknown.code, 1, unknown.out);
      assert.ok(unknown.out.includes('unknown flag'));
    });
  });
}
