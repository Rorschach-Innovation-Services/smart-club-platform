/**
 * Unit tests for patch-fixtures.ts's pure core (planFixturePatches + the two-pass write
 * helpers). No repo, no DynamoDB — a tiny synthetic tenant run through the real clash
 * detector, ledger and candidate chain.
 *
 * World: clubs alpha / beta / gamma. Beta Park is beta's ground, Alpha Oval alpha's, with
 * Alpha 2 as alpha's secondary. One released series and one draft series play on Sun
 * 2026-10-11; the draft's untimed beta v alpha has no venue, so it implicitly holds Beta Park
 * all day.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  planFixturePatches,
  teamOnlySnapshot,
  applyRemainingChanges,
  decodeItems,
  type PatchManifest,
  type PatchEntry,
} from '../src/patch-fixtures.js';
import {
  buildCandidateGrounds,
  buildPermittedByClub,
  buildVenueIndex,
} from '../src/resolve-venue-clashes.js';
import type { Club, Series, Venue } from '../src/types.js';

const DATE = '2026-10-11';

interface Fx {
  id: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  venueId?: string;
  venueName?: string;
  venueOverride?: string;
  venueStatus?: string;
  venueLocked?: boolean;
  [k: string]: unknown;
}

const clubs = [
  { id: 'alpha', name: 'Alpha CC', ground: { venue: 'Alpha Oval', secondaryVenue: 'Alpha 2' } },
  { id: 'beta', name: 'Beta CC', ground: { venue: 'Beta Park' } },
  { id: 'gamma', name: 'Gamma CC', ground: { venue: 'Gamma Field' } },
] as unknown as Club[];

const venues: Venue[] = [
  { id: 'v-alpha', name: 'Alpha Oval', homeClubIds: ['alpha'], lat: -29.9, lon: 30.9 },
  { id: 'v-alpha2', name: 'Alpha 2', homeClubIds: ['alpha'] },
  { id: 'v-beta', name: 'Beta Park', homeClubIds: ['beta'] },
  { id: 'v-gamma', name: 'Gamma Field', homeClubIds: ['gamma'] },
  { id: 'v-neutral', name: 'Neutral Ground', homeClubIds: [] },
];

function series(id: string, released: boolean, fixtures: Fx[], extra: object = {}): Series {
  return {
    id,
    name: id,
    startDate: DATE,
    teams: [],
    fixtures,
    released,
    version: 4,
    ...extra,
  } as unknown as Series;
}

/** Released league: alpha v beta at Beta Park 09:00, gamma v beta at Gamma Field 13:30. */
function released(): Series {
  return series('s-rel', true, [
    {
      id: 'f1',
      date: DATE,
      time: '09:00',
      home: 'alpha',
      away: 'beta',
      venueId: 'v-beta',
      venueName: 'Beta Park',
      venueLocked: true,
    },
    {
      id: 'f2',
      date: DATE,
      time: '13:30',
      home: 'gamma',
      away: 'beta',
      venueOverride: 'Gamma Field ',
    },
  ]);
}

/** Draft season-run: an untimed, venue-less beta v alpha ⇒ implicitly Beta Park all day. */
function draft(): Series {
  return series('s-draft', false, [{ id: 'f1', date: DATE, home: 'beta', away: 'alpha' }]);
}

const entry = (over: Partial<PatchEntry> & Pick<PatchEntry, 'set'>): PatchEntry => ({
  seriesId: 's-rel',
  fixtureId: 'f2',
  expect: { home: 'gamma', away: 'beta', date: DATE, time: '13:30', venue: 'gamma field' },
  ...over,
});

const manifest = (entries: PatchEntry[], relocate = true): PatchManifest => ({
  venueReason: 'Sheet',
  entries,
  ...(relocate ? { relocateDraftClashes: { dates: [DATE], takenBy: 'sheet fixture' } } : {}),
});

const fx = (all: Series[], sid: string, fid: string): Fx =>
  (all.find((s) => s.id === sid)!.fixtures as Fx[]).find((f) => f.id === fid)!;

