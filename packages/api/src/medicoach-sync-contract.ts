/**
 * Medicoach ↔ smart club fixture sync — wire contract v1 (ADR 0016).
 *
 * The source of truth is the shared CONTRACT.md; this module is its smart-club half, and
 * medicoach mirrors it in `packages/types/src/smartclub-sync.ts`. The JSON examples in
 * `docs/integrations/medicoach-sync-examples/` are copied byte-for-byte into BOTH repos and
 * each repo's test parses every one with its own schema, so drift fails CI on either side.
 *
 * Direction: smart club is always the CALLER (it pulls `GET /integrations/smartclub/changes`
 * and, from Slice 4, pushes `POST /integrations/smartclub/schedule`, and from ADR 0019
 * `POST /integrations/smartclub/players`); medicoach never calls
 * smart club. Requests are HMAC-SHA256 signed with one shared secret (smart club SST secret
 * `MedicoachSyncSecret` == medicoach `SmartClubSyncSecret`).
 *
 * PII: a player ref (`smartclub:<t>:player:<naturalKey>`) is an unsalted hash of the
 * person's ID number. Never log one, never put one on a public route.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const MEDICOACH_SYNC_VERSION = 1;

/**
 * The import/carry endpoints (Match Centre Connection Console, ADR 0020): read-only checks of
 * what medicoach has mapped, signed exactly like sync v1 (see `signRequest`). An addition next
 * to sync v1, versioned on its own.
 */
export const MEDICOACH_IMPORT_VERSION = 1;

/** Reject a request whose timestamp is further than this from the receiver's clock. */
export const MAX_CLOCK_SKEW_MS = 300_000;

export const SYNC_TIMESTAMP_HEADER = 'X-Sync-Timestamp';
export const SYNC_SIGNATURE_HEADER = 'X-Sync-Signature';

export const CHANGES_PATH = '/integrations/smartclub/changes';
export const SCHEDULE_PATH = '/integrations/smartclub/schedule';
/** Live-scoring state of one day's synced fixtures (the admin match monitor). */
export const LIVE_PATH = '/integrations/smartclub/live';
export const PLAYERS_PATH = '/integrations/smartclub/players';
/** `GET ${MATCHES_PATH}/:matchId/scorecard?tournamentId=&tenant=` — see `scorecardPathAndQuery`. */
export const MATCHES_PATH = '/integrations/smartclub/matches';

/** Import/carry v1: which fixture refs medicoach has mapped (POST `{tenant, refs}`). */
export const IMPORT_CHECK_REFS_PATH = '/integrations/smartclub/import/check-refs';
/** Import/carry v1: medicoach's mapped competitions + fixture counts (`GET ?tenant=`). */
export const IMPORT_CONNECTION_SUMMARY_PATH = '/integrations/smartclub/import/connection-summary';
/** Max refs per check-refs request. */
export const CHECK_REFS_MAX = 500;

/** Page size bounds for the changes endpoint. */
export const CHANGES_LIMIT_DEFAULT = 200;
export const CHANGES_LIMIT_MAX = 500;
/** Max schedule changes per push request. */
export const SCHEDULE_PUSH_MAX = 100;
/** Max players per player push request (contract §4). */
export const PLAYER_PUSH_MAX = 50;

/* ─────────────────────────── Schemas ─────────────────────────── */

/** ISO-8601 UTC instant, e.g. 2026-10-04T14:32:10.123Z. */
const isoUtc = z.string().datetime();

/**
 * An instant in ONE canonical spelling (`YYYY-MM-DDTHH:mm:ss.sssZ`). The contract accepts any
 * precision (`…58Z`, `…58.5Z`), and smart club orders by plain string comparison in
 * DynamoDB conditions (`orderAt < :o`, `changedAt < :c`), where `…58Z` sorts AFTER `…58.5Z`.
 * Every stored or compared sync timestamp goes through this first.
 */
