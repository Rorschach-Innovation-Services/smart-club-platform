/**
 * People mapping: staff deduped per person into assignments (hashed refs, no PII in
 * refs), both stored coach shapes, active-only players deduped by naturalKey with
 * veterans second-club team refs, and PII masking for console output.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MedicoachBundleSchema, refs } from '../src/medicoach-bundle.js';
import {
  buildBundle,
  maskCell,
  maskEmail,
  maskName,
  staffIdentity,
} from '../src/medicoach-export-build.js';
import type { Club, PlayerRegistration, TenantConfig, VeteransAffiliation } from '../src/types.js';

// export-medicoach.ts imports repo.ts, which resolves the table name at import time. The
// test never touches DynamoDB; the name only has to exist.
process.env.TABLE_NAME ??= 'medicoach-export-test-unused';
const { parseArgs, UsageError } = await import('../src/export-medicoach.js');

const T = 'acme';
const config = {
  tenant: T,
  branding: { name: 'Acme Union' },
  leagues: [
    { key: 'premier', label: 'Premier League', group: 'Overarching', district: 'All districts' },
    {
      key: 'veterans-premier',
      label: 'Veterans Premier',
      group: 'Overarching',
      district: 'All districts',
    },
  ],
  calendars: [
    {
      id: 'cal',
      label: '2026/27',
      blocks: [{ id: 'b1', label: 'B1', start: '2026-09-01', end: '2027-03-31' }],
    },
  ],
} as unknown as TenantConfig;

const clubs: Club[] = [
  {
    id: 'glenwood',
    name: 'Glenwood',
    district: 'North',
    leagues: ['premier'],
    // Two premier sides: players can't be pinned to one.
    leagueTeams: { premier: 2 },
    teamRosters: {
      premier: [
        { id: 'tm_g1', name: 'Glenwood A' },
        { id: 'tm_g2', name: 'Glenwood B' },
      ],
    },
    exco: {
      chair: {
        name: 'Thandi Nkosi',
        email: 'Thandi@Example.com ',
        cell: '082 555 0101',
        idNumber: '8001015009087',
      },
      sec: { name: 'Sam Pillay', email: 'sam@example.com' },
      additionalMembers: [{ name: 'Lee Naidoo', cell: '+27 83 555 0202' }],
    },
    // Form shape: coaches a named side.
    coaches: [
      {
        name: 'Coach Form',
        body: 'CSA',
        level: 'Level 2',
        email: 'form@example.com',
        teams: ['premier'],
        teamIds: ['tm_g2'],
      },
    ],
  },
  {
    id: 'ukzn',
    name: 'UKZN',
    district: 'North',
    leagues: ['premier', 'veterans-premier'],
    exco: { chair: { name: 'Other Chair', email: 'other@example.com' } },
    // Importer shape; the same person as glenwood's chair (email differs only in case).
    coaches: [
      { name: 'Thandi Nkosi', email: 'thandi@example.com', cell: '0825550101', source: 'import' },
    ],
  },
  { id: 'vets-club', name: 'Vets Club', district: 'North', leagues: ['veterans-premier'] },
].map((c) => ({ ground: { venue: `${c.name} Oval` }, ...c }) as unknown as Club);

const player = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    firstName: 'P',
    lastName: 'Layer',
    dob: '1990-01-01',
    isMinor: false,
    consentAt: 'x',
    createdAt: '2026-01-01',
    ...p,
  }) as PlayerRegistration;

const playersByClub = new Map<string, PlayerRegistration[]>([
  [
    'ukzn',
    [
      player({
        naturalKey: 'nk-active',
        clubId: 'ukzn',
        team: 'premier',
        email: 'A@X.com',
        veteransClubId: 'vets-club',
      }),
      player({
        naturalKey: 'nk-pending',
        clubId: 'ukzn',
        team: 'premier',
        status: 'clearance-pending',
      }),
      player({ naturalKey: 'nk-gone', clubId: 'ukzn', status: 'inactive' }),
      player({ naturalKey: 'nk-stub', clubId: 'ukzn', status: 'active', placeholder: true }),
      // The same person's older inactive row after a move (dedupe by naturalKey).
      player({
        naturalKey: 'nk-moved',
        clubId: 'ukzn',
        status: 'inactive',
        createdAt: '2025-01-01',
      }),
    ],
  ],
  [
    'glenwood',
    [
      player({ naturalKey: 'nk-glen', clubId: 'glenwood', team: 'premier' }),
      player({
        naturalKey: 'nk-moved',
        clubId: 'glenwood',
        team: 'premier',
        status: 'active',
        createdAt: '2026-02-01',
      }),
    ],
  ],
]);

const affiliations = new Map<string, VeteransAffiliation[]>([
  [
    'vets-club',
    [
      {
        naturalKey: 'nk-active',
        veteransClubId: 'vets-club',
        primaryClubId: 'ukzn',
      } as VeteransAffiliation,
      {
        naturalKey: 'nk-unknown',
        veteransClubId: 'vets-club',
        primaryClubId: 'ukzn',
      } as VeteransAffiliation,
    ],
  ],
]);

const run = (includeInactivePlayers = false) =>
  buildBundle({
    tenant: T,
    config,
    clubs,
    playersByClub,
    veteransAffiliationsByClub: affiliations,
    series: [],
    seasonRuns: [],
    recipes: { tenant: T, utcOffset: '+02:00', leagues: {} },
    options: { generatedAt: 'x', includeInactivePlayers },
  });

describe('staff', () => {
  const { bundle, summary } = run();
  const staff = bundle.people.staff;

  test('the same email at two clubs is one person with a chair and a coach assignment', () => {
    const thandi = staff.filter((s) => s.email === 'thandi@example.com');
    assert.equal(thandi.length, 1);
    assert.deepEqual(
      thandi[0].assignments.map((a) => [a.institutionRef, a.kind]),
      [
        [refs.institution(T, 'glenwood'), 'chair'],
        [refs.institution(T, 'ukzn'), 'coach'],
      ],
    );
    // Importer-shape coach: no teams recorded, so no team refs.
    assert.deepEqual(thandi[0].assignments[1].coach, { teamRefs: [] });
  });

  test('staff refs are hashes: no name or email appears in any ref', () => {
    for (const s of staff) {
      assert.match(s.externalRef, new RegExp(`^smartclub:${T}:staff:[0-9a-f]{24}$`));
      assert.ok(!s.externalRef.includes('thandi') && !s.externalRef.includes('@'));
    }
  });

  test('exco slots map to chair / exco:<slot> / exco:additional; the contact-less member dedupes on name+cell', () => {
    const kinds = staff.flatMap((s) => s.assignments.map((a) => a.kind)).sort();
    assert.deepEqual(kinds, ['chair', 'chair', 'coach', 'coach', 'exco:additional', 'exco:sec']);
    assert.equal(
      staffIdentity({ name: 'Lee  Naidoo', cell: '+27 83 555 0202' }, 'x'),
      'namecell:lee naidoo|0835550202',
    );
    assert.equal(summary.staff.persons, 5);
  });

  test('a form-shape coach of a named side links only that side', () => {
    const coach = staff.find((s) => s.email === 'form@example.com')!;
    assert.deepEqual(coach.assignments[0].coach, {
      level: 'Level 2',
      body: 'CSA',
      teamRefs: [refs.team(T, 'premier', 'tm_g2')],
    });
  });

  test('the chair ID number never reaches the bundle', () => {
    assert.ok(!JSON.stringify(bundle).includes('8001015009087'));
  });
});

describe('players', () => {
  const { bundle, summary } = run();
  const byKey = new Map(bundle.people.players.map((p) => [p.externalRef.split(':').pop(), p]));

  test('active only by default; excluded statuses and placeholder rows are counted', () => {
    assert.deepEqual([...byKey.keys()].sort(), ['nk-active', 'nk-glen', 'nk-moved']);
    assert.deepEqual(summary.players.excludedByStatus, { 'clearance-pending': 1, inactive: 2 });
    assert.equal(summary.players.placeholdersSkipped, 1);
  });

  test('a veterans affiliate appears once: primary institution = main club, team refs span both clubs', () => {
    const p = byKey.get('nk-active')!;
    assert.equal(p.institutionRef, refs.institution(T, 'ukzn'));
    assert.equal(p.veteransInstitutionRef, refs.institution(T, 'vets-club'));
    assert.deepEqual(p.teamRefs, [
      refs.team(T, 'premier', 'ukzn'),
      refs.team(T, 'veterans-premier', 'vets-club'),
    ]);
    assert.equal(p.email, 'a@x.com');
    assert.deepEqual(summary.veterans, {
      playersWithVeteransClub: 1,
      resolvedVeteransTeam: 1,
      affiliationsListed: 2,
      affiliationsMatched: 1,
      affiliationsUnmatched: 1,
    });
  });

  test('a player at a two-side club gets no guessed side (counted as ambiguous)', () => {
    assert.deepEqual(byKey.get('nk-glen')!.teamRefs, []);
    assert.equal(summary.players.ambiguousSide, 2);
  });

  test('--include-inactive-players keeps one row per naturalKey, preferring the active one', () => {
    const all = run(true);
    const keys = all.bundle.people.players.map((p) => p.externalRef.split(':').pop()).sort();
    assert.deepEqual(keys, ['nk-active', 'nk-glen', 'nk-gone', 'nk-moved', 'nk-pending']);
    const moved = all.bundle.people.players.find((p) => p.externalRef.endsWith('nk-moved'))!;
    assert.equal(moved.institutionRef, refs.institution(T, 'glenwood'));
    assert.equal(all.summary.players.duplicateRowsMerged, 1);
  });

  test('the bundle validates, with fixture-less leagues dated from the tenant calendar', () => {
    const r = MedicoachBundleSchema.safeParse(bundle);
    assert.ok(r.success, r.success ? '' : r.error.issues.map((i) => i.message).join('\n'));
    assert.ok(bundle.leagues.every((l) => l.season.source === 'tenant-latest-calendar'));
  });
});

describe('masking and args', () => {
  test('names, emails and cells are masked for console output', () => {
    assert.equal(maskName('Thandi Nkosi'), 'T***** N****');
    assert.equal(maskEmail('thandi@example.com'), 't***@e***.com');
    assert.equal(maskCell('082 555 0101'), '***101');
    assert.equal(maskName(''), '∅');
  });

  test('parseArgs requires --tenant and --out and reads the optional flags', () => {
    assert.deepEqual(
      parseArgs(['--tenant', 'd', '--out', 'o.json', '--leagues', 'a, b', '--confirm']),
      {
        tenant: 'd',
        out: 'o.json',
        leagues: ['a', 'b'],
        includeInactivePlayers: false,
        confirm: true,
      },
    );
    assert.throws(() => parseArgs(['--out', 'o.json']), /--tenant is required/);
    assert.throws(() => parseArgs(['--tenant', 'd', '--bogus']), /unknown argument/);
  });

  test('an explicitly empty --leagues list is a usage error, not "export everything"', () => {
    for (const empty of [',', ' , ,'])
      assert.throws(
        () => parseArgs(['--tenant', 'd', '--out', 'o.json', '--leagues', empty]),
        (e: Error) => e instanceof UsageError && /at least one league key/.test(e.message),
      );
  });
});
