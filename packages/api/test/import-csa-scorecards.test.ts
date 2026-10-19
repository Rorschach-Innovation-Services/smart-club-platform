/**
 * Tests for scripts/import-csa-scorecards.ts — the CSA premier scorecard import. Parsing, the
 * wire mapping and fixture matching are pure (a mini 2-match workbook built with ExcelJS in a
 * temp dir, real sheet headers); the dry run, --confirm, idempotency and --fill-summaries run
 * against dynalite with the REAL repo.
 */
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { CaptainsReport, Series, TenantConfig } from '../src/types.js';
import { dynaliteEnv, startDynalite, stopDynalite } from './dynalite-harness.js';

const DDB_PORT = 4729;
const TABLE = 'SmartClubCsaScorecards';
dynaliteEnv(DDB_PORT, TABLE);
process.env.NOTIFY_DRY_RUN = '1';

type Script = typeof import('../scripts/import-csa-scorecards.js');
let script: Script;
let ddb: Server;
let repo: typeof import('../src/repo.js');
let cr: typeof import('../src/captains-reports.js');

const T = 'dolphins';
const DATE = '2026-10-18';
const MEN = 'KZNCU T20 Premier Men 2026';
const WOMEN = 'KZNCU T20 Premier Women 2026';
const LINK_M = 'https://cricketpvcms.co.za/tournaments/completed/613/13662';
const LINK_W = 'https://cricketpvcms.co.za/tournaments/completed/618/13668';

// ── Mini workbook ──
interface BookOpts {
  fow?: string;
  menHome?: string;
}
async function writeBook(dir: string, opts: BookOpts = {}): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Scorecards').addRow(['ignored']);
  const add = (name: string, rows: unknown[][]) => {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  };
  const menHome = opts.menHome ?? 'African Warriors CC 1st XI';
  add('Matches', [
    [
      'Competition',
      'Season',
      'Format',
      'Match ID',
      'Date',
      'Venue',
      'Home',
      'Away',
      'Toss',
      'Result',
      '1st innings',
      '2nd innings',
      'Link',
    ],
    [
      MEN,
      '2026-27',
      't-20',
      '13662',
      DATE,
      'Oval 1',
      menHome,
      'Umzinto CC 1st XI',
      'x chose to bat',
      'Umzinto CC 1st XI Won By 60 Runs',
      'a',
      'b',
      LINK_M,
    ],
    [
      WOMEN,
      '2026-27',
      't-20',
      '13668',
      DATE,
      'Commons 2',
      'Delta Womens 1st XI',
      'Chatsworth Sporting Womens 1st XI',
      'x',
      'Delta Womens 1st XI Won By 9 Wickets',
      'a',
      'b',
      LINK_W,
    ],
  ]);
  const ih = [
    'Competition',
    'Match ID',
    'Date',
    'Innings',
    'Batting team',
    'Bowling team',
    'Total',
    'Runs',
    'Wickets',
    'Overs',
    'Extras',
    'Byes',
    'Leg byes',
    'Wides',
    'No balls',
    'Penalty',
    'Run rate',
    'Target',
    'Fall of wickets',
  ];
  add('Innings', [
    ih,
    [
      MEN,
      '13662',
      DATE,
      1,
      'Umzinto CC 1st XI',
      'African Warriors CC 1st XI',
      '160/2',
      160,
      2,
      '20.0',
      17,
      0,
      0,
      13,
      4,
      0,
      8.0,
      null,
      opts.fow ?? '1-49 (Thamsanqa Khumalo, 5.2 ov), 2-81 (Kaeden Mcallister, 10.5 ov)',
    ],
    [
      MEN,
      '13662',
      DATE,
      2,
      'African Warriors CC 1st XI',
      'Umzinto CC 1st XI',
      '100/1',
      100,
      1,
      '17.1',
      4,
      4,
      0,
      0,
      0,
      0,
      5.8,
      161,
      '1-3 (Mhlengi Ndaba, 0.6 ov)',
    ],
    [
      WOMEN,
      '13668',
      DATE,
      1,
      'Delta Womens 1st XI',
      'Chatsworth Sporting Womens 1st XI',
      '90/0',
      90,
      0,
      '8.6',
      0,
      0,
      0,
      0,
      0,
      0,
      10,
      null,
      null,
    ],
  ]);
  const bh = [
    'Competition',
    'Match ID',
    'Date',
    'Innings',
    'Team',
    'Pos',
    'Batter',
    'Player ID',
    'How out',
    'R',
    'B',
    '4s',
    '6s',
    'SR',
    'Dots',
  ];
  add('Batting', [
    bh,
    [
      MEN,
      '13662',
      DATE,
      1,
      'Umzinto',
      2,
      'Kaeden Mcallister',
      '1',
      'c X b Y',
      22,
      23,
      1,
      1,
      95.7,
      12,
    ],
    [
      MEN,
      '13662',
      DATE,
      1,
      'Umzinto',
      1,
      'Thamsanqa Khumalo',
      '2',
      'b Sakhelephi Khumalo',
      22,
      17,
      3,
      0,
      129.4,
      8,
    ],
    [
      MEN,
      '13662',
      DATE,
      1,
      'Umzinto',
      3,
      'Zaahid Mahomed',
      '3',
      'not out',
      99,
      80,
      9,
      3,
      123.8,
      20,
    ],
    [
      MEN,
      '13662',
      DATE,
      2,
      'Warriors',
      1,
      'Mhlengi Ndaba',
      '4',
      'run out (A/B)',
      1,
      3,
      0,
      0,
      33.3,
      2,
    ],
    [WOMEN, '13668', DATE, 1, 'Delta', 1, 'A Opener', '5', 'not out', 50, 30, 5, 1, 166.7, 4],
  ]);
  const oh = [
    'Competition',
    'Match ID',
    'Date',
    'Innings',
    'Team',
    'Bowler',
    'Player ID',
    'O',
    'M',
    'R',
    'W',
    'Econ',
    'Dots',
    'Wd',
    'Nb',
  ];
  add('Bowling', [
    oh,
    [MEN, '13662', DATE, 1, 'Warriors', 'Luyanda Gasa', '6', '4.0', 0, 27, 1, 6.75, 12, 4, 0],
    [MEN, '13662', DATE, 2, 'Umzinto', 'B Bowler', '7', '3.1', 1, 20, 1, 6.3, 9, 0, 0],
    [WOMEN, '13668', DATE, 1, 'Sporting', 'C Bowler', '8', '4.0', 0, 40, 0, 10, 4, 0, 0],
  ]);
  add('About', [['Matches', 2]]);
  const path = join(dir, `book-${Math.random().toString(36).slice(2)}.xlsx`);
  await wb.xlsx.writeFile(path);
  return path;
}

