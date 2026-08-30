/**
 * Frontend domain types.
 *
 * CANONICAL SOURCE: packages/api/src/types.ts — the backend owns these shapes.
 * This is a deliberate hand-port (the repo is not an npm workspace and the api
 * package has no build output, so a cross-package `import type` isn't viable).
 * Keep this file in sync when the API contract changes. Future consolidation:
 * extract a `packages/shared` both sides depend on (see migration plan).
 *
 * DELIBERATE DIVERGENCE from the backend: fields the server authoritatively
 * produces but the client doesn't always have on hand (e.g. optimistic-concurrency
 * `version`) are marked OPTIONAL here even where the backend requires them. Such
 * fields are annotated `// server-authoritative`.
 */

export type Role = 'admin' | 'rep' | 'operator';

/**
 * Sentinel tenantId for the platform-operator membership `{tenantId: '*',
 * role: 'operator'}` — grants the cross-tenant /platform/* portal, never a
 * tenant console. Mirrors PLATFORM_TENANT in packages/api/src/types.ts.
 */
export const PLATFORM_TENANT = '*';

export interface Membership {
  tenantId: string;
  role: Role;
  /** Clubs a rep is scoped to. Ignored for admins (who see the whole tenant). */
  clubIds: string[];
  invitedAt?: string;
  invitedBy?: string;
}

export interface UserProfile {
  sub: string;
  email: string;
  memberships: Membership[];
  onboardingSeen: Record<string, boolean>;
  /** First-ever sign-in (ISO). Absent ⇒ invited but never signed in ('pending'). */
  lastLoginAt?: string;
}

/** An admin-defined competition a club can register for during affiliation. */
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

/** A short how-to-use-the-app tutorial video, surfaced on the public /tutorials page. */
export interface TutorialVideo {
  title: string;
  url: string;
  poster?: string;
}

/**
 * Org copy strings keyed by slot. All optional — resolveCopy (src/branding.ts)
 * supplies the fallback chain. Stays a string map on disk (index signature) so
 * legacy `branding.copy.support`-style access keeps working.
 */
export interface BrandingCopy {
  welcome?: string;
  eyebrow?: string;
  /** Small-caps brand strip above the logo (login, signup) and in the app header. */
  tagline?: string;
  office?: string;
  admin?: string;
  support?: string;
  footer?: string;
  orgShort?: string;
  cohortName?: string;
  heroTitle?: string;
  heroBlurb?: string;
  crumbRoot?: string;
  [slot: string]: string | undefined;
}

export interface TenantBranding {
  name: string;
  title: string;
  logoUrl: string;
  /** Favicon override; applyTheme falls back to logoUrl when absent. */
  faviconUrl?: string;
  /**
   * CSS theme tokens injected at runtime. Canonical keys are the semantic ROLE tokens
   * (--brand-primary, --brand-accent, --hero-image …, see src/platform-theme.ts); legacy
   * value-named keys (--green …) still render via the alias layer in index.html.
   */
  colors: Record<string, string>;
  /** Optional per-tenant typeface; applyTheme sets --brand-font and injects the web font. */
  font?: { family: string; url?: string };
  copy: BrandingCopy;
}

/** An entry in the operator-managed club directory (TenantConfig.knownClubs). */
export interface DirectoryClub {
  /** Stable slug derived server-side from the name at save time. */
  id: string;
  name: string;
}

/* ─── SEASON CALENDAR (ADR 0008) ───
   The union's real playing calendar: blocks of play either side of a mid-season break.
   The scheduling logic over these types lives in src/competition/calendar.ts.

   Dates are LOCAL WALL-CLOCK date-only strings, never UTC instants — a fixture happens
   on a date, in one place, in a region with no DST. The engine parses them strictly with
   dayjs.utc so whole-day arithmetic can never drift by the host's offset. */

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
   schedule (when it plays). The closed sets below cover every structure in the
   KZNCU/EMCU documents; they are closed on purpose, because a configuration language
   general enough to need conditionals is the inner-platform effect.

   The logic over these types lives in src/competition/. */

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
  champion?: number[];
  promoted?: number[];
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

/* ─── VENUES (ADR 0008, phase 2) ───
   The master list of grounds fixtures are allocated to. Its own DynamoDB item per venue
   rather than a TenantConfig array: a region has hundreds, and availability windows
   change constantly, so they are operational data rather than setup data. */

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
  /**
   * Sides entered in the LEAGUE but not in this competition — a club that plays the
   * 50 Over but sits out the T20. Honoured by `leagueParticipants`, so a season run
   * never offers them; there is no UI for it yet, so today it is set through the
   * operator API or a JSON import.
   */
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