export function isoInstant(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
/** ISO-8601 instant with an explicit offset, e.g. 2026-10-04T09:00:00+02:00. */
const isoWithOffset = z.string().datetime({ offset: true });
const ref = z.string().min(1);

/**
 * `venue: string | null — at most 200 characters; senders must not exceed it and receivers
 * truncate anything longer.` (contract v1 clarification, identical in both repos.)
 */
export const VENUE_MAX_LENGTH = 200;

/**
 * A venue cut to `VENUE_MAX_LENGTH` UTF-16 units — what a sender sends and what a receiver
 * keeps. A cut that would leave half of a surrogate pair (an emoji) drops that half too, so
 * the result is always valid text and never longer than the cap.
 */
export function capVenue<T extends string | null | undefined>(venue: T): T {
  if (typeof venue !== 'string' || venue.length <= VENUE_MAX_LENGTH) return venue;
  let cut = venue.slice(0, VENUE_MAX_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut as T;
}

export const SyncScheduleSchema = z.object({
  scheduledTime: isoWithOffset.nullable(),
  timeTbc: z.boolean(),
  dateTbc: z.boolean(),
  /** At most VENUE_MAX_LENGTH characters: a longer one is accepted and truncated. */
  venue: z.string().nullable().transform(capVenue),
  postponed: z.boolean(),
  cancelled: z.boolean(),
  /** Last schedule write in medicoach (pull) / in smart club (push), any origin. */
  changedAt: isoUtc,
});

export const SyncTeamsSchema = z.object({
  homeRef: ref.nullable(),
  awayRef: ref.nullable(),
});

/**
 * A link a page may render as `href`: http(s) only. Anything else (`javascript:`, `data:`,
 * `vbscript:` — all valid URLs to zod) would run script in the console when clicked.
 */
export function httpUrlOrNull(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Time on the ground and balls bowled for a played match (contract v1, additive, optional).
 * From medicoach's ball-by-ball: first and last delivery timestamps (scorer device clock) and
 * the legal balls / all deliveries recorded. Smart club uses it as a ground-usage and pitch-load
 * proxy. A malformed block is dropped to null rather than failing the page: a bad ground
 * figure must never hold up results.
 */
export const SyncPlaySchema = z
  .object({
    startedAt: isoUtc.nullable(),
    endedAt: isoUtc.nullable(),
    legalBalls: z.number().int().min(0).max(2000).nullable(),
    deliveries: z.number().int().min(0).max(3000).nullable(),
  })
  .refine((p) => !p.startedAt || !p.endedAt || Date.parse(p.endedAt) >= Date.parse(p.startedAt), {
    message: 'endedAt is before startedAt',
  })
  .refine((p) => p.legalBalls === null || p.deliveries === null || p.deliveries >= p.legalBalls, {
    message: 'fewer deliveries than legal balls',
  });

export const SyncResultSchema = z.object({
  homeScore: z.string().nullable(),
  awayScore: z.string().nullable(),
  summary: z.string().nullable(),
  winner: z.enum(['home', 'away', 'tie', 'none']).nullable(),
  method: z
    .enum(['normal', 'run-rate', 'dls', 'no-result', 'abandoned', 'tie', 'forfeit'])
    .nullable(),
  noResult: z.boolean(),
  /** `import` = migration/backfill/service principal → never opens captain's reports. */
  source: z.enum(['live', 'manual', 'import']),
  recordedAt: isoUtc,
  scoringSide: z.enum(['home', 'away']).nullable(),
  /** PERSONAL DATA (hashed ID number) — never log. */
  captainRef: ref.nullable(),
  /** A non-http(s) link is dropped to null rather than failing the page. */
  medicoachMatchUrl: z.string().url().nullable().transform(httpUrlOrNull),
  /** Optional (a medicoach without it still parses); malformed ⇒ null, never a failed page. */
  play: SyncPlaySchema.nullable().optional().catch(null),
  /**
   * The medicoach match (PostMatchAnalysis) id behind this result and its tournament id —
   * together the key for `GET /integrations/smartclub/matches/:matchId/scorecard?tournamentId=`.
   * Optional: older senders omit them; a scorecard is fetched only when both are present.
   * Both match the documented `[A-Za-z0-9_-]{1,128}` id shape — a malformed id fails here.
   * An empty string is tolerated as another spelling of "absent" (the puller drops it).
   */
  medicoachMatchId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{0,128}$/)
    .optional(),
  medicoachTournamentId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{0,128}$/)
    .optional(),
});

export const FixtureChangeSchema = z.object({
  ref,
  syncStamp: isoUtc,
  schedule: SyncScheduleSchema,
  teams: SyncTeamsSchema,
  result: SyncResultSchema.nullable(),
  resultClearedAt: isoUtc.nullable(),
});

export const ChangesResponseSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  tenant: z.string().min(1),
  nextCursor: z.string(),
  hasMore: z.boolean(),
  fixtures: z.array(FixtureChangeSchema),
});