let dir: string;
let book: string;

before(async () => {
  ddb = await startDynalite(DDB_PORT, TABLE);
  repo = await import('../src/repo.js');
  cr = await import('../src/captains-reports.js');
  script = await import('../scripts/import-csa-scorecards.js');
  dir = await mkdtemp(join(tmpdir(), 'csa-import-'));
  book = await writeBook(dir);
});
after(async () => {
  await stopDynalite(ddb);
});

describe('parseImportArgs', () => {
  test('parses every flag; defaults to a dolphins dry run', () => {
    assert.deepEqual(
      script.parseImportArgs([
        '--stage=prod',
        '--file=/x.xlsx',
        '--date=2026-10-18',
        '--series=a,b',
        '--fill-summaries',
        '--backup-dir=/tmp/b',
        '--confirm',
      ]),
      {
        stage: 'prod',
        tenant: 'dolphins',
        file: '/x.xlsx',
        date: '2026-10-18',
        seriesIds: ['a', 'b'],
        fillSummaries: true,
        backupDir: '/tmp/b',
        confirm: true,
      },
    );
    assert.equal(script.parseImportArgs(['--stage=dev', '--file=f']).confirm, false);
  });
  test('rejects unknown flags, bad dates and missing required ones', () => {
    assert.throws(() => script.parseImportArgs(['--stage=d', '--file=f', '--x']), /unknown/);
    assert.throws(() => script.parseImportArgs(['--stage=d', '--file=f', '--date=18/10']), /YYYY/);
    assert.throws(() => script.parseImportArgs(['--file=f']), /--stage/);
    assert.throws(() => script.parseImportArgs(['--stage=d']), /--file/);
  });
});

