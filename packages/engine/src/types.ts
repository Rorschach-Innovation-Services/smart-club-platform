/**
 * Competition + season domain types — the canonical definitions.
 *
 * Owned by the engine because the engine is the one place both the web app and the API
 * compute over them. packages/api/src/types.ts and src/types.ts re-export these names;
 * add or change a competition/season shape HERE, never in either of those files.
 */

/**
 * An admin-defined competition a club can register for during affiliation. Lives
 * inside TenantConfig (low-cardinality, admin-managed setup data — not cohort data).
 * `key` is the stable, immutable matching token stored in `Club.leagues`.
 */
export interface League {
  key: string;
  label: string;
  group: string;
  /** A DISTRICTS value, or the 'All districts' sentinel for overarching leagues. */
  district: string;
  note?: string;
  /**
   * Format streams this league runs (ADR 0008) — e.g. T20 Pink Ball and 50 Over Red Ball
   * side by side over the same registered clubs. Absent ⇒ the league behaves exactly as
   * before: one flat create-series flow, no structure.
   */
  competitions?: Competition[];
}

/* ─── SEASON CALENDAR (ADR 0008) ───
   The union's real playing calendar: blocks of play either side of a mid-season break.
   Operator-managed setup data on TenantConfig, beside the league catalogue.

   Dates here are LOCAL WALL-CLOCK date-only strings and are never converted to UTC
   instants. A fixture happens on a date, in one place, in a region with no DST. The
   engine (packages/engine/src/calendar.ts) parses them strictly with dayjs.utc so
   whole-day arithmetic can never drift by the host's offset. */

/** A date-only string, `YYYY-MM-DD`. */
export type IsoDate = string;

/** A wall-clock time, `HH:MM` (24h). */
export type IsoTime = string;

/** 0 = Sunday … 6 = Saturday, matching `dayjs().day()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A continuous stretch of the season in which matches are played. Bounds inclusive. */
export interface SeasonBlock {
  id: string;
  label: string;
  start: IsoDate;
  end: IsoDate;
}

/** A stretch where no match may be scheduled. Bounds inclusive. */
export interface SeasonBreak {
  label: string;
  start: IsoDate;
  end: IsoDate;
}

export interface SeasonCalendar {
  id: string;
  /** e.g. "2026/27". */
  label: string;
  /** IANA zone, display-only. Absent ⇒ the platform default. */
  timezone?: string;
  blocks: SeasonBlock[];
  breaks?: SeasonBreak[];
  /** One-off blocked days — public holidays, exam windows, union events. */
  excludeDates?: IsoDate[];
}

/**
 * How often a round is played. `spread` reproduces the pre-calendar behaviour (rounds
 * distributed evenly across the window), so a series created before calendars existed
 * keeps its schedule shape when regenerated.
 */
export type Cadence =
  | { kind: 'weekly' }
  | { kind: 'every-n-weeks'; n: number }
  | { kind: 'weekdays'; days: Weekday[] }
  | { kind: 'spread' };

/** A named start time, e.g. `{ label: 'Morning', start: '08:00' }`. */
export interface TimeSlot {
  label: string;
  start: IsoTime;
}

/**
 * The calendar binding persisted on a Series so `regenerate` reproduces exactly the
 * schedule the admin confirmed at create time — the same parity guarantee `dateMode`
 * gives the legacy path. Absent ⇒ a legacy series scheduled from `startDate`/`endDate`.
 */
export interface SeriesSchedule {
  calendarId: string;
  blockId: string;
  cadence: Cadence;
  slots?: TimeSlot[];
  /** each planned day hosts roundsPerDay consecutive rounds; round r starts wholly at
   * slot r % slots.length; DatePlan.dates carries repeated consecutive dates. */
  roundsPerDay?: 1 | 2;
}

/* ─── COMPETITION STRUCTURE (ADR 0008) ───
   A league is not one round robin. A competition is an ordered pipeline of STAGES, each
   with a format (how fixtures are made), entrants (where its teams come from) and a
   schedule (when it plays). Everything the KZNCU/EMCU documents describe composes from
   the closed sets below — deliberately closed, because a configuration language general
   enough to need conditionals is the inner-platform effect. */

/** How fixtures are made within one group. */
export type FormatSpec =
  | {
      kind: 'round-robin';
      /** 1 = single round, 2 = home and away, 3 = a season-and-a-half. */
      legs: 1 | 2 | 3;
      /** `mirrored` plays a whole leg then reverses it; `interleaved` alternates. */
      legOrder?: 'mirrored' | 'interleaved';
    }
  | {
      kind: 'knockout';
      /** Preliminary rounds trimming the field to a power of two. Derived if absent. */
      preliminaries?: number;
      /**
       * `seeded` = standard bracket from the entrant order (1 v n, 2 v n-1 …).
       * `cross-pool` = pool winners/runners-up paired across pools (A1 v B2, B1 v A2).
       * `within-pool` = each pool's qualifiers meet each other first (A1 v A2, B1 v B2),
       *   pool winners meet in the next round. v1: exactly 2 pools × 2 qualifiers.
       */
      pairing: 'seeded' | 'cross-pool' | 'within-pool';
      thirdPlace?: boolean;
    }
  | { kind: 'single-match' }
  | { kind: 'manual' };