/* ── Scorecard (GET /integrations/smartclub/matches/:matchId/scorecard) ── */

export const ScorecardExtrasWireSchema = z.object({
  byes: z.number(),
  legByes: z.number(),
  wides: z.number(),
  noBalls: z.number(),
  penalties: z.number(),
  total: z.number(),
});

export const ScorecardBatterWireSchema = z.object({
  order: z.number(),
  name: z.string(),
  runs: z.number(),
  ballsFaced: z.number(),
  fours: z.number(),
  sixes: z.number(),
  strikeRate: z.number(),
  howOut: z.string(),
  dismissal: z.string().optional(),
});

export const ScorecardBowlerWireSchema = z.object({
  order: z.number(),
  name: z.string(),
  overs: z.string(),
  maidens: z.number(),
  runsConceded: z.number(),
  wickets: z.number(),
  economy: z.number(),
  wides: z.number(),
  noBalls: z.number(),
});

export const ScorecardFallOfWicketWireSchema = z.object({
  wicket: z.number(),
  runs: z.number(),
  overs: z.string(),
  batterName: z.string(),
});

/** One innings of a medicoach scorecard, as sent on the wire. */
export const InningsScorecardWireSchema = z.object({
  battingTeamName: z.string(),
  totalRuns: z.number(),
  wickets: z.number(),
  overs: z.string(),
  extras: ScorecardExtrasWireSchema,
  batters: z.array(ScorecardBatterWireSchema),
  bowlers: z.array(ScorecardBowlerWireSchema),
  fallOfWickets: z.array(ScorecardFallOfWicketWireSchema),
});

/**
 * `available: false` = medicoach has no ball-by-ball scorecard for the match (e.g. a
 * manually entered result); `innings` is present when it is available.
 */
export const ScorecardResponseSchema = z.object({
  available: z.boolean(),
  matchId: z.string().min(1),
  matchState: z.string().optional(),
  innings: z.array(InningsScorecardWireSchema).optional(),
});

/** A knockout side that waits on another fixture (create ops, 2026-10-18 additive). */
export const SyncSlotSchema = z.object({
  kind: z.enum(['winner', 'loser']),
  /** The feeder fixture's ref. */
  ofFixtureRef: ref,
});
export type SyncSlot = z.infer<typeof SyncSlotSchema>;

/**
 * What medicoach needs to create a fixture smart club added (`op: "create"`). A side is a team
 * ref OR a slot, never both. `phase` is derived by medicoach.
 */