describe('workbook parsing + wire', () => {
  test('reads both matches, derives the tournament id from the link, and the wire passes the schema', async () => {
    const ms = await script.readWorkbook(book);
    assert.deepEqual(
      ms.map((m) => [m.matchId, m.tournamentId, m.innings.length]),
      [
        ['13662', '613', 2],
        ['13668', '618', 1],
      ],
    );
    const wire = script.toInningsWire(ms[0]);
    const first = wire[0];
    assert.equal(first.battingTeamName, 'Umzinto CC 1st XI');
    assert.equal(first.overs, '20.0');
    assert.deepEqual(first.extras, {
      byes: 0,
      legByes: 0,
      wides: 13,
      noBalls: 4,
      penalties: 0,
      total: 17,
    });
    // Batting order is Pos, not row order; dismissal type only when out.
    assert.deepEqual(
      first.batters.map((b) => [b.order, b.name, b.howOut, b.dismissal]),
      [
        [1, 'Thamsanqa Khumalo', 'b Sakhelephi Khumalo', 'bowled'],
        [2, 'Kaeden Mcallister', 'c X b Y', 'caught'],
        [3, 'Zaahid Mahomed', 'not out', undefined],
      ],
    );
    assert.ok(!('dismissal' in first.batters[2]));
    assert.equal(first.batters[1].strikeRate, 95.7);
    assert.deepEqual(first.bowlers[0], {
      order: 1,
      name: 'Luyanda Gasa',
      overs: '4.0',
      maidens: 0,
      runsConceded: 27,
      wickets: 1,
      economy: 6.75,
      wides: 4,
      noBalls: 0,
    });
    assert.deepEqual(first.fallOfWickets, [
      { wicket: 1, runs: 49, overs: '5.2', batterName: 'Thamsanqa Khumalo' },
      { wicket: 2, runs: 81, overs: '10.5', batterName: 'Kaeden Mcallister' },
    ]);
    assert.equal(wire[1].batters[0].dismissal, 'run out');
    // An empty FOW cell (no wickets) and CSA's ".6" overs are fine.
    const women = script.toInningsWire(ms[1])[0];
    assert.deepEqual(women.fallOfWickets, []);
    assert.equal(women.overs, '8.6');
  });

  test('a fall-of-wickets cell that does not parse is a hard error', async () => {
    assert.throws(() => script.parseFallOfWickets('1-49 Khumalo 5.2'), /unreadable/);
    assert.throws(() => script.parseFallOfWickets('1-49 (A, 5.2 ov), and then some'), /unreadable/);
    const bad = await writeBook(dir, { fow: '1-49 (A Batter 5.2 ov)' });
    await assert.rejects(script.readWorkbook(bad), /Innings row 2: unreadable fall of wickets/);
  });
});

// ── Matching ──
const seriesOf = (id: string, sides: Array<[string, string]>, fixtures: unknown[]): Series =>
  ({
    id,
    name: id,
    startDate: DATE,
    teams: sides.map(([t]) => t),
    participants: sides.map(([t, name]) => ({ teamId: t, clubId: t, name })),
    fixtures,
    seasonRunId: `run-${id}`,
    kind: 'series',
    approved: true,
    released: true,
    releasedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
  }) as unknown as Series;

const MEN_SERIES = seriesOf(
  's-men',
  [
    ['umzinto', 'Umzinto CC'],
    ['warriors', 'African Warriors'],
    ['delta', 'Delta CC'],
    ['ukzn', 'UKZN'],
  ],
  [
    { id: 'f1', round: 1, date: DATE, time: '10:00', home: 'umzinto', away: 'warriors' },
    { id: 'f2', round: 1, date: DATE, time: '10:00', home: 'delta', away: 'ukzn' },
    { id: 'f3', round: 2, date: '2026-10-25', time: '10:00', home: 'umzinto', away: 'delta' },
  ],
);
const WOMEN_SERIES = seriesOf(
  's-women',
  [
    ['delta-w', 'Delta Women'],
    ['sporting-w', 'Sporting Ladies'],
  ],
  [{ id: 'f1', round: 1, date: DATE, time: '10:00', home: 'delta-w', away: 'sporting-w' }],
);

