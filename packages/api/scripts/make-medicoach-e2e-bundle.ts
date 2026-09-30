/**
 * Bundle generator for the medicoach league-migration END-TO-END harness
 * (medicoach repo: scripts/league-migration/e2e/run-e2e.mjs).
 *
 * Runs the REAL exporter pipeline (buildBundle from src/medicoach-export-build.ts, the
 * Dolphins recipes, MedicoachBundleSchema validation) over:
 *   - the checked-in prod-backup test data (test/data/medicoach/dolphins-planb-series-
 *     2026-09-10.json + dolphins-league-config-2026-09-27.json), and
 *   - synthetic clubs / players / staff (modelled on test/medicoach-people.test.ts) whose
 *     club ids are real Plan-B participants, so the people phases have real coverage.
 *
 * Writes into --out-dir (the medicoach harness's gitignored out/ dir):
 *   bundle-full.json      every Dolphins league (flagship six carry fixtures)
 *   bundle-small.json     premier + veterans-premier only (crash/fault/rollback scenarios)
 *   results.json          10 valid results (one super-over, one no-result, two via matchKeys)
 *   results-bad.json      the valid ones plus one entry that matches no fixture
 *   results-phase1.json   every phase-1 fixture of premier/50-over + promotion/30-over (multi-phase)
 *   people-cases.json     which synthetic person exercises which edge (refs + roles, no PII
 *                         beyond the synthetic example.test identities below)
 *
 *   npx tsx packages/api/scripts/make-medicoach-e2e-bundle.ts --out-dir <dir>
 *
 * Every person here is synthetic (example.test / noreply.medicoach.co.za addresses). The
 * generated bundle is an output, never committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MedicoachBundleSchema, refs, type MedicoachBundle } from '../src/medicoach-bundle.js';
import { buildBundle } from '../src/medicoach-export-build.js';
import { DOLPHINS_RECIPES } from '../src/medicoach-recipes/dolphins.js';
import type { Club, PlayerRegistration, Series, TenantConfig } from '../src/types.js';

const T = 'dolphins';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`--${name} needs a value${v ? ` (got the flag ${v})` : ''}`);
    process.exit(2);
  }
  return v;
}
const outDir = arg('out-dir');
if (!outDir) {
  console.error('usage: tsx packages/api/scripts/make-medicoach-e2e-bundle.ts --out-dir <dir>');
  process.exit(2);
}

const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`../test/data/medicoach/${f}`, import.meta.url), 'utf8'));
const series = load('dolphins-planb-series-2026-09-10.json') as Series[];
const config = load('dolphins-league-config-2026-09-27.json') as TenantConfig;

// The pinned config is trimmed (no branding), so without this the exporter would fall back
// to the bare tenant slug for the host. Pin the host here rather than editing the config:
// the slug-fallback path stays a unit-test case (test/medicoach-bundle.test.ts).
const HOST = { name: 'Dolphins Cricket Union', slugHint: 'dolphins-cricket-union' };

/* ─────────────── Synthetic people on four real Plan-B clubs ─────────────── */
// Club ids are real participants. `leagues: []` keeps the exporter from adding
// club-roster sides next to the series sides, so every club has exactly one side per
// league it plays in (players resolve to a single team; no ambiguity).
const A = 'delta-cricket-club'; // premier, premierWomen, veterans-premier
const B = 'crusaders'; // premier, veterans-premier, promotion-women-s-league
const C = 'harlequins-cricket-club'; // premier, veterans-premier
const D = 'umzinto'; // premier only

const DUP_EMAIL = 'dup.person@example.test';
const PRE_EXISTING_COACH_EMAIL = 'preexisting.coach@example.test';
const PRE_EXISTING_PLAYER = {
  name: 'Pat Preexisting',
  email: 'pat.preexisting@example.test',
};
const PLACEHOLDER_EMAIL = 'pl.holder.x1y2z3@noreply.medicoach.co.za';
const INVALID_GUARDIAN_EMAIL = 'guardian@localhost';

