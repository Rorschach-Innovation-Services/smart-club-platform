/** Domain types shared across the API. Mirrors the frontend's data shapes. */

// A venue clash pair, re-exported so `src/types.ts` on the frontend can mirror it without
// reaching into the clash-detection module. Type-only, so this re-export is erased and
// introduces no import cycle.
export type { Clash } from './venue-clash.js';

// Competition/season domain types live in the engine (packages/engine/src/types.ts), the
// single definition the web app and this API both compute over.
import type {
  Cadence,
  ClubTeam,
  Competition,
  CompetitionDefaults,
  CompetitionStructure,
  DerivationNote,
  EntrantSpec,
  FormatSpec,
  GroupPlan,
  IsoDate,
  IsoTime,
  League,
  SeasonBlock,
  SeasonBreak,
  SeasonCalendar,
  SeasonRun,
  Series,
  SeriesSchedule,
  StageRun,
  StageSchedule,
  StageSpec,
  TimeSlot,
  Venue,
  VenueStatus,
  VenueUnavailable,
  Weekday,
} from '../../engine/src/types.js';
export type {
  Cadence,
  ClubTeam,
  Competition,
  CompetitionDefaults,
  CompetitionStructure,
  DerivationNote,
  EntrantSpec,
  FormatSpec,
  GroupPlan,
  IsoDate,
  IsoTime,
  League,
  SeasonBlock,
  SeasonBreak,
  SeasonCalendar,
  SeasonRun,
  Series,
  SeriesSchedule,
  StageRun,
  StageSchedule,
  StageSpec,
  TimeSlot,
  Venue,
  VenueStatus,
  VenueUnavailable,
  Weekday,
};
export { TEAM_ID_PREFIX } from '../../engine/src/types.js';
export type {
  Umpire,
  UmpirePublic,
  OfficialRef,
  FixtureOfficials,
  FixtureOfficialsRecord,
} from '../../engine/src/umpires.js';
export type { ReportUmpireEntry, AppointedUmpire } from '../../engine/src/captainsReport.js';
import type { ReportUmpireEntry, AppointedUmpire } from '../../engine/src/captainsReport.js';
import type { InningsScorecardWire } from './medicoach-sync-contract.js';

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
  /** Small-caps brand strip above the logo (login, signup) and in the app header. */
  tagline?: string;
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

/** File formats a compliance doc can accept (see DOC_FORMAT_MIME in catalogue.ts). */
export type DocFormat =
  | 'pdf'
  | 'doc'
  | 'docx'
  | 'odt'
  | 'xls'
  | 'xlsx'
  | 'ods'
  | 'ppt'
  | 'pptx'
  | 'jpg'
  | 'jpeg'
  | 'png';

/**
 * One required compliance document in a tenant's catalogue (TenantConfig.requiredDocs).
 * `key` is the immutable identifier stored on Club.docs / Club.docMeta and embedded in
 * S3 object keys — never edited after first save, only added, archived, or (when no club
 * references it) removed. Behavior is declared as flags so the shared upload/escape-hatch
 * mechanics stay generic; the docMeta sentinel shapes are unchanged from the legacy
 * hardcoded catalogue (see safeguardingMeta / agmMeta normalizers).
 */
export interface RequiredDoc {
  key: string;
  name: string;
  desc?: string;
  /**
   * 'form' = satisfied by an on-platform form instead of a file upload. v1 restricts
   * this to the exco key (the only form-satisfiable path in the code) — see ADR 0009.
   */
  kind?: 'file' | 'form';
  /** Multi-file doc (safeguarding pattern): docMeta[key] = { files: [...] }. */
  multiFile?: boolean;
  /** multiFile only: files needed before the doc counts complete (default 2). */
  minFiles?: number;
  /** multiFile only: stored-file cap (default 10, hard cap 20). */
  maxFiles?: number;
  /** "We don't have these" escape hatch (financials pattern). Valid on single- and multiFile. */
  allowUnavailable?: boolean;
  /** "Meeting booked for <date>" escape hatch (AGM pattern). Single-file docs only. */
  allowMeetingBooked?: boolean;
  /** "Course booked for <date>" escape hatch (safeguarding pattern). multiFile docs only. */
  allowCourseBooked?: boolean;
  /** Accepted upload formats; absent ⇒ ['pdf','doc','docx'] (the legacy set). */
  accepts?: DocFormat[];
  /**
   * Filename keywords for the operator bulk-intake auto-classifier. Operator tooling:
   * stripped from the public GET /tenant payload, served only on /platform routes.
   */
  matchHints?: string[];
  /**
   * No longer required: excluded from completion counts and hidden from upload flows,
   * but stored files stay viewable/deletable. The sanctioned retire path — deleting a
   * key outright is blocked while any club still holds data under it.
   */
  archived?: boolean;
  /**
   * An optional record — archive material the tenant wants on file (disciplinary
   * records, correspondence), not a requirement. Uploadable and visible exactly like
   * any active doc (same escape hatches, same upload/view/delete routes), but excluded
   * from every completion count and gate. The server computes no completion itself;
   * the flag is honored by the frontend's count helpers (src/data.ts).
   */
  optional?: boolean;
  /**
   * Marks this doc as the canonical source for a self-serve wizard to parse (ADR 0009
   * follow-up, self-serve onboarding): the operator required-docs editor slugifies
   * names into per-tenant keys, so a wizard can never gate on literal keys like
   * `memberDatabase`/`committee` — those exist only via the Titans engineer catalogue
   * script. `docKeyForRole` resolves the ACTIVE doc holding this role, whatever its key.
   * At most one ACTIVE doc per role (validateRequiredDocs enforces it).
   */
  role?: 'memberDatabase' | 'committee';
}

/** An entry in the operator-managed club directory (TenantConfig.knownClubs). */
export interface DirectoryClub {
  /** Stable slug (clubIdFromName) — doubles as a clearance source partition. */
  id: string;
  name: string;
}

