/**
 * Frontend twin of packages/api/src/vertical.ts (parity pinned by vertical.test.ts).
 *
 * Sport verticals — the code-defined profile a tenant's `sport` discriminator selects:
 * terminology, leadership role labels, player-profile mode, coaching vocabulary, module
 * defaults and affiliation step names. Absent/unknown `sport` resolves to the cricket
 * profile, whose values are today's literals, so existing tenants behave byte-identically.
 */
import type { TenantConfig } from './types';

export type Sport = 'cricket' | 'football';

export const SPORTS: readonly Sport[] = ['cricket', 'football'];

export type ModuleKey = 'veterans' | 'cqi' | 'compliance' | 'clearances';

export const MODULE_KEYS: readonly ModuleKey[] = ['veterans', 'cqi', 'compliance', 'clearances'];

export interface VerticalTerms {
  club: string;
  clubs: string;
  Club: string;
  Clubs: string;
  chair: string;
  Chair: string;
  exco: string;
  Exco: string;
  union: string;
  Union: string;
  office: string;
  sport: string;
  Sport: string;
}

export type TermKey = keyof VerticalTerms;

export interface LeadershipRole {
  key: 'chair' | 'sec' | 'tre' | 'vc';
  label: string;
  required: boolean;
}

export interface VerticalProfile {
  sport: Sport;
  terms: VerticalTerms;
  leadershipRoles: LeadershipRole[];
  playerProfile: 'cricket' | 'positions';
  positions: string[];
  coachingBodies: string[];
  coachingLevels: string[];
  moduleDefaults: Record<ModuleKey, boolean>;
  affiliationSteps: [string, string, string];
}

const CRICKET: VerticalProfile = {
  sport: 'cricket',
  terms: {
    club: 'club',
    clubs: 'clubs',
    Club: 'Club',
    Clubs: 'Clubs',
    chair: 'chairperson',
    Chair: 'Chairperson',
    exco: 'executive committee',
    Exco: 'Executive Committee',
    union: 'union',
    Union: 'Union',
    office: 'Union office',
    sport: 'cricket',
    Sport: 'Cricket',
  },
  leadershipRoles: [
    { key: 'chair', label: 'Chairperson', required: true },
    { key: 'sec', label: 'Secretary', required: true },
    { key: 'tre', label: 'Treasurer', required: true },
    { key: 'vc', label: 'Vice-Chair', required: false },
  ],
  playerProfile: 'cricket',
  positions: [],
  coachingBodies: ['None', 'CSA', 'Gary Kirsten'],
  coachingLevels: ['None', 'Level 1', 'Level 2', 'Level 3', 'Level 4'],
  moduleDefaults: { veterans: true, cqi: true, compliance: true, clearances: true },
  affiliationSteps: ['Club Details', 'Executive Committee', 'Leagues & Coaches'],
};

const FOOTBALL: VerticalProfile = {
  sport: 'football',
  terms: {
    club: 'school',
    clubs: 'schools',
    Club: 'School',
    Clubs: 'Schools',
    chair: 'principal',
    Chair: 'Principal',
    exco: 'school leadership',
    Exco: 'School Leadership',
    union: 'league',
    Union: 'League',
    office: 'League office',
    sport: 'football',
    Sport: 'Football',
  },
  leadershipRoles: [
    { key: 'chair', label: 'Principal', required: true },
    { key: 'sec', label: 'Director of Sport', required: true },
    { key: 'tre', label: 'Director of Football', required: true },
    { key: 'vc', label: 'Director of Academics', required: true },
  ],
  playerProfile: 'positions',
  positions: [
    'Goalkeeper',
    'Right Back',
    'Left Back',
    'Centre Back',
    'Defensive Midfielder',
    'Central Midfielder',
    'Attacking Midfielder',
    'Winger',
    'Striker',
  ],
  coachingBodies: ['None', 'CAF', 'UEFA', 'SAFA'],
  coachingLevels: ['None', 'A', 'B', 'C', 'D'],
  moduleDefaults: { veterans: false, cqi: false, compliance: false, clearances: false },
  affiliationSteps: ['School Details', 'School Leadership', 'Leagues & Coaches'],
};

export const VERTICALS: Record<Sport, VerticalProfile> = { cricket: CRICKET, football: FOOTBALL };

export function isSport(value: unknown): value is Sport {
  return typeof value === 'string' && (SPORTS as readonly string[]).includes(value);
}

/** The tenant's vertical profile; absent/unknown `sport` ⇒ cricket. */
export function resolveVertical(cfg?: Pick<TenantConfig, 'sport'> | null): VerticalProfile {
  const sport = cfg?.sport;
  return isSport(sport) ? VERTICALS[sport] : CRICKET;
}

/** The display label for one leadership (exco) storage key under this profile. */
export function roleLabel(profile: VerticalProfile, key: LeadershipRole['key']): string {
  return profile.leadershipRoles.find((r) => r.key === key)?.label ?? key;
}

/** Label for a club ground's playing-field count (`ground.pitchCount`). */
export function pitchCountLabel(sport: Sport): string {
  return sport === 'cricket' ? 'Number of fields / ovals' : 'Number of fields';
}
