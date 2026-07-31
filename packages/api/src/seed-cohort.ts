/**
 * Seed a full ADR 0008 league cohort into a tenant — clubs, a calendar, structures,
 * leagues with bound competitions, venues, a season run per league, and generated
 * fixtures — plus the two logins needed to walk it.
 *
 *   sst shell --stage dev -- npm --prefix packages/api run seed-cohort -- \
 *     dolphins --clubs 16 --leagues seed-premier-men,seed-reserve-men \
 *     --admin you+dev@example.com --rep you+rep@example.com
 *
 * Clubs fan out across the leagues with deliberate OVERLAP (every club enters the first
 * league; the rest are split across the others), because a club playing two leagues is
 * the normal case and is what makes per-league rosters worth testing.
 *
 * WHY THIS EXISTS: the demo snapshot (`seed --demo`) predates ADR 0008 and carries no
 * calendars, structures or season runs, and there is no admin "create club" endpoint at
 * all — so there was no way to stand up a cohort that exercises the competition feature.
 *
 * WHY IT WRITES THROUGH `repo` RATHER THAN HTTP: fixture generation runs in the browser
 * (ADR 0004) — the API has no generate endpoint, it only stores finished objects. So the
 * CLI imports the SAME generation engine the SPA uses (src/competition/*) and persists
 * the result directly. The cost of bypassing the routes is bypassing their validation,
 * which is why `config-validation.ts` was extracted: we run the operator route's exact
 * assertions before writing.
 *
 * IDEMPOTENT AND ADDITIVE: every id is derived from (tenant, league, season), never
 * random, so re-running converges instead of duplicating. Club league registrations are
 * MERGED (see putClubMerging), so seeding a second set of leagues later adds to the first
 * rather than silently emptying it.
 *
 * See docs/runbooks/seeding-a-test-cohort.md.
 */
import { pathToFileURL } from 'node:url';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import * as repo from './repo.js';
import { clubIdFromName } from './club-id.js';
import {
  validateCalendars,
  validateStructures,
  validateCompetitions,
} from './config-validation.js';
import { grantTenantAdmin, grantClubRep } from './tenant-admin.js';
import { OVERARCHING_DISTRICT } from './catalogue.js';
import { userPoolId } from './env.js';
import type {
  Club,
  ClubTeam,
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
  StageRun,
  TenantConfig,
  Venue,
} from './types.js';

// The generation engine lives in the frontend tree (pure TS — dayjs and types only, no
// React, no DOM). Type-checked by tsconfig.seed.json, which is scoped to this file
// precisely because that tree is `strict: false` while the api project is strict.
import { materialiseStage } from '../../../src/competition/structure.js';
import { STRUCTURE_TEMPLATES } from '../../../src/competition/templates.js';
import { leagueParticipants } from '../../../src/leagues.js';

/* ─────────────────────────── Cohort fixture data ─────────────────────────── */

/**
 * Real KZN club names and grounds, NOT "Club A"…"Club N".
 *
 * The ADR 0008 runbook is explicit about this: the worst defect the feature shipped with
 * was a prefill proposing to relegate an entire group, and it stayed invisible through
 * several review rounds *because the sample clubs were alphabetical* — the wrong order
 * and the right order looked identical. Alphabetical seed data cannot catch ordering
 * bugs. Coordinates are approximate Durban-area pins, enough for travel/venue ranking to
 * produce non-degenerate results.
 */