/** File formats a compliance doc can accept (mirror of packages/api types). */
export type DocFormat = 'pdf' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'ods';

/**
 * One required compliance document in the tenant's catalogue (ADR 0009). Mirror of
 * RequiredDoc in packages/api/src/types.ts — behavior is declared as flags, and the
 * shared default list lives in data.ts DEFAULT_REQUIRED_DOCS.
 */
export interface RequiredDoc {
  key: string;
  name: string;
  desc?: string;
  /** 'form' = satisfied by an on-platform form (the exco pattern), not a file. */
  kind?: 'file' | 'form';
  /** Multi-file doc (safeguarding pattern): docMeta[key] = { files: [...] }. */
  multiFile?: boolean;
  minFiles?: number;
  maxFiles?: number;
  /** "We don't have these" escape hatch (financials pattern). */
  allowUnavailable?: boolean;
  /** "Meeting booked for <date>" escape hatch (AGM pattern). Single-file only. */
  allowMeetingBooked?: boolean;
  /** "Course booked for <date>" escape hatch (safeguarding pattern). multiFile only. */
  allowCourseBooked?: boolean;
  /** Accepted upload formats; absent ⇒ pdf/doc/docx. */
  accepts?: DocFormat[];
  /** Operator intake-classifier hints — present only on /platform payloads. */
  matchHints?: string[];
  /** Excluded from completion counts; stored files stay viewable. */
  archived?: boolean;
  /**
   * Which structural role this document satisfies for self-serve onboarding
   * (ADR 0010). The roster/committee-extract wizards gate on THIS, never a literal
   * doc key — a self-serve tenant's operator-authored catalogue (slugified doc
   * names) can never produce the Titans-only literal keys `memberDatabase`/
   * `committee`. At most one active doc per role.
   */
  role?: 'memberDatabase' | 'committee';
}

export interface TenantConfig {
  tenant: string;
  branding: TenantBranding;
  /** Per-tenant feature flags (e.g. whatsappInvites). Absent key ⇒ caller default. */
  features?: Record<string, boolean>;
  submissionDeadline: string;
  /**
   * Operator-managed directory of clubs not yet on the system — feeds the
   * previous-club dropdown on public registration. Operator-console only.
   */
  knownClubs: DirectoryClub[];
  clubSignupLink?: { token: string; createdAt: string };
  leagues?: League[];
  /**
   * Operator-managed district list. Absent ⇒ frontend falls back to the shared
   * DISTRICTS constant (data.ts); [] ⇒ new client awaiting operator setup.
   */
  districts?: string[];
  /**
   * Per-tenant compliance-doc catalogue (ADR 0009). Absent ⇒ the frontend falls back
   * to DEFAULT_REQUIRED_DOCS (data.ts). Served on GET /tenant minus matchHints.
   */
  requiredDocs?: RequiredDoc[];
  adminCount?: number;
  tutorials?: TutorialVideo[];
  /**
   * true ⇒ an empty `tutorials` list shows the public page's "coming soon" empty
   * state instead of falling back to the backend's shared default set. Absent/false
   * ⇒ the existing fallback behaviour (DEFAULT_TUTORIALS) is unchanged.
   */
  tutorialsNoFallback?: boolean;
  /**
   * Operator-managed season calendars — the playing blocks, mid-season breaks and
   * excluded dates fixture generation schedules against (ADR 0008). Absent/[] ⇒ the
   * create-series form falls back to its legacy single start/end window, so a tenant
   * that has never had a calendar configured keeps working unchanged.
   */
  calendars?: SeasonCalendar[];
  /**
   * Operator-managed competition structures — the stage pipelines leagues bind to
   * (ADR 0008). Shared across leagues: every EMCU division uses one flat round robin,
   * every T20 stream uses one pools-and-knockout. Operator-only: PUT /tenant/config
   * strips it. Absent ⇒ no league has a structure and everything runs the flat path.
   */
  structures?: CompetitionStructure[];
  /** Operator "setup complete" milestone (D6). Present ⇒ setup marked done. */
  setupCompletedAt?: string;
  setupCompletedBy?: string;
}

/** One row of GET /platform/tenants — a registry projection, not the full config. */
export interface TenantSummary {
  tenant: string;
  name: string;
  title: string;
  logoUrl: string;
  submissionDeadline: string;
  adminCount: number;
  features: Record<string, boolean>;
  /** Present ⇒ operator marked setup done; absent ⇒ still in setup. Drives the list chip. */
  setupCompletedAt?: string;
  /** Fleet rollup counts. Optional: react-query rows cached before the rollup shipped lack them. */
  clubCount?: number;
  teamCount?: number;
  playerCount?: number;
}

