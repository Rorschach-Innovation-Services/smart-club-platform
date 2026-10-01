/**
 * MedicoachBundle v1: the contract between the smart-club exporter
 * (`export-medicoach.ts`) and the medicoach bundle importer
 * (`scripts/league-migration/import-bundle.mjs` in the medicoach repo).
 *
 * The exporter writes one JSON document for a tenant, and the importer replays it over
 * medicoach's HTTP APIs. Every object carries a deterministic, tenant-prefixed
 * `externalRef`. Medicoach stores externalRef but does NOT dedupe on it server-side, so
 * the importer's mapping file (externalRef → medicoach id) is the idempotency source of
 * truth. That makes the ref scheme below load-bearing: change it and a re-run duplicates
 * everything.
 *
 *   institution  smartclub:<tenant>:club:<clubId>
 *   team         smartclub:<tenant>:team:<leagueKey>:<teamId>
 *                  leagueKey is part of the ref because a single-side club uses its clubId
 *                  as the teamId in EVERY league, so teamId alone collides across leagues.
 *   staff        smartclub:<tenant>:staff:<sha256(identity) truncated>
 *                  hashed: refs end up in a committed mapping file, so no names/emails.
 *   player       smartclub:<tenant>:player:<naturalKey>
 *                  naturalKey is already a sha256 of the player's identity (player-identity.ts).
 *   league       smartclub:<tenant>:league:<leagueKey>
 *   season       smartclub:<tenant>:season:<leagueKey>:<calendarId>
 *                  leagues without a calendar binding (Plan-B) use `derived-<label>` as the id.
 *   competition  smartclub:<tenant>:competition:<leagueKey>:<stream>
 *   fixture      smartclub:<tenant>:fixture:<seriesId>:<fixtureId>
 *                  or, for later-phase fixtures that exist only in a recipe (semis/finals
 *                  smart club never generated), smartclub:<tenant>:fixture:recipe:<leagueKey>:<stream>:<slotId>
 *
 * CAVEAT (fixture refs vs season-run rebase): a fixture ref embeds the smart-club
 * `seriesId`. A season-run rebase (`POST /season-runs/:id/rebase`) regenerates a stage's
 * series and re-keys its fixtures, so a re-export after a rebase no longer matches the
 * importer's mapping file for those fixtures and would import them a second time. Treat
 * the prod export as one-shot per season, or re-key the mapping file by hand after a rebase.
 *
 * PII: the bundle holds names, emails, cells and dates of birth. Keep it local and
 * in-region (af-south-1), never commit it, and delete it once the import is reconciled.
 */
import { z } from 'zod';

export const BUNDLE_SCHEMA = 'medicoach-bundle';
export const BUNDLE_VERSION = 1;

/* ─────────────────────────── Ref builders ─────────────────────────── */

export const refs = {
  institution: (t: string, clubId: string) => `smartclub:${t}:club:${clubId}`,
  team: (t: string, leagueKey: string, teamId: string) =>
    `smartclub:${t}:team:${leagueKey}:${teamId}`,
  staff: (t: string, identityHash: string) => `smartclub:${t}:staff:${identityHash}`,
  player: (t: string, naturalKey: string) => `smartclub:${t}:player:${naturalKey}`,
  league: (t: string, leagueKey: string) => `smartclub:${t}:league:${leagueKey}`,
  season: (t: string, leagueKey: string, calendarId: string) =>
    `smartclub:${t}:season:${leagueKey}:${calendarId}`,
  competition: (t: string, leagueKey: string, stream: string) =>
    `smartclub:${t}:competition:${leagueKey}:${stream}`,
  fixture: (t: string, seriesId: string, fixtureId: string) =>
    `smartclub:${t}:fixture:${seriesId}:${fixtureId}`,
  recipeFixture: (t: string, leagueKey: string, stream: string, slotId: string) =>
    `smartclub:${t}:fixture:recipe:${leagueKey}:${stream}:${slotId}`,
};

/* ─────────────────────────── Schemas ─────────────────────────── */

const ref = z.string().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
/** Local wall-clock instant with an explicit offset, e.g. 2026-09-26T13:00:00+02:00. */
const isoInstant = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    'expected ISO instant with offset',
  );