const COHORT: Array<{ name: string; district: string; venue: string; lat: number; lon: number }> = [
  {
    name: 'Westville CC',
    district: 'Durban West',
    venue: 'Westville Oval',
    lat: -29.8375,
    lon: 30.9276,
  },
  {
    name: 'Pinetown CC',
    district: 'Durban West',
    venue: 'Pinetown Sports Club',
    lat: -29.8156,
    lon: 30.8586,
  },
  {
    name: 'Berea Rovers',
    district: 'Durban Central',
    venue: 'Berea Rovers Ground',
    lat: -29.8489,
    lon: 31.0011,
  },
  {
    name: 'Umhlanga CC',
    district: 'Durban North',
    venue: 'Umhlanga Sports Field',
    lat: -29.7264,
    lon: 31.0856,
  },
  {
    name: 'Glenwood Old Boys',
    district: 'Durban Central',
    venue: 'Glenwood Park',
    lat: -29.8703,
    lon: 30.9932,
  },
  {
    name: 'Queensburgh CC',
    district: 'Durban West',
    venue: 'Queensburgh Oval',
    lat: -29.8617,
    lon: 30.8908,
  },
  {
    name: 'Amanzimtoti CC',
    district: 'South Coast',
    venue: 'Toti Sports Ground',
    lat: -30.0511,
    lon: 30.8836,
  },
  {
    name: 'Kloof & Highway',
    district: 'Durban West',
    venue: 'Kloof Country Club',
    lat: -29.7889,
    lon: 30.8342,
  },
  {
    name: 'Durban Collegians',
    district: 'Durban Central',
    venue: 'Collegians Field',
    lat: -29.8408,
    lon: 31.0175,
  },
  {
    name: 'Phoenix CC',
    district: 'Durban North',
    venue: 'Phoenix Cricket Ground',
    lat: -29.7011,
    lon: 31.0189,
  },
  {
    name: 'Chatsworth CC',
    district: 'Durban South',
    venue: 'Chatsworth Stadium',
    lat: -29.9089,
    lon: 30.8931,
  },
  {
    name: 'Verulam CC',
    district: 'North Coast',
    venue: 'Verulam Sports Complex',
    lat: -29.6472,
    lon: 31.0508,
  },
  {
    name: 'Pietermaritzburg CC',
    district: 'Midlands',
    venue: 'City Oval',
    lat: -29.6006,
    lon: 30.3794,
  },
  {
    name: 'Hillcrest Villagers',
    district: 'Durban West',
    venue: 'Hillcrest Village Green',
    lat: -29.7808,
    lon: 30.7628,
  },
  {
    name: 'Tongaat CC',
    district: 'North Coast',
    venue: 'Tongaat Oval',
    lat: -29.5789,
    lon: 31.1214,
  },
  {
    name: 'Isipingo CC',
    district: 'Durban South',
    venue: 'Isipingo Sports Ground',
    lat: -29.9906,
    lon: 30.9375,
  },
  {
    name: 'Ballito CC',
    district: 'North Coast',
    venue: 'Ballito Sports Club',
    lat: -29.5386,
    lon: 31.2144,
  },
  {
    name: 'New Germany CC',
    district: 'Durban West',
    venue: 'New Germany Oval',
    lat: -29.8039,
    lon: 30.8794,
  },
  {
    name: 'Malvern CC',
    district: 'Durban South',
    venue: 'Malvern Recreation Ground',
    lat: -29.8836,
    lon: 30.9433,
  },
  {
    name: 'Umbilo Park',
    district: 'Durban Central',
    venue: 'Umbilo Park Oval',
    lat: -29.8722,
    lon: 30.9825,
  },
  {
    name: 'Shongweni CC',
    district: 'Durban West',
    venue: 'Shongweni Grounds',
    lat: -29.8256,
    lon: 30.7192,
  },
  {
    name: 'Mount Edgecombe',
    district: 'Durban North',
    venue: 'Mount Edgecombe Oval',
    lat: -29.7089,
    lon: 31.0439,
  },
  {
    name: 'Scottburgh CC',
    district: 'South Coast',
    venue: 'Scottburgh Sports Field',
    lat: -30.2861,
    lon: 30.7528,
  },
  {
    name: 'Howick CC',
    district: 'Midlands',
    venue: 'Howick Village Ground',
    lat: -29.4903,
    lon: 30.2264,
  },
];

/** Clubs at these indices field two sides, so the `teamId !== clubId` path is exercised. */
const MULTI_SIDE_INDICES = new Set([0, 4]);

const CLUB_COLORS = ['#0E3529', '#215F47', '#4B8A6C', '#B89B4A', '#E7DDC6', '#8C5A3B'];

/* ─────────────────────────── Deterministic ids ─────────────────────────── */

/**
 * Ids are derived, never random. `instantiateTemplate` and `newStructureId` mint random
 * ids (correct for an operator clicking "clone"), but a seed that did that would create a
 * fresh structure on every run and leave the previous one orphaned in config.
 */
const calendarId = (season: string) => `cal-${slug(season)}`;
const structureId = (season: string, template: string) => `st-${slug(season)}-${template}`;
const competitionId = (leagueKey: string, template: string) => `comp-${leagueKey}-${template}`;
const seasonRunId = (leagueKey: string, season: string) => `run-${leagueKey}-${slug(season)}`;
const venueId = (clubId: string) => `v-${clubId}`;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/* ─────────────────────────── Config layer ─────────────────────────── */

/**
 * A two-block season either side of a festive break — the shape both unions actually run,
 * and the one `instantiateTemplate` assumes (opening stage in block 1, deciders in block 2).
 * Wall-clock date-only strings; never converted to UTC (ADR 0008).
 */
function buildCalendar(season: string, startYear: number): SeasonCalendar {
  return {
    id: calendarId(season),
    label: `${season} season`,
    timezone: 'Africa/Johannesburg',
    // Block 1 is deliberately LONG (~21 weekly dates). A flat round robin over the full
    // 24-club roster needs 25 rounds, and a block that fits fewer does not fail — it
    // silently generates a TRUNCATED season where some sides never play each other, which
    // looks like real data and is not. seedSeason warns if a stage still overflows.
    // Block ids are namespaced by CALENDAR. Bare `block-1`/`block-2` made every seeded
    // season's blocks identical in both id and label, so two calendars were
    // indistinguishable to anything matching a structure back to the calendar it belongs
    // to — and a structure built for 2026/27 resolved just as well against 2027/28, over
    // the wrong dates. Deriving from the calendar id keeps them unique without making
    // them random (this seed is re-runnable and its ids must be stable).
    blocks: [
      {
        id: `${calendarId(season)}-block-1`,
        label: 'First half',
        start: `${startYear}-08-01`,
        end: `${startYear}-12-19`,
      },
      {
        id: `${calendarId(season)}-block-2`,
        label: 'Second half',
        start: `${startYear + 1}-01-16`,
        end: `${startYear + 1}-05-29`,
      },
    ],
    breaks: [
      {
        label: 'Festive break',
        start: `${startYear}-12-20`,
        end: `${startYear + 1}-01-15`,
      },
    ],
  };
}

