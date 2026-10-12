/**
 * Medicoach player sync placement + intent (ADR 0019), pure:
 *  - regression: the shared `desiredTeamRefs` (used by BOTH the bundle exporter and the sync)
 *    reproduces the exporter's teamRefs on the existing placement fixture, and the sync's own
 *    placement context (`buildPlacementContext`) agrees with the bundle player by player;
 *  - the per-person `syncIntent` table (active, clearance-pending source/destination,
 *    rejected-and-reactivated, inactive/placeholder-only → remove, veterans union);
 *  - the name+dob key the possible-duplicate guard matches on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refs } from '../src/medicoach-bundle.js';
import { buildBundle } from '../src/medicoach-export-build.js';
import {
  ageOn,
  buildPlacementContext,
  civilDateAt,
  desiredTeamRefs,
  distinctPair,
  nameDobKey,
  playerSyncEnabled,
  syncIntent,
  unclassifiedLeagueKeys,
} from '../src/medicoach-sync/player-placement.js';
import { buildPlayerEntry } from '../src/medicoach-sync/players.js';
import { PlayerPushEntrySchema } from '../src/medicoach-sync-contract.js';
import { lintLeagueCategories } from '../src/medicoach-recipes/index.js';
import { DOLPHINS_RECIPES } from '../src/medicoach-recipes/dolphins.js';
import { MedicoachBundleSchema } from '../src/medicoach-bundle.js';
import type { PlayerClearance, PlayerRegistration, TenantConfig } from '../src/types.js';
import {
  FAN_EVAL_DATE,
  FAN_GENERATED_AT,
  FAN_PLAYERS,
  fanOutInputs,
  fanPlayer,
  placementInputs,
  T,
} from './data/medicoach/placement-fixture.js';
import dolphinsSeed from '../seed-data/dolphins.json' with { type: 'json' };

const input = placementInputs();
const ctx = buildPlacementContext({
  tenant: T,
  config: input.config,
  clubs: input.clubs,
  series: input.series,
  seasonRuns: input.seasonRuns,
  recipes: input.recipes,
});
const allRows = [...input.playersByClub.values()].flat();
const rowsOf = (nk: string) => allRows.filter((r) => r.naturalKey === nk);
const row = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    firstName: 'Sipho',
    lastName: 'Dlamini',
    dob: '2001-02-03',
    isMinor: false,
    consentAt: 'x',
    createdAt: '2026-01-01',
    naturalKey: 'nk-x',
    clubId: 'solo',
    team: 'premier',
    ...p,
  }) as PlayerRegistration;
const clearance = (c: Partial<PlayerClearance>) =>
  ({ fromClubId: 'solo', toClubId: 'multi', status: 'pending', ...c }) as PlayerClearance;

describe('desiredTeamRefs — regression against the bundle exporter', () => {
  const { bundle } = buildBundle(input);

  test('every bundled player gets exactly the teamRefs the sync would push', () => {
    assert.ok(bundle.people.players.length >= 10);
    for (const p of bundle.people.players) {
      const nk = p.externalRef.slice(refs.player(T, '').length);
      const intent = syncIntent(rowsOf(nk), [], ctx);
      assert.equal(intent.op, 'upsert', nk);
      if (intent.op === 'upsert') assert.deepEqual(intent.teamRefs, p.teamRefs, nk);
    }
  });

  test('every team ref the sync places a fixture player on exists in the bundle', () => {
    const teams = new Set(bundle.teams.map((t) => t.externalRef));
    for (const nk of new Set(allRows.map((r) => r.naturalKey))) {
      const intent = syncIntent(rowsOf(nk), [], ctx);
      if (intent.op === 'upsert') for (const t of intent.teamRefs) assert.ok(teams.has(t), t);
    }
  });
});

describe('syncIntent — per person, never per row', () => {
  test('one active row → upsert with its desired teams', () => {
    const i = syncIntent([row({})], [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
      assert.equal(i.primary.clubId, 'solo');
    }
  });

  test('a status-absent legacy row counts as active', () => {
    const i = syncIntent([row({ status: undefined })], [], ctx);
    assert.equal(i.op, 'upsert');
  });

  test('main + veterans: the union of both clubs’ teams, main side first', () => {
    const i = syncIntent([row({ veteransClubId: 'vets-club' })], [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.deepEqual(i.teamRefs, [
        refs.team(T, 'premier', 'solo'),
        refs.team(T, 'veterans-premier', 'vets-club'),
      ]);
      assert.equal(i.veteransClubId, 'vets-club');
    }
  });

  test('pending clearance: source still counts, destination waits for approval', () => {
    const rows = [
      row({ clubId: 'solo', status: 'clearance-pending' }),
      row({ clubId: 'multi', status: 'clearance-pending', team: 'promotion' }),
    ];
    const i = syncIntent(rows, [clearance({ fromClubId: 'solo', toClubId: 'multi' })], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
      assert.equal(i.primary.clubId, 'solo');
    }
  });

  test('approved clearance: destination active, source inactive → the new club’s team only', () => {
    const rows = [
      row({ clubId: 'solo', status: 'inactive' }),
      row({ clubId: 'multi', status: 'active', team: 'promotion' }),
    ];
    const i = syncIntent(rows, [clearance({ status: 'approved' })], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') assert.deepEqual(i.teamRefs, [refs.team(T, 'promotion', 'multi')]);
  });

  test('rejected clearance (source reactivated, destination gone) → upsert with source teams', () => {
    const i = syncIntent([row({ clubId: 'solo' })], [clearance({ status: 'rejected' })], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
  });

  test('a clearance-pending row with no pending clearance naming it is not eligible', () => {
    const i = syncIntent([row({ status: 'clearance-pending' })], [], ctx);
    assert.deepEqual(i, { op: 'remove', reason: 'no-eligible-row' });
  });

  test('all inactive / legacy clearance-rejected / placeholder-only → remove', () => {
    for (const rows of [
      [row({ status: 'inactive' })],
      [row({ status: 'clearance-rejected' })],
      [row({ placeholder: true })],
      [row({ status: 'inactive' }), row({ clubId: 'multi', placeholder: true })],
    ])
      assert.deepEqual(syncIntent(rows, [], ctx), { op: 'remove', reason: 'no-eligible-row' });
  });

  test('no rows at all (club cleanup removed the last one) → remove, never erase', () => {
    assert.deepEqual(syncIntent([], [], ctx), { op: 'remove', reason: 'no-rows' });
  });

  test('veterans club erased (pointer scrubbed) → upsert with reduced teams, not remove', () => {
    const i = syncIntent([row({ veteransClubId: undefined })], [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') assert.deepEqual(i.teamRefs, [refs.team(T, 'premier', 'solo')]);
  });

  test('primary row: active beats pending source, then the newest registration', () => {
    const rows = [
      row({ clubId: 'solo', createdAt: '2026-03-01' }),
      row({ clubId: 'multi', team: 'promotion', createdAt: '2026-05-01' }),
    ];
    const i = syncIntent(rows, [], ctx);
    assert.equal(i.op, 'upsert');
    if (i.op === 'upsert') {
      assert.equal(i.primary.clubId, 'multi');
      assert.deepEqual(i.teamRefs, [
        refs.team(T, 'promotion', 'multi'),
        refs.team(T, 'premier', 'solo'),
      ]);
    }
  });
});

describe('guards and flags', () => {
  test('name+dob key: case, accents, punctuation and spacing tolerant; blank never matches', () => {
    assert.equal(
      nameDobKey({ firstName: ' Zoë ', lastName: "O'Neil", dob: '2001-02-03' }),
      nameDobKey({ firstName: 'zoe', lastName: 'o neil', dob: '2001-02-03' }),
    );
    assert.notEqual(
      nameDobKey({ firstName: 'Zoe', lastName: 'Oneil', dob: '2001-02-03' }),
      nameDobKey({ firstName: 'Zoe', lastName: 'Oneil', dob: '2001-02-04' }),
    );
    assert.equal(nameDobKey({ firstName: 'Zoe', lastName: 'Oneil' }), '');
  });

  test('distinct pairs are order-independent', () => {
    assert.deepEqual(distinctPair('b', 'a'), ['a', 'b']);
    assert.deepEqual(distinctPair('a', 'b'), ['a', 'b']);
  });

  test('player sync needs BOTH medicoachSync and integrations.medicoach.playerSync', () => {
    const cfg = (features: object, playerSync?: boolean) =>
      ({ features, integrations: { medicoach: { playerSync } } }) as unknown as TenantConfig;
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: true }, true)), true);
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: false }, true)), false);
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: true }, false)), false);
    assert.equal(playerSyncEnabled(cfg({ medicoachSync: true })), false);
    assert.equal(playerSyncEnabled(null), false);
  });
});

/* ─────────────────────────── Fan-out placement ─────────────────────────── */