/**
 * The rule a standings-dependent stage follows, recorded for prefill, display and audit.
 *
 * The platform has no results or ladder model, so these rules cannot be EXECUTED — the
 * stage's entrants are `manual` and an admin confirms them. Storing the rule keeps the
 * operator's intent legible ("Top Six 6th ↔ Bottom Six 1st, points carried") and means
 * that when results capture lands, each rule promotes to a real resolver with no change
 * to stored structures. See ADR 0008.
 */
export interface DerivationNote {
  rule: 'from-standings' | 'swap' | 'winners-of' | 'carry-forward';
  /** The `StageSpec.id` this stage draws from. */
  fromStage: string;
  /** Human sentence shown to the admin confirming entrants. */
  detail: string;
  /**
   * The KZNCU mid-season swap moves points BY POSITION, not with the team: the relegated
   * side takes on the incoming side's points and vice versa. No researched platform does
   * this, so it is an admin-entered handover value, never computed.
   */
  carryPoints?: boolean;
  /**
   * "Top q per group" of `fromStage`. Counted so the preview is exact and the confirm
   * form can pre-fill — qualification itself is still admin-confirmed (no results model).
   */
  qualifiersPerGroup?: number;
}

/** How a stage's entrants divide into groups. */
export type GroupPlan =
  /** Explicit sizes — the only way to express 19 teams as 5+5+5+4. */
  | { kind: 'sizes'; sizes: number[] }
  /** Split evenly into `count` groups; a remainder lands in the earlier groups. */
  | { kind: 'even'; count: number };

/** Where a stage's teams come from. Three real resolvers — see DerivationNote for why. */
export type EntrantSpec =
  /** Every side registered for the league. Today's create-series behaviour. */
  | { kind: 'all-registered' }
  /** An admin picks. The normal path for a new client with no prior-season log. */
  | { kind: 'manual'; groups?: GroupPlan; derivedFrom?: DerivationNote }
  /** Distribute a seed order across groups. */
  | { kind: 'seeded-split'; groups: GroupPlan; method: 'blocks' | 'snake' };

/** Points and tie-break configuration, lifted off the create-series form onto the stage. */
export interface LadderSpec {
  winPoints: number;
  bonusPoints: number;
  lossPoints: number;
  tiePoints: number;
  abandonedPoints: number;
  /** Tie-break sequence, most significant first. */
  order: string[];
}

/**
 * When a stage plays. Names a POSITION into whichever calendar the competition binds,
 * not a calendar or block directly — a structure carries no calendar identity of its own,
 * so the same structure can be reused against different calendars. The Competition's
 * binding supplies the actual blocks at generation time.
 */
export interface StageSchedule {
  /** 0-based index into the bound calendar's `blocks` array. */
  blockIndex: number;
  cadence: Cadence;
  slots?: TimeSlot[];
  /** each planned day hosts roundsPerDay consecutive rounds; round r starts wholly at
   * slot r % slots.length; DatePlan.dates carries repeated consecutive dates. */
  roundsPerDay?: 1 | 2;
  /** Generate now, surface to clubs from this date (junior leagues). */
  activateFrom?: IsoDate;
  /**
   * Chain after the nearest earlier stage in the same block instead of starting at the
   * block's start. Absent ⇒ block start (the pre-existing behaviour).
   */
  startAfter?: 'previous-stage';
}

/** What finishing where in this stage means — display and next-season carry. */
export interface OutcomeSpec {
  /** Positions crowned champion, e.g. [1]. */
  champion?: number[];
  /** Positions promoted out of this group. */
  promoted?: number[];
  /** Positions relegated out of this group. */
  relegated?: number[];
}

export interface StageSpec {
  /** Stable within the structure — later stages reference it via DerivationNote. */
  id: string;
  name: string;
  format: FormatSpec;
  entrants: EntrantSpec;
  schedule: StageSchedule;
  /** Group display names, e.g. ["Top Six", "Bottom Six"]. Falls back to "Group A/B/…". */
  groupLabels?: string[];
  ladder?: LadderSpec;
  outcome?: OutcomeSpec;
}

/**
 * A reusable competition blueprint with no teams in it. Versioned: editing mints a new
 * version, and a running season keeps a snapshot of the one it started with, so a
 * template edit can never reshape a season already in flight.
 */