const clubs: Club[] = [
  {
    id: A,
    name: 'Delta Cricket Club',
    district: 'Durban',
    leagues: [],
    exco: {
      // The duplicate-email person: chair here, coach at B.
      chair: {
        name: 'Dana Duplicate',
        email: 'Dup.Person@Example.test',
        cell: '082 555 1001',
        // Synthetic and checksum-broken on purpose (fails the SA ID Luhn check): no real person.
        idNumber: '8001015009088',
      },
      sec: { name: 'Sipho Secretary', email: 'sipho.sec@example.test' },
    },
    coaches: [
      {
        name: 'Carl Coach',
        email: 'carl.coach@example.test',
        body: 'CSA',
        level: 'Level 2',
        teams: ['premier'],
      },
    ],
  },
  {
    id: B,
    name: 'Crusaders',
    district: 'Durban',
    leagues: [],
    exco: {
      chair: { name: 'Chris Chair', email: 'chris.chair@example.test', cell: '082 555 1002' },
    },
    // Importer shape, same person as A's chair (email differs only in case).
    coaches: [{ name: 'Dana Duplicate', email: DUP_EMAIL, cell: '0825551001', source: 'import' }],
  },
  {
    id: C,
    name: 'Harlequins Cricket Club',
    district: 'Durban',
    leagues: [],
    exco: {
      // Already a Coach in medicoach (the harness seeds that account): upsert attaches,
      // never promotes, and the importer records a role warning.
      chair: { name: 'Quinn Preexisting', email: PRE_EXISTING_COACH_EMAIL },
      // No email, no cell: exported (identity = name+club) but skipped by the importer
      // (no-email) and counted.
      sec: { name: 'Nomsa Nocontact' },
    },
    coaches: [],
  },
  {
    id: D,
    name: 'Umzinto',
    district: 'South Coast',
    leagues: [],
    exco: {
      chair: { name: 'Uma Umzinto', email: 'uma.chair@example.test', cell: '+27 83 555 1004' },
    },
    coaches: [{ name: 'Ulrich Coach', email: 'ulrich.coach@example.test', teams: ['premier'] }],
  },
].map((c) => ({ ground: { venue: `${c.name} Oval` }, ...c }) as unknown as Club);

let n = 0;
const player = (p: Partial<PlayerRegistration> & { clubId: string }): PlayerRegistration =>
  ({
    naturalKey: `e2e-${String(++n).padStart(2, '0')}`,
    firstName: `First${n}`,
    lastName: `Last${n}`,
    dob: '1995-03-0' + ((n % 9) + 1),
    gender: 'male',
    isMinor: false,
    consentAt: '2026-01-01',
    createdAt: '2026-01-01',
    status: 'active',
    team: 'premier',
    email: `player${n}@example.test`,
    cell: `08255520${String(n).padStart(2, '0')}`,
    ...p,
  }) as PlayerRegistration;

const playersByClub = new Map<string, PlayerRegistration[]>([
  [
    A,
    [
      player({ clubId: A }),
      player({ clubId: A }),
      player({ clubId: A }),
      player({ clubId: A }),
      // Minor #1: the contact on a minor's record is the guardian's.
      player({
        clubId: A,
        naturalKey: 'e2e-minor-1',
        firstName: 'Mini',
        lastName: 'Minor',
        dob: '2012-05-05',
        isMinor: true,
        guardianName: 'Gina Guardian',
        email: 'gina.guardian@example.test',
        cell: '0825559901',
      }),
      // Exported? no — a smart-club placeholder registration is skipped by the exporter.
      player({ clubId: A, naturalKey: 'e2e-sc-placeholder', placeholder: true } as never),
      // Exported? no — inactive.
      player({ clubId: A, naturalKey: 'e2e-inactive', status: 'inactive' }),
    ],
  ],
  [
    B,
    [
      player({ clubId: B }),
      player({ clubId: B }),
      player({ clubId: B }),
      player({ clubId: B }),
      // Minor #2 with an address the notify driver must refuse (no TLD).
      player({
        clubId: B,
        naturalKey: 'e2e-minor-2',
        firstName: 'Tiny',
        lastName: 'Tot',
        dob: '2013-06-06',
        isMinor: true,
        guardianName: 'Gerry Guardian',
        email: INVALID_GUARDIAN_EMAIL,
        cell: '0825559902',
      }),
    ],
  ],
  [
    C,
    [
      player({ clubId: C }),
      player({ clubId: C }),
      player({ clubId: C }),
      // Already an athlete in medicoach (seeded by the harness with this email + name):
      // POST /internal/players → 409 PLAYER_EXISTS → attach.
      player({
        clubId: C,
        naturalKey: 'e2e-preexisting-player',
        firstName: 'Pat',
        lastName: 'Preexisting',
        email: PRE_EXISTING_PLAYER.email,
      }),
      // A medicoach placeholder address: name claim, never an email claim; never notified.
      player({
        clubId: C,
        naturalKey: 'e2e-placeholder-email',
        firstName: 'Pl',
        lastName: 'Holder',
        email: PLACEHOLDER_EMAIL,
        cell: undefined,
      }),
    ],
  ],
  [
    D,
    [
      player({ clubId: D }),
      player({ clubId: D }),
      player({ clubId: D }),
      player({ clubId: D }),
      // Veterans dual-club: premier at Umzinto + Harlequins' veterans-premier side.
      player({
        clubId: D,
        naturalKey: 'e2e-veteran',
        firstName: 'Vic',
        lastName: 'Veteran',
        dob: '1970-01-01',
        veteransClubId: C,
      }),
    ],
  ],
]);

