/**
 * MedicoachBundle v1 contract: a JSON round trip, the bundle-wide externalRef uniqueness
 * refinement (a single-side club in two leagues), ref resolution, counts, and the results
 * backfill file schema.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MedicoachBundleSchema,
  ResultsFileSchema,
  computeCounts,
  refs,
  type MedicoachBundle,
} from '../src/medicoach-bundle.js';
import { buildBundle } from '../src/medicoach-export-build.js';
import type { Club, Series, TenantConfig } from '../src/types.js';

const T = 'acme';

/** `ukzn` is a single-side club (teamId === clubId) entered in two leagues. */
function sample(): MedicoachBundle {
  const config = {
    tenant: T,
    branding: { name: 'Acme Union' },
    leagues: [
      { key: 'premier', label: 'Premier', group: 'Senior', district: 'All districts' },
      { key: 'reserve', label: 'Reserve', group: 'Senior', district: 'All districts' },
    ],
  } as unknown as TenantConfig;
  const club = (id: string, name: string, leagues: string[]) =>
    ({
      id,
      name,
      district: 'North',
      leagues,
      ground: { venue: `${name} Oval` },
    }) as unknown as Club;
  const clubs = [
    club('ukzn', 'UKZN', ['premier', 'reserve']),
    club('glenwood', 'Glenwood', ['premier', 'reserve']),
  ];
  const s = (id: string, leagueKey: string): Series =>
    ({
      id,
      name: `${leagueKey} · T20 · Group 1`,
      leagueKey,
      maxOvers: 20,
      teams: ['ukzn', 'glenwood'],
      participants: [
        { teamId: 'ukzn', clubId: 'ukzn', name: 'UKZN' },
        { teamId: 'glenwood', clubId: 'glenwood', name: 'Glenwood' },
      ],
      fixtures: [
        { id: 'f1', round: 1, date: '2026-10-03', time: '13:00', home: 'ukzn', away: 'glenwood' },
      ],
      released: true,
      releasedAt: null,
      version: 1,
      startDate: '2026-10-03',
    }) as Series;
  return buildBundle({
    tenant: T,
    config,
    clubs,
    playersByClub: new Map(),
    series: [s('s-planb-premier-1', 'premier'), s('s-planb-reserve-1', 'reserve')],
    seasonRuns: [],
    recipes: { tenant: T, utcOffset: '+02:00', leagues: {} },
    options: { generatedAt: '2026-09-30T00:00:00.000Z' },
  }).bundle;
}

