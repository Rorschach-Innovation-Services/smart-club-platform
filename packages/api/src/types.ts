/** Domain types shared across the API. Mirrors the frontend's data shapes. */

export type Role = 'admin' | 'rep' | 'operator';

/**
 * Sentinel tenantId for the PLATFORM membership `{tenantId: '*', role: 'operator'}`.
 * It can never collide with tenant access: resolveTenant never yields '*',
 * requireTenantMembership matches an exact tenantId, and the repo layer skips
 * TENANT# markers for it (see reconcileUserMarkers) so an operator is never
 * listable inside any tenant's roster.
 */
export const PLATFORM_TENANT = '*';

export interface Membership {
  tenantId: string;
  role: Role;
  /** Clubs a rep is scoped to. Ignored for admins (who see the whole tenant). */
  clubIds: string[];
  /** When this membership was created via an admin invite (ISO). */
  invitedAt?: string;
  /** Email of the admin who issued the invite. */
  invitedBy?: string;
}

export interface UserProfile {
  sub: string;
  email: string;
  memberships: Membership[];
  onboardingSeen: Record<string, boolean>;
  /**
   * First-ever sign-in timestamp (ISO), stamped once per user lifetime by the
   * PreTokenGen trigger. Absent ⇒ the user has been invited but never signed in
   * (status 'pending'). Drives the Team & Access "Active / Not signed in" pill.
   */
  lastLoginAt?: string;
}

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
   frontend engine (src/competition/calendar.ts) parses them strictly with dayjs.utc so
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
       */
      pairing: 'seeded' | 'cross-pool';
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
  stages: StageSpec[];
}