export const SyncFixtureCreateSchema = z
  .object({
    competitionRef: ref,
    sport: z.string().min(1),
    homeTeamRef: ref.optional(),
    awayTeamRef: ref.optional(),
    homeSlot: SyncSlotSchema.optional(),
    awaySlot: SyncSlotSchema.optional(),
    stage: z.string().min(1),
    stageLabel: z.string().optional(),
    groupName: z.string().optional(),
    round: z.number().int().optional(),
    venueLat: z.number().optional(),
    venueLon: z.number().optional(),
  })
  .superRefine((c, ctx) => {
    for (const side of ['home', 'away'] as const) {
      const team = c[`${side}TeamRef`] !== undefined;
      const slot = c[`${side}Slot`] !== undefined;
      if (team === slot)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${side}: exactly one of ${side}TeamRef / ${side}Slot`,
          path: [`${side}TeamRef`],
        });
    }
  });
export type SyncFixtureCreate = z.infer<typeof SyncFixtureCreateSchema>;

export const SchedulePushOpSchema = z.enum(['upsert', 'create', 'delete']);

export const SchedulePushChangeSchema = z
  .object({
    ref,
    /** Absent = "upsert" (back-compat). */
    op: SchedulePushOpSchema.optional(),
    /** Required for every op; a "delete" reads only `changedAt`. */
    schedule: SyncScheduleSchema,
    /** Present exactly when `op === "create"`. */
    create: SyncFixtureCreateSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.op === 'create') !== (c.create !== undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`create` is present exactly when op is "create"',
        path: ['create'],
      });
  });

export const SchedulePushRequestSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  tenant: z.string().min(1),
  changes: z.array(SchedulePushChangeSchema).max(SCHEDULE_PUSH_MAX),
});

export const SCHEDULE_PUSH_STATUSES = [
  'applied',
  'stale',
  'unchanged',
  'unmapped',
  'created',
  'deleted',
  'error',
] as const;

export const SchedulePushResponseSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  results: z.array(
    z.object({
      ref,
      status: z.enum(SCHEDULE_PUSH_STATUSES),
      message: z.string().optional(),
    }),
  ),
});

/* ── 7. GET /integrations/smartclub/live?tenant=<t>&date=YYYY-MM-DD (read-only) ── */

/** Cricket overs as scorers write them: completed overs, then balls of the current one. */
const oversText = z.string().regex(/^\d{1,3}(\.[0-5])?$/);

export const LiveInningsSchema = z.object({
  number: z.number().int().min(1).max(4),
  battingSide: z.enum(['home', 'away']).nullable(),
  runs: z.number().int().min(0),
  wickets: z.number().int().min(0).max(10),
  overs: oversText,
  /** First ball of the innings. */
  startedAt: isoUtc.nullable(),
  /** Set once the innings is closed (all out, overs done, declared, target reached). */
  endedAt: isoUtc.nullable(),
});

/** A gap between two consecutive balls of ONE innings (a break between innings is never one). */
export const LiveGapSchema = z.object({
  innings: z.number().int().min(1).max(4),
  /** The ball that ended the gap, e.g. "14.2". */
  over: oversText,
  /** When that ball was scored. */
  at: isoUtc,
  gapSec: z.number().int().min(0),
  /** A break the scorer recorded inside the gap (drinks / interruption marker); null = none. */
  reason: z.enum(['drinks', 'interruption']).nullable(),
});

/**
 * A player in a live match: everyone on either side's team sheet, plus anyone the scorer added
 * with "add player" during the match. PERSONAL DATA (name, and a ref that is a hashed ID
 * number) — never log, never store; smart club resolves it to a registration status and sends
 * the admin page the status, never the ref.
 */
export const LivePlayerSchema = z.object({
  side: z.enum(['home', 'away']),
  name: z.string().min(1).max(120),
  /** `smartclub:<t>:player:<naturalKey>` when the player came from smart club; else null. */
  ref: ref.nullable(),
  /** Added by the scorer with "add player" after scoring began (not on the team sheet). */
  addedDuringMatch: z.boolean(),
  addedAt: isoUtc.nullable(),
});
export const LIVE_PLAYERS_MAX = 60;

/** Gaps of at least this long are listed in `longGaps`; shorter ones only feed the median. */
export const LIVE_GAP_FLOOR_SEC = 120;
/** At most this many `longGaps` per match (the longest are kept). */
export const LIVE_GAPS_MAX = 50;

export const LiveMatchSchema = z.object({
  /** The fixture ref the live match is linked to. */
  ref,
  status: z.enum(['not_started', 'in_progress', 'innings_break', 'completed', 'abandoned']),
  /** First ball of the match. */
  startedAt: isoUtc.nullable(),
  /** When the match was completed or abandoned. */
  endedAt: isoUtc.nullable(),
  /** The scorer's recorded abandonment reason; only when status is "abandoned" (additive, 2026-10-16). */
  abandonReason: z.string().max(200).nullable().optional(),
  /** The latest scoring write of any kind (ball, undo, correction). */
  lastInputAt: isoUtc.nullable(),
  oversPerSide: z.number().int().positive().nullable(),
  /**
   * The latest overs change's recorded reason (additive, 2026-10-16): "rain" | "agreed" |
   * "correction". Any string is accepted; consumers treat an unknown future value like null.
   */
  oversChangeReason: z.string().nullable().optional(),
  innings: z.array(LiveInningsSchema).max(4),
  /** Balls scored so far (legal and extras). */
  deliveries: z.number().int().min(0),
  /** Median gap between consecutive balls of an innings, seconds. */
  medianGapSec: z.number().min(0).nullable(),
  longGaps: z.array(LiveGapSchema).max(LIVE_GAPS_MAX),
  /** Times the scorer undid a ball (null: this scoring app doesn't report it). */
  undoCount: z.number().int().min(0).nullable(),
  /**
   * true: undoCount was stamped exactly by the scoring client; false: a server-side approximation
   * (smart club shows "~N"); null exactly when undoCount is null. Absent is read as null.
   */
  undoCountExact: z.boolean().nullable().default(null),
  /** Each side's players, team sheet first, then any added during the match. */
  players: z.array(LivePlayerSchema).max(LIVE_PLAYERS_MAX),
  medicoachMatchUrl: z.string().url().nullable().transform(httpUrlOrNull),
});

export const LiveResponseSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  tenant: z.string().min(1),
  /** The SAST day asked for. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: isoUtc,
  /** Every live match on that day linked to one of this tenant's fixture refs. */
  matches: z.array(LiveMatchSchema),
});

/* ─────────────── Import/carry v1 (POST /integrations/smartclub/import/check-refs) ─────────────── */

export const CheckRefsRequestSchema = z.object({
  tenant: z.string().min(1),
  refs: z.array(ref).max(CHECK_REFS_MAX),
});

/** Every requested ref lands in exactly one of the two lists. */
export const CheckRefsResponseSchema = z.object({
  mapped: z.array(ref),
  unmapped: z.array(ref),
});

/* ─────────────── Player push (contract §4, POST /integrations/smartclub/players) ─────────────── */

/** `YYYY-MM-DD` — the same shape the migration bundle's PlayerSchema uses for `dob`. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * The admin's answer to an earlier `needs-review`, riding on the re-push: bind the ref to an
 * existing medicoach player, or create a new one having seen these candidates.
 */
export const PlayerResolutionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), playerId: z.string().min(1) }),
  z.object({ action: z.literal('create'), acknowledgedCandidates: z.array(z.string()) }),
]);

/** Fields only an `upsert` carries; a `remove`/`erase` omits all of them. */
const PLAYER_DETAIL_FIELDS = [
  'institutionRef',
  'firstName',
  'lastName',
  'dob',
  'gender',
  'email',
  'cell',
  'isMinor',
  'guardianName',
  'teamRefs',
  'fanOutTeamRefs',
  'veteransInstitutionRef',
  'resolution',
] as const;

/**
 * One player's FULL desired state. PERSONAL DATA (name, dob, contact, guardian) — never log a
 * payload; the ref is a hashed ID number, also never logged. No raw ID number is ever sent
 * (same rule as the bundle's PlayerSchema).
 */
export const PlayerPushEntrySchema = z
  .object({
    ref,
    op: z.enum(['upsert', 'remove', 'erase']),
    changedAt: isoUtc,
    institutionRef: ref.optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dob: isoDate.optional(),
    gender: z.string().optional(),
    email: z.string().optional(),
    cell: z.string().optional(),
    isMinor: z.boolean().optional(),
    guardianName: z.string().optional(),
    teamRefs: z.array(ref).optional(),
    /**
     * Additive (fan-out placement): sides the player is placed on ADD-ONLY — disjoint from
     * `teamRefs`, never removed by an upsert, removed only by `remove`/`erase` (contract §4).
     * Upsert only; absent from a tenant without fan-out.
     */
    fanOutTeamRefs: z.array(ref).optional(),
    veteransInstitutionRef: ref.optional(),
    resolution: PlayerResolutionSchema.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.op === 'upsert') {
      for (const f of ['institutionRef', 'firstName', 'lastName', 'teamRefs'] as const)
        if (p[f] === undefined)
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: `upsert needs ${f}` });
      return;
    }
    for (const f of PLAYER_DETAIL_FIELDS)
      if (p[f] !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [f],
          message: `${p.op} carries no ${f}`,
        });
  });

export const PlayerPushRequestSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  tenant: z.string().min(1),
  dryRun: z.boolean().optional(),
  players: z.array(PlayerPushEntrySchema).max(PLAYER_PUSH_MAX),
});

export const PLAYER_PUSH_STATUSES = [
  'created',
  'linked',
  'updated',
  'unchanged',
  'removed',
  'erased',
  'stale',
  'needs-review',
  'unmapped-team',
  'error',
] as const;

/** A medicoach player the admin must choose between (needs-review only). PERSONAL DATA. */
export const PlayerCandidateSchema = z.object({
  playerId: z.string().min(1),
  name: z.string(),
  dob: z.string().nullable(),
  institutionName: z.string().nullable(),
});

export const PlayerPushResponseSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  results: z.array(
    z.object({
      ref,
      status: z.enum(PLAYER_PUSH_STATUSES),
      message: z.string().optional(),
      candidates: z.array(PlayerCandidateSchema).optional(),
      missingTeamRefs: z.array(ref).optional(),
      /** Additive (2026-10-09): team refs whose removal medicoach HELD (contract §4). */
      heldRemovals: z.array(ref).optional(),
      fieldDiffs: z
        .array(
          z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
        )
        .optional(),
    }),
  ),
});

export type SyncSchedule = z.infer<typeof SyncScheduleSchema>;
export type SyncTeams = z.infer<typeof SyncTeamsSchema>;
export type SyncResult = z.infer<typeof SyncResultSchema>;
export type SyncPlay = z.infer<typeof SyncPlaySchema>;
export type FixtureChange = z.infer<typeof FixtureChangeSchema>;
export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;
export type InningsScorecardWire = z.infer<typeof InningsScorecardWireSchema>;
export type ScorecardResponse = z.infer<typeof ScorecardResponseSchema>;
export type SchedulePushRequest = z.infer<typeof SchedulePushRequestSchema>;
export type SchedulePushResponse = z.infer<typeof SchedulePushResponseSchema>;
export type LiveMatch = z.infer<typeof LiveMatchSchema>;
export type LivePlayer = z.infer<typeof LivePlayerSchema>;
export type LiveResponse = z.infer<typeof LiveResponseSchema>;
export type PlayerResolution = z.infer<typeof PlayerResolutionSchema>;
export type PlayerPushEntry = z.infer<typeof PlayerPushEntrySchema>;
export type PlayerPushRequest = z.infer<typeof PlayerPushRequestSchema>;
export type PlayerPushResponse = z.infer<typeof PlayerPushResponseSchema>;
export type PlayerPushStatus = (typeof PLAYER_PUSH_STATUSES)[number];
export type PlayerCandidate = z.infer<typeof PlayerCandidateSchema>;

/* ─────────────────────────── Request paths ─────────────────────────── */

/**
 * The exact path + query the puller sends (and signs). `since` omitted ⇒ a full resync.
 * Built once and used for both the URL and the signature, so the two can never differ.
 */
export function changesPathAndQuery(tenant: string, since?: string, limit?: number): string {
  const q = new URLSearchParams({ tenant });
  if (since && since !== '0') q.set('since', since);
  if (limit !== undefined) q.set('limit', String(limit));
  return `${CHANGES_PATH}?${q.toString()}`;
}

/** The exact path + query of a live request (signed as sent). */
export function livePathAndQuery(tenant: string, date: string): string {
  return `${LIVE_PATH}?${new URLSearchParams({ tenant, date }).toString()}`;
}

/**
 * The exact path + query the scorecard fetch sends (and signs) for one medicoach match.
 * `tournamentId` and `tenant` are both required (medicoach resolves a match within its
 * tournament, among that tenant's synced fixtures only). Param order is fixed — tournamentId
 * then tenant — so the signed string is deterministic.
 */
export function scorecardPathAndQuery(
  matchId: string,
  tournamentId: string,
  tenant: string,
): string {
  const q = new URLSearchParams([
    ['tournamentId', tournamentId],
    ['tenant', tenant],
  ]);
  return `${MATCHES_PATH}/${encodeURIComponent(matchId)}/scorecard?${q.toString()}`;
}

/* ─────────────────────────── Signing ─────────────────────────── */

/** The exact string both sides HMAC: `${timestamp}.${METHOD}.${pathAndQuery}.${rawBody}`. */
export function signingString(
  timestamp: string,
  method: string,
  pathAndQuery: string,
  rawBody: string,
): string {
  return `${timestamp}.${method.toUpperCase()}.${pathAndQuery}.${rawBody}`;
}

/** `sha256=<lowercase hex HMAC-SHA256(secret, signingString)>`. */
export function computeSignature(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;
}

export interface SignInput {
  secret: string;
  method: string;
  /** Request path + `?` + query exactly as sent, no host. */
  pathAndQuery: string;
  /** Raw request body; empty string for a GET. */
  body?: string;
  /** Epoch ms; defaults to now. */
  timestamp?: number;
}

/** The two auth headers for a request. */
export function signRequest(input: SignInput): Record<string, string> {
  const timestamp = String(input.timestamp ?? Date.now());
  return {
    [SYNC_TIMESTAMP_HEADER]: timestamp,
    [SYNC_SIGNATURE_HEADER]: computeSignature(
      input.secret,
      signingString(timestamp, input.method, input.pathAndQuery, input.body ?? ''),
    ),
  };
}

export interface VerifyInput {
  secret: string;
  method: string;
  pathAndQuery: string;
  body?: string;
  timestampHeader: string | null | undefined;
  signatureHeader: string | null | undefined;
  /** Epoch ms; defaults to now. */
  now?: number;
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: 'malformed' | 'skew' | 'mismatch' };

/**
 * Check a signed request: timestamp within ±5 min, signature equal in constant time.
 * Every failure is a 401 to the caller; `reason` is for the receiver's own log only.
 */
export function verifySignature(input: VerifyInput): VerifyOutcome {
  const ts = input.timestampHeader ?? '';
  const sig = input.signatureHeader ?? '';
  if (!/^\d+$/.test(ts) || !/^sha256=[0-9a-f]{64}$/.test(sig) || !input.secret)
    return { ok: false, reason: 'malformed' };
  if (Math.abs((input.now ?? Date.now()) - Number(ts)) > MAX_CLOCK_SKEW_MS)
    return { ok: false, reason: 'skew' };
  const expected = computeSignature(
    input.secret,
    signingString(ts, input.method, input.pathAndQuery, input.body ?? ''),
  );
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

/* ─────────────────────────── Refs ─────────────────────────── */

export type ParsedFixtureRef =
  | { tenant: string; kind: 'series'; seriesId: string; fixtureId: string }
  | { tenant: string; kind: 'recipe'; leagueKey: string; stream: string; slotId: string };

/**
 * `smartclub:<t>:fixture:<seriesId>:<fixtureId>` or the recipe form
 * `smartclub:<t>:fixture:recipe:<leagueKey>:<stream>:<slotId>`; null for anything else.
 */
export function parseFixtureRef(value: string): ParsedFixtureRef | null {
  const parts = String(value).split(':');
  if (parts[0] !== 'smartclub' || parts[2] !== 'fixture' || !parts[1]) return null;
  if (parts[3] === 'recipe' && parts.length === 7 && parts.slice(4).every(Boolean))
    return {
      tenant: parts[1],
      kind: 'recipe',
      leagueKey: parts[4],
      stream: parts[5],
      slotId: parts[6],
    };
  if (parts.length === 5 && parts[3] && parts[4])
    return { tenant: parts[1], kind: 'series', seriesId: parts[3], fixtureId: parts[4] };
  return null;
}

/** `smartclub:<t>:team:<leagueKey>:<teamId>` → its parts; null for anything else. */
export function parseTeamRef(
  value: string,
): { tenant: string; leagueKey: string; teamId: string } | null {
  const parts = String(value).split(':');
  if (parts.length !== 5 || parts[0] !== 'smartclub' || parts[2] !== 'team') return null;
  if (!parts[1] || !parts[3] || !parts[4]) return null;
  return { tenant: parts[1], leagueKey: parts[3], teamId: parts[4] };
}