const fanIn = fanOutInputs();
const fanCtx = (fanOut = true) => {
  const i = fanOutInputs({ fanOut });
  return buildPlacementContext({
    tenant: T,
    config: i.config,
    clubs: i.clubs,
    series: i.series,
    seasonRuns: i.seasonRuns,
    recipes: i.recipes,
    evalDate: FAN_EVAL_DATE,
  });
};
const FCTX = fanCtx();
const side = (league: string, id: string) => refs.team(T, league, id);
const fanOf = (nk: string) => desiredTeamRefs(FAN_PLAYERS.find((p) => p.naturalKey === nk)!, FCTX);
const SENIOR = [side('emcuD1', 'tm_big_emcuD1_0'), side('emcuD1', 'tm_big_emcuD1_1')];

describe('fan-out placement — flag off is byte-identical', () => {
  test('no recipe placement ⇒ no fanOut context, no fan-out refs, no wire/bundle field', () => {
    const off = fanCtx(false);
    assert.equal(off.fanOut, undefined);
    for (const p of FAN_PLAYERS) {
      const placed = desiredTeamRefs(p, off);
      assert.deepEqual(placed.fanOutTeamRefs, []);
      assert.equal(placed.placementDataGap, undefined);
      // Rules 1–4 are untouched by fan-out: teamRefs identical with the flag on or off.
      assert.deepEqual(placed.teamRefs, desiredTeamRefs(p, FCTX).teamRefs, p.naturalKey);
      const intent = syncIntent([p], [], off);
      assert.ok(intent.op === 'upsert' && !('fanOutTeamRefs' in intent));
      assert.ok(!('placementDataGaps' in intent));
      const entry = buildPlayerEntry(T, { naturalKey: p.naturalKey, changedAt: 'x' }, intent);
      assert.ok(!('fanOutTeamRefs' in entry), 'wire entry byte-identical');
    }
    const { bundle, summary } = buildBundle(fanOutInputs({ fanOut: false }));
    for (const bp of bundle.people.players) assert.ok(!('fanOutTeamRefs' in bp));
    assert.equal(summary.players.fanOut, undefined);
  });

  test('categories without placement.fanOut never fan out (the flag, not the categories, gates)', () => {
    assert.ok(
      Object.values(fanOutInputs({ fanOut: false }).recipes.leagues).some((l) => l.category),
    );
    assert.deepEqual(desiredTeamRefs(fanPlayer({}), fanCtx(false)).fanOutTeamRefs, []);
  });

  test('the existing placement fixture (no recipe placement) is unchanged by the fan-out code', () => {
    const { bundle } = buildBundle(placementInputs());
    for (const bp of bundle.people.players) assert.ok(!('fanOutTeamRefs' in bp));
  });
});