/* ─── VENUES (ADR 0008) ───
   The master list of grounds fixtures are allocated to. Implemented: allocation runs
   client-side and writes venueId/venueStatus/venueReason onto each fixture (see
   src/competition/venues.ts and docs/api/series.md). Its own DynamoDB item per venue rather
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
   * Who confirmed this stage's entrants, when, what was proposed and whether they took
   * it. Relegation and points carry ride on these decisions, so the trail is a
   * governance requirement rather than a nicety.
   */
  audit?: Array<{
    at: string;
    by: string;
    prefill: string[][];
    accepted: boolean;
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

/**
 * A short how-to-use-the-app tutorial video, surfaced on the public /tutorials page
 * and linked from the chair's onboarding email. `url` may be a site-relative path
 * (e.g. '/tutorials/01-getting-started.mp4', served by the StaticSite CDN) or an
 * absolute URL; link builders resolve relative paths against the tenant host.
 */
export interface TutorialVideo {
  title: string;
  url: string;
  /** Optional poster image shown before play. */
  poster?: string;
}

/**
 * Named org-copy slots on `branding.copy`. All optional — resolution falls back
 * through `orgCopy()` (branding.ts), so a tenant row never needs every slot. Kept
 * as a string map on disk (`BrandingCopy & Record<string, string>`) so ad-hoc
 * slots survive round-trips without a shape migration.
 */
export interface BrandingCopy {
  welcome?: string;
  eyebrow?: string;
  office?: string;
  admin?: string;
  support?: string;
  footer?: string;
  /** Short org handle for compound copy, e.g. "Dolphins" → "Dolphins office". */
  orgShort?: string;
  /** Full cohort label, e.g. "Dolphins Pipeline cohort". */
  cohortName?: string;
  heroTitle?: string;
  heroBlurb?: string;
  /** Breadcrumb root, e.g. "Dolphins" in "Dolphins · Admin Console / …". */
  crumbRoot?: string;
}

/** An entry in the operator-managed club directory (TenantConfig.knownClubs). */
export interface DirectoryClub {
  /** Stable slug (clubIdFromName) — doubles as a clearance source partition. */
  id: string;
  name: string;
}

export interface TenantConfig {
  tenant: string;
  branding: {
    name: string;
    /** Human title for <title> and headers, e.g. "Dolphins Pipeline". */
    title: string;
    logoUrl: string;
    /** Browser-tab icon; absent ⇒ the frontend falls back to logoUrl. */
    faviconUrl?: string;
    /** CSS color tokens injected at the edge, e.g. { '--navy': '#1B2A4A' }. */
    colors: Record<string, string>;
    /** Org copy strings keyed by slot — named slots typed, extras allowed. */
    copy: BrandingCopy & Record<string, string>;
  };
  submissionDeadline: string;
  /**
   * Operator-managed directory of real-world clubs not yet registered on the
   * system. Merged (deduped, real club wins) into the previous-club dropdown on
   * public player registration; a directory pick opens a real pending clearance
   * from `id` (see PlayerClearance.fromClubDirectory). `id` is derived
   * server-side from the name at save time and persisted so a later rename can
   * never orphan a pending clearance's partition. Operator-only: PUT
   * /tenant/config strips it (ADR 0006), only PUT /platform/tenants/:slug
   * writes it. Legacy rows hold [].
   */
  knownClubs: DirectoryClub[];
  /**
   * Pointer to the tenant-wide club self-signup token (TOKEN# item, kind 'club-signup').
   * Single active link per tenant; regenerating revokes the prior token. Written ONLY via
   * repo.updateClubSignupLink (targeted update) — PUT /tenant/config strips it from patches
   * so a concurrent Settings save can't resurrect a revoked link.
   */
  clubSignupLink?: { token: string; createdAt: string };
  /** Admin-managed league catalogue clubs opt into. Empty for a fresh tenant. */
  leagues?: League[];
  /**
   * Operator-managed season calendars — the playing blocks, breaks and excluded dates
   * fixture generation schedules against (ADR 0008). Operator-only: PUT /tenant/config
   * strips it, only PUT /platform/tenants/:slug writes it. Absent/[] ⇒ the create-series
   * form falls back to its legacy single start/end window, so a tenant with no calendar
   * configured keeps working unchanged.
   */
  calendars?: SeasonCalendar[];
  /**
   * Operator-managed competition structures — the stage pipelines leagues bind to
   * (ADR 0008). Shared across leagues: every EMCU division uses one flat round robin,
   * every T20 stream uses one pools-and-knockout. Operator-only: PUT /tenant/config
   * strips it. Absent ⇒ no league has a structure and everything runs the flat path.
   */
  structures?: CompetitionStructure[];
  /**
   * Operator-managed district list clubs pick during signup/affiliation and leagues
   * are filed under. Absent ⇒ DEFAULT_DISTRICTS fallback at read time (legacy tenants,
   * no backfill); [] ⇒ freshly created client — club signup is blocked until the
   * operator configures districts. Operator-only: PUT /tenant/config strips it
   * (ADR 0006), only PUT /platform/tenants/:slug writes it.
   */
  districts?: string[];
  /** Optional per-tenant required-docs override; falls back to shared default. */
  requiredDocs?: unknown[];
  /**
   * Authoritative count of admins for this tenant, maintained transactionally on
   * the CONFIG item so the last-admin lockout guard is race-free (no TOCTOU on a
   * point-in-time list). Absent on legacy tenants → lazily backfilled by
   * repo.recountAdmins from authoritative memberships before the guard runs.
   */
  adminCount?: number;
  /**
   * Per-tenant how-to-use-the-app tutorial videos, shown on the public /tutorials
   * page and linked in the chair onboarding email. Absent ⇒ the shared
   * DEFAULT_TUTORIALS fallback is used (so existing rows need no migration).
   */
  tutorials?: TutorialVideo[];
  /**
   * When true, an empty/absent `tutorials` serves NO videos instead of the shared
   * DEFAULT_TUTORIALS set (e.g. a client whose own onboarding flow diverges enough
   * that the shared clips would mislead). Absent ⇒ legacy fallback behaviour
   * unchanged. Operator-only, same as `tutorials`.
   */
  tutorialsNoFallback?: boolean;
  /**
   * Per-tenant feature flags, read via hasFeature() (features.ts) so each flag
   * carries its own default. Known flags: 'whatsappInvites' (default TRUE —
   * shared WABA templates are dolphins-flavored, so new clients launch
   * email-only), 'selfServeBranding' (reserved, default false).
   */
  features?: Record<string, boolean>;
  /**
   * Operator "setup complete" milestone (D6) — informational only (the client is
   * publicly live from creation and every setting stays editable). Present ⇒ an
   * operator marked setup done; absent ⇒ still in setup. Stamped/cleared ONLY via
   * POST/DELETE /platform/tenants/:slug/setup-complete, never the config merge-patch.
   */
  setupCompletedAt?: string;
  setupCompletedBy?: string;
}

/** Stored club record. Catalogue-derived fields stay client-side. */
export interface Club {
  id: string;
  name: string;
  district: string;
  sub: string;
  chair: string;
  affiliation: 'not_started' | 'in_progress' | 'complete';
  cqi: number;
  cqiAnswers?: Record<string, unknown>;
  docs: Record<string, boolean>;
  /**
   * Per-doc upload metadata, keyed by doc key. Single-file docs store one
   * `{ objectKey, size, contentType?, uploadedAt }` object (or an admin
   * `{ markedCompliant, at }` sentinel). Safeguarding is multi-file and stores
   * `{ files: [...entries], markedCompliant?, at? }` — see safeguardingMeta.
   */
  docMeta?: Record<string, unknown>;
  /** Surfaced as `players` on read; derived from registrations. */
  players: number;
  /** Denormalized registration count, bumped atomically on each registration. */
  playerCount?: number;
  teams: number;
  women: number;
  juniors: number;
  color: string;
  ground: {
    venue?: string;
    address?: string;
    suburb?: string;
    lat?: number;
    lon?: number;
    /** Optional second home venue (input only — no map/coords). Used for fixture venue selection. */
    secondaryVenue?: string;
    secondaryAddress?: string;
  };
  leagues: string[];
  /** Teams entered per league key (a club may field >1 side in a league); absent ⇒ 1. */
  leagueTeams?: Record<string, number>;
  /**
   * Named sides per league key, present ONLY for leagues with `leagueTeams[key] >= 2`.
   * Roster length tracks the count; ids are stable (`tm_…`). A count-1 league has no
   * entry here — the club is its own single team. Drives fixture participants and
   * per-team coach assignment.
   */
  teamRosters?: Record<string, ClubTeam[]>;
  /**
   * Office bearers. `exco.chair` carries the chair's contact plus governance
   * fields `idNumber`, `termStart`, `termEnd` (ISO dates) captured on the affiliation
   * form; other roles carry name/cell/email/gender/race. `reasonForInvolvement` is
   * legacy — chairperson motivation is now a multi-select captured on the CQI form as
   * `cqiAnswers.involvementReasons: string[]` (one or more of INVOLVEMENT_REASONS).
   */
  exco?: Record<string, unknown>;
  /**
   * Coaches by league. Each entry additionally carries `idNumber`, `yearStarted`
   * (year as number/string) and `yearsExperience` ('0-3' | '4-10' | '10+').
   */
  coaches?: unknown[];
  /**
   * Set when a rep edits an already-complete affiliation form (corrections);
   * cleared by an admin re-confirming. The form is no longer hard-locked.
   */
  amendmentPending?: boolean;
  /**
   * Set when a rep renames the club (the change applies immediately but is flagged
   * for admin review); cleared by an admin acknowledging. Admin renames never set it.
   */
  nameChangePending?: boolean;
  /** The club name prior to a flagged rep rename — drives the admin "Renamed from …" pill. */
  previousName?: string;
  /** Admin communication-log notes, appended newest-last via list_append. */
  notes?: { id: string; text: string; author: string; at: string }[];
  /** Real onboarding-invite send events (email/WhatsApp), appended via list_append. */
  commLog?: ClubCommEvent[];
  /** Whether the chair opted into deadline reminders during onboarding (no cron yet). */
  remindersOptIn?: boolean;
  playerRegLink?: { token: string; createdAt: string };
  /** Marks a club loaded from the demo snapshot; gates illustrative-only UI (e.g. seeded comm-log events). */
  demo?: boolean;
  onboardedAt?: string;
  /** Provenance: set when the club was created via the public signup link, not by an admin. */
  onboardedVia?: 'self-signup';
  /** When the rep submitted the self-signup (implied POPIA consent, ISO). Only on self-signups. */
  signupConsentAt?: string;
  /** Optimistic-concurrency version + audit trail. */
  version: number;
  changedBy?: string;
  changedAt?: string;
}

/** Outbound invite channels. */
export type Channel = 'email' | 'whatsapp';

/** Per-channel outcome of an invite send (returned to the client + stored on the marker). */
export interface SendResult {
  channel: Channel;
  status: 'sent' | 'failed' | 'skipped';
  /** Recipient the send targeted (email / E.164 cell). Omitted on a skip with no value on file. */
  to?: string;
  messageId?: string;
  /** Reason a send did not succeed (validation skip or provider error). Never set on success. */
  error?: string;
  /** Aggregate, human-readable outcome for a broadcast summary row (e.g. "8 sent · 2 skipped"). */
  summary?: string;
}

/** One real outbound send (onboarding invite or fixtures broadcast), recorded in the club's comm log. */
export interface ClubCommEvent {
  id: string;
  channel: 'email' | 'whatsapp';
  /** Recipient the send targeted (email / E.164 cell). Omitted on a skip with no value on file, and on broadcast summaries (which never name an individual). */
  to?: string;
  status: 'sent' | 'failed' | 'skipped';
  /** Provider message id when sent (SES MessageId / Meta message id). */
  messageId?: string;
  /** Reason when not sent (validation skip or provider error). */
  error?: string;
  at: string;
  by: string;
  /** Ties the event back to the idempotency-keyed send attempt. */
  idempotencyKey: string;
  /**
   * What was sent. Absent ⇒ 'invite' (back-compat with pre-existing rows). A 'fixtures'
   * broadcast is recorded as one PII-free summary event per channel, not one row per player.
   * A 'clearance' row is the chairman heads-up recorded when a clearance opens against the club.
   */
  kind?: 'invite' | 'fixtures' | 'reglink' | 'clearance';
  /** Aggregate, PII-free outcome for a broadcast send, e.g. "8 sent · 2 skipped" (sent · skipped · failed; zero parts omitted). */
  summary?: string;
}

/**
 * One admin export of the cross-club player register. A best-effort, tenant-scoped
 * record of the event (who / when / how many rows / which scope) — NOT an authoritative
 * PII-access trail: the .xlsx is built in the browser from rosters already fetched, and the
 * client reports this after the fact, so the counts are client-asserted and the write is
 * bypassable. It is a compliance intent-signal, not proof of access. The register fetch
 * itself is the server-observed access boundary if a definitive trail is ever required.
 */
export interface ExportLogEntry {
  id: string;
  kind: 'player-export';
  /** Human-readable actor (caller email), mirroring notes[].author / commLog[].by. */
  by: string;
  /** Stable Cognito sub of the actor. */
  sub?: string;
  at: string;
  rowCount: number;
  /** Whether the admin exported the whole register or the current filtered selection. */
  scope: 'all' | 'filtered';
  /**
   * Number of club rosters that failed to load at export time (>0 ⇒ the file may be partial —
   * some rosters were missing when the rows were gathered; applies to filtered exports too, as
   * both draw from the same cross-club set). Recorded so the trail never reads a truncated
   * register as a clean export.
   */
  erroredClubs?: number;
}

/** Onboard payload: a Club plus the flat chair contact fields the admin form sends. */
export type ClubSpec = Partial<Club> & {
  chairEmail?: string;
  chairCell?: string;
};

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
  version: number;
  [key: string]: unknown;
}