export interface TenantConfig {
  tenant: string;
  /**
   * Sport vertical (vertical.ts) — selects terminology, leadership labels, player profile
   * and module defaults. Absent ⇒ cricket, so legacy rows need no migration. Operator-only:
   * PUT /tenant/config strips it, only POST/PUT /platform/tenants writes it.
   */
  sport?: 'cricket' | 'football';
  /** Display season label, e.g. '2027'. Absent ⇒ the built-in label. Operator-only, like `sport`. */
  seasonLabel?: string;
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
  /**
   * Per-tenant compliance-doc catalogue. Absent ⇒ DEFAULT_REQUIRED_DOCS fallback at
   * read time (legacy tenants, no backfill — see resolveRequiredDocs); an explicit []
   * means "no compliance docs". Operator-only: PUT /tenant/config strips it, only
   * PUT /platform/tenants/:slug writes it (validated + referrer delete guard, ADR 0009).
   */
  requiredDocs?: RequiredDoc[];
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
   * email-only), 'selfServeBranding' (reserved, default false), 'medicoachSync' (default
   * false — the medicoach fixture/result sync puller runs for this tenant, ADR 0016).
   */
  features?: Record<string, boolean>;
  /**
   * Third-party integration settings. Operator-only (ADR 0006): PUT /tenant/config strips
   * it, only PUT /platform/tenants/:slug writes it.
   *  - medicoach.goLiveDate (YYYY-MM-DD): results for matches before this date never open
   *    captain's reports (Slice 2.3); stored now, read by the result hook.
   */
  integrations?: {
    medicoach?: { goLiveDate?: string };
  };
  /**
   * Operator "setup complete" milestone (D6) — informational only (the client is
   * publicly live from creation and every setting stays editable). Present ⇒ an
   * operator marked setup done; absent ⇒ still in setup. Stamped/cleared ONLY via
   * POST/DELETE /platform/tenants/:slug/setup-complete, never the config merge-patch.
   */
  setupCompletedAt?: string;
  setupCompletedBy?: string;
  /**
   * Tenant-configured defaults that replace sport- and union-specific constants (ADR 0014):
   * travel cost and venue aliases (config-only, no UI). Absent (or any absent field) ⇒ the
   * built-in fallback (`resolveCompetitionDefaults`, engine defaults.ts). Admin-level setup
   * data like leagues: writable by BOTH `PUT /tenant/config` and `PUT /platform/tenants/:slug`,
   * validated by `validateCompetitionDefaults`. The anonymous `GET /tenant` serves none of it.
   */
  competitionDefaults?: CompetitionDefaults;
  /**
   * Which transfer-certificate layout this tenant issues. Absent ⇒ 'classic' (see
   * resolveCertTemplate). Operator-only: PUT /tenant/config strips it.
   */
  clearanceCertTemplate?: CertificateTemplate;
  /**
   * Organisation contact details for the certificate footer; missing fields are omitted.
   * Operator-only: PUT /tenant/config strips it.
   */
  orgContact?: OrgContact;
  /**
   * Scheduled fixture reminders to club chairs (the FixtureReminders cron). Absent or
   * `enabled: false` ⇒ no reminders for this tenant. `leadDays` (1..30, ≤4 entries, deduped
   * + sorted on write) are the days-before-match a reminder goes out. Operator-only:
   * PUT /tenant/config strips it, only PUT /platform/tenants/:slug writes it (validated by
   * validateFixtureReminders), and GET /tenant/config does not project it.
   */
  fixtureReminders?: FixtureRemindersConfig;
  /**
   * Transfer windows: inclusive tenant wall-clock date ranges (ADR 0008) in which a clearance may
   * be opened. Absent OR empty ⇒ no restriction (an empty list must never lock a tenant out).
   * Outside every window a rep-initiated request 409s and a public registration that would open
   * a clearance records it auto-rejected instead (see transfer-windows.ts). Operator-only:
   * PUT /tenant/config strips it, only PUT /platform/tenants/:slug writes it (validated by
   * validateTransferWindows, sorted by start). Served on GET /tenant and GET /tenant/config
   * together with a server-computed `transferWindowStatus`.
   */
  transferWindows?: TransferWindow[];
}

/** `rejectedBy` on a clearance created already rejected because no transfer window was open. */
export const TRANSFER_WINDOW_REJECTOR = 'system:transfer-window';

/** One transfer window (see TenantConfig.transferWindows). Dates are YYYY-MM-DD, inclusive. */
export interface TransferWindow {
  label: string;
  start: string;
  end: string;
}

/**
 * Whether transfers are open on a given tenant day: `current` is the window containing it,
 * `next` the earliest window starting after it. Served only when windows are configured.
 */
export interface TransferWindowStatus {
  open: boolean;
  current?: TransferWindow;
  next?: TransferWindow;
}

/** Channels a fixture reminder may go out on. */
export type FixtureReminderChannel = 'email' | 'whatsapp';

