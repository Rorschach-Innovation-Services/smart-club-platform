/**
 * import-emcu-fixtures.ts: the relocation pass (plan §C), the CLI flag rules, and the write /
 * revert / restore-stale round-trip through the real repo on dynalite.
 *
 *   - relocation (synthetic world, always run): EMCU yields to a non-EMCU booking; the
 *     candidate chain is walked in order and a ground must be free ALL DAY; no candidate ⇒
 *     dateTbc; EMCU-internal clashes go through chooseFixtureToMove (which, for two EMCU
 *     series, falls through to "later fixture id moves" — asserted knowingly); a club listed
 *     twice at one ground at once ⇒ the later (seriesId, fixtureId) is dateTbc; the result is
 *     independent of input order;
 *   - relocation on the real workbook + prod exports (EMCU_EXPORT_DIR; skipped when unset);
 *   - dynalite: backup → stale delete → write → revert → restore-stale; released refusals.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';
import type { Club, SeasonRun, Series, Venue } from '../src/types.js';

const DDB_PORT = 4691; // next free odd port after 4689
const TABLE = 'SmartClubEmcuImportTest';
dynaliteEnv(DDB_PORT, TABLE);

const {
  applyBootstrapOverlay,
  buildEmcuSeries,
  executeEmcuWrite,
  parseArgs,
  readWorkbookGrids,
  relocateEmcu,
  restoreStale,
  revertEmcu,
  verifyClashes,
} = await import('../src/import-emcu-fixtures.js');
const {
  DEFAULT_WORKBOOK,
  EMCU_STALE_RUN_IDS,
  EMCU_STALE_SERIES_IDS,
  emcuAliases,
  parseEmcuWorkbook,
} = await import('../src/emcu-fixture-map.js');
const { loadOffline } = await import('../src/patch-fixtures.js');
const { venueAliasesFor } = await import('../src/venue-clash.js');

type Fx = Record<string, unknown> & { id: string };

// ───────────────────────── synthetic world ─────────────────────────

const clubs = [
  { id: 'alpha', name: 'Alpha CC', ground: { venue: 'Alpha Oval', secondaryVenue: 'Alpha 2' } },
  { id: 'beta', name: 'Beta CC', ground: { venue: 'Beta Park' } },
  { id: 'gamma', name: 'Gamma CC', ground: { venue: 'Gamma Field' } },
  { id: 'delta', name: 'Delta CC', ground: { venue: 'Delta Ground' } },
] as unknown as Club[];
const venue = (id: string, name: string, homeClubIds: string[]): Venue => ({
  id,
  name,
  homeClubIds,
  surfaces: 1,
});
const venues: Venue[] = [
  venue('v-alpha-oval', 'Alpha Oval', ['alpha']),
  venue('v-alpha-2', 'Alpha 2', ['alpha']),
  venue('v-beta-park', 'Beta Park', ['beta']),
  venue('v-gamma-field', 'Gamma Field', ['gamma']),
  venue('v-delta-ground', 'Delta Ground', ['delta']),
  venue('v-neutral', 'Neutral Oval', []),
  venue('v-shared', 'Shared Field', ['alpha', 'beta']),
];
const ALIASES: Record<string, string> = {};

const at = (
  id: string,
  home: string,
  away: string,
  ground: string,
  date: string,
  time: string,
): Fx => ({
  id,
  round: 1,
  date,
  time,
  home,
  away,
  venueName: ground,
  venueId: venues.find((v) => v.name === ground)?.id,
  venueLocked: true,
});
const mkSeries = (id: string, fixtures: Fx[], released = false): Series =>
  ({
    id,
    name: id,
    leagueKey: 'emcuD1',
    startDate: '2026-10-01',
    teams: ['alpha', 'beta', 'gamma', 'delta'],
    participants: clubs.map((c) => ({ teamId: c.id, clubId: c.id, name: c.name })),
    fixtures,
    released,
    releasedAt: released ? '2026-09-01T00:00:00.000Z' : null,
    version: 1,
  }) as unknown as Series;
const fxOf = (s: Series, id: string) => (s.fixtures as Fx[]).find((f) => f.id === id)!;

describe('relocation pass (synthetic)', () => {
  const D = '2026-10-11';

  test("an EMCU fixture yields to a released booking and takes the away side's ground", () => {
    const others = [
      mkSeries('s-planb-x', [at('k1', 'alpha', 'gamma', 'Alpha Oval', D, '09:00')], true),
    ];
    const emcu = mkSeries('s-emcu-d1-t20', [at('f1', 'alpha', 'beta', 'Alpha Oval', D, '09:00')]);
    const r = relocateEmcu([emcu], others, clubs, venues, ALIASES);
    assert.deepEqual(r.errors, []);
    assert.equal(r.moves.length, 1);
    const m = r.moves[0];
    assert.equal(m.cause, 'yields');
    assert.equal(m.to, 'Beta Park');
    assert.equal(m.label, "away side's allocated ground");
    assert.match(m.blockedBy, /\(released\)$/);
    const f = fxOf(emcu, 'f1');
    assert.equal(f.venueId, 'v-beta-park');
    assert.equal(f.venueStatus, 'alternative');
    assert.match(String(f.venueReason), /^Moved: Alpha Oval taken by s-planb-x/);
    assert.deepEqual(verifyClashes([emcu], others, clubs, venues, ALIASES), []);
  });

  test('candidates are walked in order and must be free all day (a 13:00 booking blocks 09:00)', () => {
    const others = [
      mkSeries(
        's-planb-x',
        [
          at('k1', 'alpha', 'gamma', 'Alpha Oval', D, '09:00'),
          at('k2', 'gamma', 'delta', 'Beta Park', D, '13:00'),
        ],
        true,
      ),
    ];
    const emcu = mkSeries('s-emcu-d1-t20', [at('f1', 'alpha', 'beta', 'Alpha Oval', D, '09:00')]);
    const r = relocateEmcu([emcu], others, clubs, venues, ALIASES);
    assert.equal(r.moves[0].to, 'Alpha 2');
    assert.equal(r.moves[0].label, "home club's secondary ground");
    assert.deepEqual(r.moves[0].tried, ["Beta Park [away side's allocated ground] ← s-planb-x/k2"]);
  });

  test('no free candidate ⇒ dateTbc (draft), listed, nothing forced', () => {
    const others = [
      mkSeries(
        's-planb-x',
        [
          at('k1', 'alpha', 'gamma', 'Alpha Oval', D, '09:00'),
          at('k2', 'gamma', 'delta', 'Beta Park', D, '13:00'),
          at('k3', 'gamma', 'delta', 'Alpha 2', D, '13:00'),
          at('k4', 'gamma', 'delta', 'Shared Field', D, '16:00'),
        ],
        true,
      ),
    ];
    const emcu = mkSeries('s-emcu-d1-t20', [at('f1', 'alpha', 'beta', 'Alpha Oval', D, '09:00')]);
    const r = relocateEmcu([emcu], others, clubs, venues, ALIASES);
    assert.equal(r.moves.length, 0);
    assert.equal(r.dateTbc.length, 1);
    assert.equal(r.dateTbc[0].kind, 'no-candidate');
    assert.equal(fxOf(emcu, 'f1').dateTbc, true);
    assert.equal(fxOf(emcu, 'f1').venueName, 'Alpha Oval', 'the sheet venue is kept');
    assert.deepEqual(verifyClashes([emcu], others, clubs, venues, ALIASES), []);
  });

  test('EMCU-internal: chooseFixtureToMove falls through to "later fixture id moves"', () => {
    const a = mkSeries('s-emcu-d3-s1-t20', [
      at('f2', 'alpha', 'beta', 'Neutral Oval', '2026-10-18', '13:00'),
    ]);
    const b = mkSeries('s-emcu-d4-s1-t20', [
      at('f5', 'gamma', 'delta', 'Neutral Oval', '2026-10-18', '13:00'),
    ]);
    const r = relocateEmcu([a, b], [], clubs, venues, ALIASES);
    assert.equal(r.moves.length, 1);
    assert.equal(r.moves[0].cause, 'internal');
    assert.equal(r.moves[0].seriesId, 's-emcu-d4-s1-t20');
    assert.equal(r.moves[0].decision, 'later fixture id (f5) moves');
    assert.equal(r.moves[0].to, 'Delta Ground');
    assert.equal(fxOf(a, 'f2').venueName, 'Neutral Oval');
  });

  test('a club listed twice at one ground at once ⇒ the later (seriesId, fixtureId) is dateTbc', () => {
    const d3 = mkSeries('s-emcu-d3-s1-t20', [
      at('f35', 'alpha', 'beta', 'Alpha 2', '2026-11-29', '13:00'),
    ]);
    const d4 = mkSeries('s-emcu-d4-s1-t20', [
      at('f26', 'alpha', 'gamma', 'Alpha 2', '2026-11-29', '13:00'),
    ]);
    const r = relocateEmcu([d4, d3], [], clubs, venues, ALIASES);
    assert.equal(r.moves.length, 0);
    assert.equal(r.dateTbc.length, 1);
    assert.equal(r.dateTbc[0].kind, 'team-clash');
    assert.equal(r.dateTbc[0].seriesId, 's-emcu-d4-s1-t20');
    assert.equal(fxOf(d4, 'f26').dateTbc, true);
    assert.equal(fxOf(d3, 'f35').dateTbc, undefined);
  });

  test('deterministic: input order does not change the outcome', () => {
    const world = () => {
      const others = [
        mkSeries(
          's-planb-x',
          [
            at('k1', 'alpha', 'gamma', 'Alpha Oval', D, '09:00'),
            at('k2', 'gamma', 'delta', 'Beta Park', D, '13:00'),
          ],
          true,
        ),
      ];
      const built = [
        mkSeries('s-emcu-d1-t20', [
          at('f1', 'alpha', 'beta', 'Alpha Oval', D, '09:00'),
          at('f2', 'gamma', 'delta', 'Neutral Oval', '2026-10-18', '13:00'),
        ]),
        mkSeries('s-emcu-d2-t20', [
          at('f1', 'beta', 'alpha', 'Neutral Oval', '2026-10-18', '13:00'),
          at('f9', 'delta', 'gamma', 'Shared Field', D, '09:00'),
        ]),
      ];
      return { others, built };
    };
    const w1 = world();
    const r1 = relocateEmcu(w1.built, w1.others, clubs, venues, ALIASES);
    const w2 = world();
    for (const s of w2.built) (s.fixtures as Fx[]).reverse();
    const r2 = relocateEmcu([...w2.built].reverse(), w2.others, clubs, venues, ALIASES);
    assert.deepEqual(r2, r1);
    const snap = (b: Series[]) =>
      JSON.stringify(
        b
          .map((s) => ({
            id: s.id,
            f: [...(s.fixtures as Fx[])].sort((x, y) => x.id.localeCompare(y.id)),
          }))
          .sort((x, y) => String(x.id).localeCompare(String(y.id))),
      );
    assert.equal(snap(w2.built), snap(w1.built));
    assert.ok(r1.moves.length >= 2);
  });
});

describe('CLI flags', () => {
  test('offline + --confirm is an error; offline needs all three exports', () => {
    assert.throws(
      () =>
        parseArgs(['--series-json', 'a', '--clubs-json', 'b', '--venues-json', 'c', '--confirm']),
      /never writes/,
    );
    assert.throws(() => parseArgs(['--series-json', 'a']), /all three/);
  });
  test('mode rules', () => {
    assert.throws(() => parseArgs(['--parse-only', '--confirm']), /mutually exclusive/);
    assert.throws(() => parseArgs(['--revert', '--only', 'd1-t20']), /takes only --confirm/);
    assert.throws(
      () => parseArgs(['--restore-stale', 'b.json', '--parse-only']),
      /takes only --confirm/,
    );
    assert.throws(() => parseArgs(['--only', 'd9-t20']), /unknown series slug/);
    assert.throws(() => parseArgs(['--tenant', 'lions']), /for tenant "dolphins"/);
    assert.equal(parseArgs(['--restore-stale', 'b.json', '--confirm']).mode, 'restore');
    assert.deepEqual(parseArgs(['--only', 'd1-t20,d5-s2-t20']).only, ['d1-t20', 'd5-s2-t20']);
  });
});

// ───────────────────────── real workbook + prod exports ─────────────────────────

const EXPORT_DIR = process.env.EMCU_EXPORT_DIR ?? '';
const WORKBOOK = process.env.EMCU_WORKBOOK ?? DEFAULT_WORKBOOK;
const haveReal =
  existsSync(WORKBOOK) &&
  !!EXPORT_DIR &&
  ['prod-SERIES-after.json', 'prod-CLUB.json', 'prod-VENUE.json'].every((f) =>
    existsSync(join(EXPORT_DIR, f)),
  );

describe(
  'relocation on the real workbook',
  { skip: haveReal ? false : 'set EMCU_EXPORT_DIR and have the workbook' },
  () => {
    const run = async () => {
      const off = loadOffline({
        series: join(EXPORT_DIR, 'prod-SERIES-after.json'),
        clubs: join(EXPORT_DIR, 'prod-CLUB.json'),
        venues: join(EXPORT_DIR, 'prod-VENUE.json'),
      });
      const aliases = emcuAliases(venueAliasesFor(undefined));
      const o = applyBootstrapOverlay(off.clubs, off.venues, aliases);
      const parsed = parseEmcuWorkbook(await readWorkbookGrids(WORKBOOK));
      const built = buildEmcuSeries(parsed, {
        clubs: o.clubs,
        venues: o.venues,
        aliases,
      }).built.map((b) => b.series);
      const ids = new Set(built.map((s) => String(s.id)));
      const others = off.series.filter(
        (s) => !EMCU_STALE_SERIES_IDS.includes(String(s.id)) && !ids.has(String(s.id)),
      );
      const r = relocateEmcu(built, others, o.clubs, o.venues, aliases);
      return { r, built, others, clubs: o.clubs, venues: o.venues, aliases };
    };

    test('Hillary/Malvern 29 Nov double listing: the Div 4 S1 v Merebank fixture goes date-TBC', async () => {
      const { r } = await run();
      const team = r.dateTbc.filter((d) => d.kind === 'team-clash');
      assert.equal(team.length, 1);
      assert.equal(team[0].seriesId, 's-emcu-d4-s1-t20');
      assert.equal(team[0].date, '2026-11-29');
      assert.match(team[0].home + team[0].away, /Hillary\/Malvern.*Merebank/);
    });

    test('every clash is resolved, counts are unchanged, and the result is deterministic', async () => {
      const a = await run();
      assert.deepEqual(a.r.errors, []);
      assert.deepEqual(verifyClashes(a.built, a.others, a.clubs, a.venues, a.aliases), []);
      assert.equal(
        a.built.reduce((n, s) => n + (s.fixtures as unknown[]).length, 0),
        620,
      );
      assert.ok(a.r.moves.length > 0);
      assert.ok(a.r.moves.every((m) => m.cause === 'yields' || m.decision));
      const b = await run();
      assert.deepEqual(b.r, a.r);
    });
  },
);

// ───────────────────────── dynalite round-trip ─────────────────────────

const TENANT = 'dolphins';
let server: Server;
let repo: typeof import('../src/repo.js');
let backupDir: string;

const staleSeries = (id: string, i: number): Series =>
  ({
    id,
    name: `stale ${i}`,
    startDate: '2026-10-11',
    teams: ['alpha', 'beta'],
    participants: [
      { teamId: 'alpha', clubId: 'alpha', name: 'Alpha CC' },
      { teamId: 'beta', clubId: 'beta', name: 'Beta CC' },
    ],
    fixtures: [
      {
        id: 'f1',
        round: 1,
        date: '2026-10-11',
        time: '09:00',
        home: 'alpha',
        away: 'beta',
        venueName: 'Alpha Oval',
      },
    ],
    seasonRunId: EMCU_STALE_RUN_IDS[i % 3],
    released: false,
    releasedAt: null,
    version: 3,
  }) as unknown as Series;
const run = (id: string): SeasonRun =>
  ({
    id,
    leagueKey: 'emcuD1',
    seasonLabel: '2026/27',
    structureSnapshot: { stages: [] },
    calendarSnapshot: { blocks: [] },
    stages: [],
    version: 2,
  }) as unknown as SeasonRun;
const builtSeries = (id: string, fixtures: Fx[]): Series =>
  ({
    ...mkSeries(id, fixtures),
    approved: false,
    released: false,
    releasedAt: null,
    version: 1,
  }) as Series;
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );

describe('write / revert / restore-stale (dynalite)', () => {
  before(async () => {
    server = await startDynalite(DDB_PORT, TABLE);
    repo = await import('../src/repo.js');
    backupDir = mkdtempSync(join(tmpdir(), 'emcu-backup-'));
    await repo.putTenantConfig({
      tenant: TENANT,
      branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
      submissionDeadline: '2026-12-31',
      knownClubs: [],
      leagues: [
        { key: 'emcuD1', label: 'EMCU Division 1', group: 'Seniors', district: 'All districts' },
      ],
    } as unknown as Parameters<typeof repo.putTenantConfig>[0]);
    for (const c of clubs)
      await repo.putClub(TENANT, {
        ...c,
        district: 'Test',
        sub: 's',
        chair: 'C',
        affiliation: 'not_started',
        cqi: 0,
        docs: {},
        players: 0,
        teams: 1,
        women: 0,
        juniors: 0,
        color: '#123456',
        leagues: [],
        version: 1,
      } as unknown as Club);
    for (const v of venues) await repo.putVenue(TENANT, v);
    for (const [i, id] of EMCU_STALE_SERIES_IDS.entries())
      await repo.putSeries(TENANT, staleSeries(id, i));
    for (const id of EMCU_STALE_RUN_IDS) await repo.putSeasonRun(TENANT, run(id));
    await repo.putSeries(
      TENANT,
      mkSeries(
        's-planb-x',
        [at('k1', 'gamma', 'delta', 'Gamma Field', '2026-10-11', '09:00')],
        true,
      ),
    );
  });
  after(async () => {
    await stopDynalite(server);
  });

  test('a released s-emcu-* target refuses the whole write before anything is touched', async () => {
    await repo.putSeries(TENANT, {
      ...builtSeries('s-emcu-d1-30ov', []),
      released: true,
    } as Series);
    await assert.rejects(
      executeEmcuWrite(repo, TENANT, [builtSeries('s-emcu-d1-30ov', [])], {
        backupDir,
        clubSync: false,
        log: () => {},
      }),
      /RELEASED: s-emcu-d1-30ov/,
    );
    assert.equal(
      (await repo.listSeries(TENANT)).filter((s) => EMCU_STALE_SERIES_IDS.includes(String(s.id)))
        .length,
      5,
    );
    // --revert refuses too while it is released.
    const rv = await revertEmcu(repo, TENANT, { confirm: true, backupDir, log: () => {} });
    assert.deepEqual(rv.refused, ['s-emcu-d1-30ov']);
    await repo.deleteSeries(TENANT, 's-emcu-d1-30ov');
  });

  test('confirm: backup, stale series + runs deleted, drafts written, clean re-scan', async () => {
    const original = await repo.listSeries(TENANT);
    const built = [
      builtSeries('s-emcu-d1-t20', [
        at('f1', 'alpha', 'beta', 'Alpha Oval', '2026-10-11', '09:00'),
      ]),
      builtSeries('s-emcu-d1-30ov', [
        at('f1', 'beta', 'alpha', 'Beta Park', '2027-01-24', '08:30'),
      ]),
    ];
    const res = await executeEmcuWrite(repo, TENANT, built, {
      backupDir,
      clubSync: true,
      log: () => {},
    });
    assert.deepEqual(res.written, ['s-emcu-d1-t20', 's-emcu-d1-30ov']);
    assert.deepEqual(res.postWriteClashes, []);
    const after = await repo.listSeries(TENANT);
    assert.deepEqual(
      after.filter((s) => EMCU_STALE_SERIES_IDS.includes(String(s.id))),
      [],
    );
    for (const id of EMCU_STALE_RUN_IDS) assert.equal(await repo.getSeasonRun(TENANT, id), null);
    const written = after.find((s) => s.id === 's-emcu-d1-t20')!;
    assert.equal(written.released, false);
    assert.equal(written.version, 1);
    // The club-league sync ran over the drafts.
    assert.ok((await repo.getClub(TENANT, 'alpha'))!.leagues!.includes('emcuD1'));
    const backup = JSON.parse(readFileSync(res.backupPath, 'utf8'));
    assert.equal(backup.staleSeries.length, 5);
    assert.equal(backup.staleRuns.length, 3);
    assert.deepEqual(backup.emcuSeries, []);
    assert.equal(
      canon(backup.staleSeries.map((s: Series) => s.id).sort()),
      canon(
        original
          .filter((s) => EMCU_STALE_SERIES_IDS.includes(String(s.id)))
          .map((s) => s.id)
          .sort(),
      ),
    );
  });

  test('restore-stale refuses while s-emcu-* series exist; revert then restore round-trips', async () => {
    const files = readdirSync(backupDir).filter((f) => f.startsWith('emcu-fixtures-backup-'));
    const importBackup = files
      .map((f) => JSON.parse(readFileSync(join(backupDir, f), 'utf8')))
      .find((b) => b.staleSeries.length === 5)!;
    const refused = await restoreStale(repo, TENANT, importBackup, {
      confirm: true,
      log: () => {},
    });
    assert.match(String(refused.refused), /run --revert --confirm first/);

    const rv = await revertEmcu(repo, TENANT, { confirm: true, backupDir, log: () => {} });
    assert.deepEqual(rv.deleted.sort(), ['s-emcu-d1-30ov', 's-emcu-d1-t20']);
    assert.deepEqual(
      (await repo.listSeries(TENANT)).filter((s) => String(s.id).startsWith('s-emcu-')),
      [],
    );

    const r = await restoreStale(repo, TENANT, importBackup, { confirm: true, log: () => {} });
    assert.equal(r.restoredSeries.length, 5);
    assert.equal(r.restoredRuns.length, 3);
    const back = (await repo.listSeries(TENANT)).filter((s) =>
      EMCU_STALE_SERIES_IDS.includes(String(s.id)),
    );
    assert.equal(
      canon(back.sort((a, b) => String(a.id).localeCompare(String(b.id)))),
      canon(
        [...importBackup.staleSeries].sort((a: Series, b: Series) =>
          String(a.id).localeCompare(String(b.id)),
        ),
      ),
    );
    for (const id of EMCU_STALE_RUN_IDS)
      assert.equal((await repo.getSeasonRun(TENANT, id))?.version, 2);
    // Idempotent: a second restore leaves everything alone.
    const again = await restoreStale(repo, TENANT, importBackup, { confirm: true, log: () => {} });
    assert.deepEqual([again.restoredSeries, again.restoredRuns], [[], []]);
  });
});