/**
 * Three structures from the shipped templates, with deterministic ids.
 *
 * Only the flat round robin is run as a season below — it resolves from
 * `all-registered` alone, so it generates end to end with no human input. The other two
 * are installed so the operator portal and the season-run UI have realistic material to
 * drive by hand; their later stages are `manual`/`derivedFrom` and are *supposed* to sit
 * at `awaiting-entrants` until an admin confirms standings. That is the feature working,
 * not the seed failing.
 */
function buildStructures(season: string, calendar: SeasonCalendar): CompetitionStructure[] {
  const wanted = ['flat-round-robin', 'split-league-swap', 'pools-to-knockout'];
  return wanted.map((templateId) => {
    const template = STRUCTURE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new Error(`unknown structure template "${templateId}"`);
    const first = calendar.blocks[0].id;
    const second = calendar.blocks[1]?.id ?? first;
    return {
      id: structureId(season, templateId),
      name: template.name,
      version: 1,
      templateId: template.id,
      // The calendar these blockIds were authored against. Without it the operator
      // console opens every seeded structure against whichever calendar happens to be
      // first, where the stored blocks resolve to nothing: blank pickers, a preview rail
      // calling a good structure broken, and Save still enabled over the wrong blocks.
      calendarId: calendar.id,
      stages: template.stages.map((stage, i) => ({
        ...stage,
        schedule: { ...stage.schedule, blockId: i === 0 ? first : second },
      })),
    };
  });
}

/**
 * Display metadata for the built-in league keys, so a multi-league cohort reads like a
 * real catalogue (Senior Men / Senior Women / Junior) rather than three clones. An
 * unrecognised `--leagues` key still works; it just gets a derived label.
 */
const LEAGUE_META: Record<string, { label: string; group: string }> = {
  'seed-premier-men': { label: 'Premier Men', group: 'Senior Men' },
  'seed-reserve-men': { label: 'Reserve Men', group: 'Senior Men' },
  'seed-premier-women': { label: 'Premier Women', group: 'Senior Women' },
  'seed-t20-cup': { label: 'T20 Cup', group: 'Senior Men' },
  'seed-under-19': { label: 'Under 19', group: 'Junior' },
};