/** Chair contact fields the league drill-down renders. All optional (legacy clubs). */
export interface ChairContact {
  name?: string;
  email?: string;
  cell?: string;
}

/**
 * Cross-tenant-safe club projection served by GET /platform/tenants/:slug/overview.
 * A deliberate allowlist — the league drill-down widened it to include chair
 * name/email/cell (`chair`/`chairContact`) and named-side ids/names (`teamRosters`),
 * but coach ID numbers, chair ID numbers, notes, comm log, doc metadata, CQI answers,
 * ground addresses/coords, and live registration tokens still never cross the
 * operator surface. The full admin Club satisfies this shape structurally, so
 * InsightsBreakdown (src/insights.tsx) accepts both.
 */
export interface InsightsClub {
  id: string;
  name: string;
  district: string;
  affiliation: 'not_started' | 'in_progress' | 'complete';
  cqi: number;
  docs: Record<string, boolean>;
  /** Denormalized registered-player count. */
  players: number;
  leagues?: string[];
  leagueTeams?: Record<string, number>;
  /** Named sides per league key — id/name only on the operator wire (no venue/coords). */
  teamRosters?: Record<string, Array<Pick<ClubTeam, 'id' | 'name'>>>;
  /** Chair display name (Club.chair on the admin side; projected on the operator wire). */
  chair?: string;
  /** Operator-wire chair contact, picked field-by-field (never the full exco.chair). */
  chairContact?: ChairContact;
  /** Admin-side office bearers; `exco.chair` carries the chair contact fields. */
  exco?: Record<string, unknown>;
  /**
   * Self-serve onboarding (ADR 0010): per-role classification of this club's stored
   * documents, resolved through `RequiredDoc.role` (not literal doc keys) — drives
   * the roster wizard's per-club gating and the onboarding checklist's progress
   * bars. Absent on an older backend that hasn't shipped the field yet.
   */
  intake?: {
    memberDatabase: 'absent' | 'parseable' | 'unparseable';
    committee: 'absent' | 'parseable' | 'unparseable';
  };
}

/** One anonymised demographic bucket — counts only, no player rows. */
export interface DemographicBucket {
  label: string;
  count: number;
}

/** Aggregated player demographics (age bands / gender / race) for one cohort slice. */
export interface DemographicsSummary {
  totalPlayers: number;
  ageGroups: DemographicBucket[];
  gender: DemographicBucket[];
  race: DemographicBucket[];
}

/**
 * GET /admin/insights/demographics (and TenantOverview.demographics) — the cohort
 * summary plus optional per-league split. `perLeague`/`unattributed` are optional for
 * deploy skew (an older backend serves the bare summary). `'unattributed'` is never a
 * `perLeague` key — it's the separate field.
 */
export type DemographicsResponse = DemographicsSummary & {
  perLeague?: Record<string, DemographicsSummary>;
  unattributed?: DemographicsSummary;
};

/** GET /platform/tenants/:slug/overview — exactly what the operator breakdown renders. */
export interface TenantOverview {
  tenant: string;
  name: string;
  leagues: League[];
  districts: string[];
  clubs: InsightsClub[];
  clearances: Array<{ status: ClearanceStatus }>;
  /** Anonymised player demographics; absent while an older backend serves the route. */
  demographics?: DemographicsResponse;
}

/** Presigned-POST grant from POST /platform/tenants/:slug/logo-upload. */
export interface LogoUploadPost {
  url: string;
  fields: Record<string, string>;
  objectKey: string;
  publicUrl: string;
}

/**
 * Upload grant from POST /platform/tenants/:slug/tutorial-upload. `mode: 'post'` is a
 * standard presigned-POST (poster, or a video ≤ 100 MiB) — submit via uploadPostToS3,
 * same shape as LogoUploadPost. `mode: 'multipart'` is a video over the single-POST
 * cap — PUT each `partUrls[].url` slice, then finish with
 * platformTutorialUploadComplete. Discriminated on `mode` so callers must branch.
 */
export type TutorialUploadGrant =
  | {
      mode: 'post';
      url: string;
      fields: Record<string, string>;
      objectKey: string;
      publicUrl: string;
    }
  | {
      mode: 'multipart';
      uploadId: string;
      objectKey: string;
      publicUrl: string;
      partSizeBytes: number;
      partUrls: { partNumber: number; url: string }[];
    };

