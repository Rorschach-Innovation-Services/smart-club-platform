import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FACTOR_ORDER,
  allocateVenues,
  buildLedger,
  geoCoverage,
  homeAwayBalance,
  travelPerTeam,
  venueUnavailableReason,
  type AllocatedFixture,
  type TeamHome,
} from './venues';
import type { Venue } from '../types';

/** Three Durban grounds, roughly where they really are. */
const KINGSMEAD: Venue = { id: 'kingsmead', name: 'Kingsmead', lat: -29.856, lon: 31.03 };
const CHATSWORTH: Venue = { id: 'chatsworth', name: 'Chatsworth Oval', lat: -29.918, lon: 30.888 };
const PINETOWN: Venue = { id: 'pinetown', name: 'Pinetown Oval', lat: -29.816, lon: 30.86 };
const VENUES = [KINGSMEAD, CHATSWORTH, PINETOWN];

const HOMES: Record<string, TeamHome> = {
  alpha: { venueId: 'kingsmead', lat: -29.856, lon: 31.03 },
  bravo: { venueId: 'chatsworth', lat: -29.918, lon: 30.888 },
  charlie: { venueId: 'pinetown', lat: -29.816, lon: 30.86 },
};
const teamHome = (t: string) => HOMES[t];

const fx = (id: string, date: string, home: string, away: string): AllocatedFixture => ({
  id,
  round: 1,
  date,
  home,
  away,
  venueStatus: 'unresolved',
  venueReason: '',
});

const alloc = (
  fixtures: AllocatedFixture[],
  opts: Partial<Parameters<typeof allocateVenues>[0]> = {},
) =>
  allocateVenues({
    fixtures,
    venues: VENUES,
    teamHome,
    ledger: buildLedger([]),
    ...opts,
  });

/** A double-header fixture: `fx` plus a slot (`time`), the way `fixturesFromDates` writes one. */
const fxAt = (
  id: string,
  date: string,
  home: string,
  away: string,
  time: string,
): AllocatedFixture => ({ ...fx(id, date, home, away), time });

describe('venueUnavailableReason', () => {
  it('closes a ground inside a maintenance window, inclusive of both ends', () => {
    const v: Venue = {
      ...KINGSMEAD,
      unavailable: [{ start: '2026-10-01', end: '2026-10-14', reason: 'outfield relaid' }],
    };
    expect(venueUnavailableReason(v, '2026-09-30')).toBeNull();
    expect(venueUnavailableReason(v, '2026-10-01')).toBe('outfield relaid');
    expect(venueUnavailableReason(v, '2026-10-14')).toBe('outfield relaid');
    expect(venueUnavailableReason(v, '2026-10-15')).toBeNull();
  });

  it('closes a ground on a blocked weekday', () => {
    // 2026-09-13 is a Sunday.
    const v: Venue = { ...KINGSMEAD, unavailableWeekdays: [0] };
    expect(venueUnavailableReason(v, '2026-09-13')).toContain('day of the week');
    expect(venueUnavailableReason(v, '2026-09-14')).toBeNull();
  });
});

describe('geoCoverage', () => {
  it('is the share of venues with a pinned location', () => {
    expect(geoCoverage(VENUES)).toBe(1);
    expect(geoCoverage([...VENUES, { id: 'x', name: 'Unpinned' }])).toBeCloseTo(0.75);
    expect(geoCoverage([])).toBe(1);
  });
});

describe('allocateVenues — the ordinary case', () => {
  it('plays a fixture at the home side’s ground and says so', () => {
    const r = alloc([fx('f1', '2026-09-13', 'alpha', 'bravo')]);
    expect(r.fixtures[0].venueId).toBe('kingsmead');
    expect(r.fixtures[0].venueStatus).toBe('home');
    expect(r.fixtures[0].venueReason).toBe('Home ground');
    expect(r.unresolved).toBe(0);
  });

  it('applies the default factor order when none is given', () => {
    expect(DEFAULT_FACTOR_ORDER[0]).toBe('home-preference');
    const r = alloc([fx('f1', '2026-09-13', 'bravo', 'alpha')]);
    expect(r.fixtures[0].venueId).toBe('chatsworth');
  });
});