function build(leagues?: string[]): MedicoachBundle {
  const { bundle, summary } = buildBundle({
    tenant: T,
    config,
    clubs,
    playersByClub,
    series,
    seasonRuns: [],
    recipes: { ...DOLPHINS_RECIPES, host: HOST },
    options: { generatedAt: '2026-09-30T00:00:00.000Z', ...(leagues ? { leagues } : {}) },
  });
  const parsed = MedicoachBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    console.error(parsed.error.issues.map((i) => i.message).join('\n'));
    throw new Error('generated bundle failed MedicoachBundleSchema');
  }
  console.log(
    `bundle${leagues ? ` [${leagues.join(',')}]` : ''}: ${JSON.stringify(bundle.counts)}; players exported ${summary.players.exported ?? bundle.people.players.length}, noTeam ${summary.players.noTeam}, ambiguous ${summary.players.ambiguousSide}; warnings ${summary.warnings.length}`,
  );
  // stdout, not stderr: the medicoach harness logs only stdout on success.
  for (const w of summary.warnings) console.log(`  warning: ${w}`);
  return bundle;
}

const full = build();
const small = build(['premier', 'veterans-premier']);

/* ─────────────── Results files ─────────────── */
type Entry = Record<string, unknown>;
const teamName = new Map(full.teams.map((t) => [t.externalRef, t.name]));

// 10 valid results from one group of one competition, so a group table has real rows.
const premier = full.leagues.find((l) => l.key === 'premier')!;
const t20 = premier.competitions.find((c) => c.stream === 't20')!;
const group1 = t20.groups[0].name;
const g1Fixtures = t20.fixtures.filter(
  (f) => f.groupName === group1 && f.homeTeamRef && f.awayTeamRef,
);
if (g1Fixtures.length < 10)
  throw new Error(`premier/t20 ${group1} has only ${g1Fixtures.length} fixtures`);

const cricket = (i: number) => ({
  homeWickets: 3 + (i % 5),
  awayWickets: 10,
  homeOvers: 20,
  awayOvers: 18.3,
  awayAllOut: true,
  overLimit: 20,
});
const results: Entry[] = g1Fixtures.slice(0, 10).map((f, i) => {
  const base: Entry = { homeScore: 150 + i, awayScore: 120 + i, cricketResult: cricket(i) };
  if (i === 3) {
    // Super over: level on runs, home wins the eliminator.
    base.homeScore = 140;
    base.awayScore = 140;
    base.cricketResult = {
      homeWickets: 6,
      awayWickets: 8,
      homeOvers: 20,
      awayOvers: 20,
      overLimit: 20,
      superOverWinner: 'home',
    };
    base.resultNote = 'Won in super over';
  }
  if (i === 5) {
    base.homeScore = 0;
    base.awayScore = 0;
    base.cricketResult = { noResult: true, overLimit: 20 };
    base.resultNote = 'No result (rain)';
  }
  if (i === 7 || i === 8) {
    // Match on keys instead of the ref (league, local date, both team names).
    return {
      ...base,
      matchKeys: {
        leagueKey: premier.key,
        stream: t20.stream,
        date: f.scheduledTime.slice(0, 10),
        homeTeamName: teamName.get(f.homeTeamRef!)!,
        awayTeamName: teamName.get(f.awayTeamRef!)!,
      },
    };
  }
  return { fixtureRef: f.externalRef, ...base };
});
const bad: Entry[] = [
  ...results,
  {
    matchKeys: {
      leagueKey: premier.key,
      stream: t20.stream,
      date: '2031-01-01',
      homeTeamName: 'Nobody Home XI',
      awayTeamName: 'Nobody Away XI',
    },
    homeScore: 1,
    awayScore: 0,
    cricketResult: { homeWickets: 0, awayWickets: 10, homeOvers: 1, awayOvers: 1, overLimit: 20 },
  },
];