export const HostSchema = z.object({
  name: z.string().min(1),
  slugHint: z.string().min(1),
});

export const GroundSchema = z.object({
  venue: z.string().optional(),
  address: z.string().optional(),
  suburb: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

export const InstitutionSchema = z.object({
  externalRef: ref,
  /** The smart-club club id, kept for operator cross-reference. */
  sourceId: z.string().min(1),
  name: z.string().min(1),
  district: z.string().optional(),
  province: z.string().optional(),
  ground: GroundSchema.optional(),
  slugHint: z.string().min(1),
  /** True when the club was referenced by a series but missing from the club list. */
  synthesised: z.boolean().optional(),
});

export const TeamSchema = z.object({
  externalRef: ref,
  institutionRef: ref,
  /** The smart-club team id (a clubId for a single-side club, `tm_…` otherwise). */
  sourceTeamId: z.string().min(1),
  name: z.string().min(1),
  leagueKey: z.string().min(1),
  venue: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

export const StaffAssignmentSchema = z.object({
  institutionRef: ref,
  /** `chair`, `exco:<slot>` (sec/tre/vc/additional, or a vertical's own slot keys), or `coach`. */
  kind: z.string().regex(/^(chair|coach|exco:[A-Za-z0-9_-]+)$/),
  coach: z
    .object({
      level: z.string().optional(),
      body: z.string().optional(),
      teamRefs: z.array(ref),
    })
    .optional(),
});

export const StaffSchema = z.object({
  externalRef: ref,
  name: z.string().min(1),
  email: z.string().optional(),
  cell: z.string().optional(),
  assignments: z.array(StaffAssignmentSchema).min(1),
});

export const PlayerSchema = z.object({
  externalRef: ref,
  /** Primary (main) club. Veterans second-club membership shows up in `teamRefs` only. */
  institutionRef: ref,
  firstName: z.string(),
  lastName: z.string(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  email: z.string().optional(),
  cell: z.string().optional(),
  isMinor: z.boolean(),
  guardianName: z.string().optional(),
  sourceStatus: z.string(),
  battingHand: z.string().optional(),
  bowlingHand: z.string().optional(),
  battingType: z.string().optional(),
  bowlerType: z.string().optional(),
  isAllRounder: z.boolean().optional(),
  isWk: z.boolean().optional(),
  position: z.string().optional(),
  /** Teams across the main club and (for veterans affiliates) the veterans club. */
  teamRefs: z.array(ref),
  veteransInstitutionRef: ref.optional(),
});

export const FormatTypeSchema = z.enum(['league', 'groups_knockout', 'knockout']);

export const ExtraPhaseSchema = z.object({
  type: FormatTypeSchema,
  rounds: z.union([z.literal(1), z.literal(2)]).optional(),
  groupSeeding: z.enum(['carry', 'subdivide']).optional(),
  subGroups: z.number().int().min(2).max(8).optional(),
  thirdPlace: z.boolean().optional(),
});

export const FormatSchema = z.object({
  type: FormatTypeSchema,
  rounds: z.union([z.literal(1), z.literal(2)]),
  extraPhases: z.array(ExtraPhaseSchema),
  teamsPerGroup: z.number().int().min(2).optional(),
  advancePerGroup: z.number().int().min(1).optional(),
  thirdPlace: z.boolean().optional(),
});

export const CricketMatchFormatSchema = z.enum(['T10', 'T20', 'T30', 'T40', 'ODI', 'time']);

export const GroupSchema = z.object({
  /** Stable join key ("Group 1", "Group 2", …): swaps and group-position slots match on it. Never rename. */
  name: z.string().min(1),
  /** The smart-club label it came from ("Top 6", "Group A", …), for humans only. */
  sourceName: z.string().optional(),
  order: z.number().int().min(0),
  teamRefs: z.array(ref),
});

export const SlotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('winner'), ofFixtureRef: ref }),
  z.object({ kind: z.literal('loser'), ofFixtureRef: ref }),
  z.object({
    kind: z.literal('group-position'),
    groupName: z.string().min(1),
    position: z.number().int().min(1),
  }),
]);

export const FixtureSchema = z
  .object({
    externalRef: ref,
    round: z.number().int().min(1),
    /** 1 = the format's main phase (for groups_knockout that includes its knockout); 2+ = an `extraPhases` entry. */
    phase: z.number().int().min(1),
    /** Human stage label: "Group stage", "Semi-final", "Final", or a structure stage name. */
    stage: z.string().min(1),
    /** Group the fixture belongs to (phase-1 group fixtures only). */
    groupName: z.string().optional(),
    scheduledTime: isoInstant,
    /** No start time in smart club: scheduledTime carries 00:00 and must not be shown as a time. */
    timeTbc: z.boolean().optional(),
    /** Recipe-generated later-phase fixture: scheduledTime is the season end date, a placeholder. */
    placeholderDate: z.boolean().optional(),
    venue: z.string().optional(),
    venueLat: z.number().optional(),
    venueLon: z.number().optional(),
    /** Smart club still withholds this series' venue/time from clubs (ADR 0011). */
    venueWithheld: z.boolean().optional(),
    timeWithheld: z.boolean().optional(),
    /** The smart-club fixture status verbatim (null when never set). */
    sourceStatus: z.string().nullable(),
    status: z.literal('scheduled'),
    notes: z.array(z.string()).optional(),
    homeTeamRef: ref.optional(),
    homeSlot: SlotSchema.optional(),
    awayTeamRef: ref.optional(),
    awaySlot: SlotSchema.optional(),
  })
  .superRefine((f, ctx) => {
    for (const side of ['home', 'away'] as const) {
      const hasRef = f[`${side}TeamRef`] !== undefined;
      const hasSlot = f[`${side}Slot`] !== undefined;
      if (hasRef === hasSlot)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fixture ${f.externalRef}: exactly one of ${side}TeamRef / ${side}Slot is required`,
        });
    }
  });

export const CompetitionSchema = z.object({
  externalRef: ref,
  /** Stream key within the league, e.g. `t20`, `50-over`, `main`. */
  stream: z.string().min(1),
  name: z.string().min(1),
  /** Where the format came from: a league setup, the tenant recipe module, or inference from fixtures. */
  formatSource: z.enum(['setup', 'recipe', 'inferred', 'fixtures-only']),
  format: FormatSchema,
  cricketMatchFormat: CricketMatchFormatSchema.optional(),
  maxOvers: z.number().int().positive().optional(),
  groups: z.array(GroupSchema),
  fixtures: z.array(FixtureSchema),
  /** An open question for the union, surfaced in the export summary. */
  confirm: z.string().optional(),
});

export const SeasonSchema = z.object({
  externalRef: ref,
  name: z.string().min(1),
  startDate: isoDate,
  endDate: isoDate,
  /**
   * Where the dates came from: the league's bound calendar, the fixtures' date span, or
   * (a league with neither) the tenant calendar with the latest end, as a stand-in.
   */
  source: z.enum(['calendar', 'fixtures', 'tenant-latest-calendar']),
});

export const SwapSchema = z.object({
  competitionRef: ref,
  groupA: z.string().min(1),
  positionA: z.number().int().min(1),
  groupB: z.string().min(1),
  positionB: z.number().int().min(1),
  carryPoints: z.boolean(),
});

export const PositionRelegationSchema = z.object({
  competitionRef: ref,
  group: z.string().min(1),
  position: z.number().int().min(1),
  targetLeagueRef: ref,
});

export const LeagueSchema = z.object({
  externalRef: ref,
  key: z.string().min(1),
  label: z.string().min(1),
  group: z.string().optional(),
  district: z.string().optional(),
  fixturesOnly: z.boolean().optional(),
  /** Not in the smart-club catalogue; built from series leagueKeys (e.g. veterans-premier). */
  synthesised: z.boolean().optional(),
  season: SeasonSchema,
  /** The league's master team list. */
  teamRefs: z.array(ref),
  competitions: z.array(CompetitionSchema),
  relegation: z.object({
    swaps: z.array(SwapSchema),
    positionRelegations: z.array(PositionRelegationSchema),
    /** Every league a relegation in this league points at. */
    targetLeagueRefs: z.array(ref),
  }),
  confirm: z.string().optional(),
});

export const CountsSchema = z.object({
  institutions: z.number().int().min(0),
  teams: z.number().int().min(0),
  staff: z.number().int().min(0),
  staffAssignments: z.number().int().min(0),
  players: z.number().int().min(0),
  playerTeamMemberships: z.number().int().min(0),
  leagues: z.number().int().min(0),
  seasons: z.number().int().min(0),
  leagueTeams: z.number().int().min(0),
  competitions: z.number().int().min(0),
  groups: z.number().int().min(0),
  groupMemberships: z.number().int().min(0),
  fixtures: z.number().int().min(0),
  placeholderFixtures: z.number().int().min(0),
  swaps: z.number().int().min(0),
  positionRelegations: z.number().int().min(0),
});

const BundleShape = z.object({
  schema: z.literal(BUNDLE_SCHEMA),
  version: z.literal(BUNDLE_VERSION),
  tenant: z.string().min(1),
  generatedAt: z.string().min(1),
  host: HostSchema,
  institutions: z.array(InstitutionSchema),
  teams: z.array(TeamSchema),
  people: z.object({
    staff: z.array(StaffSchema),
    players: z.array(PlayerSchema),
  }),
  leagues: z.array(LeagueSchema),
  meta: z.object({
    /** Open questions for the union (recipe `confirm` notes). No PII. */
    confirmations: z.array(z.string()),
    /** League keys deliberately excluded (seed-*, demo, --leagues filter). */
    excludedLeagues: z.array(z.string()),
  }),
  counts: CountsSchema,
});

export type MedicoachBundle = z.infer<typeof BundleShape>;
export type BundleInstitution = z.infer<typeof InstitutionSchema>;
export type BundleTeam = z.infer<typeof TeamSchema>;
export type BundleStaff = z.infer<typeof StaffSchema>;
export type BundleStaffAssignment = z.infer<typeof StaffAssignmentSchema>;
export type BundlePlayer = z.infer<typeof PlayerSchema>;
export type BundleLeague = z.infer<typeof LeagueSchema>;
export type BundleSeason = z.infer<typeof SeasonSchema>;
export type BundleCompetition = z.infer<typeof CompetitionSchema>;
export type BundleFormat = z.infer<typeof FormatSchema>;
export type BundleExtraPhase = z.infer<typeof ExtraPhaseSchema>;
export type BundleGroup = z.infer<typeof GroupSchema>;
export type BundleFixture = z.infer<typeof FixtureSchema>;
export type BundleSlot = z.infer<typeof SlotSchema>;
export type BundleSwap = z.infer<typeof SwapSchema>;
export type BundlePositionRelegation = z.infer<typeof PositionRelegationSchema>;
export type BundleCounts = z.infer<typeof CountsSchema>;
export type CricketMatchFormat = z.infer<typeof CricketMatchFormatSchema>;

/** Tally every entity type. The exporter writes this; the refinement checks it matches. */
export function computeCounts(b: Omit<MedicoachBundle, 'counts'>): BundleCounts {
  const comps = b.leagues.flatMap((l) => l.competitions);
  const groups = comps.flatMap((c) => c.groups);
  const fixtures = comps.flatMap((c) => c.fixtures);
  return {
    institutions: b.institutions.length,
    teams: b.teams.length,
    staff: b.people.staff.length,
    staffAssignments: b.people.staff.reduce((n, s) => n + s.assignments.length, 0),
    players: b.people.players.length,
    playerTeamMemberships: b.people.players.reduce((n, p) => n + p.teamRefs.length, 0),
    leagues: b.leagues.length,
    seasons: b.leagues.length,
    leagueTeams: b.leagues.reduce((n, l) => n + l.teamRefs.length, 0),
    competitions: comps.length,
    groups: groups.length,
    groupMemberships: groups.reduce((n, g) => n + g.teamRefs.length, 0),
    fixtures: fixtures.length,
    placeholderFixtures: fixtures.filter((f) => f.placeholderDate).length,
    swaps: b.leagues.reduce((n, l) => n + l.relegation.swaps.length, 0),
    positionRelegations: b.leagues.reduce((n, l) => n + l.relegation.positionRelegations.length, 0),
  };
}

/**
 * The bundle schema with its cross-object invariants:
 *   1. every externalRef is unique bundle-wide (across all entity types);
 *   2. every `*Ref` field resolves to an object declared in the bundle, with the right type;
 *   3. slots resolve (winner/loser → a fixture in the same competition; group-position →
 *      a group of that competition), swaps/relegations name real groups;
 *   4. `counts` equals the recomputed tally.
 */
export const MedicoachBundleSchema = BundleShape.superRefine((b, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });

  // 1. Uniqueness.
  const kindOf = new Map<string, string>();
  const declare = (r: string, kind: string) => {
    const prior = kindOf.get(r);
    if (prior) issue(`duplicate externalRef ${r} (${prior} and ${kind})`);
    else kindOf.set(r, kind);
  };
  for (const i of b.institutions) declare(i.externalRef, 'institution');
  for (const t of b.teams) declare(t.externalRef, 'team');
  for (const s of b.people.staff) declare(s.externalRef, 'staff');
  for (const p of b.people.players) declare(p.externalRef, 'player');
  for (const l of b.leagues) {
    declare(l.externalRef, 'league');
    declare(l.season.externalRef, 'season');
    for (const c of l.competitions) {
      declare(c.externalRef, 'competition');
      for (const f of c.fixtures) declare(f.externalRef, 'fixture');
    }
  }

  // 2. Resolution.
  const expect = (r: string, kind: string, where: string) => {
    const got = kindOf.get(r);
    if (got !== kind)
      issue(`${where}: ${r} does not resolve to a ${kind}${got ? ` (is a ${got})` : ''}`);
  };
  const leagueKeys = new Set(b.leagues.map((l) => l.key));
  for (const t of b.teams) {
    expect(t.institutionRef, 'institution', `team ${t.externalRef}`);
    if (!leagueKeys.has(t.leagueKey))
      issue(`team ${t.externalRef}: league ${t.leagueKey} not in bundle`);
  }
  for (const s of b.people.staff)
    for (const a of s.assignments) {
      expect(a.institutionRef, 'institution', `staff ${s.externalRef}`);
      for (const tr of a.coach?.teamRefs ?? []) expect(tr, 'team', `staff ${s.externalRef}`);
    }
  for (const p of b.people.players) {
    expect(p.institutionRef, 'institution', `player ${p.externalRef}`);
    if (p.veteransInstitutionRef)
      expect(p.veteransInstitutionRef, 'institution', `player ${p.externalRef}`);
    for (const tr of p.teamRefs) expect(tr, 'team', `player ${p.externalRef}`);
  }
  for (const l of b.leagues) {
    for (const tr of l.teamRefs) expect(tr, 'team', `league ${l.key}`);
    const leagueTeams = new Set(l.teamRefs);
    const groupsByComp = new Map<string, Set<string>>();
    for (const c of l.competitions) {
      const groupNames = new Set<string>();
      for (const g of c.groups) {
        if (groupNames.has(g.name))
          issue(`competition ${c.externalRef}: duplicate group ${g.name}`);
        groupNames.add(g.name);
        for (const tr of g.teamRefs) {
          expect(tr, 'team', `group ${c.externalRef}/${g.name}`);
          if (!leagueTeams.has(tr))
            issue(`group ${c.externalRef}/${g.name}: ${tr} is not in league ${l.key}'s team list`);
        }
      }
      groupsByComp.set(c.externalRef, groupNames);
      const compFixtures = new Set(c.fixtures.map((f) => f.externalRef));
      for (const f of c.fixtures) {
        for (const side of ['home', 'away'] as const) {
          const tr = f[`${side}TeamRef`];
          if (tr) {
            expect(tr, 'team', `fixture ${f.externalRef}`);
            if (!leagueTeams.has(tr))
              issue(`fixture ${f.externalRef}: ${tr} is not in league ${l.key}'s team list`);
          }
          const slot = f[`${side}Slot`];
          if (slot?.kind === 'winner' || slot?.kind === 'loser') {
            if (!compFixtures.has(slot.ofFixtureRef))
              issue(
                `fixture ${f.externalRef}: slot source ${slot.ofFixtureRef} is not a fixture of ${c.externalRef}`,
              );
          } else if (slot?.kind === 'group-position' && !groupNames.has(slot.groupName)) {
            issue(
              `fixture ${f.externalRef}: slot group "${slot.groupName}" is not a group of ${c.externalRef}`,
            );
          }
        }
        if (f.groupName && !groupNames.has(f.groupName))
          issue(
            `fixture ${f.externalRef}: group "${f.groupName}" is not a group of ${c.externalRef}`,
          );
      }
    }
    const inGroup = (compRef: string, name: string, where: string) => {
      const names = groupsByComp.get(compRef);
      if (!names) issue(`${where}: ${compRef} is not a competition of league ${l.key}`);
      else if (!names.has(name)) issue(`${where}: group "${name}" is not in ${compRef}`);
    };
    for (const s of l.relegation.swaps) {
      inGroup(s.competitionRef, s.groupA, `league ${l.key} swap`);
      inGroup(s.competitionRef, s.groupB, `league ${l.key} swap`);
    }
    for (const r of l.relegation.positionRelegations) {
      inGroup(r.competitionRef, r.group, `league ${l.key} relegation`);
      expect(r.targetLeagueRef, 'league', `league ${l.key} relegation`);
      if (!l.relegation.targetLeagueRefs.includes(r.targetLeagueRef))
        issue(
          `league ${l.key}: relegation target ${r.targetLeagueRef} missing from targetLeagueRefs`,
        );
    }
    for (const t of l.relegation.targetLeagueRefs) expect(t, 'league', `league ${l.key} targets`);
  }

  // 4. Counts.
  const { counts, ...rest } = b;
  const recomputed = computeCounts(rest);
  for (const k of Object.keys(recomputed) as Array<keyof BundleCounts>)
    if (counts[k] !== recomputed[k])
      issue(`counts.${k} is ${counts[k]}, bundle holds ${recomputed[k]}`);
});