describe('allocateVenues — the fallback chain', () => {
  it('moves to the away side’s ground when the home ground is closed, and explains why', () => {
    const venues = [
      {
        ...KINGSMEAD,
        unavailable: [{ start: '2026-09-13', end: '2026-09-13', reason: 'a wedding' }],
      },
      CHATSWORTH,
      PINETOWN,
    ];
    const r = alloc([fx('f1', '2026-09-13', 'alpha', 'bravo')], { venues });
    expect(r.fixtures[0].venueStatus).toBe('alternative');
    expect(r.fixtures[0].venueId).toBe('chatsworth');
    expect(r.fixtures[0].venueReason).toContain('a wedding');
    expect(r.fixtures[0].venueReason).toContain("away side's ground");
  });

  it('falls through to a neutral ground when neither side’s is usable', () => {
    const closed = (v: Venue) => ({
      ...v,
      unavailable: [{ start: '2026-09-13', end: '2026-09-13', reason: 'closed' }],
    });
    const r = alloc([fx('f1', '2026-09-13', 'alpha', 'bravo')], {
      venues: [closed(KINGSMEAD), closed(CHATSWORTH), PINETOWN],
    });
    expect(r.fixtures[0].venueId).toBe('pinetown');
    expect(r.fixtures[0].venueStatus).toBe('neutral');
    expect(r.fixtures[0].venueReason).toContain('neutral ground');
  });

  it('respects a ground’s daily capacity', () => {
    // Kingsmead has two pitches, so it can host both fixtures that day.
    const twoPitch = [{ ...KINGSMEAD, surfaces: 2 }, CHATSWORTH, PINETOWN];
    const r = alloc(
      [fx('f1', '2026-09-13', 'alpha', 'bravo'), fx('f2', '2026-09-13', 'charlie', 'alpha')],
      { venues: twoPitch },
    );
    // alpha plays twice that day, so the second is a team clash regardless of capacity —
    // use two independent pairings instead.
    const r2 = allocateVenues({
      fixtures: [
        { ...fx('f1', '2026-09-13', 'alpha', 'bravo') },
        { ...fx('f2', '2026-09-13', 'charlie', 'delta') },
      ],
      venues: [{ ...KINGSMEAD, surfaces: 2 }],
      teamHome: (t) => (t === 'alpha' || t === 'charlie' ? { venueId: 'kingsmead' } : undefined),
      ledger: buildLedger([]),
    });
    expect(r2.unresolved).toBe(0);
    expect(r2.fixtures.every((f) => f.venueId === 'kingsmead')).toBe(true);
    expect(r.fixtures).toHaveLength(2);
  });
});

describe('allocateVenues — nothing is silently wrong', () => {
  it('marks a fixture unresolved when every ground is closed, with a reason', () => {
    const closed = (v: Venue) => ({
      ...v,
      unavailable: [{ start: '2026-09-13', end: '2026-09-13', reason: 'closed' }],
    });
    const r = alloc([fx('f1', '2026-09-13', 'alpha', 'bravo')], {
      venues: VENUES.map(closed),
    });
    expect(r.unresolved).toBe(1);
    expect(r.fixtures[0].venueId).toBeUndefined();
    expect(r.fixtures[0].venueStatus).toBe('unresolved');
    expect(r.fixtures[0].venueReason).toBe('No ground is available on that date');
    expect(r.warnings.join(' ')).toContain('could not be placed');
  });

  it('says so plainly when no venues exist at all', () => {
    const r = alloc([fx('f1', '2026-09-13', 'alpha', 'bravo')], { venues: [] });
    expect(r.fixtures[0].venueReason).toBe('No venues have been added yet');
  });

  it('marks a fixture unresolved when every ground is fully booked that day', () => {
    const oneGround = [KINGSMEAD];
    const r = allocateVenues({
      fixtures: [
        fx('f1', '2026-09-13', 'alpha', 'bravo'),
        fx('f2', '2026-09-13', 'charlie', 'delta'),
      ],
      venues: oneGround,
      teamHome,
      ledger: buildLedger([]),
    });
    expect(r.unresolved).toBe(1);
    const stranded = r.fixtures.find((f) => f.venueStatus === 'unresolved')!;
    expect(stranded.venueReason).toBe('Every available ground is already booked that day');
  });
});