describe('fan-out placement — the three arms', () => {
  test('a man 15+ fans onto every side of every senior-open league, incl. lettered tm_ sides', () => {
    const p = fanOf('nk-man');
    assert.deepEqual(p.teamRefs, [side('premier', 'big')]);
    assert.deepEqual(p.fanOutTeamRefs, SENIOR);
  });

  test('a boy turning 15 ON the eval date fans out; one a day younger (14) does not', () => {
    assert.deepEqual(fanOf('nk-boy-15').fanOutTeamRefs, SENIOR);
    assert.deepEqual(fanOf('nk-boy-14').fanOutTeamRefs, []);
    assert.equal(fanOf('nk-boy-14').placementDataGap, undefined, 'too young is not a data gap');
  });

  test('women 15+ fan onto the women’s sides only; a 14-year-old girl does not', () => {
    const w = fanOutInputs()
      .playersByClub.get('big')!
      .find((r) => r.naturalKey === 'nk-woman')!;
    // Registered in premierWomen: that side is her teamRef, so a second women's league would be
    // her fan-out. Re-register her in premier to see the arm on its own.
    assert.deepEqual(desiredTeamRefs({ ...w, team: 'premier' }, FCTX).fanOutTeamRefs, [
      side('premierWomen', 'big'),
    ]);
    assert.deepEqual(fanOf('nk-woman').fanOutTeamRefs, [], 'already on it via teamRefs');
    assert.deepEqual(
      desiredTeamRefs({ ...fanPlayer({ gender: 'F', dob: '2012-01-01' }) }, FCTX).fanOutTeamRefs,
      [],
    );
    assert.deepEqual(fanOf('nk-girl-14').fanOutTeamRefs, []);
  });

  test('a man 40+ with NO veteransClubId fans onto his club’s veterans sides (and senior)', () => {
    const v = fanOf('nk-vet');
    assert.deepEqual(v.fanOutTeamRefs, [side('veterans-premier', 'big'), ...SENIOR]);
    assert.equal(v.veteransResolved, false, 'the veteransClubId rule is untouched');
  });

  test('custom thresholds from the recipe are honoured', () => {
    const i = fanOutInputs();
    const ctx = buildPlacementContext({
      tenant: T,
      config: i.config,
      clubs: i.clubs,
      series: [],
      seasonRuns: [],
      recipes: { ...i.recipes, placement: { fanOut: true, seniorMinAge: 18, veteransMinAge: 50 } },
      evalDate: FAN_EVAL_DATE,
    });
    assert.deepEqual(desiredTeamRefs(fanPlayer({ dob: '2010-01-01' }), ctx).fanOutTeamRefs, []);
    assert.deepEqual(desiredTeamRefs(fanPlayer({ dob: '1980-01-01' }), ctx).fanOutTeamRefs, SENIOR);
  });

  test('missing/unrecognised gender or dob ⇒ legacy placement only, counted as a data gap', () => {
    for (const p of [
      fanPlayer({ gender: undefined }),
      fanPlayer({ gender: 'Womxn' }),
      fanPlayer({ dob: '' }),
      fanPlayer({ dob: 'not-a-date' }),
    ]) {
      const placed = desiredTeamRefs(p, FCTX);
      assert.deepEqual(placed.fanOutTeamRefs, []);
      assert.equal(placed.placementDataGap, true);
      assert.deepEqual(placed.teamRefs, [side('premier', 'big')], 'legacy placement intact');
    }
    const i = syncIntent([fanPlayer({ gender: undefined })], [], FCTX);
    assert.ok(i.op === 'upsert');
    assert.equal(i.placementDataGaps, 1);
    assert.deepEqual(i.fanOutTeamRefs, []);
  });
});