/** Per-tenant fixture-reminder settings (see TenantConfig.fixtureReminders). */
export interface FixtureRemindersConfig {
  enabled: boolean;
  leadDays: number[];
  channels: FixtureReminderChannel[];
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
    /** Number of playing fields/pitches at the ground (whole number 0–99). */
    pitchCount?: number;
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
  /**
   * The chair's reminders choice: set by the onboarding modal and the club-home toggle.
   * The FixtureReminders cron skips a club only when this is explicitly `false` — absent
   * counts as opted in, because CLI-imported clubs never pass through the onboarding modal
   * and would otherwise silently never get reminders (the tenant's `fixtureReminders.enabled`
   * is the master switch).
   */
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
   * A 'clearance-approved' / 'clearance-rejected' row is recorded on BOTH clubs when the union
   * office resolves a clearance (override → approved, reject → rejected). A 'clearance-reopened'
   * row is recorded on BOTH clubs when the union office reopens a previously rejected clearance
   * (source chair gets the pending template + preamble; the destination chair gets an email-only
   * notice, WhatsApp logged skipped). The daily cap counts `kind === 'clearance'` only, so these
   * resolution/reopen notices never consume it.
   */
  kind?:
    | 'invite'
    // A `staff-invite` row is a bulk staff (chair/coach/officer) invite recorded on each of
    // the person's clubs by the contact-import CLI — labelled distinctly from the self-serve
    // 'invite' so an admin auditing a club can tell an imported invite from an onboarding one.
    | 'staff-invite'
    | 'fixtures'
    | 'reglink'
    | 'clearance'
    | 'clearance-approved'
    | 'clearance-rejected'
    | 'clearance-reopened'
    // Veterans squad-selection requests (ADR 0013). A `veterans-request` row is the primary
    // chair's heads-up recorded when a veterans club requests one of the club's players. A
    // `veterans-request-accepted` / `veterans-request-declined` row is recorded on the veterans
    // club (both clubs when the union office resolves as an override). Email-only, uncapped.
    | 'veterans-request'
    | 'veterans-request-accepted'
    | 'veterans-request-declined'
    // Fixture postponement negotiation (ADR 0015). `postponement-request` is the opposing
    // chair's heads-up when a request opens; `postponement-counter` the other chair's when a
    // side counter-proposes; `postponement-agreed` / `postponement-admin-final` are recorded on
    // BOTH clubs when the new date applies (chair agreement / union override);
    // `postponement-declined` / `postponement-withdrawn` on the counterpart club. Email-only.
    | 'postponement-request'
    | 'postponement-counter'
    | 'postponement-agreed'
    | 'postponement-admin-final'
    | 'postponement-declined'
    | 'postponement-withdrawn'
    // Scheduled fixture reminder to the chair (FixtureReminders cron), one row per channel,
    // idempotency-keyed `fixture-reminder-<targetDate>-<channel>`.
    | 'fixture-reminder'
    // Destination chair's heads-up that a clearance opened INTO the club (recorded on the
    // destination). A separate kind so it never counts toward the source-club daily cap.
    | 'clearance-inbound'
    // Pending-clearance nudge to the source chair (admin "Send reminder" or the ClearanceReminders
    // cron), keyed `clearance-<id>-reminder-<date>-<channel>`. Bypasses the daily cap.
    | 'clearance-reminder';
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
  /**
   * `player-export`: the admin register download. `medicoach-export`: the export-medicoach
   * CLI's bundle, written only under `--confirm` (actor is the CLI, counts are per entity).
   */
  kind: 'player-export' | 'medicoach-export';
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
  /** Where the data went (medicoach-export only). */
  destination?: 'medicoach';
  /** Per-entity counts (medicoach-export only): the bundle's `counts` block. No PII. */
  counts?: Record<string, number>;
  /** League keys the export covered (medicoach-export only). */
  leagues?: string[];
}

/**
 * What one tenant-wide player erasure (`DELETE /admin/players/:nk`) removed, per category.
 * Counts only — returned to the admin and stored on the audit row; never names the person.
 */
export interface PlayerErasureCounts {
  /** PLAYER# rows deleted (one per club the person was registered at). */
  playerRows: number;
  /** Clearances deleted outright (canonical + mirror each count once). */
  clearances: number;
  /** Registration reviews (REGREVIEW#) deleted. */
  registrationReviews: number;
  /** Veterans squad-selection requests deleted (canonical + mirror each count once). */
  veteransRequests: number;
  /** Uploaded objects purged: ID documents (rows, snapshots, held reviews) + certificate PDFs. */
  documents: number;
  /** CERT# certificate-registry items deleted (their /verify lookups now 404). */
  certificates: number;
  /** Captain's reports that named the person and were scrubbed in place (not deleted). */
  captainsReportsScrubbed: number;
  /** Cached medicoach scorecards (FIXSCORECARD#) that named the person: scrubbed and marked terminal. */
  scorecardsScrubbed: number;
  /**
   * Captain's reports whose scorecard correction `feedback` named the person and was scrubbed
   * in place (also counted in `captainsReportsScrubbed`). Absent on audit rows written before.
   */
  reportScorecardFeedbackScrubbed: number;
  /**
   * Pending REPORTOPEN# markers whose captain ref was this person: the ref is scrubbed, the
   * marker kept (its retry then addresses the scoring side's chair instead).
   */
  reportOpenMarkers: number;
}

/**
 * Audit row for one player erasure (`PLAYERERASE#<iso>#<id>` under the tenant pk). PII-free by
 * design: the actor and the per-category counts only — the erased person is not identifiable
 * from it (no name, natural key or contact).
 */
export interface PlayerEraseLogEntry {
  id: string;
  kind: 'player-erasure';
  /** Human-readable actor (caller email), mirroring ExportLogEntry.by. */
  by: string;
  at: string;
  counts: PlayerErasureCounts;
}

/** Onboard payload: a Club plus the flat chair contact fields the admin form sends. */
export type ClubSpec = Partial<Club> & {
  chairEmail?: string;
  chairCell?: string;
};

export type WithheldField = 'venue' | 'time';

/** Stored object metadata for a player's uploaded ID document (parallels club docMeta). */
export interface PlayerIdDocMeta {
  objectKey: string;
  size: number;
  uploadedAt: string;
  /** MIME type the file was signed/stored as (ID docs allow image/* or PDF). */
  contentType?: string;
}