describe('allocateVenues — the tenant-wide ledger', () => {
  // The single biggest correctness requirement: two competitions share the same grounds
  // on the same Saturday, and the allocator must see BOTH.
  it('will not double-book a ground already used by another competition', () => {
    const other = [
      {
        id: 'other-series',
        fixtures: [{ date: '2026-09-13', home: 'x', away: 'y', venueId: 'kingsmead' }],
      },
    ];
    const r = allocateVenues({
      fixtures: [fx('f1', '2026-09-13', 'alpha', 'bravo')],
      venues: [KINGSMEAD, CHATSWORTH],
      teamHome,
      ledger: buildLedger(other),
    });
    expect(r.fixtures[0].venueId).not.toBe('kingsmead');
    expect(r.fixtures[0].venueId).toBe('chatsworth');
  });

  it('will not play a side twice in one day, even across competitions', () => {
    const other = [
      {
        id: 'other-series',
        fixtures: [{ date: '2026-09-13', home: 'alpha', away: 'zulu', venueId: 'pinetown' }],
      },
    ];
    const r = allocateVenues({
      fixtures: [fx('f1', '2026-09-13', 'alpha', 'bravo')],
      venues: VENUES,
      teamHome,
      ledger: buildLedger(other),
    });
    expect(r.unresolved).toBe(1);
    expect(r.fixtures[0].venueReason).toContain('already has a match that day');
  });

  // Re-allocating a series must not see its own previous placements as conflicts.
  it('excludes the series being re-allocated from its own ledger', () => {
    const own = [
      {
        id: 'mine',
        fixtures: [{ date: '2026-09-13', home: 'alpha', away: 'bravo', venueId: 'kingsmead' }],
      },
    ];
    const blocked = allocateVenues({
      fixtures: [fx('f1', '2026-09-13', 'alpha', 'bravo')],
      venues: [KINGSMEAD],
      teamHome,
      ledger: buildLedger(own),
    });
    expect(blocked.unresolved).toBe(1);

    const rerun = allocateVenues({
      fixtures: [fx('f1', '2026-09-13', 'alpha', 'bravo')],
      venues: [KINGSMEAD],
      teamHome,
      ledger: buildLedger(own, { excludeSeriesIds: ['mine'] }),
    });
    expect(rerun.unresolved).toBe(0);
    expect(rerun.fixtures[0].venueId).toBe('kingsmead');
  });

  // Knockout placeholders are series-scoped — every bracket numbers from f1 — so two
  // competitions' finals both read `win:f1 v win:f2`. Treating those as real sides makes
  // the second competition's final collide with the first over teams that don't exist.
  it('does not treat knockout placeholders as sides already playing that day', () => {
    const otherCup = [
      {
        id: 'other-cup',
        fixtures: [{ date: '2026-09-13', home: 'win:f1', away: 'win:f2', venueId: 'kingsmead' }],
      },
    ];
    const r = allocateVenues({
      fixtures: [fx('f3', '2026-09-13', 'win:f1', 'win:f2')],
      venues: VENUES,
      teamHome,
      ledger: buildLedger(otherCup),
    });
    expect(r.unresolved).toBe(0);
    expect(r.fixtures[0].venueId).toBeTruthy();
    expect(r.fixtures[0].venueId).not.toBe('kingsmead'); // the GROUND is still booked
  });
});