describe('fan-out placement — what never fans out', () => {
  test('unclassified leagues never fan out, incl. the real Dolphins kcSat / snT20 keys', () => {
    const all = FAN_PLAYERS.flatMap((p) => desiredTeamRefs(p, FCTX).fanOutTeamRefs);
    assert.ok(FCTX.sidesOf('big', 'kcSat').length && FCTX.sidesOf('big', 'snT20').length);
    for (const k of ['kcSat', 'snT20'])
      for (const t of FCTX.sidesOf('big', k)) assert.ok(!all.includes(t), t);
    assert.deepEqual(unclassifiedLeagueKeys(FCTX).sort(), ['kcSat', 'snT20']);
    // And in the real recipe: the seed's sub-union + registration leagues are unclassified.
    for (const k of ['kcSat', 'kcD1', 'kcWebber', 'snT20', 'sn30', 'veterans'])
      assert.equal(DOLPHINS_RECIPES.leagues[k]?.category, undefined, k);
  });

  test('junior, fixtures-only and recipe-excluded leagues never fan out', () => {
    const all = FAN_PLAYERS.flatMap((p) => desiredTeamRefs(p, FCTX).fanOutTeamRefs);
    for (const k of ['emcuU11', 'cup']) {
      assert.ok(FCTX.sidesOf('big', k).length, k);
      for (const t of FCTX.sidesOf('big', k)) assert.ok(!all.includes(t), t);
    }
    assert.equal(FCTX.sidesOf('big', 'promotion-women-s-league').length, 0, 'excluded');
    assert.ok(!all.some((t) => t.includes('promotion-women-s-league')));
  });

  test('a recipe with fan-out on but no evalDate is refused (never a silent clock read)', () => {
    const i = fanOutInputs();
    assert.throws(() =>
      buildPlacementContext({
        tenant: T,
        config: i.config,
        clubs: i.clubs,
        series: [],
        seasonRuns: [],
        recipes: i.recipes,
      }),
    );
  });
});