export interface CompetitionStructure {
  id: string;
  name: string;
  version: number;
  /** Provenance only — which starter template this was cloned from, if any. */
  templateId?: string;
  /**
   * Who authored it: an operator (portal/wizard), an admin's quick start (the server
   * instantiated a template on their behalf), or the flat-run migration. Absent ⇒
   * `operator`, the pre-existing meaning. Provenance only, like `templateId`.
   */
  source?: 'operator' | 'quick-start' | 'migration';
  stages: StageSpec[];
}

/* ─── VENUES (ADR 0008) ───
   The master list of grounds fixtures are allocated to. Implemented: allocation runs
   client-side and writes venueId/venueStatus/venueReason onto each fixture (see
   packages/engine/src/venues.ts and docs/api/series.md). Its own DynamoDB item per venue rather
   than a TenantConfig array: a region has hundreds, and availability windows change
   constantly, so they are operational data rather than setup data. */

/** A window in which a ground can't be used — maintenance, another sport's season, exams. */
export interface VenueUnavailable {
  start: IsoDate;
  end: IsoDate;
  reason: string;
}

export interface Venue {
  id: string;
  name: string;
  address?: string;
  suburb?: string;
  /** Hand-pinned; there is no geocoder. Absent ⇒ this venue can't be distance-ranked. */
  lat?: number;
  lon?: number;
  /**
   * Clubs that call this ground home. Plural on purpose — ground-sharing is routine in
   * club cricket, and it is exactly why "home preference" can conflict with itself.
   */
  homeClubIds?: string[];
  /** Matches playable here on one day. Grounds with two pitches host two. Default 1. */
  surfaces?: number;
  unavailable?: VenueUnavailable[];
  /** Weekdays the ground is never available (0 = Sunday). */
  unavailableWeekdays?: Weekday[];
  note?: string;
}

/**
 * How a fixture's venue was decided. Ordered by how well it served the home team, so a
 * glance down a column tells an operator how much compromise the allocation involved.
 */
export type VenueStatus = 'home' | 'alternative' | 'neutral' | 'unresolved';

/**
 * One format stream inside a league. The structural gap in the pre-ADR-0008 model: a
 * league could only be ONE thing, but KZNCU Premier Men runs a T20 Pink Ball competition
 * and a 50 Over Red Ball competition in parallel — different structures, different
 * groupings, over the same twelve registered clubs.
 */
export interface Competition {
  id: string;
  /** e.g. "50 Over (Red Ball)". */
  label: string;
  matchFormat?: { overs?: number; ballType?: string; label?: string };
  structureId: string;
  calendarId: string;
  /** Sides entered in the LEAGUE but not in this competition. Honoured client-side. */
  excludeTeamIds?: string[];
}

/** A stage's progress within a running season. */
export interface StageRun {
  /** → `StageSpec.id` on the run's structure snapshot. */
  specId: string;
  status: 'awaiting-entrants' | 'ready' | 'generated' | 'complete';
  groups: Array<{
    id: string;
    label: string;
    entrants: string[];
    /** The Series this group materialised into, once generated. */
    seriesId?: string;
  }>;
  /**
   * The mid-season swap's points handover, keyed by teamId. Admin-entered and never
   * recomputed — flagged so a future ladder cannot double-count it (ADR 0008).
   */
  carriedPoints?: Record<string, number>;
  /**
   * Run-time knockout pairing chosen at qualifier confirmation, overriding the stage
   * spec's `format.pairing`. Absent ⇒ the structure default.
   */
  pairingOverride?: 'seeded' | 'cross-pool' | 'within-pool';
  /**
   * Set by `POST /season-runs/:id/rebase` when the stage's schedule spec changed: the
   * pairing-only divergence check never fires for date/cadence edits, so the server marks
   * the stage "Needs regenerating" explicitly. Cleared by the client on regeneration.
   */
  staleSchedule?: boolean;
  /**
   * Who confirmed this stage's entrants, when, what was proposed and whether they took
   * it. Relegation and points carry ride on these decisions, so the trail is a
   * governance requirement rather than a nicety.
   *
   * `event: 'rebase'` entries are written by the rebase route: `prefill` then holds the
   * grouping the rebase cleared (so the confirm form can pre-fill from it) and `pairing`
   * the run-time override it dropped, if any.
   */
  audit?: Array<{
    at: string;
    by: string;
    prefill: string[][];
    accepted: boolean;
    event?: 'rebase';
    pairing?: string;
  }>;
}

/**
 * One competition being played out for one season.
 *
 * Holds a SNAPSHOT of the structure and calendar it started with: editing a structure
 * mints a new version and must never reshape a season already in flight. Same defensive
 * pattern as `Series.participants`, which snapshots team identity so a later roster edit
 * can't orphan a released series.
 */
