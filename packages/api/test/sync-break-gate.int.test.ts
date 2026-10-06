/**
 * The sync-break gate on the Plan-B importer CLI (ADR 0016): on a tenant with
 * `features.medicoachSync`, --revert / --prune would orphan fixture refs medicoach holds
 * results against, so they exit non-zero unless --allow-sync-break, printing the refs.
 *
 * Drives the REAL CLI as a child process (like import-planb.e2e.test.ts) against an
 * in-process dynalite table; asserts on the exit code, the output and what is stored.
 * No workbooks needed: revert/prune read only the stored series.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4661; // next free odd port after 4659
const TABLE = 'SmartClubSyncBreakGate';
dynaliteEnv(DDB_PORT, TABLE);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(testDir, '..');
const TSX_BIN = path.join(API_DIR, 'node_modules', '.bin', 'tsx');
const IMPORTER = path.join(API_DIR, 'src', 'import-planb-fixtures.ts');

let server: Server;
let repo: typeof import('../src/repo.js');
let workDir: string;

const runCli = (args: string[]): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [IMPORTER, ...args], {
      cwd: mkdtempSync(path.join(workDir, 'run-')),
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });

const config = (features: Record<string, boolean>): TenantConfig =>
  ({
    tenant: 'dolphins',
    branding: { name: 'D', title: 'D', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features,
  }) as unknown as TenantConfig;

const planbSeries = (slug: string): Series =>
  ({
    id: `s-planb-${slug}`,
    name: `Premier · T20 · ${slug}`,
    leagueKey: 'premier',
    startDate: '2026-10-04',
    teams: ['a', 'b'],
    fixtures: [
      { id: 'f1', round: 1, date: '2026-10-04', home: 'a', away: 'b' },
      { id: 'f2', round: 2, date: '2026-10-11', home: 'b', away: 'a' },
    ],
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

before(async () => {
  server = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  workDir = mkdtempSync(path.join(os.tmpdir(), 'sync-break-'));
});

after(async () => {
  await stopDynalite(server);
  rmSync(workDir, { recursive: true, force: true });
});

describe('import-planb-fixtures sync-break gate', () => {
  beforeEach(async () => {
    await repo.putSeries('dolphins', planbSeries('premier-men-t20-g1'));
    await repo.putSeries('dolphins', planbSeries('premier-men-t20-top6'));
  });

  test('--revert on a sync tenant without the flag exits non-zero, lists refs, deletes nothing', async () => {
    await repo.putTenantConfig(config({ medicoachSync: true }));
    const { code, out } = await runCli(['--revert', '--confirm']);
    assert.notEqual(code, 0, out);
    assert.match(out, /--revert refused: this tenant has the medicoach fixture sync on/);
    assert.match(out, /smartclub:dolphins:fixture:s-planb-premier-men-t20-g1:f1/);
    assert.ok(await repo.getSeries('dolphins', 's-planb-premier-men-t20-g1'), 'nothing deleted');
  });

  test('--prune on a sync tenant without the flag exits non-zero', async () => {
    await repo.putTenantConfig(config({ medicoachSync: true }));
    const { code, out } = await runCli(['--prune']);
    assert.notEqual(code, 0, out);
    assert.match(out, /--prune refused/);
    assert.match(out, /smartclub:dolphins:fixture:s-planb-premier-men-t20-top6:f2/);
  });

  test('--allow-sync-break lets the revert dry run proceed, warning with the refs', async () => {
    await repo.putTenantConfig(config({ medicoachSync: true }));
    const { code, out } = await runCli(['--revert', '--allow-sync-break']);
    assert.equal(code, 0, out);
    assert.match(
      out,
      /--allow-sync-break: --revert on a medicoach-synced tenant orphans 4 fixture ref/,
    );
    assert.match(out, /\[dry-run\] would delete {2}s-planb-premier-men-t20-g1/);
  });

  test('a tenant without the sync keeps the old behaviour (dry run, exit 0)', async () => {
    await repo.putTenantConfig(config({}));
    const { code, out } = await runCli(['--revert']);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /refused/);
  });
});