// ── Operator bulk document-intake (POST /platform/tenants/:slug/doc-intake/*) ──

/** One request row for POST /platform/tenants/:slug/doc-intake/presign. */
export interface DocIntakePresignItem {
  clubId: string;
  docKey: string;
  contentType: string;
  size: number;
}
/**
 * One positional result from .../doc-intake/presign — index-aligned with the
 * request `items` array. A bad row (unknown club/doc key, unaccepted type,
 * oversize) fails ONLY that row; the batch never 400s wholesale.
 */
export type DocIntakePresignResult =
  | { ok: true; uploadUrl: string; objectKey: string; contentType: string }
  | { ok: false; error: string };

/** One request row for POST /platform/tenants/:slug/doc-intake/commit, built from
 *  an already-uploaded .../presign result plus the picked file's own name/size. */
export interface DocIntakeCommitItem {
  clubId: string;
  docKey: string;
  objectKey: string;
  size: number;
  contentType?: string;
  sourceName?: string;
}
/** One per-club result from .../doc-intake/commit — never index-aligned with the
 *  request (items are grouped server-side by clubId into one write per club). */
export type DocIntakeCommitClubResult =
  | { clubId: string; ok: true; docs: Record<string, boolean> }
  | { clubId: string; ok: false; error: string };

/** GET /platform/tenants/:slug/dns — the vanity-domain go-live instruction sheet. */
export interface DnsRecord {
  type: 'CNAME';
  host: string;
  target: string;
}
export interface DnsStep {
  key: string;
  title: string;
  detail: string;
  records?: DnsRecord[];
}
export interface DnsSheet {
  tenant: string;
  /** Where the client is already reachable (wildcard host, or vanity origin). */
  liveUrl: string | null;
  note: string;
  steps: DnsStep[];
  /** The one shared API host every tenant uses (informational). */
  sharedApiHost?: string;
  sharedApiTarget?: string;
}

/**
 * A named side a club fields in a league when it enters >1 team there
 * (`leagueTeams[key] >= 2`). `id` uses the reserved `tm_` prefix so the teamId
 * namespace never collides with a bare clubId. Single-team leagues have no roster
 * (the club is the team; `teamId === clubId`).
 */
export interface ClubTeam {
  id: string; // `tm_${shortId}`
  name: string; // "Glenwood A", 1–80 chars
  venue?: string; // optional home-ground override; absent ⇒ club ground
  address?: string;
  lat?: number;
  lon?: number;
}

/** Reserved prefix every generated team id carries (clubIds never have it). */
export const TEAM_ID_PREFIX = 'tm_';

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

/** A note appended to a club's admin communication log. */
export interface ClubNote {
  id: string;
  text: string;
  author: string;
  at: string;
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
  /** Per-doc upload metadata, keyed by doc key (single-file object or multi-file `{ files }`). */
  docMeta?: Record<string, unknown>;
  players: number;
  playerCount?: number; // server-authoritative (denormalized count)
  teams: number;
  women: number;
  juniors: number;
  color: string;
  ground: ClubGround;
  leagues?: string[]; // server-authoritative (may be absent on legacy client records)
  /** Teams entered per league key (a club may field >1 side in a league); absent ⇒ 1. */
  leagueTeams?: Record<string, number>;
  /**
   * Named sides per league key, present ONLY for leagues with `leagueTeams[key] >= 2`.
   * Roster length tracks the count; ids are stable (`tm_…`). A count-1 league has no
   * entry — the club is its own single team.
   */
  teamRosters?: Record<string, ClubTeam[]>;
  /** Office bearers; `exco.chair` carries chair contact + governance fields. */
  exco?: Record<string, unknown>;
  /** Coaches by league; entries carry idNumber/yearStarted/yearsExperience. */
  coaches?: unknown[];
  amendmentPending?: boolean;
  /** Set when a rep renames the club (change applies live, flagged for admin review). */
  nameChangePending?: boolean;
  /** Name prior to a flagged rep rename — drives the admin "Renamed from …" pill. */
  previousName?: string;
  notes?: ClubNote[];
  commLog?: ClubCommEvent[];
  remindersOptIn?: boolean;
  playerRegLink?: { token: string; createdAt: string };
  /** Marks a club loaded from the demo snapshot; gates illustrative-only UI. */
  demo?: boolean;
  onboardedAt?: string;
  onboardedVia?: 'self-signup';
  signupConsentAt?: string;
  version?: number; // server-authoritative (optimistic-concurrency)
  changedBy?: string;
  changedAt?: string;
}

