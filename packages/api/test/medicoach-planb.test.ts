/**
 * The Dolphins flagship leagues, end to end through buildBundle, from real data:
 *   - test/data/medicoach/dolphins-planb-series-2026-09-10.json — the 23 Plan-B series
 *     (620 fixtures) from the prod backup packages/api/planb-backup-dolphins-2026-09-10…json,
 *     trimmed to ids/names/participants/fixture pairings (venue fields dropped);
 *   - test/data/medicoach/dolphins-league-config-2026-09-27.json — leagues/structures/
 *     calendars from league-setups-backup-dolphins-2026-09-27…json.
 * The raw backups are gitignored; these trimmed copies are what the tests pin.
 *
 * Encodes the handover §9.3 recipes for the six flagship leagues (via
 * medicoach-recipes/dolphins.ts). Carry vs subdivide is the highest-risk mapping.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MedicoachBundleSchema, refs, type BundleCompetition } from '../src/medicoach-bundle.js';
import { buildBundle } from '../src/medicoach-export-build.js';
import { DOLPHINS_RECIPES } from '../src/medicoach-recipes/dolphins.js';
import type { Series, TenantConfig } from '../src/types.js';

const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`./data/medicoach/${f}`, import.meta.url), 'utf8'));
const series = load('dolphins-planb-series-2026-09-10.json') as Series[];
const config = load('dolphins-league-config-2026-09-27.json') as TenantConfig;

const { bundle, summary } = buildBundle({
  tenant: 'dolphins',
  config,
  clubs: [],
  playersByClub: new Map(),
  series,
  seasonRuns: [],
  recipes: DOLPHINS_RECIPES,
  options: { generatedAt: '2026-09-30T00:00:00.000Z' },
});

function comp(leagueKey: string, stream: string): BundleCompetition {
  const l = bundle.leagues.find((x) => x.key === leagueKey);
  assert.ok(l, `league ${leagueKey} exported`);
  const c = l.competitions.find((x) => x.stream === stream);
  assert.ok(c, `competition ${leagueKey}/${stream} exported`);
  return c;
}
const sizes = (c: BundleCompetition) => c.groups.map((g) => g.teamRefs.length);
const placeholders = (c: BundleCompetition) => c.fixtures.filter((f) => f.placeholderDate);
const gpos = (group: number, position: number) => ({
  kind: 'group-position',
  groupName: `Group ${group}`,
  position,
});

describe('Plan-B backup → bundle', () => {
  test('the bundle validates (ref uniqueness, ref resolution, counts)', () => {
    const parsed = MedicoachBundleSchema.safeParse(bundle);
    assert.ok(
      parsed.success,
      parsed.success ? '' : parsed.error.issues.map((i) => i.message).join('\n'),
    );
  });

  test('every one of the 620 source fixtures is exported, plus 13 recipe placeholders', () => {
    assert.equal(summary.fixtures.read, 620);
    assert.equal(summary.fixtures.cancelledSkipped, 0);
    assert.equal(summary.fixtures.unresolvedSideSkipped, 0);
    assert.equal(bundle.counts.fixtures, 633);
    assert.equal(bundle.counts.placeholderFixtures, 13);
  });

  test('one competition per (league, stream): 11 competitions, 23 groups', () => {
    const got = summary.competitions.map((c) => `${c.league}/${c.stream}`).sort();
    assert.deepEqual(got, [
      'premier/50-over',
      'premier/t20',
      'premierWomen/30-over',
      'premierWomen/t20',
      'promotion-women-s-league/t20',
      'promotion/30-over',
      'promotion/t20',
      'veterans-premier/30-over',
      'veterans-premier/t20',
      'veterans-promotion/30-over',
      'veterans-promotion/t20',
    ]);
    assert.equal(bundle.counts.groups, 23);
  });

  test('all null-status fixtures land as scheduled with sourceStatus null', () => {
    const all = bundle.leagues.flatMap((l) => l.competitions.flatMap((c) => c.fixtures));
    assert.ok(all.every((f) => f.status === 'scheduled'));
    assert.ok(all.filter((f) => !f.placeholderDate).every((f) => f.sourceStatus === null));
  });

  test('veterans-premier/promotion exist only on series: synthesised with recipe labels', () => {
    assert.deepEqual(summary.leagues.synthesised.sort(), [
      'veterans-premier',
      'veterans-promotion',
    ]);
    const vp = bundle.leagues.find((l) => l.key === 'veterans-premier')!;
    assert.equal(vp.label, 'Veterans Premier');
    assert.equal(vp.synthesised, true);
  });

  test('seed-* and demo are excluded', () => {
    assert.ok(bundle.leagues.every((l) => !l.key.startsWith('seed-') && l.key !== 'demo'));
    assert.ok(bundle.meta.excludedLeagues.includes('demo'));
  });

  test('a season is derived from the fixture span for setup-less leagues', () => {
    const premier = bundle.leagues.find((l) => l.key === 'premier')!;
    assert.equal(premier.season.source, 'fixtures');
    assert.equal(premier.season.externalRef, 'smartclub:dolphins:season:premier:derived-2026-27');
    assert.equal(premier.season.name, '2026/27');
  });
});

describe('flagship recipes (handover §9.3)', () => {
  test('Premier Men T20: groups_knockout, 2×6, semis G1-1 v G2-1 and G1-2 v G2-2, then the final', () => {
    const c = comp('premier', 't20');
    assert.equal(c.formatSource, 'recipe');
    assert.equal(c.format.type, 'groups_knockout');
    assert.equal(c.format.rounds, 1);
    assert.deepEqual(sizes(c), [6, 6]);
    assert.equal(c.cricketMatchFormat, 'T20');
    const ko = placeholders(c);
    assert.equal(ko.length, 3);
    const byRef = (id: string) =>
      ko.find((f) => f.externalRef === refs.recipeFixture('dolphins', 'premier', 't20', id))!;
    assert.deepEqual(byRef('sf1').homeSlot, gpos(1, 1));
    assert.deepEqual(byRef('sf1').awaySlot, gpos(2, 1));
    assert.deepEqual(byRef('sf2').homeSlot, gpos(1, 2));
    assert.deepEqual(byRef('sf2').awaySlot, gpos(2, 2));
    assert.deepEqual(byRef('final').homeSlot, {
      kind: 'winner',
      ofFixtureRef: byRef('sf1').externalRef,
    });
    assert.deepEqual(byRef('final').awaySlot, {
      kind: 'winner',
      ofFixtureRef: byRef('sf2').externalRef,
    });
    // Placeholder date = the league's season end.
    const premier = bundle.leagues.find((l) => l.key === 'premier')!;
    assert.ok(ko.every((f) => f.scheduledTime.startsWith(premier.season.endDate) && f.timeTbc));
  });

  test('Premier Men 50 Over: league rounds 2 + CARRY phase + points-carrying swap + relegation', () => {
    const c = comp('premier', '50-over');
    assert.equal(c.format.type, 'league');
    assert.equal(c.format.rounds, 2);
    assert.deepEqual(c.format.extraPhases, [{ type: 'league', rounds: 1, groupSeeding: 'carry' }]);
    assert.deepEqual(sizes(c), [6, 6]);
    // Top 6 sorts before Bottom 6, so it is Group 1.
    assert.deepEqual(
      c.groups.map((g) => [g.name, g.sourceName]),
      [
        ['Group 1', 'Top 6'],
        ['Group 2', 'Bottom 6'],
      ],
    );
    assert.equal(c.cricketMatchFormat, 'ODI');
    assert.equal(placeholders(c).length, 0);
    const premier = bundle.leagues.find((l) => l.key === 'premier')!;
    assert.deepEqual(premier.relegation.swaps, [
      {
        competitionRef: c.externalRef,
        groupA: 'Group 1',
        positionA: 6,
        groupB: 'Group 2',
        positionB: 1,
        carryPoints: true,
      },
    ]);
    assert.deepEqual(premier.relegation.positionRelegations, [
      {
        competitionRef: c.externalRef,
        group: 'Group 2',
        position: 6,
        targetLeagueRef: 'smartclub:dolphins:league:promotion',
      },
    ]);
  });

  test('Promotion Men 30 Over: SUBDIVIDE into 2 sub-groups (Kingsmead Cup confirmed), not carry', () => {
    const c = comp('promotion', '30-over');
    assert.equal(c.format.type, 'league');
    assert.equal(c.format.rounds, 1);
    assert.deepEqual(c.format.extraPhases, [
      { type: 'league', rounds: 1, groupSeeding: 'subdivide', subGroups: 2 },
    ]);
    assert.deepEqual(sizes(c), [10, 10]);
    assert.equal(c.confirm, undefined);
    assert.equal(bundle.leagues.find((l) => l.key === 'promotion')!.relegation.swaps.length, 0);
  });

  test('Promotion Men T20: 4×5 groups, semis from the four winners (pairing confirmed)', () => {
    const c = comp('promotion', 't20');
    assert.equal(c.format.type, 'groups_knockout');
    assert.deepEqual(sizes(c), [5, 5, 5, 5]);
    assert.equal(placeholders(c).length, 3);
    assert.equal(c.confirm, undefined);
  });

  test('Premier Women: T20 2×4 cross-pool semis; 30 Over rounds 2, relegate G2 last to Promotion Women', () => {
    const t20 = comp('premierWomen', 't20');
    assert.equal(t20.format.type, 'groups_knockout');
    assert.deepEqual(sizes(t20), [4, 4]);
    const sf = placeholders(t20).filter((f) => f.stage === 'Semi-final');
    assert.deepEqual(
      sf.map((f) => [f.homeSlot, f.awaySlot]),
      [
        [gpos(1, 1), gpos(2, 2)],
        [gpos(2, 1), gpos(1, 2)],
      ],
    );
    const ov30 = comp('premierWomen', '30-over');
    assert.equal(ov30.format.type, 'league');
    assert.equal(ov30.format.rounds, 2);
    assert.deepEqual(sizes(ov30), [4, 4]);
    const pw = bundle.leagues.find((l) => l.key === 'premierWomen')!;
    assert.deepEqual(pw.relegation.positionRelegations, [
      {
        competitionRef: ov30.externalRef,
        group: 'Group 2',
        position: 4,
        targetLeagueRef: 'smartclub:dolphins:league:promotion-women-s-league',
      },
    ]);
    assert.deepEqual(pw.relegation.targetLeagueRefs, [
      'smartclub:dolphins:league:promotion-women-s-league',
    ]);
  });

  test('Promotion Women: exported so the relegation target exists; format inferred from fixtures, flagged', () => {
    const c = comp('promotion-women-s-league', 't20');
    assert.equal(c.formatSource, 'inferred');
    assert.equal(c.format.type, 'league');
    assert.equal(c.format.rounds, 2); // pairs meet more than twice; clamped and warned
    assert.equal(c.groups.length, 3);
    assert.ok(summary.warnings.some((w) => /promotion-women-s-league t20: a pair meets/.test(w)));
    assert.ok(summary.confirmations.some((m) => m.startsWith('promotion-women-s-league:')));
  });

  test('Veterans Premier: T20 2×6 cross-pool; 30 Over a single group of 12', () => {
    assert.deepEqual(sizes(comp('veterans-premier', 't20')), [6, 6]);
    const c = comp('veterans-premier', '30-over');
    assert.equal(c.format.type, 'league');
    assert.equal(c.format.rounds, 1);
    assert.deepEqual(sizes(c), [12]);
    assert.equal(c.fixtures.length, 66);
  });

  test('Veterans Promotion: T20 uneven 7+8 with a single final G1 1st v G2 2nd; 30 Over one group of 15', () => {
    const t20 = comp('veterans-promotion', 't20');
    assert.deepEqual(sizes(t20), [7, 8]);
    const ko = placeholders(t20);
    assert.equal(ko.length, 1);
    assert.equal(ko[0].stage, 'Final');
    assert.deepEqual([ko[0].homeSlot, ko[0].awaySlot], [gpos(1, 1), gpos(2, 2)]);
    assert.equal(t20.confirm, undefined);
    // Only G1 1st and G2 2nd qualify: no per-group advance count, the final carries the rule.
    assert.equal(t20.format.advancePerGroup, undefined);
    assert.deepEqual(sizes(comp('veterans-promotion', '30-over')), [15]);
  });

  test('union answers (1 Oct 2026) leave only the Promotion Women structure question open', () => {
    for (const key of ['premierWomen', 'veterans-premier']) {
      assert.equal(comp(key, 't20').confirm, undefined, `${key} t20 crossed semis confirmed`);
    }
    assert.equal(summary.confirmations.length, 1);
    assert.ok(summary.confirmations[0].startsWith('promotion-women-s-league:'));
    assert.deepEqual(bundle.meta.confirmations, summary.confirmations);
  });

  test('refs are invariant under --leagues: a premier-only export yields the same refs for premier', () => {
    const only = buildBundle({
      tenant: 'dolphins',
      config,
      clubs: [],
      playersByClub: new Map(),
      series,
      seasonRuns: [],
      recipes: DOLPHINS_RECIPES,
      options: { leagues: ['premier'], generatedAt: 'x' },
    }).bundle;
    const refsOf = (b: typeof bundle) => {
      const l = b.leagues.find((x) => x.key === 'premier')!;
      return {
        league: l.externalRef,
        season: l.season.externalRef,
        teams: [...l.teamRefs].sort(),
        teamObjects: b.teams
          .filter((t) => t.leagueKey === 'premier')
          .map((t) => [t.externalRef, t.institutionRef])
          .sort(),
        competitions: l.competitions.map((c) => c.externalRef).sort(),
        groups: l.competitions.flatMap((c) =>
          c.groups.map((g) => `${c.stream}/${g.name}:${g.teamRefs.join(',')}`),
        ),
        fixtures: l.competitions
          .flatMap((c) =>
            c.fixtures.map((f) =>
              [
                f.externalRef,
                f.homeTeamRef ?? JSON.stringify(f.homeSlot),
                f.awayTeamRef ?? JSON.stringify(f.awaySlot),
              ].join('|'),
            ),
          )
          .sort(),
        swaps: l.relegation.swaps,
      };
    };
    assert.deepEqual(refsOf(only), refsOf(bundle));
  });

  test('--leagues filter drops a relegation whose target is not exported', () => {
    const only = buildBundle({
      tenant: 'dolphins',
      config,
      clubs: [],
      playersByClub: new Map(),
      series,
      seasonRuns: [],
      recipes: DOLPHINS_RECIPES,
      options: { leagues: ['premier'], generatedAt: 'x' },
    });
    assert.deepEqual(
      only.bundle.leagues.map((l) => l.key),
      ['premier'],
    );
    assert.deepEqual(only.bundle.leagues[0].relegation.positionRelegations, []);
    assert.ok(MedicoachBundleSchema.safeParse(only.bundle).success);
  });
});