/**
 * Roster lifecycle. `'clearance-rejected'` is LEGACY (read-only): reject no longer writes it —
 * a rejected transfer now cancels the move (player active at the source club) rather than
 * flagging the destination row. The value is kept so rows written before this change still
 * render; no new code sets it.
 */
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
  /**
   * Veterans second-club affiliation (capture-only): the club this player plays veterans
   * cricket for, when it is not their own. `veteransClub` (the name) is DERIVED server-side from the
   * validated club (never trusted from the client — same rename-drift tolerance as `lastClub`)
   * and `veteransClubId` is always set alongside it. A `VETAFFIL#` record under that club
   * mirrors this pointer while the row is `active` (write-on-activation); it does NOT create a
   * second roster row and never affects playerCount/demographics/clearances.
   */
  veteransClub?: string;
  veteransClubId?: string;
  battingHand?: 'Right' | 'Left';
  bowlingHand?: 'Right' | 'Left';
  battingType?: string;
  /** Empty string ⇒ not a bowler. */
  bowlerType?: string;
  isAllRounder?: boolean;
  isWk?: boolean;
  /** Playing position — only for 'positions'-profile verticals, validated against the profile list. */
  position?: string;
  /**
   * Set when a registration moved this person between clubs without a clearance (the tenant's
   * clearances module is off): on the new row it names the club they left, on the deactivated
   * old row the club they joined.
   */
  transferNote?: string;
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
   * LEGACY (read-only). Was set when a registration-origin clearance was rejected under the
   * old behaviour: the player stayed on this (current) club's roster flagged
   * 'clearance-rejected'. Reject no longer writes these — it now cancels the move (see
   * repo.rejectClearance) — but pre-existing rows may still carry them, so activation paths
   * still scrub them (see rekeyPlayer / resolveClearance). Meaningful ONLY while
   * status === 'clearance-rejected'.
   */
  clearanceRejectedAt?: string;
  clearanceRejectedReason?: string;
  /**
   * Marks a MINIMAL source-club stand-in written by the registration-clearance backfill
   * (backfill-registration-clearance.ts) or the admin reassign — name/ID/team only, no contact
   * details and no ID document. Reject's case detection replaces such a row with the real
   * registration rather than reactivating the stub (case B″). Legacy placeholders written
   * before this flag are recognised by heuristic (pending AND no idDocMeta AND no cell AND no
   * email AND no registeredVia); see repo.isPlaceholder.
   */
  placeholder?: true;
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

/**
 * A veterans second-club affiliation record (stored under the VETERANS club — see
 * `veteransAffiliationKey`). A denormalised index off the primary player row's
 * `veteransClubId`, written only while that row is `active` (write-on-activation). It exists so
 * a veterans club's portal can list who plays veterans cricket for it without a cross-club scan.
 * `naturalKey` is the player's ID number (PII) — the affiliates GET returns
 * {@link VeteransAffiliatePublic}, which projects it out.
 */
export interface VeteransAffiliation {
  /** The player's ID number — the same key the primary player row is addressed by. PII. */
  naturalKey: string;
  /**
   * Display snapshot of the player's name, captured when the record was (re-)written. Like
   * {@link primaryClubName} it can drift from later roster edits to the primary row — accepted:
   * the record is re-written on each lifecycle transition, so it re-syncs on the next one.
   */
  playerName: string;
  /** The veterans club this record is partitioned under (the affiliation target). */
  veteransClubId: string;
  /** The player's OWN (primary) club — where the pointing player row lives. */
  primaryClubId: string;
  primaryClubName: string;
  createdAt: string;
  /** How the affiliation was declared. */
  source: 'registration' | 'admin' | 'portal';
}

/** The affiliates GET projection: everything a veterans club may see, WITHOUT the PII naturalKey. */
export type VeteransAffiliatePublic = Omit<VeteransAffiliation, 'naturalKey'>;

/** Lifecycle of a veterans squad-selection request (ADR 0013). */
export type VeteransRequestStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn';

/**
 * A veterans squad-selection request (ADR 0013): a veterans club has FOUND a player tenant-wide
 * and asks the player's PRIMARY club (the POPIA responsible party) to confirm the affiliation.
 * Accept calls the same `setPlayerVeteransClub` the capture-only register/edit paths use, so the
 * `VETAFFIL#` write-on-activation invariant is untouched and no second roster row / playerCount /
 * demographics change occurs.
 *
 * Stored as a CANONICAL row under the primary club (`VETREQ#<id>`, gsi1 for the admin listing,
 * carrying `playerNaturalKey`) + a MIRROR under the veterans club (`OUTBOUND_VETREQ#<id>`, no
 * gsi1, no `playerNaturalKey`). See `veteransRequestKey` / `outboundVeteransRequestKey`.
 */
export interface VeteransRequest {
  id: string;
  /**
   * The primary player row's identity hash. CANONICAL ROW ONLY — the mirror omits it so the
   * requesting (veterans) club never receives the player's key (it only ever saw an opaque HMAC
   * handle from the finder). Present on the canonical for the accept path to read the player row.
   */
  playerNaturalKey?: string;
  /**
   * HMAC-SHA256(secret, `tenant|primaryClubId|naturalKey`) — the opaque handle the finder returns
   * and the request carries. Safe to expose (irreversible to the natural key); used to re-match
   * the player against the primary club's rows at create time.
   */
  candidateId: string;
  /** Denormalized "First Last" for display + audit (survives the affiliation write). */
  playerName: string;
  /** The player's OWN club — the partition owner of the canonical row and who confirms. */
  primaryClubId: string;
  primaryClubName: string;
  /** The veterans club that made the request — the partition owner of the mirror row. */
  veteransClubId: string;
  veteransClubName: string;
  /** Veterans league the request targets, when the veterans club plays more than one. */
  leagueKey?: string;
  note?: string;
  requestedAt: string;
  /** Email of the veterans-club rep (or admin) who made the request. */
  requestedBy?: string;
  status: VeteransRequestStatus;
  resolvedAt?: string;
  resolvedBy?: string;
  /** Which surface resolved it — the primary club portal, or a union-admin override. */
  resolvedVia?: 'portal' | 'admin';
  declineReason?: string;
  /** TTL (epoch seconds): set on a terminal (resolved) row so it self-expires after 90 days. */
  expiresAt?: number;
  version: number;
}

/**
 * A veterans request as HTTP responses return it: the stored row WITHOUT the PII
 * `playerNaturalKey`. The mirror already lacks it; the canonical is projected through this before
 * it leaves the API — the admin list, the outbound (mirror) array and the single-request replies
 * are all stripped. The ONE exception is the INBOUND array of `GET /clubs/:id/veterans-requests`:
 * those canonical rows live in the requesting club's OWN partition (which already receives the
 * natural key on its roster GET), so they ship with `playerNaturalKey` intact.
 */
export type VeteransRequestPublic = Omit<VeteransRequest, 'playerNaturalKey'>;

/**
 * One proposed new date in a fixture postponement negotiation (ADR 0015). `by` names the side
 * that proposed it. `time` is carried only while the fixture's kick-off time is revealed to
 * clubs (ADR 0011); a proposal without `time` keeps the fixture's current kick-off. `venueId` /
 * `venueName` are set by an admin override only — chairs negotiate the date, not the ground.
 */