function buildLeague(
  leagueKey: string,
  season: string,
  structures: CompetitionStructure[],
): League {
  const meta = LEAGUE_META[leagueKey] ?? {
    label: leagueKey
      .replace(/^seed-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    group: 'Senior Men',
  };
  const competitions: Competition[] = structures.map((st) => ({
    id: competitionId(leagueKey, st.templateId ?? slug(st.name)),
    label:
      st.templateId === 'flat-round-robin'
        ? '50 Over (Red Ball)'
        : st.templateId === 'pools-to-knockout'
          ? 'T20 (Pink Ball)'
          : 'Premier League',
    matchFormat:
      st.templateId === 'pools-to-knockout'
        ? { overs: 20, ballType: 'pink', label: 'T20' }
        : { overs: 50, ballType: 'red', label: '50 Over' },
    structureId: st.id,
    calendarId: calendarId(season),
  }));
  return {
    key: leagueKey,
    label: meta.label,
    group: meta.group,
    district: OVERARCHING_DISTRICT,
    note: 'Seeded test cohort',
    competitions,
  };
}

/**
 * Rewrite an incoming calendar to reuse the block IDs the tenant already has, and point
 * the incoming structures at them.
 *
 * Matched **by label first**, position only as a fallback. The seed's own block shape is
 * fixed, but the shape of the calendar it is merging INTO is not — an operator can
 * reorder or delete blocks from the calendars card. Matching purely by index there is
 * silent relocation of exactly the kind this function exists to prevent: if the operator
 * has put Second half first, `block-2` — the id every persisted `Series.schedule.blockId`
 * knows as the January window — comes back carrying August dates, and `addFixture` starts
 * scheduling a January competition in August with no error anywhere.
 *
 * Labels (`First half`/`Second half`) are stable across seed runs and are what existing
 * seeded calendars already carry, so the label pass hits in every real case. Matched ids
 * are consumed, so a block that misses on label can't positionally steal one another
 * block already claimed. Anything still unmatched keeps its incoming (namespaced) id: it
 * is genuinely new, so nothing can be pointing at it yet.
 *
 * Exported for testing: this is the whole of the data-safety guarantee that a re-seed
 * never dangles a `Series.schedule.blockId`, and it is not otherwise reachable.
 */
export function keepExistingBlockIds(
  existing: SeasonCalendar,
  incoming: SeasonCalendar,
  structures: CompetitionStructure[],
): { calendar: SeasonCalendar; structures: CompetitionStructure[] } {
  const taken = new Set<string>();
  const keptIds: string[] = [];

  // Pass 1 — same label wins, wherever it sits.
  incoming.blocks.forEach((b, i) => {
    const hit = existing.blocks.find((x) => !taken.has(x.id) && x.label.trim() === b.label.trim());
    if (hit) {
      taken.add(hit.id);
      keptIds[i] = hit.id;
    }
  });

  // Pass 2 — whatever is left over, in order, for blocks the labels didn't match
  // (an operator who renamed one). Best effort, and it cannot collide: every id pass 1
  // claimed is already consumed.
  const leftover = existing.blocks.filter((x) => !taken.has(x.id)).map((x) => x.id);
  incoming.blocks.forEach((b, i) => {
    if (keptIds[i]) return;
    keptIds[i] = leftover.shift() ?? b.id;
  });

  const rename = new Map(incoming.blocks.map((b, i) => [b.id, keptIds[i]]));
  return {
    calendar: {
      ...incoming,
      blocks: incoming.blocks.map((b, i) => ({ ...b, id: keptIds[i] })),
    },
    structures: structures.map((st) => ({
      ...st,
      stages: st.stages.map((s) => ({
        ...s,
        schedule: { ...s.schedule, blockId: rename.get(s.schedule.blockId) ?? s.schedule.blockId },
      })),
    })),
  };
}

/**
 * Merge the cohort's config into whatever is already there.
 *
 * Read-modify-write, merged BY ID — never a blind overwrite. The CONFIG row is the tenant
 * registry's source of truth and carries branding, `adminCount` and `clubSignupLink` that
 * a re-seed must not clobber, plus any leagues/calendars the tenant authored itself.
 *
 * Returns the calendar and structures AS WRITTEN, which may differ from what was passed
 * in — see `keepExistingBlockIds`. The caller has to seed seasons against the written
 * values, not the built ones, or the run would reference blocks the stored calendar
 * doesn't have.
 */
async function mergeConfig(
  tenant: string,
  cohort: {
    calendar: SeasonCalendar;
    structures: CompetitionStructure[];
    leagues: League[];
    districts: string[];
  },
): Promise<{ calendar: SeasonCalendar; structures: CompetitionStructure[] }> {
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new Error(`tenant "${tenant}" not found — run \`seed -- ${tenant}\` first`);

  /*
   * Block IDs are namespaced for a calendar this run CREATES, and never for one that
   * already exists.
   *
   * A calendar is merged by id, so re-seeding a tenant replaces its blocks in place. Had
   * that carried new ids, everything already pointing at the old ones would dangle at
   * once: `Series.schedule.blockId` is persisted, and `addFixture` (src/admin.tsx) reads
   * it back to date the next round — a miss there doesn't error, it silently falls
   * through to the legacy "+7 days" path, straight into the mid-season break that season
   * calendars exist to remove. Any operator-authored structure bound to the calendar
   * would also fail `validateCompetitions` below, taking the whole re-seed — and every
   * later tenant PUT — down with it.
   *
   * So: keep the existing ids, take the incoming dates. Positional, because
   * `buildCalendar` emits a fixed two-block shape and `buildStructures` assigns them by
   * index. Fresh tenants still get namespaced ids, which is where the ambiguity this
   * guards against actually arises.
   */
  const existingCalendar = (config.calendars ?? []).find((c) => c.id === cohort.calendar.id);
  if (existingCalendar) {
    const kept = keepExistingBlockIds(existingCalendar, cohort.calendar, cohort.structures);
    cohort = { ...cohort, calendar: kept.calendar, structures: kept.structures };
  }

  const mergeById = <T extends { id: string }>(existing: T[] | undefined, incoming: T[]): T[] => {
    const out = [...(existing ?? [])];
    for (const item of incoming) {
      const at = out.findIndex((x) => x.id === item.id);
      if (at >= 0) out[at] = item;
      else out.push(item);
    }
    return out;
  };

  const calendars = mergeById(config.calendars, [cohort.calendar]);
  const structures = mergeById(config.structures, cohort.structures);
  const leagues = [...(config.leagues ?? [])];
  for (const incoming of cohort.leagues) {
    const at = leagues.findIndex((l) => l.key === incoming.key);
    if (at >= 0) leagues[at] = incoming;
    else leagues.push(incoming);
  }

  const districts = Array.from(new Set([...(config.districts ?? []), ...cohort.districts]));

  // The same assertions PUT /platform/tenants/:slug runs. Writing through repo skips the
  // route entirely, and a dangling structureId/calendarId/blockId would persist happily
  // and only fail much later at generation time with no obvious cause.
  validateCalendars(calendars);
  validateStructures(structures);
  validateCompetitions(leagues, structures, calendars);

  const next: TenantConfig = { ...config, calendars, structures, leagues, districts };
  await repo.putTenantConfig(next);
  return { calendar: cohort.calendar, structures: cohort.structures };
}

/* ─────────────────────────── Clubs and venues ─────────────────────────── */

/**
 * Which leagues each club enters.
 *
 * Every club joins the FIRST league (so it always has a full field), then fans out across
 * the rest by index. That gives leagues of genuinely different sizes with overlapping
 * membership — a club playing Premier Men *and* the T20 Cup is the normal case in club
 * cricket, and it is what makes `Series.participants` and the per-league team rosters
 * worth testing at all. Deterministic, so a re-run assigns identically.
 */
function leaguesForClub(index: number, leagueKeys: string[]): string[] {
  if (leagueKeys.length === 1) return [leagueKeys[0]];
  const extra = leagueKeys[1 + (index % (leagueKeys.length - 1))];
  return Array.from(new Set([leagueKeys[0], extra]));
}

/**
 * Assign clubs so EVERY league ends up with exactly `perLeague` of them (`--per-league`).
 *
 * Each league takes a window of `perLeague` consecutive clubs, starting at a rotating
 * offset, wrapping around the roster. Windows overlap — which is the point: with 16 clubs
 * and three leagues of 12 you cannot have disjoint sets, and overlapping entries are the
 * realistic case anyway (a club fielding sides in several competitions).
 *
 * Rotating rather than taking the same first N keeps the leagues genuinely different: a
 * fixed window would give three identical fields and test nothing about per-league rosters.
 */
function assignByWindow(totalClubs: number, leagueKeys: string[], perLeague: number): string[][] {
  const perClub: string[][] = Array.from({ length: totalClubs }, () => []);
  // Spread the windows as evenly as the roster allows; at least 1 so leagues differ.
  const stride = Math.max(1, Math.floor(totalClubs / leagueKeys.length));
  leagueKeys.forEach((key, l) => {
    for (let j = 0; j < perLeague; j++) {
      perClub[(l * stride + j) % totalClubs].push(key);
    }
  });
  return perClub.map((keys) => Array.from(new Set(keys)));
}

function buildClubs(count: number, leagueKeys: string[], perLeague?: number): Club[] {
  const windowed = perLeague ? assignByWindow(count, leagueKeys, perLeague) : undefined;
  return COHORT.slice(0, count).map((spec, i) => {
    const id = clubIdFromName(spec.name);
    const sides = MULTI_SIDE_INDICES.has(i) ? 2 : 1;
    const mine = windowed ? windowed[i] : leaguesForClub(i, leagueKeys);

    const leagueTeams: Record<string, number> = {};
    const teamRosters: Record<string, ClubTeam[]> = {};
    for (const key of mine) {
      leagueTeams[key] = sides;
      // Deterministic team ids, matching the shape clubTeamsForLeague pads with, so a
      // re-seed keeps the same teamIds and existing fixtures stay valid. Rosters exist
      // ONLY for leagues fielding >= 2 sides — a count-1 league has no roster, the club
      // is its own team, and writing one anyway would contradict clubTeamsForLeague.
      if (sides >= 2) {
        teamRosters[key] = Array.from({ length: sides }, (_, n) => ({
          id: `tm_${id}_${key}_${n}`,
          name: `${spec.name} ${String.fromCharCode(65 + n)}`,
          venue: spec.venue,
          lat: spec.lat,
          lon: spec.lon,
        }));
      }
    }

    return {
      id,
      name: spec.name,
      district: spec.district,
      sub: '',
      chair: `${spec.name} Chairperson`,
      affiliation: 'complete',
      cqi: 60 + ((i * 7) % 35),
      docs: {
        constitution: true,
        agm: true,
        financials: i % 3 !== 0,
        exco: true,
        codeOfConduct: i % 4 !== 0,
        safeguarding: i % 2 === 0,
      },
      players: 0,
      teams: sides,
      women: i % 3,
      juniors: i % 5,
      color: CLUB_COLORS[i % CLUB_COLORS.length],
      ground: { venue: spec.venue, suburb: spec.district, lat: spec.lat, lon: spec.lon },
      leagues: mine,
      leagueTeams,
      ...(Object.keys(teamRosters).length ? { teamRosters } : {}),
      // Matches seedDemoData, so demo-only UI (the illustrative comm-log) renders for
      // these and stays off real onboarded clubs.
      demo: true,
      onboardedAt: new Date().toISOString(),
      version: 1,
    } as Club;
  });
}

/**
 * Write a club, PRESERVING league registrations it already has.
 *
 * `repo.putClub` is a whole-item put, so a plain write would drop the club out of every
 * league from a previous run — seed `--leagues a`, then `--leagues b`, and league A is
 * silently empty with its fixtures still pointing at teams that no longer claim it.
 *
 * But a blanket union is equally wrong: re-seeding the SAME leagues with a different
 * membership (a smaller `--per-league`, say) would keep every club the previous run put
 * there, so the store would say 16 clubs while this run's fixtures contain 12 — and the
 * CLI's own summary, computed from the in-memory assignment, would report the 12 and be
 * lying about what is on disk.
 *
 * So the rule is scoped: **this run is authoritative for the leagues it manages, and
 * leaves every other league alone.** `managed` is the set of keys in `--leagues`.
 *
 * Only the seed's OWN fields are reconciled; anything else on an existing record
 * (affiliation edits, notes, docs) is intentionally replaced — these are seeded demo clubs.
 */
async function putClubMerging(tenant: string, club: Club, managed: Set<string>): Promise<void> {
  const existing = await repo.getClub(tenant, club.id);
  if (!existing) {
    await repo.putClub(tenant, club);
    return;
  }
  // Keep registrations this run has no opinion about; drop managed ones it did not assign.
  const untouched = (existing.leagues ?? []).filter((k) => !managed.has(k));
  const leagues = Array.from(new Set([...untouched, ...club.leagues]));

  const pickUnmanaged = <T>(map: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(map ?? {}).filter(([k]) => !managed.has(k)));

  const leagueTeams = { ...pickUnmanaged(existing.leagueTeams), ...(club.leagueTeams ?? {}) };
  const teamRosters = { ...pickUnmanaged(existing.teamRosters), ...(club.teamRosters ?? {}) };

  await repo.putClub(tenant, {
    ...club,
    leagues,
    leagueTeams,
    ...(Object.keys(teamRosters).length ? { teamRosters } : {}),
    version: existing.version ?? 1,
  });
}

function buildVenues(clubs: Club[]): Venue[] {
  return clubs.map((club) => ({
    id: venueId(club.id),
    name: club.ground.venue ?? `${club.name} ground`,
    suburb: club.ground.suburb,
    lat: club.ground.lat,
    lon: club.ground.lon,
    homeClubIds: [club.id],
    surfaces: 1,
  }));
}

/* ─────────────────────────── Season run + series ─────────────────────────── */

/**
 * Materialise the flat round-robin structure and persist one Series per stage-group.
 *
 * The series id is `s-${runId}-${stageId}-${groupId}` — byte-identical to what
 * `generateStageSeriesInner` (src/main.tsx) produces, which is what lets a re-seed
 * overwrite the same rows the admin UI would have written rather than stacking duplicates.
 */
async function seedSeason(
  tenant: string,
  opts: {
    clubs: Club[];
    league: League;
    structure: CompetitionStructure;
    competition: Competition;
    calendar: SeasonCalendar;
    season: string;
  },
): Promise<{ run: SeasonRun; series: Series[] }> {
  const { clubs, league, structure, competition, calendar, season } = opts;
  const runId = seasonRunId(league.key, season);

  const participants = leagueParticipants(clubs, league.key, competition.excludeTeamIds ?? []);
  const registered = participants.map((p) => p.teamId);
  if (registered.length < 2)
    throw new Error(`league "${league.key}" has ${registered.length} registered side(s) — need 2+`);

  const stages: StageRun[] = [];
  const seriesOut: Series[] = [];

  for (const stage of structure.stages) {
    const result = materialiseStage({ stage, calendar, context: { registered } });

    if (result.status === 'awaiting-entrants') {
      // Correct and expected for a standings-dependent stage — it waits for a human.
      stages.push({ specId: stage.id, status: 'awaiting-entrants', groups: [] });
      continue;
    }

    const groups: StageRun['groups'] = [];
    for (const group of result.groups) {
      const seriesId = `s-${runId}-${stage.id}-${group.id}`;
      const startDate = group.plan.dates[0];
      // A stage whose rounds outrun its block does NOT fail — `fixturesFromDates` simply
      // emits fewer rounds, producing a round robin in which some sides never meet. That
      // is broken test data wearing the costume of real data, and nothing downstream would
      // ever flag it. `plan.fits` is the engine's own verdict; surface it loudly rather
      // than writing a partial season in silence.
      if (!group.plan.fits) {
        const placed = group.plan.roundsPlaced ?? group.plan.dates.length;
        const wanted = group.plan.roundsRequested ?? placed;
        console.warn(
          `  ⚠ ${league.label} · ${group.label}: only ${placed} of ${wanted} rounds fit ` +
            `${group.plan.summary} — ${wanted - placed} round(s) DROPPED, so some sides ` +
            `never play each other. Use fewer --clubs, a wider block, or a denser cadence.`,
        );
      }
      // HARD INVARIANT: Series.startDate is the gsi1 SORT KEY. dynalite accepts an empty
      // string and real DynamoDB rejects it, so a blank here passes every offline test and
      // then fails on dev part-way through the loop, after earlier groups are already
      // written. materialiseStage already refuses to call a group with <2 entrants
      // "ready", but assert rather than trust — this is the expensive failure.
      if (!startDate)
        throw new Error(
          `stage "${stage.name}" group "${group.label}" produced no dates — ` +
            `${group.plan.summary}. Refusing to write a blank startDate.`,
        );

      const byTeamId = new Map(participants.map((p) => [p.teamId, p]));
      const series: Series = {
        id: seriesId,
        name: `${league.label} · ${stage.name}${result.groups.length > 1 ? ` · ${group.label}` : ''}`,
        startDate,
        teams: group.entrants,
        // Snapshot team identity so a later roster edit can't orphan these fixtures.
        participants: group.entrants.flatMap((teamId) => {
          const p = byTeamId.get(teamId);
          if (!p) return [];
          return [
            {
              teamId: p.teamId,
              clubId: p.clubId,
              name: p.name,
              ...(p.venue ? { venue: p.venue } : {}),
              ...(Number.isFinite(p.lat) ? { lat: p.lat as number } : {}),
              ...(Number.isFinite(p.lon) ? { lon: p.lon as number } : {}),
            },
          ];
        }),
        fixtures: group.fixtures,
        schedule: {
          calendarId: calendar.id,
          blockId: stage.schedule.blockId,
          cadence: stage.schedule.cadence,
          ...(stage.schedule.slots?.length ? { slots: stage.schedule.slots } : {}),
        },
        seasonRunId: runId,
        stageSpecId: stage.id,
        groupId: group.id,
        maxOvers: competition.matchFormat?.overs ?? 50,
        seriesType: competition.label,
        kind: 'series',
        // Seeded fixtures are meant to be VISIBLE — the whole point is logging in as a rep
        // and seeing them. Approved first: the API refuses `released` without it.
        approved: true,
        approvedAt: new Date().toISOString(),
        released: true,
        releasedAt: new Date().toISOString(),
        version: 1,
      };
      await repo.putSeries(tenant, series);
      seriesOut.push(series);
      groups.push({ id: group.id, label: group.label, entrants: group.entrants, seriesId });
    }
    stages.push({ specId: stage.id, status: 'generated', groups });
  }

  const run: SeasonRun = {
    id: runId,
    leagueKey: league.key,
    competitionId: competition.id,
    // HARD INVARIANT: seasonLabel is the gsi1 sort key — same blank-string trap as above.
    seasonLabel: season,
    structureSnapshot: structure,
    calendarSnapshot: calendar,
    stages,
    createdAt: new Date().toISOString(),
    createdBy: 'seed-cohort',
    version: 1,
  };
  await repo.putSeasonRun(tenant, run);
  return { run, series: seriesOut };
}

/* ─────────────────────────── CLI ─────────────────────────── */

interface Args {
  tenant: string;
  clubs: number;
  leagueKeys: string[];
  perLeague?: number;
  season: string;
  admin?: string;
  rep?: string;
}

const DEFAULT_LEAGUES = ['seed-premier-men', 'seed-reserve-men', 'seed-premier-women'];

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags.set(a.slice(2), argv[++i] ?? '');
    else positional.push(a);
  }
  const tenant = positional[0];
  if (!tenant)
    throw new Error(
      'usage: seed-cohort <tenant> [--clubs N] [--leagues a,b,c] [--per-league N] ' +
        '[--season 2026/27] [--admin EMAIL] [--rep EMAIL]',
    );

  const clubs = Number(flags.get('clubs') ?? 16);
  if (!Number.isInteger(clubs) || clubs < 2 || clubs > COHORT.length)
    throw new Error(`--clubs must be a whole number between 2 and ${COHORT.length}`);

  // `--league` (singular) kept as an alias so the original one-league invocation and the
  // runbook's earlier examples still work.
  const raw = flags.get('leagues') ?? flags.get('league');
  const leagueKeys = raw
    ? Array.from(
        new Set(
          raw
            .split(',')
            .map((k) => slug(k.trim()))
            .filter(Boolean),
        ),
      )
    : DEFAULT_LEAGUES;
  if (leagueKeys.length === 0) throw new Error('--leagues needs at least one key');
  if (leagueKeys.length > 6) throw new Error('--leagues is capped at 6');
  const perLeagueRaw = flags.get('per-league');
  const perLeague = perLeagueRaw === undefined ? undefined : Number(perLeagueRaw);
  if (perLeague !== undefined) {
    if (!Number.isInteger(perLeague) || perLeague < 2)
      throw new Error('--per-league must be a whole number of 2 or more');
    if (perLeague > clubs)
      throw new Error(
        `--per-league ${perLeague} exceeds --clubs ${clubs}; a league cannot hold more clubs ` +
          `than the roster has. Raise --clubs (max ${COHORT.length}).`,
      );
  }

  // Below two sides a league generates nothing, and materialiseStage would (correctly)
  // refuse it — catch it here with a message that says what to change. With --per-league
  // the size is explicit and already validated above.
  if (perLeague === undefined) {
    // Every club joins league 1 and fans out across the rest, so the smallest a secondary
    // league can get is clubs/(n-1).
    const smallest = leagueKeys.length > 1 ? Math.floor(clubs / (leagueKeys.length - 1)) : clubs;
    if (smallest < 2)
      throw new Error(
        `${clubs} clubs across ${leagueKeys.length} leagues leaves a league with fewer than 2 ` +
          `sides. Raise --clubs (max ${COHORT.length}), use fewer leagues, or set --per-league.`,
      );
  }

  const admin = flags.get('admin')?.trim().toLowerCase() || undefined;
  const rep = flags.get('rep')?.trim().toLowerCase() || undefined;
  // Memberships are ONE PER TENANT: granting both to one address would silently overwrite
  // the first with the second, the run would report success, and you would discover the
  // missing view only when a screen refused to load. Refuse up front instead.
  if (admin && rep && admin === rep)
    throw new Error(
      `--admin and --rep cannot be the same address (${admin}): memberships are one per ` +
        `tenant, so the second grant would overwrite the first. Use a plus-address for one.`,
    );

  return {
    tenant,
    clubs,
    leagueKeys,
    perLeague,
    season: flags.get('season')?.trim() || '2026/27',
    admin,
    rep,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startYear = Number(args.season.slice(0, 4)) || new Date().getFullYear();

  const calendar = buildCalendar(args.season, startYear);
  const structures = buildStructures(args.season, calendar);
  const leagues = args.leagueKeys.map((key) => buildLeague(key, args.season, structures));
  const clubs = buildClubs(args.clubs, args.leagueKeys, args.perLeague);
  const districts = Array.from(new Set(clubs.map((c) => c.district)));

  // AS WRITTEN, not as built: re-seeding an existing tenant keeps that calendar's block
  // ids, so seeding a season against the built values would reference blocks the stored
  // calendar doesn't have.
  const { calendar: writtenCalendar, structures: writtenStructures } = await mergeConfig(
    args.tenant,
    { calendar, structures, leagues, districts },
  );
  console.log(
    `· config: calendar "${writtenCalendar.label}", ${writtenStructures.length} structures, ` +
      `${leagues.length} leagues (${leagues.map((l) => l.label).join(', ')})`,
  );

  // Reconciling, not putting: a whole-item put would drop these clubs out of any league a
  // PREVIOUS run registered them in, silently emptying that league behind its fixtures.
  // Scoped to the leagues THIS run manages, so re-seeding with a different membership
  // actually shrinks them rather than accumulating.
  const managed = new Set(args.leagueKeys);
  for (const club of clubs) await putClubMerging(args.tenant, club, managed);
  console.log(`· ${clubs.length} clubs`);

  const venues = buildVenues(clubs);
  for (const venue of venues) await repo.putVenue(args.tenant, venue);
  console.log(`· ${venues.length} venues`);

  // The flat round robin is the one that generates unattended: `all-registered` resolves
  // from the club list alone. The other structures are installed for hand-driving.
  const flat = writtenStructures.find((s) => s.templateId === 'flat-round-robin')!;
  let totalSeries = 0;
  let totalFixtures = 0;
  for (const league of leagues) {
    const competition = league.competitions!.find((c) => c.structureId === flat.id)!;
    const entered = clubs.filter((c) => c.leagues.includes(league.key));
    const { run, series } = await seedSeason(args.tenant, {
      clubs,
      league,
      structure: flat,
      competition,
      calendar: writtenCalendar,
      season: args.season,
    });
    const fixtures = series.reduce((n, s) => n + s.fixtures.length, 0);
    totalSeries += series.length;
    totalFixtures += fixtures;
    console.log(
      `· ${league.label}: ${entered.length} clubs · run ${run.id} · ` +
        `${series.length} series, ${fixtures} fixtures — approved + released`,
    );
  }
  console.log(
    `· ${totalSeries} series, ${totalFixtures} fixtures across ${leagues.length} leagues`,
  );

  if (args.admin || args.rep) {
    const cognito = new CognitoIdentityProviderClient({});
    // Offline (LOCAL_AUTH=1) there is no Cognito: every admin call in cognito-users.ts is
    // stubbed and the pool id is never read, so demanding one would block the offline dry
    // run for no reason. Same gate that module uses.
    const pool = process.env.LOCAL_AUTH === '1' ? 'local-pool' : userPoolId();
    if (args.admin) {
      const { sub } = await grantTenantAdmin(cognito, pool, args.tenant, args.admin);
      console.log(`· admin  ${args.admin} (sub ${sub})`);
    }
    if (args.rep) {
      const { sub } = await grantClubRep(
        cognito,
        pool,
        args.tenant,
        args.rep,
        clubs.map((c) => c.id),
      );
      console.log(`· rep    ${args.rep} (sub ${sub}) — scoped to all ${clubs.length} clubs`);
    }
  }

  console.log('\n✓ cohort seeded. Sign in via email OTP.');
  if (args.rep)
    console.log(
      `  The rep lands on /club/${clubs[0].id}; other clubs are reachable at /club/<id> ` +
        `(there is no switcher in the UI).`,
    );
}

// Only run as a CLI — the test imports `keepExistingBlockIds` directly, and an
// unguarded main() would parse the test runner's argv and exit before it got there.
// Same guard as backfill-player-team.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