/** Onboard payload: a Club plus the flat chair contact fields the admin form sends. */
export type ClubSpec = Partial<Club> & {
  chairEmail?: string;
  chairCell?: string;
};

/** Outbound invite channels. */
export type Channel = 'email' | 'whatsapp';

/** Per-channel outcome of an invite send (returned to the client + stored on the marker). */
export interface SendResult {
  channel: Channel;
  status: 'sent' | 'failed' | 'skipped';
  to?: string;
  messageId?: string;
  error?: string;
  summary?: string;
}

/** One real outbound send (onboarding invite or fixtures broadcast). */
export interface ClubCommEvent {
  id: string;
  channel: Channel;
  to?: string;
  status: 'sent' | 'failed' | 'skipped';
  messageId?: string;
  error?: string;
  at: string;
  by: string;
  idempotencyKey: string;
  kind?:
    | 'invite'
    | 'fixtures'
    | 'reglink'
    | 'clearance'
    | 'clearance-approved'
    | 'clearance-rejected'
    | 'clearance-reopened';
  summary?: string;
}

export interface Series {
  id: string;
  name: string;
  startDate: string;
  endDate?: string;
  dateMode?: 'spread' | 'reference';
  teams: string[];
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
  approved?: boolean;
  approvedAt?: string | null;
  released: boolean;
  releasedAt: string | null;
  /** Fields withheld from clubs on a released series (ADR 0011). Server-owned: set at release, cleared by reveal/recall. Absent ⇒ nothing withheld. */
  withheld?: { venue?: true; time?: true };
  /** When each withheld field was revealed to clubs. */
  revealedAt?: { venue?: string; time?: string };
  version: number;
  [key: string]: unknown;
}

export type WithheldField = 'venue' | 'time';

/** Stored object metadata for a player's uploaded ID document. */
export interface PlayerIdDocMeta {
  objectKey: string;
  size: number;
  uploadedAt: string;
  contentType?: string;
}

// `'clearance-rejected'` is LEGACY — reject no longer writes it. A rejected transfer now
// cancels the move and the player ends up active at the source club (reversible via reopen).
// Rows written before this change still carry the status and must keep rendering.
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
  // Official Union registration fields — all optional (absent on legacy rows and
  // public-link self-registrations; populated by the in-portal chair form).
  // SA citizens give a 13-digit RSA ID (dob derived from it); non-SA citizens give a
  // passport/visa number + a manually-entered dob. `idType` defaults to 'sa-id'.
  idType?: 'sa-id' | 'passport';
  idNumber?: string;
  /** Player nationality (demonym, e.g. 'South African'); defaults to 'South African' for SA-ID registrants. */
  nationality?: string;
  race?: string;
  gender?: string;
  postalAddress?: string;
  postalCode?: string;
  team?: string;
  district?: string;
  lastClub?: string;
  battingHand?: 'Right' | 'Left';
  bowlingHand?: 'Right' | 'Left';
  battingType?: string;
  bowlerType?: string;
  isAllRounder?: boolean;
  isWk?: boolean;
  idDocMeta?: PlayerIdDocMeta;
  /** Previous club's vetted ID doc, carried over when a registration-origin clearance is approved. */
  previousIdDocMeta?: PlayerIdDocMeta;
  status?: PlayerStatus;
  /**
   * LEGACY (read-only). Was set when a registration-origin clearance was rejected under the
   * old behaviour: the player stayed on this (current) club's roster flagged
   * 'clearance-rejected'. Reject no longer writes these — it now cancels the move (see
   * repo.rejectClearance) — but pre-existing rows may still carry them, so activation paths
   * still scrub them (see rekeyPlayer / resolveClearance). Meaningful ONLY while
   * status === 'clearance-rejected'.
   */
  clearanceRejectedAt?: string;
  clearanceRejectedReason?: string;
  registeredBy?: string;
  registeredVia?: 'link' | 'portal';
  version?: number;
}

export type ClearanceStatus = 'pending' | 'approved' | 'admin-override' | 'rejected';

/**
 * What a reject did to the player's registration — set on reject, cleared on reopen. Drives the
 * admin toast and the club-portal card copy. Mirrors the API's RejectOutcome:
 *   source-reactivated  — the move is cancelled; the player is (or returns to) active at the source.
 *   moved-to-source     — the registration (details + ID doc) is moved to the source club.
 *   stays-at-destination — the source is not on the system, so the player stays at the destination.
 */