export interface PostponementProposal {
  by: 'requesting' | 'opposing' | 'admin';
  date: string;
  time?: string;
  /** Admin only. */
  venueId?: string;
  /** Admin only. */
  venueName?: string;
  note?: string;
  at: string;
  byUser: string;
}

/** Lifecycle of a postponement request (ADR 0015). `applied` / `admin-final` moved the fixture. */
export type PostponementStatus = 'open' | 'applied' | 'admin-final' | 'declined' | 'withdrawn';

/**
 * A fixture postponement request (ADR 0015): one club asks to move a released fixture to a new
 * date; the clubs negotiate by counter-proposal and the agreed date auto-applies to the fixture.
 * The union admin may override with a final date/time/venue at any point (even after a chair
 * agreement applied), which the chairs then acknowledge.
 *
 * Stored as a CANONICAL row under the OPPOSING club (`POSTPONE#<id>`, gsi1 for the admin listing)
 * + a MIRROR under the REQUESTING club (`OUTBOUND_POSTPONE#<id>`, no gsi1). Every transition
 * rewrites both rows in one transaction conditioned on the canonical, so the two never drift.
 */
export interface PostponementRequest {
  id: string;
  seriesId: string;
  fixtureId: string;
  /** The club that opened the request — partition owner of the mirror row. */
  requestingClubId: string;
  /** The fixture's other club — partition owner of the canonical row. Derived server-side. */
  opposingClubId: string;
  /** Snapshot of the fixture's date when the request opened — the accept-time baseline. */
  originalDate: string;
  /** Snapshot of the kick-off time at open; absent when the time was withheld (or unset). */
  originalTime?: string;
  reason?: string;
  /** Every proposal in order; the LAST one is the current proposal on the table. */
  proposals: PostponementProposal[];
  /** Whose move it is while `open`; `none` once terminal. */
  awaiting: 'requesting' | 'opposing' | 'none';
  status: PostponementStatus;
  /** clubId → acknowledgement of an admin-final ruling. Reset on every new admin ruling. */
  acknowledgements?: Record<string, { at: string; byUser: string }>;
  requestedAt: string;
  requestedBy: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedVia?: 'portal' | 'admin';
  declineReason?: string;
  /** TTL (epoch seconds): set on a terminal row so it self-expires after 90 days. */
  expiresAt?: number;
  version: number;
}

/**
 * The finder response row (GET /clubs/:id/veterans-candidates): everything a requesting club may
 * see about a tenant-wide player. NEVER carries the natural key / ID number / dob / contact — the
 * `candidateId` HMAC handle is the only identifier that leaves the API.
 */
export interface VeteransCandidate {
  candidateId: string;
  playerName: string;
  primaryClubId: string;
  primaryClubName: string;
}

export type ClearanceStatus = 'pending' | 'approved' | 'admin-override' | 'rejected';

/**
 * What a reject did to the player, in terms the UI can speak truthfully (public — set on the
 * clearance at reject, cleared on reopen). Mapped from the internal {@link RejectCase}:
 *   request/dest-deleted → 'source-reactivated' (the move is cancelled; player at the source club)
 *   moved-over-placeholder/moved-to-source → 'moved-to-source' (the registration moved to the source club)
 *   dest-activated → 'stays-at-destination' (source is off-system; player stays at the destination)
 *   window-closed → 'not-registered' (registration outside a transfer window; no row was ever
 *     written, so the player remains unregistered / at their current club)
 */
export type RejectOutcome =
  | 'source-reactivated'
  | 'moved-to-source'
  | 'stays-at-destination'
  | 'not-registered';

/**
 * How a reject was actually applied, derived from the LIVE row state at reject time (never from
 * a stored flag). Internal: it rides the canonical only (stripped from the mirror and from every
 * HTTP response) as part of {@link RejectSnapshot}, and drives the reversible Reopen.
 *   request              — rep-initiated transfer (no destination row); source row → active
 *   dest-deleted         — registration-origin; destination row deleted, source reactivated (B) or left as-is (B′)
 *   moved-over-placeholder— the source held only a placeholder; the real registration replaces it (B″)
 *   moved-to-source      — the source club exists but held no row; the registration is moved there (C)
 *   dest-activated       — the source is an off-system directory entry; the player stays at the destination (D)
 *   window-closed        — a registration outside every transfer window, created ALREADY rejected
 *                          (repo.createAutoRejectedClearance); never produced by detectRejectCase
 */
export type RejectCase =
  | 'request'
  | 'dest-deleted'
  | 'moved-over-placeholder'
  | 'moved-to-source'
  | 'dest-activated'
  | 'window-closed';

/**
 * The pre-reject row state a Reopen restores. CANONICAL ONLY — never mirrored, never returned
 * over HTTP (the repo read layer and publicClearance strip it). `destRow` is the deleted
 * destination registration (B/B′), restored byte-equal on reopen; `placeholderRow` is the
 * source placeholder replaced in B″, restored on reopen; C/D carry neither (reopen moves the
 * LIVE row so post-reject edits survive). A rejected-and-never-reopened clearance retains this
 * snapshot — and, via it, the destination's ID-document object keys — indefinitely, so erasure
 * paths must collect them (see repo.clearanceDocObjectKeys; POPIA).
 */