/** Stored object metadata for a player's uploaded ID document (parallels club docMeta). */
export interface PlayerIdDocMeta {
  objectKey: string;
  size: number;
  uploadedAt: string;
  /** MIME type the file was signed/stored as (ID docs allow image/* or PDF). */
  contentType?: string;
}

export type PlayerStatus = 'active' | 'clearance-pending' | 'inactive' | 'clearance-rejected';

export interface PlayerRegistration {
  naturalKey: string;
  clubId: string;
  firstName: string;
  lastName: string;
  dob: string;
  cell?: string;
  email?: string;
  isMinor: boolean;
  guardianName?: string;
  consentAt: string;
  createdAt: string;
  // ── Official Union registration fields ──
  // All optional: absent on legacy rows and on public-link self-registrations,
  // which collect only the minimal POPIA-consent set. The in-portal chair form
  // (POST /clubs/:id/players) populates them.
  /**
   * SA citizens: a 13-digit RSA ID, with `dob` derived from it server-side. Non-SA
   * citizens: `idType: 'passport'` and a passport/visa number, with `dob` taken from
   * the client (no oracle exists to derive it). `idType` defaults to 'sa-id'.
   */
  idType?: 'sa-id' | 'passport';
  idNumber?: string;
  /** Player nationality (demonym); defaults to 'South African' for SA-ID registrants. */
  nationality?: string;
  race?: string;
  gender?: string;
  postalAddress?: string;
  postalCode?: string;
  /** League key the player is registered for (e.g. a 'Premier Men' catalogue key). */
  team?: string;
  district?: string;
  /** Club the player was last registered for ('—' if first registration). */
  lastClub?: string;
  battingHand?: 'Right' | 'Left';
  bowlingHand?: 'Right' | 'Left';
  battingType?: string;
  /** Empty string ⇒ not a bowler. */
  bowlerType?: string;
  isAllRounder?: boolean;
  isWk?: boolean;
  idDocMeta?: PlayerIdDocMeta;
  /**
   * The vetted ID document from the player's PREVIOUS club, carried onto the
   * destination record when a registration-origin clearance is approved. The
   * fresh registration's own `idDocMeta` is self-asserted; this preserves the
   * source club's evidence of the original identity.
   */
  previousIdDocMeta?: PlayerIdDocMeta;
  /** Roster lifecycle. Absent ⇒ treated as 'active'. */
  status?: PlayerStatus;
  /**
   * Set when a registration-origin clearance was REJECTED: the player stays on this
   * (current) club's roster flagged 'clearance-rejected' instead of reverting to the
   * previous club. Meaningful ONLY while status === 'clearance-rejected' — cleared on
   * any later activation (see resolveClearance). `lastClub` holds the previous club name.
   */
  clearanceRejectedAt?: string;
  clearanceRejectedReason?: string;
  /** Email of the chair/admin who registered the player via the portal. */
  registeredBy?: string;
  /** Which path created the row. Absent ⇒ 'link' (back-compat with pre-existing rows). */
  registeredVia?: 'link' | 'portal';
  /**
   * Optimistic-concurrency version for portal/admin edits and the clearance move.
   * Absent on legacy rows → treated as 0 (same convention as Club.version).
   */
  version?: number;
}