describe('fan-out — syncIntent and the wire', () => {
  test('fan-out refs union across a person’s rows, disjoint from teamRefs', () => {
    const big = fanPlayer({ naturalKey: 'nk-both' });
    const small = fanPlayer({ naturalKey: 'nk-both', clubId: 'small', createdAt: '2025-01-01' });
    const i = syncIntent([big, small], [], FCTX);
    assert.ok(i.op === 'upsert');
    assert.deepEqual(i.teamRefs, [side('premier', 'big'), side('premier', 'small')]);
    assert.deepEqual(i.fanOutTeamRefs, [...SENIOR, side('emcuD1', 'small')]);
    for (const t of i.fanOutTeamRefs!) assert.ok(!i.teamRefs.includes(t));
  });

  test('a ref placed by rule 1–4 on one row and fan-out on another stays in teamRefs only', () => {
    const emcu = fanPlayer({ naturalKey: 'nk-x', clubId: 'small', team: 'emcuD1' });
    const prem = fanPlayer({ naturalKey: 'nk-x', clubId: 'small', createdAt: '2025-01-01' });
    const i = syncIntent([emcu, prem], [], FCTX);
    assert.ok(i.op === 'upsert');
    assert.ok(i.teamRefs.includes(side('emcuD1', 'small')));
    assert.ok(!i.fanOutTeamRefs!.includes(side('emcuD1', 'small')));
  });

  test('the upsert entry carries fanOutTeamRefs and fits the contract', () => {
    const p = fanPlayer({ naturalKey: 'nk-wire' });
    const e = buildPlayerEntry(
      T,
      { naturalKey: 'nk-wire', changedAt: '2026-10-03T00:00:00.000Z' },
      syncIntent([p], [], FCTX),
    );
    assert.deepEqual(e.fanOutTeamRefs, SENIOR);
    assert.ok(PlayerPushEntrySchema.safeParse(e).success);
  });

  test('remove carries no team sets: medicoach removes stored-desired ∪ stored fan-out', () => {
    const gone = fanPlayer({ naturalKey: 'nk-gone', status: 'inactive' });
    const i = syncIntent([gone], [], FCTX);
    assert.equal(i.op, 'remove');
    const e = buildPlayerEntry(
      T,
      { naturalKey: 'nk-gone', changedAt: '2026-10-03T00:00:00.000Z' },
      i,
    );
    assert.equal(e.op, 'remove');
    assert.ok(!('fanOutTeamRefs' in e) && !('teamRefs' in e));
    // The contract refuses a fan-out set on a remove (the licence lives on the medicoach side).
    assert.equal(PlayerPushEntrySchema.safeParse({ ...e, fanOutTeamRefs: SENIOR }).success, false);
  });
});

describe('fan-out — exporter ↔ sync parity', () => {
  const { bundle, summary } = buildBundle(fanIn);
  const ctx = (() => {
    const evalDate = civilDateAt(new Date(FAN_GENERATED_AT), '+02:00');
    assert.equal(evalDate, FAN_EVAL_DATE, 'one civil date from the same instant');
    return FCTX;
  })();

  test('every bundled player carries exactly the teamRefs AND fanOutTeamRefs the sync pushes', () => {
    assert.equal(bundle.people.players.length, FAN_PLAYERS.length);
    for (const bp of bundle.people.players) {
      const nk = bp.externalRef.slice(refs.player(T, '').length);
      const intent = syncIntent(
        FAN_PLAYERS.filter((r) => r.naturalKey === nk),
        [],
        ctx,
      );
      assert.ok(intent.op === 'upsert', nk);
      assert.deepEqual(bp.teamRefs, intent.teamRefs, nk);
      assert.deepEqual(bp.fanOutTeamRefs, intent.fanOutTeamRefs, nk);
    }
  });

  test('the fan-out bundle validates (every fan-out ref is a bundle team) and is summarised', () => {
    assert.ok(MedicoachBundleSchema.safeParse(bundle).success);
    assert.deepEqual(summary.players.fanOut, {
      playersFannedOut: 4, // man, boy-15, vet, small
      memberships: 2 + 2 + 3 + 1,
      placementDataGaps: 2,
      unclassifiedLeagues: ['kcSat', 'snT20'],
    });
  });

  test('ages are evaluated on the TENANT civil date, not the UTC date', () => {
    assert.equal(civilDateAt(new Date('2026-10-02T21:59:59Z'), '+02:00'), '2026-10-02');
    assert.equal(civilDateAt(new Date('2026-10-02T22:00:00Z'), '+02:00'), '2026-10-03');
    assert.equal(ageOn('2011-10-03', '2026-10-03'), 15);
    assert.equal(ageOn('2011-10-04', '2026-10-03'), 14);
    assert.equal(ageOn('2008-02-29', '2026-02-28'), 17);
  });
});

