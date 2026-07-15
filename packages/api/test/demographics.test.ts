/**
 * Unit tests for the pure demographics aggregation module (demographics.ts):
 * age-band edges against a FIXED `now`, Unknown/Unspecified rules, canonical
 * gender/race ordering with lenient extras, status-agnostic counting, and the
 * demographicsByLeague attribution ladder (catalogue team wins; orphaned team
 * short-circuits to unattributed even at a single-league club; absent team
 * falls back only at single-league clubs).
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageFromDob,
  summarizeDemographics,
  demographicsByLeague,
  type DemographicPlayer,
} from '../src/demographics.js';

// Fixed clock so band-edge assertions never rot: 1 July 2026 (UTC).
const NOW = new Date('2026-07-01T00:00:00.000Z');

const bucket = (summary: { label: string; count: number }[], label: string) =>
  summary.find((b) => b.label === label);

describe('ageFromDob', () => {
  test('whole-year age, birthday counted only once reached', () => {
    assert.equal(ageFromDob('2013-07-01', NOW), 13); // 13th birthday today
    assert.equal(ageFromDob('2013-07-02', NOW), 12); // birthday tomorrow
    assert.equal(ageFromDob('1976-07-01', NOW), 50);
  });

  test('missing / invalid / future dob → null', () => {
    assert.equal(ageFromDob(undefined, NOW), null);
    assert.equal(ageFromDob('', NOW), null);
    assert.equal(ageFromDob('not-a-date', NOW), null);
    assert.equal(ageFromDob('2027-01-01', NOW), null); // future
    // Date-parseable but non-ISO: would parse in LOCAL time and flip band edges
    // across timezones — pins the strict-ISO guard so a refactor can't drop it.
    assert.equal(ageFromDob('05/05/1990', NOW), null);
  });

  test('born today → 0, not null', () => {
    assert.equal(ageFromDob('2026-07-01', NOW), 0);
  });
});

describe('summarizeDemographics — age bands', () => {
  test('band edges land on the right side', () => {
    const players: DemographicPlayer[] = [
      { dob: '2013-07-02' }, // 12 → Under 13
      { dob: '2013-07-01' }, // 13 → 13–17
      { dob: '2008-07-02' }, // 17 → 13–17
      { dob: '2008-07-01' }, // 18 → 18–34
      { dob: '1991-07-01' }, // 35 → 35–49
      { dob: '1976-07-02' }, // 49 → 35–49
      { dob: '1976-07-01' }, // 50 → 50+
    ];
    const s = summarizeDemographics(players, NOW);
    assert.equal(s.totalPlayers, 7);
    assert.deepEqual(
      s.ageGroups,
      [
        { label: 'Under 13', count: 1 },
        { label: '13–17', count: 2 },
        { label: '18–34', count: 1 },
        { label: '35–49', count: 2 },
        { label: '50+', count: 1 },
      ],
      'five fixed bands, no Unknown when every dob resolves',
    );
  });

  test('invalid, missing and future dobs bucket as Unknown (appended last, only when > 0)', () => {
    const s = summarizeDemographics([{ dob: 'garbage' }, {}, { dob: '2030-01-01' }], NOW);
    assert.deepEqual(s.ageGroups.at(-1), { label: 'Unknown', count: 3 });
    assert.equal(s.ageGroups.length, 6);
  });
});

describe('summarizeDemographics — gender & race buckets', () => {
  test('canonical order regardless of input order; zero-count canonical buckets kept', () => {
    const s = summarizeDemographics(
      [{ gender: 'Non-binary' }, { gender: 'Female' }, { gender: 'Female' }],
      NOW,
    );
    assert.deepEqual(s.gender, [
      { label: 'Male', count: 0 },
      { label: 'Female', count: 2 },
      { label: 'Non-binary', count: 1 },
    ]);
  });

  test('lenient extra stored values appended alphabetically after the canonical set', () => {
    const s = summarizeDemographics(
      [{ race: 'Khoisan' }, { race: 'Asian' }, { race: 'African' }],
      NOW,
    );
    assert.deepEqual(
      s.race.map((b) => b.label),
      ['African', 'Indian', 'Coloured', 'White', 'Other', 'Asian', 'Khoisan'],
    );
    assert.equal(bucket(s.race, 'Asian')?.count, 1);
  });

  test('blank/missing values → Unspecified, always last (after extras), only when > 0', () => {
    const s = summarizeDemographics([{ gender: '  ' }, {}, { gender: 'Womxn' }], NOW);
    assert.deepEqual(s.gender.at(-1), { label: 'Unspecified', count: 2 });
    assert.equal(s.gender.at(-2)?.label, 'Womxn');
    // No Unspecified bucket when every row carries a value.
    const clean = summarizeDemographics([{ gender: 'Male' }], NOW);
    assert.ok(!bucket(clean.gender, 'Unspecified'));
  });

  test('empty input → zeroed canonical buckets, no Unknown/Unspecified', () => {
    const s = summarizeDemographics([], NOW);
    assert.equal(s.totalPlayers, 0);
    assert.deepEqual(
      s.ageGroups.map((b) => b.label),
      ['Under 13', '13–17', '18–34', '35–49', '50+'],
    );
    assert.ok(s.ageGroups.every((b) => b.count === 0));
    assert.deepEqual(
      s.gender.map((b) => b.label),
      ['Male', 'Female', 'Non-binary'],
    );
    assert.deepEqual(
      s.race.map((b) => b.label),
      ['African', 'Indian', 'Coloured', 'White', 'Other'],
    );
  });

  test('status-agnostic: every row counts, whatever status it carries', () => {
    // Pins the deliberate rule (see module docblock): a future 'inactive' status
    // must not silently shrink the histograms.
    const rows = [
      { dob: '1990-01-01', gender: 'Male', status: 'active' },
      { dob: '1990-01-01', gender: 'Male', status: 'clearance-pending' },
      { dob: '1990-01-01', gender: 'Male', status: 'inactive' },
    ] as unknown as DemographicPlayer[];
    const s = summarizeDemographics(rows, NOW);
    assert.equal(s.totalPlayers, 3);
    assert.equal(bucket(s.gender, 'Male')?.count, 3);
  });
});

describe('demographicsByLeague — attribution ladder', () => {
  const LEAGUE_KEYS = ['premier', 'u13'];
  const clubs = [
    { id: 'single', leagues: ['premier'] },
    { id: 'multi', leagues: ['premier', 'u13'] },
    { id: 'none', leagues: [] },
  ];

  test('step 1: a catalogue team key wins, aggregated across clubs', () => {
    const { perLeague, unattributed } = demographicsByLeague(
      [
        { clubId: 'single', team: 'premier' },
        { clubId: 'multi', team: 'premier' },
        { clubId: 'multi', team: 'u13' },
      ],
      clubs,
      LEAGUE_KEYS,
      NOW,
    );
    assert.equal(perLeague.premier.totalPlayers, 2);
    assert.equal(perLeague.u13.totalPlayers, 1);
    assert.equal(unattributed.totalPlayers, 0);
  });

  test('step 2: an orphaned team → unattributed EVEN at a single-league club', () => {
    // The player declared a league; the ladder short-circuits before the club
    // fallback — reassigning them to the club's current league would be a guess.
    const { perLeague, unattributed } = demographicsByLeague(
      [{ clubId: 'single', team: 'deleted-league' }],
      clubs,
      LEAGUE_KEYS,
      NOW,
    );
    assert.deepEqual(perLeague, {});
    assert.equal(unattributed.totalPlayers, 1);
  });

  test('step 3: absent team + single-league club → that league', () => {
    const { perLeague, unattributed } = demographicsByLeague(
      [{ clubId: 'single' }],
      clubs,
      LEAGUE_KEYS,
      NOW,
    );
    assert.equal(perLeague.premier.totalPlayers, 1);
    assert.equal(unattributed.totalPlayers, 0);
  });

  test('step 3: absent team + multi-league / zero-league / unknown club → unattributed', () => {
    const { perLeague, unattributed } = demographicsByLeague(
      [{ clubId: 'multi' }, { clubId: 'none' }, { clubId: 'ghost-club' }, {}],
      clubs,
      LEAGUE_KEYS,
      NOW,
    );
    assert.deepEqual(perLeague, {});
    assert.equal(unattributed.totalPlayers, 4);
  });

  test("'unattributed' is never a perLeague key — it is the separate field", () => {
    // Even a stored team literally named 'unattributed' is just an orphaned key
    // (not in the catalogue) and lands in the separate field, collision-free.
    const { perLeague, unattributed } = demographicsByLeague(
      [
        { clubId: 'single', team: 'unattributed' },
        { clubId: 'multi' },
        { clubId: 'single', team: 'premier' },
      ],
      clubs,
      LEAGUE_KEYS,
      NOW,
    );
    assert.ok(!('unattributed' in perLeague));
    assert.equal(unattributed.totalPlayers, 2);
    assert.equal(perLeague.premier.totalPlayers, 1);
  });

  test('per-league summaries carry the same bucket shape as the cohort summary', () => {
    const { perLeague } = demographicsByLeague(
      [{ clubId: 'single', team: 'premier', dob: '2015-01-01', gender: 'Female' }],
      clubs,
      LEAGUE_KEYS,
      NOW,
    );
    const s = perLeague.premier;
    assert.equal(bucket(s.ageGroups, 'Under 13')?.count, 1);
    assert.equal(bucket(s.gender, 'Female')?.count, 1);
  });
});