export type ClearanceStatus = 'pending' | 'approved' | 'admin-override' | 'rejected';

/**
 * An inter-club transfer/clearance request. Stored as TWO items written together:
 * the canonical item under the SOURCE club (sk `CLEARANCE#<id>`, carries the gsi1
 * entry so admins list every request in one query) and a mirror under the
 * DESTINATION club (sk `INBOUND_CLEARANCE#<id>`, no gsi1) so each club reads only
 * its own partition — never a tenant-wide scan. The source club confirms fees +
 * misconduct (no time limit); the union office may override and approve any pending
 * request on the source club's behalf.
 */
export interface PlayerClearance {
  id: string;
  playerNaturalKey: string;
  /** Denormalized "First Last" for display + audit (survives the player move). */
  playerName: string;
  idNumber?: string;
  team?: string;
  fromClubId: string;
  toClubId: string;
  fromClubName: string;
  toClubName: string;
  requestedAt: string;
  /** Email of the destination-club rep who initiated the request. */
  requestedBy?: string;
  note?: string;
  /**
   * How the clearance came to exist. 'registration' ⇒ opened automatically by the
   * public registration page (the destination player row already exists, status
   * 'clearance-pending', with self-asserted data). Absent ⇒ 'request'
   * (destination-rep initiated; the destination row is created on approval).
   */
  origin?: 'registration' | 'request';
  /**
   * True ⇔ the source is a tenant-directory (off-system) club: no source player
   * row or club META existed when the clearance was opened. Listing/UX + route
   * guards only — resolve/reject branch on the ACTUAL source row's existence,
   * not this flag, because a club may later sign up under the same slug and
   * roster the player. Cleared by the admin reassign route, which moves the
   * clearance to a real club and backfills a placeholder source row.
   */
  fromClubDirectory?: boolean;
  feesCleared: boolean;
  misconductCleared: boolean;
  status: ClearanceStatus;
  clubApprovedAt?: string | null;
  adminOverrideAt?: string | null;
  rejectedAt?: string | null;
  /** Email of the union admin who rejected on the clubs' behalf. */
  rejectedBy?: string;
  rejectReason?: string;
  /**
   * Free text on an override: why the union issued the clearance on the clubs' behalf. Written
   * only on an ADMIN override, but SHOWN TO BOTH CLUBS — it rides the mirror as well as the
   * canonical, exactly like rejectReason. Load-bearing when override is used to DISPOSE of a
   * clearance that should never have existed (junk registration, or a player who named a club
   * they never played for) — reject is refused for sourceless clearances and deletion is
   * blocked while pending, so override is the only exit, and without this the resolved record
   * reads as a genuine approved transfer.
   */
  overrideReason?: string;
  /** Email of the union admin who overrode, mirroring rejectedBy. Admin overrides only. */
  overriddenBy?: string;
  version: number;
}