describe('planFixturePatches — section A', () => {
  test('applies time, home side and registry venue binds; inputs untouched', () => {
    const input = [
      released(),
      series(
        's-teams',
        true,
        [
          {
            id: 'f1',
            date: '2026-10-10',
            time: '13:00',
            home: 'tm-a',
            away: 'tm-b',
            venueOverride: 'Free text',
          },
        ],
        {
          participants: [
            { teamId: 'tm-a', clubId: 'alpha', name: 'Alpha Vets' },
            { teamId: 'tm-b', clubId: 'beta', name: 'Beta Vets' },
            { teamId: 'tm-g', clubId: 'gamma', name: 'Gamma Vets' },
          ],
        },
      ),
    ];
    const snapshot = structuredClone(input);
    const plan = planFixturePatches(
      input,
      clubs,
      venues,
      manifest(
        [
          // time + bind to a ground the home club does NOT own ⇒ neutral
          entry({ set: { time: '09:00', venueId: 'v-neutral' } }),
          // home change via participants, then bind to the NEW home club's ground ⇒ home
          {
            seriesId: 's-teams',
            fixtureId: 'f1',
            expect: {
              home: 'tm-a',
              away: 'tm-b',
              date: '2026-10-10',
              time: '13:00',
              venue: 'FREE TEXT',
            },
            set: { home: 'tm-g', venueId: 'v-gamma' },
          },
        ],
        false,
      ),
    );
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(input, snapshot, 'inputs are not mutated');

    const f2 = fx(plan.next, 's-rel', 'f2');
    assert.equal(f2.time, '09:00');
    assert.equal(f2.venueId, 'v-neutral');
    assert.equal(f2.venueName, 'Neutral Ground');
    assert.equal(f2.venueOverride, undefined);
    assert.equal(f2.venueLocked, true);
    assert.equal(f2.venueStatus, 'neutral');
    assert.equal(f2.venueReason, 'Sheet');

    const t1 = fx(plan.next, 's-teams', 'f1');
    assert.equal(t1.home, 'tm-g');
    assert.equal(t1.venueId, 'v-gamma');
    assert.equal(t1.venueStatus, 'home');
    assert.deepEqual(plan.touchedSeriesIds.sort(), ['s-rel', 's-teams']);
    assert.equal(plan.diffs.length, 2);
  });

  test('a guard mismatch aborts the run with an error naming the field', () => {
    const plan = planFixturePatches(
      [released(), draft()],
      clubs,
      venues,
      manifest([
        entry({
          expect: { home: 'gamma', away: 'beta', date: DATE, time: '21:00', venue: 'Gamma Field' },
          set: { time: '09:00' },
        }),
      ]),
    );
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /s-rel\/f2: guard mismatch — time "13:30" ≠ expected "21:00"/);
    assert.equal(plan.gate, undefined, 'no relocation / gate after a guard failure');
    assert.equal(plan.moves.length, 0);
  });

  test('unknown series, fixture and venueId are errors', () => {
    const plan = planFixturePatches(
      [released()],
      clubs,
      venues,
      manifest(
        [
          entry({ seriesId: 's-nope', set: { time: '09:00' } }),
          entry({ fixtureId: 'f99', set: { time: '09:00' } }),
          entry({ set: { venueId: 'v-nope' } }),
        ],
        false,
      ),
    );
    assert.equal(plan.errors.length, 3);
    assert.match(plan.errors[0], /series not found/);
    assert.match(plan.errors[1], /fixture not found/);
    assert.match(plan.errors[2], /not in the registry/);
  });
});

