/**
 * Player team placement (2026-10-02). A prod import keyed on bundle externalRefs is already
 * in flight, so the new placement may only ADD: teamRefs on players that had none, and the
 * club squad teams they land on. Every pre-existing object must be byte-identical, which
 * is checked against test/data/medicoach/placement-baseline.json: this same fixture built
 * by the exporter before the change.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MedicoachBundleSchema, refs, type MedicoachBundle } from '../src/medicoach-bundle.js';
import { buildBundle } from '../src/medicoach-export-build.js';
import { placementInputs, T } from './data/medicoach/placement-fixture.js';

const baseline = JSON.parse(
  readFileSync(new URL('./data/medicoach/placement-baseline.json', import.meta.url), 'utf8'),
) as MedicoachBundle;
const { bundle, summary } = buildBundle(placementInputs());

const teamsOf = (b: MedicoachBundle, nk: string) =>
  b.people.players.find((p) => p.externalRef === refs.player(T, nk))!.teamRefs;
const squad = (clubId: string) => refs.squadTeam(T, clubId);

describe('player placement', () => {
  test('the bundle validates (refs resolve, squads are league-less, counts match)', () => {
    const r = MedicoachBundleSchema.safeParse(bundle);
    assert.ok(r.success, r.success ? '' : r.error.issues.map((i) => i.message).join('\n'));
  });

  test('single side: unchanged', () => {
    assert.deepEqual(teamsOf(bundle, 'nk-solo'), [refs.team(T, 'premier', 'solo')]);
    assert.deepEqual(teamsOf(bundle, 'nk-multi-promo'), [refs.team(T, 'promotion', 'multi')]);
    assert.deepEqual(teamsOf(bundle, 'nk-vets'), [refs.team(T, 'veterans-premier', 'vets-club')]);
  });

  test('ambiguous multi-side club: every side of the club in that league', () => {
    assert.deepEqual(teamsOf(bundle, 'nk-twin'), [
      refs.team(T, 'premier', 'tm_twin_1'),
      refs.team(T, 'premier', 'tm_twin_2'),
    ]);
  });

  test('no usable league: the club squad, one per club, with a deterministic ref', () => {
    assert.deepEqual(teamsOf(bundle, 'nk-multi'), [squad('multi')]);
    assert.deepEqual(teamsOf(bundle, 'nk-multi-2'), [squad('multi')]);
    assert.deepEqual(teamsOf(bundle, 'nk-nolg'), [squad('nolg')]);
    assert.deepEqual(teamsOf(bundle, 'nk-twin-u19'), [squad('twin')]);
    const squads = bundle.teams.filter((t) => t.clubSquad);
    assert.deepEqual(squads, [
      {
        externalRef: 'smartclub:acme:team:multi:squad',
        institutionRef: refs.institution(T, 'multi'),
        sourceTeamId: 'multi',
        name: 'Multi CC Squad',
        clubSquad: true,
      },
      {
        externalRef: 'smartclub:acme:team:nolg:squad',
        institutionRef: refs.institution(T, 'nolg'),
        sourceTeamId: 'nolg',
        name: 'No League CC Squad',
        clubSquad: true,
      },
      {
        externalRef: 'smartclub:acme:team:twin:squad',
        institutionRef: refs.institution(T, 'twin'),
        sourceTeamId: 'twin',
        name: 'Twin CC Squad',
        clubSquad: true,
      },
    ]);
    // No league lists a squad, so it plays no fixtures.
    const leagueTeams = new Set(bundle.leagues.flatMap((l) => l.teamRefs));
    assert.ok(squads.every((t) => !leagueTeams.has(t.externalRef)));
  });

  test('veterans: an already-teamed player is never re-placed', () => {
    const vet = refs.team(T, 'veterans-premier', 'vets-club');
    assert.deepEqual(teamsOf(bundle, 'nk-twin-vet'), [vet]);
    assert.deepEqual(teamsOf(bundle, 'nk-nolg-vet'), [vet]);
  });

  test('summary: counts per rule, nothing left without a team', () => {
    assert.deepEqual(summary.players.placement, {
      singleSide: 3,
      veteransOnly: 2,
      allSidesOfAmbiguous: 1,
      clubSquad: 4,
    });
    assert.deepEqual(summary.players.clubSquadReasons, {
      noRegisteredLeague: 1,
      multipleCandidateLeagues: 2,
      leagueNotExported: 1,
      noSideInLeague: 0,
    });
    assert.equal(summary.players.squadTeams, 3);
    assert.equal(summary.players.noTeam, 0);
    assert.equal(summary.players.withTeam, summary.players.exported);
  });

  test('the export is deterministic', () => {
    assert.deepEqual(buildBundle(placementInputs()).bundle, bundle);
  });
});

describe('existing refs are untouched (vs the pre-change baseline)', () => {
  const byRef = <X extends { externalRef: string }>(xs: X[]) =>
    new Map(xs.map((x) => [x.externalRef, x]));

  test('host, meta and tenant are identical', () => {
    assert.deepEqual(bundle.host, baseline.host);
    assert.deepEqual(bundle.meta, baseline.meta);
    assert.equal(bundle.tenant, baseline.tenant);
    assert.equal(bundle.version, baseline.version);
  });

  test('institutions, staff and leagues (seasons, competitions, groups, fixtures, league teams) are identical', () => {
    assert.deepEqual(bundle.institutions, baseline.institutions);
    assert.deepEqual(bundle.people.staff, baseline.people.staff);
    assert.deepEqual(bundle.leagues, baseline.leagues);
  });

  test('every baseline team is identical and keeps its position; only club squads are added', () => {
    assert.deepEqual(bundle.teams.slice(0, baseline.teams.length), baseline.teams);
    const added = bundle.teams.slice(baseline.teams.length);
    assert.ok(added.length > 0);
    assert.ok(added.every((t) => t.clubSquad === true && t.externalRef.endsWith(':squad')));
  });

  test('players: same set; teamed ones identical, teamless ones differ only by added teamRefs', () => {
    const now = byRef(bundle.people.players);
    assert.deepEqual(
      [...now.keys()],
      baseline.people.players.map((p) => p.externalRef),
    );
    let gained = 0;
    for (const before of baseline.people.players) {
      const after = now.get(before.externalRef)!;
      if (before.teamRefs.length) {
        assert.deepEqual(after, before, before.externalRef);
        continue;
      }
      gained++;
      assert.ok(after.teamRefs.length > 0, `${before.externalRef} is placed`);
      assert.deepEqual({ ...after, teamRefs: [] }, before, before.externalRef);
    }
    assert.equal(gained, 5);
  });

  test('counts differ only in teams and player memberships', () => {
    const changed = Object.keys(bundle.counts).filter(
      (k) =>
        bundle.counts[k as keyof typeof bundle.counts] !==
        baseline.counts[k as keyof typeof baseline.counts],
    );
    assert.deepEqual(changed.sort(), ['playerTeamMemberships', 'teams']);
  });
});