// Every phase-1 fixture of the two multi-phase competitions, so their phase boundaries
// fall due on the next public read (scenario I):
//   premier/50-over     2 groups of 6, double round robin, extra phase = carry + a swap
//   promotion/30-over   2 groups of 10 (the largest placement), extra phase = subdivide ×2
const multiPhase = [
  ['premier', '50-over', 50],
  ['promotion', '30-over', 30],
] as const;
const phase1: Entry[] = multiPhase.flatMap(([leagueKey, stream, overs]) => {
  const comp = full.leagues
    .find((l) => l.key === leagueKey)!
    .competitions.find((c) => c.stream === stream)!;
  if (!comp.format.extraPhases.length) throw new Error(`${leagueKey}/${stream} has no extra phase`);
  return comp.fixtures
    .filter((f) => f.phase === 1 && f.homeTeamRef && f.awayTeamRef)
    .map((f, i) => ({
      fixtureRef: f.externalRef,
      homeScore: 160 + ((i * 7) % 60),
      awayScore: 110 + ((i * 11) % 60),
      cricketResult: {
        homeWickets: 2 + (i % 8),
        awayWickets: 1 + ((i * 3) % 10),
        homeOvers: overs,
        awayOvers: overs,
        overLimit: overs,
      },
    }));
});

/* ─────────────── Write ─────────────── */
const dir = resolve(outDir);
mkdirSync(dir, { recursive: true });
const write = (f: string, v: unknown) =>
  writeFileSync(join(dir, f), JSON.stringify(v, null, 2), { mode: 0o600 });
write('bundle-full.json', full);
write('bundle-small.json', small);
write('results.json', results);
write('results-bad.json', bad);
write('results-phase1.json', phase1);

const staffRef = (email: string) => full.people.staff.find((s) => s.email === email)?.externalRef;
write('people-cases.json', {
  tenant: T,
  clubs: { A, B, C, D },
  institutions: Object.fromEntries([A, B, C, D].map((c) => [c, refs.institution(T, c)])),
  duplicateEmailStaff: { ref: staffRef(DUP_EMAIL), email: DUP_EMAIL },
  preExistingCoach: {
    ref: staffRef(PRE_EXISTING_COACH_EMAIL),
    email: PRE_EXISTING_COACH_EMAIL,
    seedRole: 'Coach',
  },
  noContactStaff: { ref: full.people.staff.find((s) => !s.email && !s.cell)?.externalRef },
  preExistingPlayer: {
    ref: refs.player(T, 'e2e-preexisting-player'),
    ...PRE_EXISTING_PLAYER,
    teamRef: full.people.players.find(
      (p) => p.externalRef === refs.player(T, 'e2e-preexisting-player'),
    )?.teamRefs[0],
  },
  placeholderEmailPlayer: {
    ref: refs.player(T, 'e2e-placeholder-email'),
    email: PLACEHOLDER_EMAIL,
  },
  minors: [refs.player(T, 'e2e-minor-1'), refs.player(T, 'e2e-minor-2')],
  invalidGuardianMinor: { ref: refs.player(T, 'e2e-minor-2'), email: INVALID_GUARDIAN_EMAIL },
  veteran: { ref: refs.player(T, 'e2e-veteran') },
  skippedByExporter: [refs.player(T, 'e2e-sc-placeholder'), refs.player(T, 'e2e-inactive')],
  resultsCompetition: { ref: t20.externalRef, league: premier.externalRef, group: group1 },
});
console.log(
  `wrote bundle-full/small, results (${results.length}), results-bad (${bad.length}), results-phase1 (${phase1.length}) to ${dir}`,
);