describe('planFixturePatches — section B draft relocation', () => {
  test('a draft sharing a released fixture’s ground moves to the first ALL-DAY-free candidate', () => {
    // Alpha Oval (first candidate: away side's allocated ground) is busy only at 13:30 —
    // still not free all day for an untimed draft, so Alpha 2 (away club's secondary) wins.
    const rel = released();
    (rel.fixtures as Fx[]).push({
      id: 'f3',
      date: DATE,
      time: '13:30',
      home: 'gamma',
      away: 'alpha',
      venueName: 'Alpha Oval',
    });
    const plan = planFixturePatches(
      [rel, draft()],
      clubs,
      venues,
      manifest([entry({ set: { time: '13:00' } })]),
    );
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.moves.length, 1);
    const m = plan.moves[0];
    assert.equal(`${m.seriesId}/${m.fixtureId}`, 's-draft/f1');
    assert.equal(m.from, 'Beta Park');
    assert.equal(m.to, 'Alpha 2');
    assert.equal(m.label, "away club's secondary ground");
    assert.deepEqual(m.blockedBy, ['s-rel/f1']);
    assert.match(m.tried[0], /^Alpha Oval \[away side's allocated ground\] ← s-rel\/f3$/);

    const d = fx(plan.next, 's-draft', 'f1');
    assert.equal(d.venueId, 'v-alpha2');
    assert.equal(d.venueStatus, 'alternative');
    assert.equal(d.venueReason, 'Moved: Beta Park taken by sheet fixture');
    assert.equal(plan.gate!.introduced.length, 0);
    assert.equal(plan.gate!.weekendReleased.length, 0);
  });

  test('released fixtures are never moved — a released-vs-released clash is a gate error', () => {
    const rel = released();
    // A second released series puts its own game on Beta Park at 09:00 too.
    const rel2 = series('s-rel2', true, [
      { id: 'f1', date: DATE, time: '09:00', home: 'gamma', away: 'alpha', venueName: 'Beta Park' },
    ]);
    const before = structuredClone([rel, rel2]);
    const plan = planFixturePatches(
      [rel, rel2, draft()],
      clubs,
      venues,
      manifest([entry({ set: { time: '13:00' } })]),
    );
    // The draft still moves off Beta Park; neither released Beta Park game is touched.
    assert.deepEqual(
      plan.moves.map((m) => `${m.seriesId}/${m.fixtureId}`),
      ['s-draft/f1'],
    );
    assert.deepEqual(fx(plan.next, 's-rel', 'f1'), before[0].fixtures![0]);
    assert.deepEqual(fx(plan.next, 's-rel2', 'f1'), before[1].fixtures![0]);
    assert.ok(plan.gate!.weekendReleased.length > 0);
    assert.ok(plan.errors.some((e) => /involve a released fixture/.test(e)));
  });

  test('no free candidate ground ⇒ hard error, draft left in place', () => {
    const rel = released();
    // Every candidate for beta v alpha is taken that day: Alpha Oval and Alpha 2.
    (rel.fixtures as Fx[]).push(
      {
        id: 'f3',
        date: DATE,
        time: '09:00',
        home: 'gamma',
        away: 'alpha',
        venueName: 'Alpha Oval',
      },
      { id: 'f4', date: DATE, time: '09:00', home: 'gamma', away: 'beta', venueName: 'Alpha 2' },
    );
    const plan = planFixturePatches(
      [rel, draft()],
      clubs,
      venues,
      manifest([entry({ set: { time: '13:00' } })]),
    );
    assert.equal(plan.moves.length, 0);
    assert.ok(
      plan.errors.some((e) =>
        /^no free all-day ground for draft s-draft\/f1 on 2026-10-11/.test(e),
      ),
    );
    assert.equal(fx(plan.next, 's-draft', 'f1').venueName, undefined);
  });

  test('a section-A venue move onto a draft’s implicit ground relocates that draft', () => {
    // Move released f2 onto Beta Park at 13:30 — the draft (untimed, Beta Park) must give way.
    const rel = series('s-rel', true, [
      {
        id: 'f2',
        date: DATE,
        time: '13:30',
        home: 'gamma',
        away: 'beta',
        venueOverride: 'Gamma Field ',
      },
    ]);
    const plan = planFixturePatches(
      [rel, draft()],
      clubs,
      venues,
      manifest([entry({ set: { venueId: 'v-beta' } })]),
    );
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.moves.length, 1);
    assert.equal(plan.moves[0].to, 'Alpha Oval');
    assert.equal(plan.gate!.introduced.length, 0);
  });
});

describe('candidate chain (extracted from resolve-venue-clashes)', () => {
  test('order: away ground, home secondary, away secondary, permitted fields; contested excluded', () => {
    const byNorm = buildVenueIndex(venues);
    const c = buildCandidateGrounds({
      homeClubId: 'beta',
      awayClubId: 'alpha',
      contested: 'Beta Park',
      clubsById: new Map(clubs.map((x) => [x.id, x])),
      byNorm,
      permittedByClub: buildPermittedByClub(byNorm),
    });
    assert.deepEqual(
      c.map((x) => x.ground),
      ['Alpha Oval', 'Alpha 2'],
    );
  });
});