describe('matchFixtures', () => {
  test('unordered side pair + alias: matches both, reports the swap, warns on an unclaimed fixture', async () => {
    const ms = await script.readWorkbook(book);
    const out = script.matchFixtures(
      ms,
      [
        { series: MEN_SERIES, leagueKey: 'premier' },
        { series: WOMEN_SERIES, leagueKey: 'premierWomen' },
      ],
      [],
      { 'chatsworth sporting': 'sporting' },
    );
    assert.deepEqual(out.errors, []);
    assert.deepEqual(
      out.matched.map((m) => [m.match.matchId, m.seriesId, m.fixtureId, m.swapped]),
      [
        ['13662', 's-men', 'f1', true],
        ['13668', 's-women', 'f1', false],
      ],
    );
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /s-men\/f2 Delta CC v UKZN .*no workbook row/);
  });

  test('without the alias the women match has no fixture: a hard error naming the alias map', async () => {
    const ms = await script.readWorkbook(book);
    const out = script.matchFixtures(
      ms,
      [
        { series: MEN_SERIES, leagueKey: 'premier' },
        { series: WOMEN_SERIES, leagueKey: 'premierWomen' },
      ],
      [],
      {},
    );
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /match 13668 .*no premierWomen fixture .*TEAM_ALIASES/);
  });

  test('two candidate fixtures, or two matches claiming one fixture, are hard errors', async () => {
    const ms = await script.readWorkbook(book);
    const dup = seriesOf(
      's-dup',
      [
        ['umzinto', 'Umzinto'],
        ['warriors', 'African Warriors'],
      ],
      [{ id: 'f9', date: DATE, home: 'warriors', away: 'umzinto' }],
    );
    const two = script.matchFixtures(
      [ms[0]],
      [
        { series: MEN_SERIES, leagueKey: 'premier' },
        { series: dup, leagueKey: 'premier' },
      ],
      [],
      {},
    );
    assert.match(two.errors.join(), /2 candidate fixtures \(s-men\/f1, s-dup\/f9\)/);
    const again = { ...ms[0], matchId: '99999' };
    const claimed = script.matchFixtures(
      [ms[0], again],
      [{ series: MEN_SERIES, leagueKey: 'premier' }],
      [],
      {},
    );
    assert.match(claimed.errors.join(), /match 99999 .*already claimed by match 13662/);
  });

  test('club names count as side names too (participant renamed)', async () => {
    const ms = await script.readWorkbook(book);
    const renamed = seriesOf(
      's-r',
      [
        ['umzinto', 'UMZ'],
        ['warriors', 'AW'],
      ],
      [{ id: 'f1', date: DATE, home: 'umzinto', away: 'warriors' }],
    );
    const out = script.matchFixtures(
      [ms[0]],
      [{ series: renamed, leagueKey: 'premier' }],
      [
        { id: 'umzinto', name: 'Umzinto Cricket Club' },
        { id: 'warriors', name: 'African Warriors' },
      ],
      {},
    );
    assert.deepEqual(out.errors, []);
    assert.equal(out.matched[0].fixtureId, 'f1');
  });
});

// ── Integration ──
const club = (id: string, name: string) =>
  ({
    id,
    name,
    district: 'd',
    sub: '',
    chair: `${name} Chair`,
    exco: { chair: { name: `${name} Chair`, email: `chair@${id}.test` } },
    affiliation: 'complete',
    cqi: 0,
    docs: {},
    players: 0,
    teams: 1,
    women: 0,
    juniors: 0,
    color: '#000',
    ground: { venue: 'Ground' },
    leagues: ['premier'],
  }) as never;

const report = (
  seriesId: string,
  clubId: string,
  side: 'home' | 'away',
  over: Partial<CaptainsReport> = {},
): CaptainsReport => ({
  id: `${seriesId}~f1~${clubId}`,
  seriesId,
  fixtureId: 'f1',
  clubId,
  status: 'pending',
  source: 'auto',
  matchDate: DATE,
  side,
  clubName: clubId,
  opponentName: 'x',
  competition: 'Premier T20',
  resultSummary: null,
  umpiresSnapshot: [],
  recipient: { kind: 'chair', memberId: `m-${clubId}`, name: 'Chair' },
  captainName: '',
  umpires: [],
  general: '',
  linkExpiresAt: '2026-10-25T21:59:00.000Z',
  createdAt: '2026-10-18T16:00:00.000Z',
  updatedAt: '2026-10-18T16:00:00.000Z',
  ...over,
});