export interface RejectSnapshot {
  case: RejectCase;
  destRow?: PlayerRegistration;
  placeholderRow?: PlayerRegistration;
  sourceReactivated?: boolean;
  /**
   * window-closed only: the destination row the registration WOULD have written (status
   * 'clearance-pending', incl. idDocMeta). Never written as a player row; Reopen puts it at the
   * destination. Its ID-doc keys are collected by repo.clearanceDocObjectKeys (POPIA).
   */
  pendingPlayer?: PlayerRegistration;
}

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
   * What the reject did, in UI-truthful terms (public; set on reject, cleared on reopen).
   * Rides the canonical AND the mirror so both clubs' portals can word the outcome correctly.
   */
  rejectOutcome?: RejectOutcome;
  /**
   * The pre-reject row state a Reopen restores. CANONICAL ONLY — stripped from the mirror by
   * clearanceItems and from every HTTP response by publicClearance / the repo read layer.
   */
  rejectSnapshot?: RejectSnapshot;
  /** When/who reopened a previously rejected clearance (rejected → pending). Cleared on a re-reject. */
  reopenedAt?: string;
  reopenedBy?: string;
  /**
   * Free text on an override: why the union issued the clearance on the clubs' behalf. Written
   * only on an ADMIN override, but SHOWN TO BOTH CLUBS — it rides the mirror as well as the
   * canonical, exactly like rejectReason. Override remains the DISPOSAL path for a clearance
   * that should never have existed (junk registration, or a player who named a club they never
   * played for): reject now MOVES such a registration to the named club rather than discarding
   * it, and deletion is blocked while pending, so override-then-delete is the only clean exit —
   * and without this the resolved record reads as a genuine approved transfer.
   */
  overrideReason?: string;
  /** Email of the union admin who overrode, mirroring rejectedBy. Admin overrides only. */
  overriddenBy?: string;
  /**
   * Email of the source-club rep who issued the clearance (ECTA: the approval's recorded
   * identity). Set on a CLUB approval only; absent on pre-feature approvals.
   */
  clubApprovedBy?: string;
  /**
   * Pointer to the issued transfer certificate (see CertificateRecord). Rides the canonical
   * AND the mirror so both clubs can view it. Written only by the certificate issuer.
   */
  certificateMeta?: CertificateMeta;
  /**
   * True when the union override opted OUT of a certificate (a disposal, not a real transfer).
   * Rides both rows; the issuer and both view-url routes refuse such a clearance.
   */
  certificateDeclined?: boolean;
  version: number;
}

export type CertificateTemplate = 'classic' | 'confirmation';

/** The clearance-side pointer to an issued certificate. */
export interface CertificateMeta {
  serial: string;
  objectKey: string;
  contentType: string;
  generatedAt: string;
  template: CertificateTemplate;
  /** sha256 of the stored PDF — lets a missing registry item be rebuilt from this pointer. */
  sha256: string;
  /** Issued with the historical-records approval copy (backfill --include-imported). */
  historical?: boolean;
  revokedAt?: string;
}

/** One side of the approval record as the certificate states it. */
export interface CertificateApproval {
  /** 'club' = the club's own portal action; 'admin' = union override; others are copy-only. */
  kind: 'club' | 'admin' | 'registration' | 'not-recorded' | 'historical';
  by?: string;
  at?: string;
}

/**
 * The GLOBAL certificate registry item (pk `CERT#<serial>`, sk `META`) — the verify page's
 * source of truth. Not tenant-enumerable (like TOKEN#), so erasure harvests serials from the
 * clearance rows' certificateMeta. Carries only the masked ID: it is served publicly.
 */
export interface CertificateRecord {
  serial: string;
  tenant: string;
  clearanceId: string;
  fromClubId: string;
  toClubId: string;
  fromClubName: string;
  toClubName: string;
  playerName: string;
  idNumberMasked: string;
  orgName: string;
  effectiveDate: string;
  issuedAt: string;
  transferringApproval: CertificateApproval;
  acquiringApproval: CertificateApproval;
  template: CertificateTemplate;
  objectKey: string;
  sha256: string;
  kid: string;
  /** Compact JWS (ES256) over the canonical certificate facts. */
  signedPayload: string;
  /**
   * SPKI PEM of the key that signed `signedPayload` (whose id is `kid`). Travels with the
   * record so verification survives a future key rotation.
   */
  publicKeyPem: string;
  status: 'valid' | 'revoked';
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
}