describe('two-pass write helpers', () => {
  const original = series('s', true, [
    {
      id: 'f7',
      date: DATE,
      time: '09:00',
      home: 'harlequins',
      away: 'toti',
      venueName: 'Danville 1',
    },
    { id: 'f8', date: DATE, time: '09:00', home: 'cs', away: 'sn', venueName: 'Tills' },
  ]);
  const planned = series('s', true, [
    { id: 'f7', date: DATE, time: '13:30', home: 'rhythm', away: 'toti', venueName: 'Danville 1' },
    {
      id: 'f8',
      date: DATE,
      time: '13:30',
      home: 'cs',
      away: 'sn',
      venueName: 'Chatsworth Oval',
      venueId: 'v-co',
    },
  ]);

  test('pass 1 snapshot carries ONLY the home/away change', () => {
    const p1 = teamOnlySnapshot(original, planned)!;
    assert.deepEqual(p1.fixtures, [
      {
        id: 'f7',
        date: DATE,
        time: '09:00',
        home: 'rhythm',
        away: 'toti',
        venueName: 'Danville 1',
      },
      { id: 'f8', date: DATE, time: '09:00', home: 'cs', away: 'sn', venueName: 'Tills' },
    ]);
    assert.equal(teamOnlySnapshot(original, original), undefined, 'no side change ⇒ single pass');
  });

  test('pass 2 applies every remaining change on the re-read series, keeping its own fields', () => {
    const reread = teamOnlySnapshot(original, planned)!;
    reread.version = 5;
    (reread.fixtures as Fx[])[0].schedule = { changedAt: '2026-10-06T00:00:00.000Z' };
    const p2 = applyRemainingChanges(reread, original, planned);
    assert.equal(p2.version, 5);
    assert.deepEqual(p2.fixtures, [
      {
        id: 'f7',
        date: DATE,
        time: '13:30',
        home: 'rhythm',
        away: 'toti',
        venueName: 'Danville 1',
        schedule: { changedAt: '2026-10-06T00:00:00.000Z' },
      },
      {
        id: 'f8',
        date: DATE,
        time: '13:30',
        home: 'cs',
        away: 'sn',
        venueName: 'Chatsworth Oval',
        venueId: 'v-co',
      },
    ]);
  });
});

describe('decodeItems', () => {
  test('accepts raw DynamoDB Query output and plain arrays alike', () => {
    const plain = [{ id: 'v-a', name: 'A', surfaces: 1 }];
    assert.deepEqual(decodeItems({ Items: plain.map((p) => marshall(p)) }), plain);
    assert.deepEqual(decodeItems(plain), plain);
    assert.throws(() => decodeItems({ nope: 1 }));
  });
});

describe('planFixturePatches — set.dateTbc', () => {
  const tbcEntry = (seriesId: string, fixtureId: string, x: PatchEntry['expect']): PatchEntry => ({
    seriesId,
    fixtureId,
    expect: x,
    set: { dateTbc: true },
  });

  test('dateTbc on a released series is a hard error', () => {
    const plan = planFixturePatches(
      [released(), draft()],
      clubs,
      venues,
      manifest([
        tbcEntry('s-rel', 'f1', {
          home: 'alpha',
          away: 'beta',
          date: DATE,
          time: '09:00',
          venue: 'Beta Park',
        }),
      ]),
    );
    assert.equal(plan.errors.length, 1);
    assert.match(plan.errors[0], /s-rel\/f1: set\.dateTbc is only allowed on a draft series/);
    assert.equal(fx(plan.next, 's-rel', 'f1').dateTbc, undefined);
  });

  test('dateTbc on a draft takes it out of mover detection and the gate; date kept', () => {
    // Same world as the no-candidate case: without the TBC mark the draft would be a hard error.
    const rel = released();
    (rel.fixtures as Fx[]).push(
      {
        id: 'f3',
        date: DATE,
        time: '09:00',
        home: 'gamma',
        away: 'alpha',
        venueName: 'Alpha Oval',
      },
      { id: 'f4', date: DATE, time: '09:00', home: 'gamma', away: 'beta', venueName: 'Alpha 2' },
    );
    const plan = planFixturePatches(
      [rel, draft()],
      clubs,
      venues,
      manifest([
        tbcEntry('s-draft', 'f1', { home: 'beta', away: 'alpha', date: DATE, time: '', venue: '' }),
      ]),
    );
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.moves.length, 0);
    const d = fx(plan.next, 's-draft', 'f1');
    assert.equal(d.dateTbc, true);
    assert.equal(d.date, DATE);
    assert.equal(plan.gate!.introduced.length, 0);
    assert.equal(plan.gate!.weekendReleased.length, 0);
  });
});