export type RejectOutcome = 'source-reactivated' | 'moved-to-source' | 'stays-at-destination';

/** An inter-club transfer/clearance request. */
export interface PlayerClearance {
  id: string;
  playerNaturalKey: string;
  playerName: string;
  idNumber?: string;
  team?: string;
  fromClubId: string;
  toClubId: string;
  fromClubName: string;
  toClubName: string;
  requestedAt: string;
  requestedBy?: string;
  note?: string;
  /** 'registration' ⇒ opened by the public registration page; absent ⇒ rep-initiated request. */
  origin?: 'registration' | 'request';
  /**
   * True ⇔ the source is a directory (off-system) club. Drives the "Not on
   * system" pill and the Reallocate action in the admin clearances view.
   */
  fromClubDirectory?: boolean;
  feesCleared: boolean;
  misconductCleared: boolean;
  status: ClearanceStatus;
  clubApprovedAt?: string | null;
  adminOverrideAt?: string | null;
  rejectedAt?: string | null;
  rejectedBy?: string;
  rejectReason?: string;
  /** How the reject resolved (see RejectOutcome). Public; set on reject, cleared on reopen. */
  rejectOutcome?: RejectOutcome;
  /** Set when a rejected clearance was reopened (rejected → pending); cleared again on re-reject. */
  reopenedAt?: string;
  reopenedBy?: string;
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
 * A clearance as GET /admin/clearances returns it — the stored row plus two derived fields.
 * Deliberately NOT on PlayerClearance: every writer spreads a whole clearance, so a derived
 * field on the persisted type is one pass-through away from being stored.
 *
 * `predictedRejectCase` predicts which reject case applies, computed server-side from the SAME
 * detection the reject itself uses (the actual roster state), so the console never has to infer
 * it from a boolean. Present only on PENDING clearances. ABSENT means the API could not work it
 * out (older API, the derivation failed, or that pair could not be read) and must be treated as
 * its own state — the console fails closed and DISABLES Reject when it is, because a reject may
 * create or replace a row at another club and the admin must see the right consequence first.
 *
 * `sourceRostered` is retained (informational, pending only) — it still drives the Reallocate
 * offer; it no longer drives Reject enablement.
 *
 * NOTE this copy is DOCUMENTATION ONLY for now. The compiler enforcement it describes is real
 * on the API side (packages/api/src/types.ts); here AdminClearances' props are untyped and
 * tsconfig.app.json still has noImplicitAny off, so nothing checks it until the strict ratchet
 * lands. Do not read it as a guarantee on this side of the wire.
 */
export type AdminClearanceView = PlayerClearance & {
  sourceRostered?: boolean;
  predictedRejectCase?: 'A' | 'B' | 'B-placeholder' | 'B-active' | 'C' | 'D';
};

export type RegistrationReviewKind = 'off-system-alert' | 'cross-club-hold';
export type RegistrationReviewStatus = 'open' | 'resolved';
export type RegistrationReviewResolution = 'acknowledged' | 'accepted' | 'declined';

/**
 * A self-registration needing a human look. `off-system-alert` = admin-only FYI that a
 * player named an off-system previous club (row already active). `cross-club-hold` = a
 * registration that chose a different club than the link, parked (no row yet) for the
 * destination chair to accept/decline. Mirror of the backend type.
 */
export interface RegistrationReview {
  id: string;
  kind: RegistrationReviewKind;
  playerNaturalKey: string;
  playerName: string;
  idNumber?: string;
  destClubId: string;
  destClubName: string;
  linkClubId: string;
  linkClubName: string;
  typedPreviousClub?: string;
  previousClubName?: string;
  /** Present only on open cross-club holds (self-asserted; the chair needs it to decide). */
  pendingPlayer?: PlayerRegistration;
  pendingLastClubId?: string;
  createdAt: string;
  status: RegistrationReviewStatus;
  resolution?: RegistrationReviewResolution;
  resolvedAt?: string;
  resolvedBy?: string;
  version: number;
}

// ── Self-serve onboarding suite (ADR 0010, /platform/tenants/:slug/*) ──
// Backend routes land alongside the frontend wizards (a later wave); these shapes
// ARE the contract, taken verbatim from the plan's wire-shape sections.

// ── Roster intake (1.1) ──

/** POST /platform/tenants/:slug/roster-intake/parse body — one club per call, the UI
 *  fans out with bounded concurrency. Both fields are PARSE inputs, per-club: an
 *  exception carries no identity, so re-parsing (not client-side promotion) is how a
 *  flipped `allowMissingId` or an edited `ageGroupMap` entry takes effect. */
export interface RosterIntakeParseRequest {
  clubId: string;
  allowMissingId?: boolean;
  ageGroupMap?: Record<string, string>;
}

/** One committable draft row — no identity fields beyond what a historical register
 *  structurally has (see the DECISION note on the commit shape below). */
export interface RosterDraftRow {
  rowNumber: number;
  firstName: string;
  lastName: string;
  dob: string;
  idNumber?: string;
  missingId: boolean;
  gender?: string;
  race?: string;
  team?: string;
}

/** An unparseable/rejected row. Carries NO identity (never a name/id) — flipping
 *  `allowMissingId` or remapping an age band re-parses the club instead of promoting
 *  an exception row client-side. `reason` is a stable machine key, not display prose —
 *  mirrors RosterException['reason'] in packages/api/src/roster-parse.ts exactly (that
 *  module is the only place these values are ever produced). */
export interface RosterIntakeException {
  rowNumber: number;
  sheet: string;
  reason:
    | 'bad-id'
    | 'no-usable-identity'
    | 'bad-id-checksum'
    | 'unmapped-age-group'
    | 'missing-surname';
  maskedId?: string;
}

export interface RosterSheetParseResult {
  name: string;
  skipped: boolean;
  hasIdColumn: boolean;
  totalDataRows: number;
  rows: RosterDraftRow[];
  exceptions: RosterIntakeException[];
  unknownGenderRaw: string[];
  unknownRaceRaw: string[];
}

/** One distinct raw age-band string found in the workbook, and the league key it
 *  maps to — `null` is the junior-confirm table's attention-flagged row (a band
 *  `ageGroupToLeagueKey` doesn't know, which would otherwise commit team-less). */
export interface AgeGroupRaw {
  raw: string;
  leagueKey: string | null;
}

/** `parseable:false` covers a PDF/scan or any non-workbook contentType — a designed
 *  200, never an error the wizard has to special-case as a failure. */
export type RosterIntakeParseResponse =
  | {
      parseable: true;
      sheets: RosterSheetParseResult[];
      dobOnlyCount: number;
      juniorLeagueKeys: string[];
      ageGroupRaws: AgeGroupRaw[];
    }
  | { parseable: false; reason: string };

export const ROSTER_INTAKE_MAX_ITEMS = 500;

/** One flat commit row (server groups by clubId). Deliberately the IMPORT shape —
 *  no cell/nationality/district/guardian, which historical registers structurally
 *  lack — plus explicit status/version so these rows read identically to portal
 *  registrations for later edits/clearances. Client-supplied identity is
 *  authoritative for the review table; the server still recomputes the natural key
 *  and re-validates the checksum/dob pairing rather than trusting it blindly. */
export interface RosterIntakeCommitItem {
  clubId: string;
  rowNumber: number;
  firstName: string;
  lastName: string;
  dob: string;
  idNumber?: string;
  gender?: string;
  race?: string;
  team?: string;
}

export interface RosterIntakeCommitRequest {
  items: RosterIntakeCommitItem[];
}

/** A cross-club duplicate the commit excluded rather than failing outright — either
 *  another row in THIS batch (in-batch, via the shared duplicate detector) or an
 *  already-registered player elsewhere (`alreadyRegisteredAt` present). */
export interface RosterIntakeCrossClubConflict {
  rowNumber: number;
  clubId: string;
  playerNaturalKey: string;
  claimedBy: string;
  alreadyRegisteredAt?: string;
}

export interface RosterIntakeCommitResponse {
  batchId: string;
  created: number;
  /** Idempotent re-commit of an already-created row (ConditionalCheckFailed) —
   *  counted, never an error. */
  alreadyPresent: number;
  crossClubConflicts: RosterIntakeCrossClubConflict[];
  /** Authoritative post-write count per touched club (one `reconcilePlayerCount`
   *  per club, not per row). */
  playerCount: Record<string, number>;
}

// ── Structure intake (1.2) ──

/** POST /platform/tenants/:slug/structure-intake/parse body — base64 JSON, no S3
 *  round-trip (workbooks are small: 30–500KB, capped at 2MB base64-string length
 *  before decoding). */
export interface StructureIntakeParseRequest {
  filename: string;
  dataBase64: string;
}

export interface StructureSectionRow {
  raw: string;
  venue?: string;
}

/** One header-shaped block of rows from one sheet. NO league mapping, NO club
 *  resolution — both are operator UI choices made client-side (`matchClub` in
 *  intake-match.ts; league picks happen in the sections screen). */
export interface StructureSection {
  sheet: string;
  header: string;
  rows: StructureSectionRow[];
}

export interface StructureIntakeParseResponse {
  sections: StructureSection[];
  sheetsScanned: number;
  sheetsWithSections: number;
}

export const STRUCTURE_MAX_WORKBOOK_BYTES = 2 * 1024 * 1024;
export const STRUCTURE_COMMIT_MAX_CLUBS = 100;

export interface StructureClubTeamPlanRow {
  name: string;
  venue?: string;
}

/** A club's team plan for commit. Team ids are NOT sent — the server mints the
 *  `tm_${clubId}_${key}_${n}` ids so that convention stays enforceable in one place. */
export interface StructureClubPlan {
  leagues: string[];
  leagueTeams: Record<string, number>;
  teamRosters: Record<string, StructureClubTeamPlanRow[]>;
  firstTeamVenue?: string;
}

/** `overwrite` must be explicit `true` to replace an existing plan wholesale (the
 *  operator-confirmed mirror of the CLI's manifest-ownership rule) — omitted/false
 *  against a club with an existing plan comes back as a per-club 409, not a write. */
export interface StructureIntakeCommitClub {
  clubId: string;
  overwrite?: boolean;
  plan: StructureClubPlan;
}

/** `newLeagues` are client-side DRAFT leagues (from "Create league…" in the sections
 *  step) — nothing writes tenant config until commit; validated + appended
 *  fail-fast, before any club write. */
export interface StructureIntakeCommitRequest {
  newLeagues?: League[];
  clubs: StructureIntakeCommitClub[];
}

export interface StructureIntakeCommitClubResult {
  clubId: string;
  ok: boolean;
  error?: string;
  teams?: number;
  women?: number;
  juniors?: number;
}

export interface StructureIntakeCommitResponse {
  batchId: string;
  leaguesAppended: string[];
  clubs: StructureIntakeCommitClubResult[];
}

// ── Rep invites (1.3) ──

export interface TenantRepSummary {
  sub: string;
  email: string;
  clubIds: string[];
  invitedAt?: string;
  invitedBy?: string;
  status: 'pending' | 'active';
}

/** Included even for a club with zero reps — the coverage table's whole point is
 *  surfacing the gaps, not just what exists. */
export interface TenantRepCoverage {
  clubId: string;
  repCount: number;
}

export interface TenantRepsResponse {
  reps: TenantRepSummary[];
  coverage: TenantRepCoverage[];
}

/** POST /platform/tenants/:slug/reps body. `channels` absent/empty ⇒ link-only (no
 *  send attempted); `link` overrides the resolved tenant-canonical login URL. */
export interface InviteRepRequest {
  email: string;
  clubIds: string[];
  channels?: Channel[];
  link?: string;
}

export interface InviteRepResponse {
  sub: string;
  email: string;
  loginUrl: string;
  results?: SendResult[];
  /** Present only when the login URL fell back to the request Origin (a dormant
   *  tenant with no canonical web origin yet) instead of failing silently. */
  warning?: string;
}

/** One committee-extract candidate. `confidence` follows the extractor's scoring
 *  tiers (chair ⇒ high, vice/deputy ⇒ medium, any officer with an email ⇒ low). */
export interface CommitteeExtractCandidate {
  name: string;
  role: string;
  email?: string;
  cell?: string;
  confidence: 'high' | 'medium' | 'low';
  sheet: string;
  rowNumber: number;
}

/** `unparseable` covers a PDF/doc/image committee file — a designed 200 (the reps
 *  page's manual-form-plus-view-document path is a first-class equal, not an error
 *  state), never a failure the caller has to branch around specially. */
export type CommitteeExtractResponse =
  | { status: 'ok'; candidates: CommitteeExtractCandidate[] }
  | { status: 'unparseable'; reason: string };

/** POST /platform/tenants/:slug/clubs/:clubId/docs/:key/view-url — the operator twin
 *  of the tenant-side `getDocViewUrl` (same on-record objectKey gate), so the reps
 *  page can show a committee PDF beside the manual invite form. */
export interface PlatformDocViewUrlResponse {
  viewUrl: string;
  // The operator committee preview holds no docMeta of its own, so the route echoes the
  // stored file's contentType (+ objectKey + size) — enough for docPreviewKind to pick a
  // renderer and for the inline renderers to gate oversized files to the download path.
  contentType?: string;
  objectKey?: string;
  size?: number;
}