/** Operator-set organisation contact details printed in the confirmation template's footer. */
export interface OrgContact {
  regNo?: string;
  address?: string;
  phone?: string;
  website?: string;
  email?: string;
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

/**
 * A medicoach-owned fixture result (ADR 0016), stored as its own FIXRESULT# item per fixture
 * so a whole-series PATCH can never overwrite or drop it. Written ONLY by the sync puller.
 *
 * Ordering: `orderAt` is the newest of `recordedAt` / `clearedAt` ever applied. A pulled
 * result is stored only when its `recordedAt` is newer, a clear only when its
 * `resultClearedAt` is newer — so an out-of-order or replayed change can never win. A
 * cleared result keeps its item as a tombstone (`cleared: true`, no score fields).
 *
 * No player ref is stored here (POPIA): a pulled result's `captainRef` lives only on the
 * REPORTOPEN# marker while its captain's reports are pending (see `ReportOpenMarker`).
 */
export interface StoredFixtureResult {
  seriesId: string;
  fixtureId: string;
  /** The fixture ref medicoach sent (fixture refs carry no personal data). */
  ref: string;
  orderAt: string;
  cleared?: boolean;
  clearedAt?: string;
  homeScore?: string | null;
  awayScore?: string | null;
  summary?: string | null;
  winner?: 'home' | 'away' | 'tie' | 'none' | null;
  method?: string | null;
  noResult?: boolean;
  resultSource?: 'live' | 'manual' | 'import';
  recordedAt?: string;
  scoringSide?: 'home' | 'away' | null;
  medicoachMatchUrl?: string | null;
  /** The medicoach match (PostMatchAnalysis) id, when the sender gave one — scorecard key. */
  medicoachMatchId?: string;
  /** The medicoach tournament id of that match — required alongside it for the scorecard. */
  medicoachTournamentId?: string;
  storedAt: string;
}

/**
 * A medicoach scorecard for one fixture (FIXSCORECARD#), fetched by the sync after a result
 * is stored and re-fetched by the sweep while it may still change. Written by the sync
 * (medicoach-sync/scorecard-fetch.ts) and, to scrub names, by player erasure. Holds player
 * names — personal data, erased with the tenant / cohort / series like FIXRESULT#.
 *
 * `terminal: true` = this fixture can never have a scorecard (medicoach answered 404, or kept
 * answering `available: false` for 3 days — until then such a stub is re-checked, with
 * `fetchedAt` the first `available: false` and `lastCheckedAt` the latest): the sweep stops
 * retrying. A newly stored result still re-fetches.
 * Player erasure also sets it on an AVAILABLE card it scrubbed, so the sweep never re-fetches
 * the card (and with it the erased name) from medicoach.
 */
export interface StoredFixtureScorecard {
  seriesId: string;
  fixtureId: string;
  medicoachMatchId: string;
  medicoachTournamentId: string;
  schemaVersion: 1;
  /** ISO instant of the fetch that produced this row. */
  fetchedAt: string;
  available: boolean;
  matchState?: string;
  innings?: InningsScorecardWire[];
  terminal?: boolean;
  /**
   * ISO instant of the last fetch that found no card while this AVAILABLE one was kept (a
   * 404 / `available: false` never overwrites an available card).
   */
  lastCheckedAt?: string;
}

/** The read-only result joined onto a fixture in GET /series (no captain/player data). */
export interface FixtureResultView {
  homeScore: string | null;
  awayScore: string | null;
  summary: string | null;
  winner: 'home' | 'away' | 'tie' | 'none' | null;
  method: string | null;
  noResult: boolean;
  source: 'live' | 'manual' | 'import';
  recordedAt: string;
  medicoachMatchUrl: string | null;
}

/** One SYNCLOG# audit row: counts and outcomes only — never player refs. */
export interface SyncLogEntry {
  id: string;
  at: string;
  /** `write`/`cli`: a smart-club series write (admin/API or a CLI), not a sync run. */
  trigger: 'cron' | 'manual' | 'write' | 'cli';
  outcome: 'ok' | 'error';
  pages: number;
  fixtures: number;
  counts: {
    resultsStored: number;
    resultsStale: number;
    resultsCleared: number;
    unmapped: number;
    slotsFilled: number;
    scheduleDiffers: number;
    /** Inbound schedule changes applied (medicoach newer). Absent on pre-Slice-3 rows. */
    scheduleApplied?: number;
    /** Inbound schedule changes dropped because smart club's change is newer. */
    scheduleStale?: number;
    /** Inbound schedule changes held as SYNCCONFLICT# for admin review. */
    scheduleConflicts?: number;
  };
  /** Fixture refs whose medicoach schedule differs from smart club's. */
  scheduleDiffersRefs?: string[];
  /** Refs whose inbound schedule was dropped as older than smart club's (most-recent-wins). */
  scheduleStaleRefs?: string[];
  /**
   * `push` rows record an outbox flush (Slice 4); `new-fixtures` a write that added fixtures
   * to a mapped series which medicoach does not have (needs a bundle top-up); absent ⇒ a pull.
   */
  kind?: 'pull' | 'push' | 'new-fixtures';
  /** Refs of the new fixtures (`new-fixtures` rows only). Fixture refs carry no PII. */
  newFixtureRefs?: string[];
  /** Outbox flush outcome counts (push rows only). */
  push?: SchedulePushCounts;
  /** Technical failure text (field paths and statuses only — never a payload value). */
  error?: string;
  /** `error` in plain language for the admin page (medicoach-sync/explain.ts). */
  message?: string;
}

/** SYNCHEALTH#<tenant> — the last successful and the last failed sync run (admin page). */
export interface SyncHealth {
  lastAttemptAt?: string;
  /** A pull that completed (dry runs never count). */
  lastSuccessAt?: string;
  lastErrorAt?: string;
  /** Technical text (the "Details" toggle); the page explains it with explainSyncError. */
  lastError?: string;
}

/** What one outbox flush did (Slice 4). */
export interface SchedulePushCounts {
  sent: number;
  applied: number;
  stale: number;
  unchanged: number;
  unmapped: number;
  errors: number;
}

/** A smart-club fixture schedule in the wire shape (`SyncSchedule`, contract v1). */
export interface SyncScheduleSnapshot {
  scheduledTime: string | null;
  timeTbc: boolean;
  dateTbc: boolean;
  venue: string | null;
  postponed: boolean;
  cancelled: boolean;
  changedAt: string;
}

/**
 * PENDINGSYNC#<ref> — the latest smart-club schedule for one mapped fixture, waiting to be
 * pushed to medicoach. Collapsed per ref (a newer edit overwrites the row and resets the
 * attempt count); deleted only when medicoach answers a success status for THIS snapshot.
 */
export interface PendingScheduleSync {
  ref: string;
  seriesId: string;
  fixtureId: string;
  schedule: SyncScheduleSnapshot;
  origin: ScheduleChangeOrigin;
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  /**
   * The series withholds venue and/or time from clubs (ADR 0011), so this snapshot must not
   * reach medicoach's public match centre yet: the flush skips it until the series is fully
   * revealed (the reveal re-queues the series with its real schedule).
   */
  heldUntilReveal?: boolean;
}

/** Who changed a fixture's schedule. `medicoach` = the Slice 3 inbound apply (never echoed). */
/** `operator-upload` = the operator console's reminder-fixtures upload (writes like a CLI). */
export type ScheduleChangeOrigin = 'admin' | 'generate' | 'cli' | 'medicoach' | 'operator-upload';

/**
 * SYNCCONFLICT#<ref> — a medicoach schedule change held for admin review instead of applied.
 * The latest proposal per ref wins; `notifiedAt` records the one admin email per proposal.
 */
export interface SyncConflict {
  ref: string;
  seriesId: string;
  fixtureId: string;
  /** Display context for the inbox (names, never refs of people). */
  seriesName?: string;
  matchLine?: string;
  current: { date?: string; time?: string; venue?: string; status?: string; dateTbc?: boolean };
  proposed: SyncScheduleSnapshot;
  fields: string[];
  reason: 'venue-unresolved' | 'clash';
  /** Human lines: the clashes, or the venue name that did not resolve. */
  detail: string[];
  detectedAt: string;
  notifiedAt?: string;
}

/** REPORTOPEN#<ref> — captain's reports still to open + notify for a stored result. */
export interface ReportOpenMarker {
  ref: string;
  seriesId: string;
  fixtureId: string;
  /** The stored result's recordedAt this marker was written for. */
  recordedAt: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  /**
   * The result's captain player ref (a hashed ID number — PII), kept ONLY while the reports
   * are pending so a retry can still address the captain. Deleted with the marker; never
   * returned by any route, logged or written to SYNCLOG.
   */
  captainRef?: string | null;
}

// ── Captain's reports (ADR 0016, Slice 2) ──

export type CaptainsReportStatus = 'pending' | 'submitted' | 'void';

/**
 * Who the report link went to. `memberId` is an OPAQUE random id minted when the report
 * opened (never a player's natural key — that is a hashed ID number); the submit-once link is
 * bound to it, so re-addressing a report kills the old link. `kind: 'portal'` marks a report
 * a club filed by hand from the portal (no link was sent).
 */
export interface CaptainsReportRecipient {
  kind: 'captain' | 'chair' | 'portal';
  memberId: string;
  name: string;
  /** Set when the chair sent the report on to the match captain ("Send to captain"). */
  forwardedBy?: { name: string; via: 'link' | 'portal'; at: string };
}

/**
 * Why a notice channel was not sent: `no-contact` (no email AND no cell on file), `no-email`,
 * `no-cell`, `dry-run` (NOTIFY_DRY_RUN / no provider credentials), `template-pending` (no
 * approved WhatsApp template), `send-failed` (the provider refused or errored).
 */
export type CaptainsReportDeliveryReason =
  | 'no-contact'
  | 'no-email'
  | 'no-cell'
  | 'dry-run'
  | 'template-pending'
  | 'send-failed';

/**
 * One channel of one notice about a report (the opening, a chair's forward, the reminder).
 * Never carries an address. `messageId` (the provider's id) is kept server-side only: the
 * WhatsApp status webhook matches on it; views strip it.
 */
export interface CaptainsReportDelivery {
  channel: 'email' | 'whatsapp';
  status: 'sent' | 'failed' | 'skipped';
  reason?: CaptainsReportDeliveryReason;
  at: string;
  messageId?: string;
  purpose: 'opened' | 'forwarded' | 'reminder';
  recipientKind: 'captain' | 'chair';
  /** Meta's latest delivery status for a sent WhatsApp message (status webhook). */
  providerStatus?: 'sent' | 'delivered' | 'read' | 'failed';
  providerAt?: string;
  /** Meta's error title for a failed WhatsApp message (no address, no body). */
  providerError?: string;
}

/** A captain's report's answer on the match scorecard (see `CaptainsReport.scorecard`). */
export interface CaptainsReportScorecardAnswer {
  action: 'confirmed' | 'correction';
  feedback?: string;
  againstFetchedAt?: string;
  stale?: true;
}

/**
 * A captain's report: `CAPREPORT#<seriesId>#<fixtureId>#<clubId>`, one per fixture side.
 * Opened `pending` when medicoach reports a result (or created by hand from the portal),
 * `submitted` exactly once, `void` when the result is cleared before submission. There is no
 * due date: the link expires 7 days after the match and the club can file from the portal
 * at any time.
 */
export interface CaptainsReport {
  /** `<seriesId>~<fixtureId>~<clubId>` — URL-safe and deterministic. */
  id: string;
  seriesId: string;
  fixtureId: string;
  clubId: string;
  status: CaptainsReportStatus;
  /**
   * `auto` opened by a pulled result; `manual` filed from the portal for a listed fixture;
   * `manual-unlisted` filed for a match that is not in the fixture list (seriesId `unlisted`).
   */
  source: 'auto' | 'manual' | 'manual-unlisted';
  /** The medicoach sync ref for the fixture (fixture refs carry no personal data). */
  fixtureRef?: string;
  matchDate: string;
  /** LEGACY: reports opened before the due date was dropped carry one; ignored, never served. */
  deadline?: string;
  side: 'home' | 'away';
  clubName: string;
  opponentName: string;
  competition: string;
  venue?: string;
  resultSummary?: string | null;
  /** The appointed umpires when the report opened (FIXOFFICIALS#). */
  umpiresSnapshot: AppointedUmpire[];
  recipient: CaptainsReportRecipient;
  captainName: string;
  umpires: ReportUmpireEntry[];
  general: string;
  declaration?: boolean;
  /**
   * The answer on the match scorecard (FIXSCORECARD#): asked — and required to submit —
   * whenever an available scorecard is attached. `feedback` (≤ 2,000 chars) is required for a
   * correction, which emails the platform operators. `againstFetchedAt` is the card version
   * answered against (server-clamped, set at submission). `stale`: a newer card arrived after
   * that version — server-only, set at submission or by the scorecard sweep.
   */
  scorecard?: CaptainsReportScorecardAnswer;
  /** `CR-YYYY-NNNN`, assigned from the per-tenant counter at submission. */
  ref?: string;
  submittedBy?: string;
  submittedVia?: 'portal' | 'link';
  submittedAt?: string;
  voidedAt?: string;
  /** Set when the result behind a SUBMITTED report was cleared — the admin should look. */
  flagged?: { reason: string; at: string };
  /**
   * When the emailed/WhatsApp link stops working (ISO): 23:59:59 SAST on the later of the
   * match date + 7 days and the day the result first arrived + 3 days. Absent on reports
   * opened before it was stored (then: match date + 7 days).
   */
  linkExpiresAt?: string;
  /** Per-channel outcome of every notice sent about this report (no addresses). */
  deliveries?: CaptainsReportDelivery[];
  /** When a notice about this report first reached someone (a channel `sent`). */
  notifiedAt?: string;
  /** When the one pre-expiry reminder went out. */
  reminderSentAt?: string;
  /**
   * After "Send to captain": the chair's own link id, which keeps working until the report
   * is submitted (first submit wins). Server-only — never served.
   */
  chairMemberId?: string;
  /** How many times the chair has sent the report on (max 3). */
  forwardCount?: number;
  /**
   * The captain recipient's notify contact, kept so the reminder can reach them (a captain's
   * roster key is a hashed ID number and is never stored). Server-only — never served or
   * logged; deleted with the report.
   */
  recipientContact?: { email?: string; cell?: string };
  createdAt: string;
  updatedAt: string;
}