function issues(b: unknown): string[] {
  const r = MedicoachBundleSchema.safeParse(b);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe('MedicoachBundle v1 schema', () => {
  test('a built bundle survives a JSON round trip unchanged and valid', () => {
    const b = sample();
    const parsed = MedicoachBundleSchema.parse(JSON.parse(JSON.stringify(b)));
    assert.deepEqual(parsed, b);
  });

  test('a single-side club in two leagues gets two distinct team refs (leagueKey is in the ref)', () => {
    const b = sample();
    const ukzn = b.teams
      .filter((t) => t.sourceTeamId === 'ukzn')
      .map((t) => t.externalRef)
      .sort();
    assert.deepEqual(ukzn, [refs.team(T, 'premier', 'ukzn'), refs.team(T, 'reserve', 'ukzn')]);
    assert.deepEqual(issues(b), []);
  });

  test('the uniqueness refinement catches the collision a leagueKey-less team ref would cause', () => {
    const b = sample();
    // Simulate the old scheme: team ref from teamId alone.
    const legacy = (r: string) => r.replace(/:team:[^:]+:/, ':team:');
    for (const t of b.teams) t.externalRef = legacy(t.externalRef);
    for (const l of b.leagues) {
      l.teamRefs = l.teamRefs.map(legacy);
      for (const c of l.competitions) {
        for (const g of c.groups) g.teamRefs = g.teamRefs.map(legacy);
        for (const f of c.fixtures) {
          if (f.homeTeamRef) f.homeTeamRef = legacy(f.homeTeamRef);
          if (f.awayTeamRef) f.awayTeamRef = legacy(f.awayTeamRef);
        }
      }
    }
    const errs = issues(b);
    assert.ok(
      errs.some((m) => m.includes(`duplicate externalRef smartclub:${T}:team:ukzn`)),
      errs.join('\n'),
    );
  });

  test('a ref that resolves to nothing is rejected', () => {
    const b = sample();
    b.leagues[0].competitions[0].fixtures[0].homeTeamRef = refs.team(T, 'premier', 'ghost');
    assert.ok(issues(b).some((m) => m.includes('does not resolve to a team')));
  });

  test('a ref that resolves to the wrong kind is rejected', () => {
    const b = sample();
    b.teams[0].institutionRef = b.leagues[0].externalRef;
    assert.ok(issues(b).some((m) => m.includes('does not resolve to a institution (is a league)')));
  });

  test('a fixture needs exactly one of teamRef / slot per side', () => {
    const b = sample();
    const f = b.leagues[0].competitions[0].fixtures[0];
    f.homeSlot = { kind: 'group-position', groupName: 'Group 1', position: 1 };
    assert.ok(issues(b).some((m) => m.includes('exactly one of homeTeamRef / homeSlot')));
  });

  test('a slot pointing outside its competition is rejected', () => {
    const b = sample();
    const f = b.leagues[0].competitions[0].fixtures[0];
    delete f.awayTeamRef;
    f.awaySlot = {
      kind: 'winner',
      ofFixtureRef: b.leagues[1].competitions[0].fixtures[0].externalRef,
    };
    assert.ok(issues(b).some((m) => m.includes('is not a fixture of')));
  });

  test('counts must match the recomputed tally', () => {
    const b = sample();
    b.counts.fixtures += 1;
    assert.ok(issues(b).some((m) => m.startsWith('counts.fixtures')));
    const { counts: _c, ...rest } = sample();
    void _c;
    assert.equal(computeCounts(rest).teams, 4);
  });
});

describe('results backfill file schema', () => {
  const cricket = {
    homeWickets: 7,
    awayWickets: 10,
    homeOvers: 20,
    awayOvers: 18.4,
    awayAllOut: true,
  };

  test('accepts entries keyed by fixtureRef or by matchKeys', () => {
    const r = ResultsFileSchema.safeParse([
      {
        fixtureRef: refs.fixture(T, 's1', 'f1'),
        homeScore: 150,
        awayScore: 120,
        cricketResult: cricket,
      },
      {
        matchKeys: {
          leagueKey: 'premier',
          stream: 't20',
          date: '2026-10-03',
          homeTeamName: 'UKZN',
          awayTeamName: 'Glenwood',
        },
        homeScore: 0,
        awayScore: 0,
        cricketResult: { noResult: true },
      },
    ]);
    assert.ok(r.success);
  });

  test('rejects an entry with both or neither key, and a fractional score', () => {
    const both = ResultsFileSchema.safeParse([
      {
        fixtureRef: 'x',
        matchKeys: { leagueKey: 'p', date: '2026-10-03', homeTeamName: 'a', awayTeamName: 'b' },
        homeScore: 1,
        awayScore: 2,
      },
    ]);
    const neither = ResultsFileSchema.safeParse([{ homeScore: 1, awayScore: 2 }]);
    const fractional = ResultsFileSchema.safeParse([
      { fixtureRef: 'x', homeScore: 1.5, awayScore: 2 },
    ]);
    assert.equal(both.success, false);
    assert.equal(neither.success, false);
    assert.equal(fractional.success, false);
  });
});

describe('host institution', () => {
  const build = (config: Partial<TenantConfig>, host?: { name: string; slugHint: string }) =>
    buildBundle({
      tenant: T,
      config: { tenant: T, leagues: [], ...config } as unknown as TenantConfig,
      clubs: [],
      playersByClub: new Map(),
      series: [],
      seasonRuns: [],
      recipes: { tenant: T, utcOffset: '+02:00', leagues: {}, ...(host ? { host } : {}) },
      options: { generatedAt: '2026-09-30T00:00:00.000Z' },
    });
  const fellBack = (w: string[]) => w.filter((m) => m.includes('host name fell back'));

  test('uses the branding name for the host name and slugHint, with no warning', () => {
    const { bundle, summary } = build({
      branding: { name: 'Acme Cricket Union', title: 'Acme Pipeline' },
    } as unknown as Partial<TenantConfig>);
    assert.deepEqual(bundle.host, { name: 'Acme Cricket Union', slugHint: 'acme-cricket-union' });
    assert.deepEqual(fellBack(summary.warnings), []);
  });

  test('falls through to copy.orgShort, then the title, before the slug', () => {
    const short = build({
      branding: { name: ' ', title: 'Acme Pipeline', copy: { orgShort: 'Acme' } },
    } as unknown as Partial<TenantConfig>);
    assert.equal(short.bundle.host.name, 'Acme');
    const title = build({
      branding: { title: 'Acme Pipeline' },
    } as unknown as Partial<TenantConfig>);
    assert.equal(title.bundle.host.name, 'Acme Pipeline');
    assert.deepEqual(fellBack(title.summary.warnings), []);
  });

  test('without branding it falls back to the tenant slug and records a warning', () => {
    const { bundle, summary } = build({});
    assert.deepEqual(bundle.host, { name: T, slugHint: T });
    assert.equal(fellBack(summary.warnings).length, 1);
    assert.match(fellBack(summary.warnings)[0], /set the tenant's display name/);
  });

  test('a unicode-only branding name keeps the name, slugHint falls back to the tenant', () => {
    const { bundle, summary } = build({
      branding: { name: 'ドルフィンズ' },
    } as unknown as Partial<TenantConfig>);
    assert.deepEqual(bundle.host, { name: 'ドルフィンズ', slugHint: T });
    assert.deepEqual(fellBack(summary.warnings), []);
  });

  test('a recipe host override wins and suppresses the fallback warning', () => {
    const { bundle, summary } = build({}, { name: 'Recipe Host', slugHint: 'recipe-host' });
    assert.deepEqual(bundle.host, { name: 'Recipe Host', slugHint: 'recipe-host' });
    assert.deepEqual(fellBack(summary.warnings), []);
  });
});