async function resetTable() {
  const { DynamoDBClient, ScanCommand, DeleteItemCommand } =
    await import('@aws-sdk/client-dynamodb');
  const c = new DynamoDBClient({
    endpoint: process.env.DYNAMO_ENDPOINT,
    region: 'localhost',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const items = (await c.send(new ScanCommand({ TableName: TABLE }))).Items ?? [];
  for (const i of items)
    await c.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
}

const run = (id: string, leagueKey: string) =>
  ({ id, leagueKey, seasonLabel: '2026/27', stages: [], version: 1 }) as never;

const lines: string[] = [];
const T1 = new Date('2026-10-19T08:00:00.000Z');
const T2 = new Date('2026-10-19T09:00:00.000Z');
const args = (over: Partial<import('../scripts/import-csa-scorecards.js').ImportArgs> = {}) => ({
  stage: 'local',
  tenant: T,
  file: book,
  fillSummaries: false,
  confirm: false,
  backupDir: dir,
  ...over,
});
const deps = (now = T1) => ({ repo, log: (l: string) => lines.push(l), now: () => now });

/** The women's participant names match the workbook without an alias here. */
async function seed() {
  await repo.putTenantConfig({
    tenant: T,
    branding: { name: 'Dolphins', title: 'Dolphins', logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-12-01',
    knownClubs: [],
    features: {},
  } as unknown as TenantConfig);
  for (const [id, name] of [
    ['umzinto', 'Umzinto CC'],
    ['warriors', 'African Warriors'],
    ['delta', 'Delta CC'],
    ['ukzn', 'UKZN'],
    ['delta-w', 'Delta Women'],
    ['sporting-w', 'Chatsworth Sporting'],
  ])
    await repo.createClub(T, club(id, name));
  await repo.putSeasonRun(T, run('run-s-men', 'premier'));
  await repo.putSeasonRun(T, run('run-s-women', 'premierWomen'));
  await repo.putSeasonRun(T, run('run-s-other', 'saturdayLeague'));
  await repo.putSeries(T, MEN_SERIES);
  await repo.putSeries(
    T,
    seriesOf(
      's-women',
      [
        ['delta-w', 'Delta Women'],
        ['sporting-w', 'Chatsworth Sporting'],
      ],
      [{ id: 'f1', round: 1, date: DATE, time: '10:00', home: 'delta-w', away: 'sporting-w' }],
    ),
  );
  // Same date + same clubs, but not a premier league: never a candidate.
  await repo.putSeries(
    T,
    seriesOf(
      's-other',
      [
        ['umzinto', 'Umzinto CC'],
        ['warriors', 'African Warriors'],
      ],
      [{ id: 'f1', round: 1, date: DATE, time: '10:00', home: 'umzinto', away: 'warriors' }],
    ),
  );
  await repo.openCaptainsReportIfAbsent(T, report('s-men', 'umzinto', 'home'));
  await repo.openCaptainsReportIfAbsent(
    T,
    report('s-men', 'warriors', 'away', { resultSummary: 'kept as is' }),
  );
  await repo.openCaptainsReportIfAbsent(
    T,
    report('s-women', 'delta-w', 'home', { status: 'submitted' }),
  );
  await repo.openCaptainsReportIfAbsent(T, report('s-women', 'sporting-w', 'away'));
}

const backups = async () =>
  (await readdir(dir)).filter((f) => f.startsWith(`csa-scorecards-backup-${T}-`));

describe('runImport', () => {
  beforeEach(async () => {
    await resetTable();
    await seed();
    lines.length = 0;
  });

  test('dry run prints the plan and writes nothing but the backup', async () => {
    const before = (await backups()).length;
    assert.equal(await script.runImport(args(), deps()), 0);
    const out = lines.join('\n');
    assert.match(out, /DRY RUN/);
    assert.match(out, /match 13662 → s-men\/f1 Umzinto CC v African Warriors \(HOME\/AWAY SWAPPED/);
    assert.match(out, /match 13668 → s-women\/f1/);
    assert.match(out, /WARN premier fixture s-men\/f2/);
    assert.doesNotMatch(out, /s-other/);
    assert.match(out, /report home umzinto: pending resultSummary=\(none\)/);
    assert.equal(await repo.getFixtureScorecard(T, 's-men', 'f1'), null);
    assert.equal((await backups()).length, before + 1);
    assert.equal((await repo.getCaptainsReport(T, 's-men', 'f1', 'umzinto'))?.resultSummary, null);
  });

  test('a workbook team with no fixture stops the run: exit 1, nothing written, no backup', async () => {
    const before = (await backups()).length;
    const bad = await writeBook(dir, { menHome: 'Nobody CC 1st XI' });
    assert.equal(await script.runImport(args({ file: bad, confirm: true }), deps()), 1);
    assert.match(lines.join('\n'), /ERROR match 13662 .*no premier fixture/);
    assert.match(lines.join('\n'), /nothing written/);
    assert.equal(await repo.getFixtureScorecard(T, 's-women', 'f1'), null);
    assert.equal((await backups()).length, before);
  });

  test('--confirm stores available + terminal + sourceUrl cards; a re-run keeps fetchedAt', async () => {
    assert.equal(await script.runImport(args({ confirm: true }), deps(T1)), 0);
    const men = await repo.getFixtureScorecard(T, 's-men', 'f1');
    assert.ok(men);
    assert.equal(men.available, true);
    assert.equal(men.terminal, true);
    assert.equal(men.medicoachMatchId, 'csa-13662');
    assert.equal(men.medicoachTournamentId, 'csa-613');
    assert.equal(men.sourceUrl, LINK_M);
    assert.equal(men.matchState, 'Complete');
    assert.equal(men.fetchedAt, T1.toISOString());
    assert.equal(men.innings?.length, 2);
    assert.equal(
      (await repo.getFixtureScorecard(T, 's-women', 'f1'))?.medicoachTournamentId,
      'csa-618',
    );
    // No --fill-summaries: reports untouched.
    assert.equal((await repo.getCaptainsReport(T, 's-men', 'f1', 'umzinto'))?.resultSummary, null);

    lines.length = 0;
    assert.equal(await script.runImport(args({ confirm: true }), deps(T2)), 0);
    assert.match(lines.join('\n'), /content unchanged, fetchedAt kept/);
    assert.equal((await repo.getFixtureScorecard(T, 's-men', 'f1'))?.fetchedAt, T1.toISOString());

    // The served context: the card + the CSA link (no FIXRESULT ⇒ no result).
    const r = (await repo.getCaptainsReport(T, 's-men', 'f1', 'umzinto'))!;
    const ctx = await cr.attachScorecardContext(repo, T, r);
    assert.equal(ctx.scorecard?.innings.length, 2);
    assert.equal(ctx.medicoachMatchUrl, LINK_M);
    assert.equal(ctx.result, undefined);
  });

  test('--fill-summaries fills pending reports without a summary only', async () => {
    assert.equal(await script.runImport(args({ confirm: true, fillSummaries: true }), deps()), 0);
    const get = (s: string, c: string) => repo.getCaptainsReport(T, s, 'f1', c);
    assert.equal(
      (await get('s-men', 'umzinto'))?.resultSummary,
      'Umzinto CC 1st XI won by 60 runs',
    );
    assert.equal((await get('s-men', 'warriors'))?.resultSummary, 'kept as is');
    assert.equal((await get('s-women', 'delta-w'))?.resultSummary, null, 'submitted: untouched');
    assert.equal(
      (await get('s-women', 'sporting-w'))?.resultSummary,
      'Delta Womens 1st XI won by 9 wickets',
    );
    assert.match(lines.join('\n'), /summaries filled=2/);
    const latest = (await backups()).sort().at(-1)!;
    const saved = JSON.parse(await readFile(join(dir, latest), 'utf8'));
    assert.equal(saved.fixtures.length, 2);
  });

  test('--overwrite-summaries replaces a wrong pending summary for the named match only', async () => {
    assert.throws(
      () => script.parseImportArgs(['--stage=dev', '--file=x', '--overwrite-summaries=13662']),
      /--overwrite-summaries needs --fill-summaries/,
    );
    assert.equal(
      await script.runImport(
        args({ confirm: true, fillSummaries: true, overwriteSummaries: ['13662'] }),
        deps(),
      ),
      0,
    );
    const get = (s: string, c: string) => repo.getCaptainsReport(T, s, 'f1', c);
    // The named match replaces the wrong text; pending-only still holds elsewhere.
    assert.equal(
      (await get('s-men', 'warriors'))?.resultSummary,
      'Umzinto CC 1st XI won by 60 runs',
    );
    assert.match(lines.join('\n'), /resultSummary OVERWRITTEN on/);
    assert.equal((await get('s-women', 'delta-w'))?.resultSummary, null, 'submitted: untouched');
  });
});