export interface SeasonRun {
  id: string;
  leagueKey: string;
  competitionId: string;
  /** e.g. "2026/27". */
  seasonLabel: string;
  structureSnapshot: CompetitionStructure;
  calendarSnapshot: SeasonCalendar;
  stages: StageRun[];
  createdAt?: string;
  createdBy?: string;
  version: number;
  /**
   * Only set when `competitionId` is the flat sentinel: there is no config competition
   * to read format from, so the admin's series-type/overs choice is persisted here and
   * the panel synthesizes a Competition from it (regenerate must preserve the choice).
   */
  flatFormat?: { seriesType: string; overs: number };
}

/** A club's home/secondary ground. */
export interface ClubGround {
  venue?: string;
  address?: string;
  suburb?: string;
  lat?: number;
  lon?: number;
  secondaryVenue?: string;
  secondaryAddress?: string;
}

/**
 * A named side a club fields in a league when it enters more than one team there
 * (`Club.leagueTeams[key] >= 2`). Each carries a stable, generated `id` so coach
 * links and fixture references survive renames/reorders within the form.
 *
 * `id` MUST use the reserved `tm_` prefix so the teamId namespace can never collide
 * with a bare `clubId` slug (e.g. 'ukzn'). A single-team league has NO roster: the
 * club itself is the team and `teamId === clubId`.
 */
export interface ClubTeam {
  /** `tm_${shortId}` — reserved prefix, never equal to a clubId. */
  id: string;
  /** Display name, e.g. "Glenwood A". 1–80 chars. */
  name: string;
  /** Optional home-ground override; absent ⇒ the club ground. */
  venue?: string;
  address?: string;
  /** Optional pin; absent ⇒ club ground coords are used for travel cost. */
  lat?: number;
  lon?: number;
}

/** The reserved prefix every generated team id carries (clubIds never have it). */
export const TEAM_ID_PREFIX = 'tm_';

export interface Series {
  id: string;
  name: string;
  startDate: string;
  endDate?: string; // optional; when set, may drive scheduling (see dateMode)
  dateMode?: 'spread' | 'reference'; // how endDate is used: spread rounds vs display only
  /**
   * Participant ids. A participant is a *team*, not a club: for a single-team club
   * `teamId === clubId` (legacy-compatible); for a multi-team club these are `tm_…`
   * ids. Fixtures' `home`/`away` reference these. Resolve back to a club via
   * `participants`.
   */
  teams: string[];
  /**
   * Self-contained snapshot mapping each `teams[]` id → its club, display name and
   * travel coords, captured at series-creation time. Authoritative for rendering and
   * cost so a later roster edit (rename/shrink/league removal) never orphans a live
   * series. Absent ⇒ legacy series where every `teams[]` id is a clubId.
   */
  participants?: Array<{
    teamId: string;
    clubId: string;
    name: string;
    /** Resolved home-venue label at creation (team override or club ground). */
    venue?: string;
    lat?: number;
    lon?: number;
  }>;
  fixtures: unknown[];
  /**
   * The season-calendar binding (ADR 0008), when this series was scheduled against one.
   * Persisted so `regenerate` reproduces the schedule the admin confirmed — the same
   * parity guarantee `dateMode` gives the legacy path. Absent ⇒ a legacy series
   * scheduled from `startDate`/`endDate` alone.
   */
  schedule?: SeriesSchedule;
  /**
   * Delayed visibility: a released series stays hidden from clubs and player broadcasts
   * until this date. Junior leagues generate their fixtures up front but only activate in
   * the second half of the season. Absent ⇒ visible as soon as it is released.
   */
  activateFrom?: IsoDate;
  /**
   * Back-pointers to the season run that produced this series (ADR 0008). One
   * stage-group materialises into one Series, so these three identify which. Absent ⇒ a
   * standalone series created through the flat create-series flow — the default, and
   * unchanged. The club portal groups by `seasonRunId` so a split league reads as one
   * season rather than three unrelated series.
   */
  seasonRunId?: string;
  stageSpecId?: string;
  groupId?: string;
  /** Admin sign-off gate: a series can only be released once approved. Editing a fixture clears it. */
  approved?: boolean;
  approvedAt?: string | null;
  released: boolean;
  releasedAt: string | null;
  /**
   * Fields withheld from clubs on a released series (ADR 0011). Set ONLY by the release
   * PATCH (the false→true transition); cleared per key by `reveal`, wholesale by recall.
   * Absent ⇒ nothing withheld — every series released before this existed reads as
   * fully visible. Storage keeps the real venue/time data; withholding is a read-side
   * projection for club users, so the release clash gate still sees real venues.
   */
  withheld?: { venue?: true; time?: true };
  /** Audit: when each withheld field was revealed. Cleared by recall; `releasedAt` is never bumped by a reveal. */
  revealedAt?: { venue?: string; time?: string };
  version: number;
  [key: string]: unknown;
}