describe('fan-out — recipe classification lint', () => {
  const catalogue = (
    dolphinsSeed as { leagues: Array<{ key: string; label: string; group: string }> }
  ).leagues;

  test('the Dolphins categories agree with the label/group classifiers', () => {
    assert.deepEqual(lintLeagueCategories(DOLPHINS_RECIPES, catalogue), []);
  });

  test('a category disagreeing with isWomensLeague / isVeteransLeague / Juniors is flagged', () => {
    const bad = {
      leagues: {
        premierWomen: { category: 'senior-open', competitions: {} },
        'veterans-premier': {
          label: 'Veterans Premier',
          category: 'senior-open',
          competitions: {},
        },
        premier: { category: 'womens', competitions: {} },
        emcuU11: { category: 'senior-open', competitions: {} },
      },
    } as const;
    const issues = lintLeagueCategories(bad as never, catalogue);
    assert.equal(issues.filter((i) => i.startsWith('premierWomen')).length, 1);
    assert.equal(issues.filter((i) => i.startsWith('veterans-premier')).length, 1);
    assert.equal(issues.filter((i) => i.startsWith('premier ')).length, 1);
    assert.equal(issues.filter((i) => i.startsWith('emcuU11')).length, 1);
  });

  test('Dolphins classifies exactly the medicoach-imported leagues (+ EMCU juniors)', () => {
    const cats = Object.fromEntries(
      Object.entries(DOLPHINS_RECIPES.leagues)
        .filter(([, l]) => l.category)
        .map(([k, l]) => [k, l.category]),
    );
    assert.deepEqual(cats, {
      premier: 'senior-open',
      promotion: 'senior-open',
      premierWomen: 'womens',
      'veterans-premier': 'veterans',
      'veterans-promotion': 'veterans',
      emcuD1: 'senior-open',
      emcuD2: 'senior-open',
      emcuD3_s1: 'senior-open',
      emcuD3_s2: 'senior-open',
      emcuD4_s1: 'senior-open',
      emcuD4_s2: 'senior-open',
      emcuD5_s1: 'senior-open',
      emcuD5_s2: 'senior-open',
      emcuU11: 'junior',
      emcuU13: 'junior',
    });
    assert.equal(DOLPHINS_RECIPES.placement?.fanOut, true);
  });
});

describe('fan-out — enqueue-players dry run surfaces the prediction', () => {
  test('planBackfill counts fan-out players, add-only memberships, data gaps and unclassified leagues', async () => {
    const { planBackfill } = await import('../src/medicoach-sync/enqueue-players.js');
    const rowsByNk = new Map(FAN_PLAYERS.map((p) => [p.naturalKey, [p]]));
    const snap = {
      config: null,
      ctx: FCTX,
      clubsById: new Map(),
      rowsByNk,
      clearancesByNk: new Map(),
      byNameDob: new Map(),
      distinct: new Set<string>(),
    };
    const plan = planBackfill(snap as never);
    assert.equal(plan.counts.upsert, FAN_PLAYERS.length);
    assert.deepEqual(plan.fanOut, {
      players: 4,
      memberships: 8,
      placementDataGaps: 2,
      unclassifiedLeagues: ['kcSat', 'snT20'],
    });
    const off = planBackfill({ ...snap, ctx: fanCtx(false) } as never);
    assert.equal(off.fanOut, undefined, 'no fan-out lines for a tenant without it');
  });
});