/**
 * A clearance as the ADMIN LISTING returns it: the stored row plus one derived field.
 *
 * `sourceRostered` is kept OFF PlayerClearance on purpose. Every writer spreads a whole
 * clearance (clearanceItems puts `...c` into both the canonical and the mirror), so a derived
 * field living on the persisted type is one careless pass-through away from being stored. Here
 * the compiler enforces what a comment used to: a value of this type cannot be handed to
 * resolveClearance/rejectClearance/clearanceItems without being narrowed first.
 *
 * Set only for PENDING REGISTRATION-origin clearances: does the source club actually hold this
 * player? `false` ⇒ sourceless, so the source cannot decide on an informed basis — the reject
 * route refuses and the reassign route permits, and the console mirrors both. ABSENT means
 * unknown (older API, or the derivation failed), which the console must treat as its own state
 * rather than folding into either answer.
 */
export type AdminClearanceView = PlayerClearance & { sourceRostered?: boolean };

export type RegistrationReviewKind = 'off-system-alert' | 'cross-club-hold';
export type RegistrationReviewStatus = 'open' | 'resolved';
export type RegistrationReviewResolution = 'acknowledged' | 'accepted' | 'declined';

/**
 * A self-registration that needs a human look before it's fully trusted. Two kinds,
 * distinguished by audience + action:
 *
 *  - `off-system-alert` — the player registered into their OWN link club but named an
 *    "Other" (off-system) previous club, so no clearance could be opened. The player row
 *    is already active; this is an admin-only FYI carrying the typed club name.
 *  - `cross-club-hold` — the player used one club's link but chose a DIFFERENT current
 *    club (`currentClubId`). Because a per-club link must not silently write onto another
 *    club's active roster, NO player row exists yet: the fully-validated registration is
 *    parked in `pendingPlayer` until the destination club's chair accepts (→ the row, and
 *    any previous-club clearance, are materialized) or declines (→ discarded, ID doc purged).
 *
 * Stored as ONE canonical item under the DESTINATION club (sk `REGREVIEW#<id>`, gsi1 for
 * the admin cohort-wide listing) — the same own-partition-only read model as clearances.
 */