/* ─────────────────────────── Results backfill ───────────────────────────
   A separate file supplied by the union (smart club stores no scores). The importer matches
   each entry to a fixture by `fixtureRef`, or by `matchKeys` when the union only knows the
   teams and date, and PATCHes it through medicoach's RecordFixtureResultSchema. The
   cricketResult fields mirror that schema one-to-one. Unmatched entries are importer errors,
   never guesses. */

export const CricketResultSchema = z.object({
  homeWickets: z.number().int().min(0).max(10).optional(),
  awayWickets: z.number().int().min(0).max(10).optional(),
  /** True-over decimals: 48.5 = 48 overs 3 balls. */
  homeOvers: z.number().min(0).optional(),
  awayOvers: z.number().min(0).optional(),
  homeAllOut: z.boolean().optional(),
  awayAllOut: z.boolean().optional(),
  overLimit: z.number().int().positive().optional(),
  noResult: z.boolean().optional(),
  superOverWinner: z.enum(['home', 'away']).optional(),
});

export const MatchKeysSchema = z.object({
  leagueKey: z.string().min(1),
  /** Competition stream, when the league runs more than one (`t20`, `50-over`). */
  stream: z.string().optional(),
  date: isoDate,
  homeTeamName: z.string().min(1),
  awayTeamName: z.string().min(1),
});

export const ResultEntrySchema = z
  .object({
    fixtureRef: ref.optional(),
    matchKeys: MatchKeysSchema.optional(),
    homeScore: z.number().int().min(0),
    awayScore: z.number().int().min(0),
    resultNote: z.string().optional(),
    forfeitedBy: z.enum(['home', 'away']).optional(),
    cricketResult: CricketResultSchema.optional(),
  })
  .refine((e) => (e.fixtureRef === undefined) !== (e.matchKeys === undefined), {
    message: 'each result needs exactly one of fixtureRef or matchKeys',
  });

export const ResultsFileSchema = z.array(ResultEntrySchema);

export type ResultEntry = z.infer<typeof ResultEntrySchema>;
export type ResultsFile = z.infer<typeof ResultsFileSchema>;