describe('planFixturePatches — set.date, postponements and gate mode', () => {
  /** s-rel plus a second released series holding Gamma Field at 13:30 on the 18th. */
  const nextWeek = () =>
    series('s-next', true, [
      {
        id: 'n1',
        date: '2026-10-18',
        time: '13:30',
        home: 'alpha',
        away: 'gamma',
        venueName: 'Gamma Field',
      },
    ]);

  test('set.date alone re-dates the fixture; the gate checks the NEW day', () => {
    const clean = planFixturePatches(
      [released(), nextWeek()],
      clubs,
      venues,
      manifest([entry({ set: { date: '2026-10-17' } })], false),
    );
    assert.deepEqual(clean.errors, []);
    const f2 = fx(clean.next, 's-rel', 'f2');
    assert.equal(f2.date, '2026-10-17');
    assert.equal(f2.status, undefined, 'a plain re-date is not a postponement');
    assert.equal(f2.originalDate, undefined);

    // Onto Gamma Field 13:30 on the 18th, which s-next/n1 holds ⇒ introduced clash.
    const clash = planFixturePatches(
      [released(), nextWeek()],
      clubs,
      venues,
      manifest([entry({ set: { date: '2026-10-18' } })], false),
      undefined,
      { gateMode: 'introduced' },
    );
    assert.ok(clash.errors.some((e) => /introduce 2 new venue clash/.test(e)));
    assert.ok(clash.gate!.introduced.every((c) => c.date === '2026-10-18'));
  });

  test('set.date + postponed: the ADR 0015 shape — originalDate kept, new slot booked', () => {
    const plan = planFixturePatches(
      [released(), nextWeek()],
      clubs,
      venues,
      manifest([entry({ set: { date: '2026-10-18', postponed: true } })], false),
      undefined,
      { gateMode: 'introduced' },
    );
    const f2 = fx(plan.next, 's-rel', 'f2');
    assert.equal(f2.status, 'postponed');
    assert.equal(f2.originalDate, DATE);
    assert.equal(f2.date, '2026-10-18');
    // A rescheduled postponement is NOT clash-exempt: the double-booking is still refused.
    assert.ok(plan.errors.some((e) => /introduce/.test(e)));

    // A second postponement keeps pointing at the FIRST schedule.
    const rel = released();
    Object.assign((rel.fixtures as Fx[])[1], { status: 'postponed', originalDate: '2026-10-04' });
    const again = planFixturePatches(
      [rel],
      clubs,
      venues,
      manifest([entry({ set: { date: '2026-10-25', postponed: true } })], false),
    );
    assert.deepEqual(again.errors, []);
    assert.equal(fx(again.next, 's-rel', 'f2').originalDate, '2026-10-04');
  });

  test('postponed without a date: postponed + dateTbc (allowed on released), slot freed for another entry', () => {
    // f1 (alpha v beta, Beta Park 09:00) postponed undated; f2 moves onto Beta Park 09:00.
    const plan = planFixturePatches(
      [released()],
      clubs,
      venues,
      manifest(
        [
          entry({
            fixtureId: 'f1',
            expect: { home: 'alpha', away: 'beta', date: DATE, time: '09:00', venue: 'Beta Park' },
            set: { postponed: true },
          }),
          entry({ set: { time: '09:00', venueId: 'v-beta' } }),
        ],
        false,
      ),
      undefined,
      { gateMode: 'introduced' },
    );
    assert.deepEqual(plan.errors, []);
    const f1 = fx(plan.next, 's-rel', 'f1');
    assert.equal(f1.status, 'postponed');
    assert.equal(f1.date, DATE);
    assert.equal(f1.originalDate, undefined);
    assert.equal(f1.dateTbc, true, 'the undated shape rides the existing dateTbc exemption');
    assert.deepEqual(plan.gate!.introduced, []);
  });

  test('a bare set.dateTbc stays draft-only even though postponed + dateTbc is allowed', () => {
    const plan = planFixturePatches(
      [released()],
      clubs,
      venues,
      manifest([entry({ set: { dateTbc: true } })], false),
    );
    assert.match(plan.errors[0], /only allowed on a draft series/);
  });

  test('re-dating an undated (dateTbc) postponement clears dateTbc, stamps originalDate, books its slot', () => {
    const rel = released();
    Object.assign((rel.fixtures as Fx[])[1], { status: 'postponed', dateTbc: true });
    const plan = planFixturePatches(
      [rel, nextWeek()],
      clubs,
      venues,
      manifest([entry({ set: { date: '2026-10-18', postponed: true } })], false),
      undefined,
      { gateMode: 'introduced' },
    );
    const f2 = fx(plan.next, 's-rel', 'f2');
    assert.equal(f2.status, 'postponed');
    assert.equal(f2.date, '2026-10-18');
    assert.equal(f2.dateTbc, undefined);
    assert.equal(f2.originalDate, DATE);
    // Back in the ledger: the new slot (s-next/n1's) is an introduced clash.
    assert.ok(plan.errors.some((e) => /introduce/.test(e)));

    // A plain set.date (no set.postponed) on a postponed fixture is still a reschedule.
    const rel2 = released();
    Object.assign((rel2.fixtures as Fx[])[1], { status: 'postponed', dateTbc: true });
    const plain = planFixturePatches(
      [rel2],
      clubs,
      venues,
      manifest([entry({ set: { date: '2026-10-25' } })], false),
    );
    assert.deepEqual(plain.errors, []);
    const g = fx(plain.next, 's-rel', 'f2');
    assert.equal(g.dateTbc, undefined);
    assert.equal(g.originalDate, DATE);
  });

  test('set.date / set.postponed validation', () => {
    const plan = planFixturePatches(
      [released()],
      clubs,
      venues,
      manifest(
        [
          entry({ set: { date: '2026-02-30' } }),
          entry({
            fixtureId: 'f1',
            expect: { home: 'alpha', away: 'beta', date: DATE, time: '09:00', venue: 'Beta Park' },
            set: { date: DATE },
          }),
        ],
        false,
      ),
    );
    assert.match(plan.errors[0], /set.date "2026-02-30" is not a YYYY-MM-DD date/);
    assert.match(plan.errors[1], /is the fixture's current date/);
    const bad = planFixturePatches(
      [released()],
      clubs,
      venues,
      manifest([entry({ set: { postponed: false as unknown as true } })], false),
    );
    assert.match(bad.errors[0], /set.postponed must be true/);
    const draftMix = planFixturePatches(
      [draft()],
      clubs,
      venues,
      manifest(
        [
          {
            seriesId: 's-draft',
            fixtureId: 'f1',
            expect: { home: 'beta', away: 'alpha', date: DATE, time: '', venue: '' },
            set: { date: '2026-10-12', dateTbc: true },
          },
        ],
        false,
      ),
    );
    assert.match(draftMix.errors[0], /cannot be combined/);
  });

  test('gate mode: a pre-existing released clash on the dates is fatal only when strict', () => {
    const rel = released();
    // A standing double-booking: f3 shares Gamma Field 13:30 with f2.
    (rel.fixtures as Fx[]).push({
      id: 'f3',
      date: DATE,
      time: '13:30',
      home: 'beta',
      away: 'alpha',
      venueName: 'Gamma Field',
    });
    const m = manifest(
      [
        entry({
          fixtureId: 'f1',
          expect: { home: 'alpha', away: 'beta', date: DATE, time: '09:00', venue: 'Beta Park' },
          set: { time: '10:00' },
        }),
      ],
      false,
    );
    const strict = planFixturePatches([rel], clubs, venues, m);
    assert.ok(strict.errors.some((e) => /involve a released fixture/.test(e)));
    const introduced = planFixturePatches([rel], clubs, venues, m, undefined, {
      gateMode: 'introduced',
    });
    assert.deepEqual(introduced.errors, []);
    assert.equal(introduced.gate!.weekendReleased.length > 0, true, 'still reported');
  });

  test('reportDates widen the reported weekend without changing the verdict', () => {
    const rel = released();
    (rel.fixtures as Fx[]).push({
      id: 'f3',
      date: '2026-10-10',
      time: '10:00',
      home: 'beta',
      away: 'alpha',
      venueName: 'Alpha Oval',
    });
    const other = series('s-o', true, [
      {
        id: 'o1',
        date: '2026-10-10',
        time: '10:00',
        home: 'gamma',
        away: 'beta',
        venueName: 'Alpha Oval',
      },
    ]);
    const plan = planFixturePatches(
      [rel, other],
      clubs,
      venues,
      manifest([entry({ set: { time: '14:00' } })], false),
      undefined,
      { gateMode: 'introduced', reportDates: ['2026-10-10'] },
    );
    assert.deepEqual(plan.errors, []);
    assert.ok(plan.gate!.weekendReleased.some((c) => c.date === '2026-10-10'));
  });
});