export interface RegistrationReview {
  id: string;
  kind: RegistrationReviewKind;
  playerNaturalKey: string;
  /** Denormalized "First Last" for display + audit. */
  playerName: string;
  idNumber?: string;
  /** The club the player registered INTO — partition owner + who actions a hold. */
  destClubId: string;
  destClubName: string;
  /** The club whose public link/token was used (may equal destClubId for off-system alerts). */
  linkClubId: string;
  linkClubName: string;
  /** Free-text off-system previous club, when the player picked "Other". */
  typedPreviousClub?: string;
  /** On-system previous club name, when the player named a real club (cross-club holds). */
  previousClubName?: string;
  /**
   * Fully-validated player payload awaiting the destination chair's acceptance
   * (cross-club-hold only; `status` omitted). Materialized into a PLAYER# row on accept,
   * discarded (ID doc purged) on decline. Absent on off-system alerts (row already active).
   */
  pendingPlayer?: PlayerRegistration;
  /**
   * The on-system previous club id the player selected, if any — re-resolved at accept
   * time to decide whether the materialized row opens a clearance to that club.
   */
  pendingLastClubId?: string;
  createdAt: string;
  status: RegistrationReviewStatus;
  resolution?: RegistrationReviewResolution;
  resolvedAt?: string;
  resolvedBy?: string;
  version: number;
}
