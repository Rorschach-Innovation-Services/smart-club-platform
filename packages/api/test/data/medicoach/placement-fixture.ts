/**
 * Inputs for the team-placement tests (test/medicoach-placement.test.ts). One club per
 * placement case:
 *   solo      one premier side             → the single side (unchanged rule)
 *   twin      two premier sides            → ambiguous → every side
 *   multi     single side in two leagues   → no `team`, two candidate leagues → club squad
 *   nolg      no leagues at all            → club squad
 *   vets-club veterans-premier only        → veterans second-club side
 * plus edge rows: a registered league that is not in the bundle, and veterans affiliates
 * whose main club gives no side (they already had a team and must stay byte-identical).
 *
 * `placement-baseline.json` is this fixture built by the exporter BEFORE the placement
 * change (main @ bb09634). Regenerate it only from that code, never from the current builder:
 * it is the "every pre-existing ref is untouched" oracle.
 */
import type { BuildInputs } from '../../../src/medicoach-export-build.js';
import type { Club, PlayerRegistration, Series, TenantConfig } from '../../../src/types.js';

export const T = 'acme';

const config = {
  tenant: T,
  branding: { name: 'Acme Union' },
  leagues: [
    { key: 'premier', label: 'Premier League', group: 'Senior', district: 'All districts' },
    { key: 'promotion', label: 'Promotion League', group: 'Senior', district: 'All districts' },
    {
      key: 'veterans-premier',
      label: 'Veterans Premier',
      group: 'Veterans',
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
  { id: 'solo', name: 'Solo CC', leagues: ['premier'] },
  {
    id: 'twin',
    name: 'Twin CC',
    leagues: ['premier'],
    leagueTeams: { premier: 2 },
    teamRosters: {
      premier: [
        { id: 'tm_twin_1', name: 'Twin A' },
        { id: 'tm_twin_2', name: 'Twin B' },
      ],
    },
  },
  { id: 'multi', name: 'Multi CC', leagues: ['premier', 'promotion'] },
  {
    id: 'nolg',
    name: 'No League CC',
    leagues: [],
    exco: { chair: { name: 'Nola Chair', email: 'nola@example.com' } },
  },
  { id: 'vets-club', name: 'Vets Club', leagues: ['veterans-premier'] },
].map((c) => ({ district: 'North', ground: { venue: `${c.name} Oval` }, ...c }) as unknown as Club);

const player = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  ({
    firstName: 'P',
    lastName: p.naturalKey ?? 'Layer',
    dob: '1990-01-01',
    isMinor: false,
    consentAt: 'x',
    createdAt: '2026-01-01',
    ...p,
  }) as PlayerRegistration;

const playersByClub = new Map<string, PlayerRegistration[]>([
  ['solo', [player({ naturalKey: 'nk-solo', clubId: 'solo', team: 'premier' })]],
  [
    'twin',
    [
      player({ naturalKey: 'nk-twin', clubId: 'twin', team: 'premier' }),
      // Registered for a league that is not in the bundle (no such league).
      player({ naturalKey: 'nk-twin-u19', clubId: 'twin', team: 'u19' }),
      // Ambiguous main side BUT a resolved veterans side: already teamed, must not change.
      player({
        naturalKey: 'nk-twin-vet',
        clubId: 'twin',
        team: 'premier',
        veteransClubId: 'vets-club',
      }),
    ],
  ],
  [
    'multi',
    [
      player({ naturalKey: 'nk-multi', clubId: 'multi' }),
      player({ naturalKey: 'nk-multi-2', clubId: 'multi' }),
      player({ naturalKey: 'nk-multi-promo', clubId: 'multi', team: 'promotion' }),
    ],
  ],
  [
    'nolg',
    [
      player({ naturalKey: 'nk-nolg', clubId: 'nolg' }),
      // No main-club side, but a veterans side: already teamed, must not change.
      player({ naturalKey: 'nk-nolg-vet', clubId: 'nolg', veteransClubId: 'vets-club' }),
    ],
  ],
  ['vets-club', [player({ naturalKey: 'nk-vets', clubId: 'vets-club' })]],
]);

const series: Series[] = [
  {
    id: 's-premier-1',
    name: 'Premier League · T20 · Group 1',
    leagueKey: 'premier',
    maxOvers: 20,
    teams: ['solo', 'tm_twin_1', 'tm_twin_2', 'multi'],
    participants: [
      { teamId: 'solo', clubId: 'solo', name: 'Solo CC' },
      { teamId: 'tm_twin_1', clubId: 'twin', name: 'Twin A' },
      { teamId: 'tm_twin_2', clubId: 'twin', name: 'Twin B' },
      { teamId: 'multi', clubId: 'multi', name: 'Multi CC' },
    ],
    fixtures: [
      { id: 'f1', round: 1, date: '2026-10-03', time: '13:00', home: 'solo', away: 'tm_twin_1' },
      { id: 'f2', round: 1, date: '2026-10-03', time: '13:00', home: 'tm_twin_2', away: 'multi' },
    ],
    released: true,
    releasedAt: null,
    version: 1,
    startDate: '2026-10-03',
  } as unknown as Series,
];

export function placementInputs(): BuildInputs {
  return {
    tenant: T,
    config,
    clubs,
    playersByClub,
    series,
    seasonRuns: [],
    recipes: { tenant: T, utcOffset: '+02:00', leagues: {} },
    options: { generatedAt: '2026-10-02T00:00:00.000Z' },
  };
}

/* ─────────────── Fan-out fixture (recipe `placement.fanOut`, explicit categories) ─────────────── */

/**
 * One club, `big`, with a side in every kind of league the fan-out rules distinguish:
 *   premier          senior-open, single side (the registration league of most rows)
 *   emcuD1           senior-open, TWO lettered sides with no roster → `tm_big_emcuD1_<n>`
 *   premierWomen     womens
 *   veterans-premier veterans
 *   emcuU11          junior (group Juniors) — never fans out
 *   kcSat, snT20     REAL Dolphins sub-union keys, unclassified — never fan out
 *   cup              classified senior-open but fixtures-only — never fans out
 *   promotion-women-s-league  classified womens but excluded by recipe — never fans out
 * plus `small` (premier + emcuD1 single side) for the per-person union across clubs.
 * The Dolphins seed's real labels are used so the classifier lint reads them as in prod.
 */
export const FAN_GENERATED_AT = '2026-10-02T23:30:00.000Z'; // SAST civil date 2026-10-03
export const FAN_EVAL_DATE = '2026-10-03';

const fanConfig = {
  tenant: T,
  branding: { name: 'Acme Union' },
  leagues: [
    { key: 'premier', label: 'Premier League', group: 'Overarching Leagues' },
    { key: 'premierWomen', label: 'Premier Women’s League', group: 'Overarching Leagues' },
    { key: 'veterans-premier', label: 'Veterans Premier', group: 'Overarching Leagues' },
    { key: 'emcuD1', label: 'EMCU Division 1', group: 'EMCU Divisions' },
    { key: 'emcuU11', label: 'Under 11', group: 'Juniors' },
    { key: 'kcSat', label: 'KZN SU King Cetshwayo Saturday League', group: 'King Cetshwayo' },
    { key: 'snT20', label: 'KZN SU Southern Natal T20', group: 'Southern Natal' },
    { key: 'cup', label: 'Cup', group: 'Overarching Leagues', fixturesOnly: true },
    {
      key: 'promotion-women-s-league',
      label: 'Promotion Women’s League',
      group: 'Overarching Leagues',
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

const fanClubs: Club[] = [
  {
    id: 'big',
    name: 'Big CC',
    leagues: [
      'premier',
      'premierWomen',
      'veterans-premier',
      'emcuD1',
      'emcuU11',
      'kcSat',
      'snT20',
      'cup',
      'promotion-women-s-league',
    ],
    leagueTeams: { emcuD1: 2 },
  },
  { id: 'small', name: 'Small CC', leagues: ['premier', 'emcuD1'] },
].map((c) => ({ district: 'North', ground: { venue: `${c.name} Oval` }, ...c }) as unknown as Club);

export const fanPlayer = (p: Partial<PlayerRegistration>): PlayerRegistration =>
  player({ clubId: 'big', team: 'premier', gender: 'Male', dob: '1990-06-01', ...p });

export const FAN_PLAYERS: PlayerRegistration[] = [
  fanPlayer({ naturalKey: 'nk-man' }),
  // Turns 15 ON the eval date (SAST) — fans out; the exporter and the sync must agree.
  fanPlayer({ naturalKey: 'nk-boy-15', dob: '2011-10-03', isMinor: true }),
  fanPlayer({ naturalKey: 'nk-boy-14', dob: '2011-10-04', isMinor: true }),
  fanPlayer({ naturalKey: 'nk-woman', gender: 'Female', team: 'premierWomen' }),
  fanPlayer({ naturalKey: 'nk-girl-14', gender: 'F', team: 'premierWomen', dob: '2012-01-01' }),
  fanPlayer({ naturalKey: 'nk-vet', dob: '1980-01-01' }), // 46, no veteransClubId
  fanPlayer({ naturalKey: 'nk-nogender', gender: undefined }),
  fanPlayer({ naturalKey: 'nk-nodob', dob: '' }),
  fanPlayer({ naturalKey: 'nk-small', clubId: 'small' }),
];

export const FAN_RECIPES = {
  tenant: T,
  utcOffset: '+02:00',
  leagues: {
    premier: { category: 'senior-open', competitions: {} },
    emcuD1: { category: 'senior-open', competitions: {} },
    premierWomen: { category: 'womens', competitions: {} },
    'veterans-premier': { category: 'veterans', competitions: {} },
    emcuU11: { category: 'junior', competitions: {} },
    cup: { category: 'senior-open', competitions: {} },
    'promotion-women-s-league': { category: 'womens', competitions: {} },
  },
  excludeLeagues: { 'promotion-women-s-league': 'not yet created' },
  placement: { fanOut: true },
} as const;

export function fanOutInputs(over: { fanOut?: boolean } = {}): BuildInputs {
  const recipes = JSON.parse(JSON.stringify(FAN_RECIPES));
  if (over.fanOut === false) delete recipes.placement;
  return {
    tenant: T,
    config: fanConfig,
    clubs: fanClubs,
    playersByClub: new Map([
      ['big', FAN_PLAYERS.filter((p) => p.clubId === 'big')],
      ['small', FAN_PLAYERS.filter((p) => p.clubId === 'small')],
    ]),
    series: [],
    seasonRuns: [],
    recipes,
    options: { generatedAt: FAN_GENERATED_AT },
  };
}