describe('allocateVenues — manual overrides survive', () => {
  // The classic way hand-placed work gets lost.
  it('keeps a locked fixture’s ground and lets nothing else take that slot', () => {
    const locked: AllocatedFixture = {
      ...fx('f1', '2026-09-13', 'charlie', 'bravo'),
      venueId: 'kingsmead',
      venueName: 'Kingsmead',
      venueStatus: 'neutral',
      venueReason: 'Union final — set by hand',
      venueLocked: true,
    };
    const r = allocateVenues({
      fixtures: [locked, fx('f2', '2026-09-13', 'alpha', 'delta')],
      venues: [KINGSMEAD],
      teamHome,
      ledger: buildLedger([]),
    });
    const kept = r.fixtures.find((f) => f.id === 'f1')!;
    expect(kept.venueId).toBe('kingsmead');
    expect(kept.venueReason).toBe('Union final — set by hand');
    // alpha's own ground is taken by the locked fixture, so it can't be placed.
    const other = r.fixtures.find((f) => f.id === 'f2')!;
    expect(other.venueStatus).toBe('unresolved');
  });

  // `venueOverride` is what the fixture editor actually writes — nothing in the app sets
  // `venueLocked`. Without honouring it, "hand-picked venues are kept" is a promise no
  // user can satisfy, and re-allocation silently books a different ground.
  it('treats a hand-typed venue override as locked, and resolves it to the registry', () => {
    const overridden: AllocatedFixture = {
      ...fx('f1', '2026-09-13', 'alpha', 'bravo'),
      venueOverride: 'Kingsmead',
    };
    const r = allocateVenues({
      fixtures: [overridden, fx('f2', '2026-09-13', 'charlie', 'delta')],
      venues: [KINGSMEAD],
      teamHome,
      ledger: buildLedger([]),
    });
    const kept = r.fixtures.find((f) => f.id === 'f1')!;
    expect(kept.venueOverride).toBe('Kingsmead');
    // The named ground is matched back to the registry, so travel cost, the fairness
    // reports and the club portal all describe the ground actually being played on.
    expect(kept.venueId).toBe('kingsmead');
    expect(kept.venueLat).toBe(KINGSMEAD.lat);
    expect(kept.venueStatus).toBe('home'); // Kingsmead IS alpha's ground
    expect(kept.venueReason).toBe('Set by hand');
    // …and it is BOOKED, so the other fixture can't be sent there.
    expect(r.fixtures.find((f) => f.id === 'f2')!.venueStatus).toBe('unresolved');
  });

  // The realistic sequence: allocate, hand-correct one fixture, re-allocate. The editor
  // writes `venueOverride` without clearing the allocated `venueId`, so preferring the
  // stale id would book the superseded ground and leave the chosen one looking free.
  it('prefers the override over an already-allocated venueId', () => {
    const corrected: AllocatedFixture = {
      ...fx('f1', '2026-09-13', 'alpha', 'bravo'),
      venueId: 'kingsmead', // what allocation picked last time
      venueName: 'Kingsmead',
      venueStatus: 'home',
      venueReason: 'Home ground',
      venueOverride: 'Pinetown Oval', // what the admin then typed
    };
    const r = allocateVenues({
      fixtures: [corrected, fx('f2', '2026-09-13', 'charlie', 'delta')],
      venues: VENUES,
      teamHome,
      ledger: buildLedger([]),
    });
    const kept = r.fixtures.find((f) => f.id === 'f1')!;
    expect(kept.venueId).toBe('pinetown');
    expect(kept.venueName).toBe('Pinetown Oval');
    expect(kept.venueStatus).toBe('neutral'); // pinetown is charlie's ground, not alpha's or bravo's
    // Pinetown is booked, so charlie's fixture can't have its own ground.
    expect(r.fixtures.find((f) => f.id === 'f2')!.venueId).not.toBe('pinetown');
  });

  // "Other (type below)" takes free text, so a miss is the normal case. Leaving the old
  // allocation behind made the row show the typed name while travel cost was computed
  // against the ground allocation last picked — and the ledger held that ground too.
  it('clears the superseded allocation when the override names no registry ground', () => {
    const corrected: AllocatedFixture = {
      ...fx('f1', '2026-09-13', 'alpha', 'bravo'),
      venueId: 'kingsmead',
      venueName: 'Kingsmead',
      venueLat: KINGSMEAD.lat,
      venueLon: KINGSMEAD.lon,
      venueStatus: 'home',
      venueReason: 'Home ground',
      venueOverride: 'A school field nobody registered',
    };
    const r = allocateVenues({
      fixtures: [corrected, fx('f2', '2026-09-13', 'charlie', 'delta')],
      venues: [KINGSMEAD],
      teamHome,
      ledger: buildLedger([]),
    });
    const kept = r.fixtures.find((f) => f.id === 'f1')!;
    expect(kept.venueId).toBeUndefined();
    expect(kept.venueName).toBeUndefined();
    expect(kept.venueLat).toBeUndefined();
    expect(kept.venueReason).toContain('not in the venue registry');
    // Kingsmead was NOT booked, so the other fixture can still use it — holding a slot
    // this fixture isn't using would strand another for nothing.
    expect(r.fixtures.find((f) => f.id === 'f2')!.venueId).toBe('kingsmead');
  });

  it('still books the SIDES of an override whose ground is not in the registry', () => {
    const offSite: AllocatedFixture = {
      ...fx('f1', '2026-09-13', 'alpha', 'bravo'),
      venueOverride: 'A school field nobody registered',
    };
    const r = allocateVenues({
      fixtures: [offSite, fx('f2', '2026-09-13', 'alpha', 'charlie')],
      venues: VENUES,
      teamHome,
      ledger: buildLedger([]),
    });
    // alpha is playing that day, wherever it is — so its second fixture can't be placed.
    expect(r.fixtures.find((f) => f.id === 'f2')!.venueStatus).toBe('unresolved');
  });
});

describe('allocateVenues — the geo-coverage gate', () => {
  // There is no geocoder; a half-pinned registry is the normal state, and distance
  // ranking over missing coordinates produces confident nonsense.
  it('switches distance off and says so when too few venues are pinned', () => {
    const mostlyUnpinned: Venue[] = [
      KINGSMEAD,
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const r = alloc([fx('f1', '2026-09-13', 'alpha', 'bravo')], { venues: mostlyUnpinned });
    expect(r.distanceUsed).toBe(false);
    expect(r.geoCoverage).toBeCloseTo(0.25);
    expect(r.warnings.join(' ')).toContain('25% of venues have a pinned location');
  });

  // Review finding: an unpinned venue used to take NO distance penalty, so it scored as
  // though it were 0 km away and beat a pinned ground a kilometre down the road. The
  // coverage gate only switches distance off entirely below the threshold; above it the
  // unpinned minority still has to rank, and "unknown" must rank worst.
  it('ranks an unpinned ground below a nearby pinned one', () => {
    const near: Venue = { id: 'near', name: 'Near', lat: -29.857, lon: 31.031 };
    const nopin: Venue = { id: 'nopin', name: 'No pin' };
    const r = allocateVenues({
      fixtures: [fx('f1', '2026-09-13', 'x', 'y')],
      // 3 of 4 pinned — above the coverage gate, so distance ranking is on.
      venues: [near, nopin, CHATSWORTH, PINETOWN],
      teamHome: () => ({ lat: -29.856, lon: 31.03 }),
      ledger: buildLedger([]),
    });
    expect(r.distanceUsed).toBe(true);
    expect(r.fixtures[0].venueId).toBe('near');
  });

  it('still places an unpinned ground when it is the only option', () => {
    const r = allocateVenues({
      fixtures: [fx('f1', '2026-09-13', 'x', 'y')],
      venues: [{ id: 'nopin', name: 'No pin' }, KINGSMEAD, CHATSWORTH, PINETOWN],
      teamHome: () => ({ venueId: 'nopin' }),
      ledger: buildLedger([]),
    });
    expect(r.fixtures[0].venueId).toBe('nopin');
    expect(r.fixtures[0].venueStatus).toBe('home');
  });

  it('uses distance when coverage is good', () => {
    const r = alloc([fx('f1', '2026-09-13', 'alpha', 'bravo')]);
    expect(r.distanceUsed).toBe(true);
    expect(r.geoCoverage).toBe(1);
    expect(r.warnings).toEqual([]);
  });
});

describe('allocateVenues — most-constrained-first', () => {
  /**
   * The whole point of the ordering. Two fixtures on one day: one can only use Kingsmead
   * (its sides have nowhere else), the other could use either ground. Date order would
   * place the flexible one at Kingsmead and strand the tight one; most-constrained-first
   * places both.
   */
  it('places a tight fixture before a flexible one so neither is stranded', () => {
    const venues: Venue[] = [KINGSMEAD, { ...CHATSWORTH, unavailable: [] }];
    const r = allocateVenues({
      // 'flex' is listed FIRST, so a naive in-order pass would take Kingsmead for it.
      fixtures: [
        fx('flex', '2026-09-13', 'alpha', 'bravo'),
        fx('tight', '2026-09-13', 'charlie', 'delta'),
      ],
      venues,
      teamHome: (t) =>
        t === 'alpha'
          ? { venueId: 'kingsmead' }
          : t === 'bravo'
            ? { venueId: 'chatsworth' }
            : undefined,
      ledger: buildLedger([]),
    });
    expect(r.unresolved).toBe(0);
    expect(new Set(r.fixtures.map((f) => f.venueId)).size).toBe(2);
  });
});

describe('allocateVenues — double-headers key the ledger on date AND slot', () => {
  it('allocates a side’s AM and PM fixtures fully — no false "already has a match" clash', () => {
    // alpha plays bravo in the morning and charlie in the afternoon, same date — a real
    // double-header, not a scheduling mistake. Slot-awareness must not read the PM
    // fixture as alpha already being busy that day.
    const r = alloc([
      fxAt('am', '2026-09-13', 'alpha', 'bravo', '08:00'),
      fxAt('pm', '2026-09-13', 'alpha', 'charlie', '13:30'),
    ]);
    expect(r.unresolved).toBe(0);
    expect(r.fixtures.every((f) => f.venueId)).toBe(true);
  });

  it('hosts an AM and a PM fixture on one ground with a single surface, no over-capacity flag', () => {
    const oneSurface = [KINGSMEAD]; // surfaces defaults to 1
    const r = allocateVenues({
      fixtures: [
        fxAt('am', '2026-09-13', 'alpha', 'bravo', '08:00'),
        fxAt('pm', '2026-09-13', 'charlie', 'bravo', '13:30'),
      ],
      venues: oneSurface,
      teamHome,
      ledger: buildLedger([]),
    });
    expect(r.unresolved).toBe(0);
    expect(r.fixtures.every((f) => f.venueId === 'kingsmead')).toBe(true);
  });

  // Regression: slot-awareness must not accidentally loosen a REAL clash. Another
  // competition already has Kingsmead booked at the exact same date and slot, so this
  // fixture must still be refused that ground.
  it('still clashes with a same-date, same-slot booking from a different competition', () => {
    const other = [
      {
        id: 'other-series',
        fixtures: [
          { date: '2026-09-13', home: 'x', away: 'y', venueId: 'kingsmead', time: '08:00' },
        ],
      },
    ];
    const r = allocateVenues({
      fixtures: [fxAt('f1', '2026-09-13', 'alpha', 'bravo', '08:00')],
      venues: [KINGSMEAD, CHATSWORTH],
      teamHome,
      ledger: buildLedger(other),
    });
    expect(r.fixtures[0].venueId).not.toBe('kingsmead');
    expect(r.fixtures[0].venueId).toBe('chatsworth');
  });

  // An UNTIMED booking owns the whole day: a timed fixture for the same side must still
  // read as a clash, not slide past it because the stored booking has no slot key.
  it('clashes a timed allocation against an already-stored UNTIMED booking for the same side', () => {
    const other = [
      {
        id: 'other-series',
        // No `time` at all — the normal shape for a non-double-header series.
        fixtures: [{ date: '2026-09-13', home: 'alpha', away: 'zulu' }],
      },
    ];
    const r = allocateVenues({
      fixtures: [fxAt('f1', '2026-09-13', 'alpha', 'bravo', '08:00')],
      venues: VENUES,
      teamHome,
      ledger: buildLedger(other),
    });
    expect(r.unresolved).toBe(1);
    expect(r.fixtures[0].venueReason).toContain('already has a match that day');
  });

  // Symmetrically: a TIMED booking already on the books must be seen by an UNTIMED
  // allocation asking "is this side playing at all today" — not just by another timed
  // lookup at the exact same slot.
  it('clashes an untimed allocation against an already-stored TIMED booking for the same side', () => {
    const other = [
      {
        id: 'other-series',
        fixtures: [{ date: '2026-09-13', home: 'alpha', away: 'zulu', time: '08:00' }],
      },
    ];
    const r = allocateVenues({
      // No `time` — an ordinary, non-double-header fixture for the same side.
      fixtures: [fx('f1', '2026-09-13', 'alpha', 'bravo')],
      venues: VENUES,
      teamHome,
      ledger: buildLedger(other),
    });
    expect(r.unresolved).toBe(1);
    expect(r.fixtures[0].venueReason).toContain('already has a match that day');
  });

  // A single-surface ground already holding an UNTIMED booking must refuse BOTH an AM and
  // a PM slot that day — the untimed booking occupies the whole day, not just "no slot".
  it('refuses both AM and PM at a one-surface ground already holding an untimed booking', () => {
    const other = [
      {
        id: 'other-series',
        fixtures: [{ date: '2026-09-13', home: 'x', away: 'y', venueId: 'kingsmead' }],
      },
    ];
    const r = allocateVenues({
      fixtures: [
        fxAt('am', '2026-09-13', 'alpha', 'bravo', '08:00'),
        fxAt('pm', '2026-09-13', 'charlie', 'delta', '13:30'),
      ],
      venues: [KINGSMEAD], // surfaces defaults to 1
      teamHome,
      ledger: buildLedger(other),
    });
    expect(r.unresolved).toBe(2);
    expect(r.fixtures.every((f) => f.venueStatus === 'unresolved')).toBe(true);
  });
});

describe('allocateVenues — same-day co-location nudge', () => {
  // The interleaved case: the same pair swaps home/away between legs. This is what a
  // pair-keyed map already handled — must stay green under the participant-keyed rewrite.
  it('keeps an interleaved same-pair double-header at one ground across legs', () => {
    const r = alloc([
      fxAt('am', '2026-09-13', 'alpha', 'bravo', '08:00'), // alpha home → naturally Kingsmead
      fxAt('pm', '2026-09-13', 'bravo', 'alpha', '13:30'), // swapped: bravo home, alpha away
    ]);
    const am = r.fixtures.find((f) => f.id === 'am')!;
    const pm = r.fixtures.find((f) => f.id === 'pm')!;
    expect(am.venueId).toBe('kingsmead');
    // Without the nudge, home preference alone would send the PM leg to bravo's own
    // ground (Chatsworth). The nudge keeps the return leg at the AM ground instead.
    expect(pm.venueId).toBe('kingsmead');
  });

  // The mirrored case a pair-keyed map MISSED: the shared side plays a different opponent
  // each leg, so the unordered pair ("alpha|bravo" vs "alpha|charlie") never matches
  // between legs. Re-keying per participant fixes it — the nudge follows alpha, not the
  // pairing.
  it('nudges a mirrored double-header toward the shared side’s already-assigned ground', () => {
    const r = alloc([
      // bravo home vs alpha away — home preference alone sends this to Chatsworth.
      fxAt('am', '2026-09-13', 'bravo', 'alpha', '08:00'),
      // charlie home vs alpha away — a DIFFERENT pairing. Home preference alone would
      // send this to Pinetown (charlie's ground) instead.
      fxAt('pm', '2026-09-13', 'charlie', 'alpha', '13:30'),
    ]);
    const am = r.fixtures.find((f) => f.id === 'am')!;
    const pm = r.fixtures.find((f) => f.id === 'pm')!;
    expect(am.venueId).toBe('chatsworth');
    // alpha already has Chatsworth booked from the AM leg, and it's still free at 13:30 —
    // the nudge should follow alpha there rather than defaulting to charlie's home ground.
    expect(pm.venueId).toBe('chatsworth');
  });
});

describe('reports', () => {
  const placed: AllocatedFixture[] = [
    {
      ...fx('f1', '2026-09-13', 'alpha', 'bravo'),
      venueId: 'kingsmead',
      venueStatus: 'home',
      venueReason: '',
    },
    {
      ...fx('f2', '2026-09-20', 'bravo', 'alpha'),
      venueId: 'chatsworth',
      venueStatus: 'home',
      venueReason: '',
    },
    {
      ...fx('f3', '2026-09-27', 'alpha', 'bravo'),
      venueId: 'pinetown',
      venueStatus: 'neutral',
      venueReason: '',
    },
  ];

  it('counts home/away from where the match is ACTUALLY played', () => {
    const rows = homeAwayBalance(placed, teamHome);
    const alpha = rows.find((r) => r.teamId === 'alpha')!;
    // Kingsmead is alpha's ground; Chatsworth and Pinetown are not.
    expect(alpha.home).toBe(1);
    expect(alpha.away).toBe(2);
  });

  it('counts an unplaced fixture as neutral rather than pretending it is a home game', () => {
    const rows = homeAwayBalance([fx('f9', '2026-10-04', 'alpha', 'bravo')], teamHome);
    expect(rows.find((r) => r.teamId === 'alpha')?.neutral).toBe(1);
  });

  it('reports travel per side so the burden is visible, not just the total', () => {
    const rows = travelPerTeam(placed, VENUES, teamHome);
    const alpha = rows.find((r) => r.teamId === 'alpha')!;
    const bravo = rows.find((r) => r.teamId === 'bravo')!;
    expect(alpha.km).toBeGreaterThan(0);
    expect(bravo.km).toBeGreaterThan(0);
    // alpha travels for f2 and f3; its home fixture contributes nothing.
    expect(alpha.trips).toBe(2);
  });

  it('contributes nothing for a side or ground with no pinned location', () => {
    const rows = travelPerTeam(placed, [{ id: 'kingsmead', name: 'Kingsmead' }], teamHome);
    expect(rows.every((r) => r.km === 0)).toBe(true);
  });

  // A bracket's later rounds carry `win:f1` placeholders. Reporting those as sides puts
  // a row headed "win:f1" in front of an operator looking at club travel fairness.
  it('leaves knockout placeholders out of both reports', () => {
    const bracket: AllocatedFixture[] = [
      {
        ...fx('f3', '2026-10-04', 'win:f1', 'win:f2'),
        venueId: 'kingsmead',
        venueStatus: 'neutral',
        venueReason: '',
      },
    ];
    expect(homeAwayBalance(bracket, teamHome)).toEqual([]);
    expect(travelPerTeam(bracket, VENUES, teamHome)).toEqual([]);
  });
});
